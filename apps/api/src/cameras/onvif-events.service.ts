import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../common/prisma/prisma.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { RecordingProcessManagerService } from '../recordings/recording-process-manager.service';
import { CamerasService } from './cameras.service';
import { AiManagerService } from '../ai/ai-manager.service';
import { AiService } from '../ai/ai.service';
import { MediamtxProxyService } from '../camera-stream/mediamtx-proxy.service';
import { envNumber } from '../common/config/env-number.helper';
import { assertCameraTargetAllowed } from '../common/network/safe-url.helper';
import { candidateOnvifPorts, streamUriIdentifiesCamera } from './helpers/onvif-port-discovery.helper';
import { classificarEventoOnvif, deveGravar, tipoDeEventoDoSistema, type EventoOnvifClassificado } from './helpers/evento-onvif.helper';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const onvif = require('onvif');

// Tópicos ONVIF que indicam que a PRÓPRIA câmera detecta movimento.
const MOTION_TOPIC_RE = /motion|cellmotion|motionalarm|videomotion|motiondetect/i;
// Eventos que significam FIM de movimento — não devem disparar gravação.
const MOTION_STOP_RE = /action=Stop|IsMotion=false|State=false/i;

type ListenerState = {
  cam: any | null;          // instância conectada da lib onvif (null = conectando)
  connectedAt: number | null;
};

type NativeMotionState = {
  lastEventAt: number | null;  // último evento de movimento REAL recebido da câmera
  fallbackActive: boolean;     // MOG2 local ligada como reserva desta câmera
  deadSyncs: number;           // ciclos seguidos com a escuta caída (armada)
};

/**
 * Detecção de movimento pela PRÓPRIA câmera (ONVIF).
 *
 * Responsabilidades:
 *  1) AUTO-PROBE: descobre quais câmeras publicam eventos de movimento ONVIF e
 *     ajusta `motionTrigger` sozinho — 'CAMERA' quando a câmera detecta (custo
 *     zero de CPU nossa) ou 'SYSTEM' quando não (cai na nossa MOG2 leve). O flip
 *     também SINCRONIZA a análise local na hora (liga/desliga a MOG2), sem
 *     esperar restart.
 *  2) GRAVAÇÃO DIRETA: para câmeras 'CAMERA' ARMADAS (recordingMode='motion'),
 *     um evento de movimento da câmera dispara a gravação na hora
 *     (handleMotionDetected → grava + agenda parada por post-roll). O evento
 *     também é registrado como MOTION_DETECTED (timeline/alarmes), como já
 *     acontece com o detector local.
 *  3) RESILIÊNCIA (cinto e suspensório): escuta que cai é reconectada (erro
 *     remove do mapa → sync de 60s reconecta; re-assinatura forçada periódica
 *     cobre mortes silenciosas do pull-point). Câmera armada com a escuta caída
 *     ou muda demais (sem eventos por horas) ganha a MOG2 local como RESERVA
 *     automaticamente; a reserva desliga quando a câmera dá prova de vida (um
 *     evento real). Promoção a 'CAMERA' de câmera armada também começa com a
 *     reserva ligada até a primeira prova.
 */
@Injectable()
export class OnvifEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OnvifEventsService.name);
  private activeCams: Map<string, ListenerState> = new Map();
  private lastTriggerByCamera: Map<string, number> = new Map();
  private nativeState: Map<string, NativeMotionState> = new Map();
  // Backoff de conexão: câmera com ONVIF recusando (porta fechada) não deve ser
  // re-tentada a cada 60s para sempre — após 3 falhas seguidas, tenta a cada 10min.
  private connectFailures: Map<string, { count: number; nextRetryAt: number }> = new Map();
  // Câmeras cuja porta ONVIF procuramos e não achamos: recuam para não ficarem
  // sondando o equipamento do cliente a cada ciclo para sempre.
  private portDiscoveryFailures: Map<string, { count: number; nextRetryAt: number }> = new Map();
  private pollInterval: NodeJS.Timeout | null = null;
  private probeInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cryptoService: CryptoService,
    private readonly moduleRef: ModuleRef,
  ) {}

  private isDisabled() {
    return String(process.env.AI_AUTO_START_ENABLED ?? 'true').trim().toLowerCase() === 'false';
  }

  private resubscribeAfterMs() {
    // 10 min (era 30): observamos em campo (2026-07-21 19:04→19:30) o pull-point
    // ensurdecer em silêncio 4 min após conectar e só voltar na re-assinatura
    // forçada. A janela de re-assinatura é o TETO da surdez possível.
    return envNumber('AI_ONVIF_RESUBSCRIBE_MINUTES', 10, { min: 5 }) * 60_000;
  }

  private silenceFallbackMs() {
    return envNumber('AI_ONVIF_SILENCE_FALLBACK_HOURS', 12, { min: 1 }) * 3_600_000;
  }

  private deadSyncsForFallback() {
    return envNumber('AI_ONVIF_DEAD_SYNCS_FOR_FALLBACK', 3, { min: 1 });
  }

  private portDiscoveryEnabled() {
    return String(process.env.AI_ONVIF_PORT_DISCOVERY ?? 'true').trim().toLowerCase() !== 'false';
  }

  /**
   * Teto de câmeras sondadas por ciclo. A descoberta tenta até 6 portas por
   * câmera; sem teto, um site novo com 50 câmeras sem cadastro viraria 300
   * conexões contra o roteador do cliente de uma vez.
   */
  private portDiscoveryBudget() {
    return envNumber('AI_ONVIF_PORT_DISCOVERY_PER_CYCLE', 4, { min: 1, max: 64, integer: true });
  }

  async onModuleInit() {
    if (this.isDisabled()) return;
    this.logger.log('Inicializando daemon de eventos ONVIF...');
    // Escuta das câmeras 'CAMERA' + watchdog de reserva (reavalia a cada 60s).
    this.pollInterval = setInterval(() => this.syncCameras(), 60000);
    setTimeout(() => this.syncCameras(), 5000);
    // Auto-probe: descobre suporte a movimento e ajusta motionTrigger.
    this.probeInterval = setInterval(() => this.probeAllCameras(), 15 * 60 * 1000);
    setTimeout(() => this.probeAllCameras(), 12000);
  }

  onModuleDestroy() {
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.probeInterval) clearInterval(this.probeInterval);
  }

  private getNativeState(cameraId: string): NativeMotionState {
    let state = this.nativeState.get(cameraId);
    if (!state) {
      state = { lastEventAt: null, fallbackActive: false, deadSyncs: 0 };
      this.nativeState.set(cameraId, state);
    }
    return state;
  }

  private registerCameraEvent(cameraId: string, type: string, severity: string, message: string, metadata?: any) {
    try {
      const cameras = this.moduleRef.get(CamerasService, { strict: false });
      return cameras.registerEvent(cameraId, type, severity, message, metadata).catch(() => undefined);
    } catch {
      return Promise.resolve(undefined);
    }
  }

  // ── DESCOBERTA DA PORTA ONVIF ──────────────────────────────────────────────
  /**
   * Pergunta a uma porta candidata: "você é a câmera X?".
   *
   * A resposta vem da PRÓPRIA câmera — pede-se o fluxo dela (GetStreamUri) e
   * exige-se que o endereço declarado seja o que temos no cadastro. Uma porta
   * que responde mas aponta para a câmera vizinha é rejeitada, que é justamente
   * o engano em que um mapeamento por posição cairia.
   */
  private confirmOnvifPort(camera: any, port: number, password: string): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        assertCameraTargetAllowed(camera.ip, port);
      } catch {
        return resolve(false);
      }
      let settled = false;
      const finish = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
      const timer = setTimeout(() => finish(false), 8000);
      try {
        const cam = new onvif.Cam(
          { hostname: camera.ip, username: camera.username, password, port, timeout: 6000 },
          (err: any) => {
            if (settled) return;
            if (err) { clearTimeout(timer); return finish(false); }
            cam.getStreamUri({ protocol: 'RTSP' }, (e2: any, result: any) => {
              if (settled) return;
              clearTimeout(timer);
              if (e2 || !result?.uri) return finish(false);
              finish(streamUriIdentifiesCamera(String(result.uri), camera));
            });
          },
        );
        cam.on('error', () => {});
      } catch { clearTimeout(timer); finish(false); }
    });
  }

  /**
   * Preenche a porta ONVIF das câmeras cadastradas sem ela.
   *
   * Por que isto existe: `probeMotionSupport` desiste sem `onvifPort`, então uma
   * câmera com o campo em branco nunca é sondada e fica em `motionTrigger`
   * SYSTEM para sempre — pagando 1,06 Mbps e ~2% de CPU no servidor mesmo
   * quando o equipamento sabe detectar movimento sozinho. Medido em campo
   * (2026-07-31): 9 das 15 câmeras em SYSTEM tinham a porta ONVIF ABERTA no
   * roteador; faltava apenas alguém digitar o número.
   *
   * Roda antes do auto-probe para que a porta descoberta já seja sondada no
   * mesmo ciclo, sem esperar mais 15 minutos.
   */
  private async discoverMissingOnvifPorts() {
    if (!this.portDiscoveryEnabled()) return;
    const semPorta = await this.prisma.camera.findMany({
      where: { enabled: true, onvifPort: null },
      select: { id: true, name: true, ip: true, rtspPort: true, username: true, passwordEncrypted: true },
    });
    if (semPorta.length === 0) return;

    // As irmãs do mesmo endereço revelam a regra do roteador daquele site.
    const comPorta = await this.prisma.camera.findMany({
      where: { onvifPort: { not: null } },
      select: { ip: true, rtspPort: true, onvifPort: true },
    });
    const irmasPorIp = new Map<string, Array<{ rtspPort: number; onvifPort: number }>>();
    for (const irma of comPorta) {
      if (irma.rtspPort == null || irma.onvifPort == null) continue;
      const lista = irmasPorIp.get(irma.ip) ?? [];
      lista.push({ rtspPort: irma.rtspPort, onvifPort: irma.onvifPort });
      irmasPorIp.set(irma.ip, lista);
    }

    let orcamento = this.portDiscoveryBudget();
    for (const camera of semPorta) {
      if (orcamento <= 0) break;
      const recuo = this.portDiscoveryFailures.get(camera.id);
      if (recuo && Date.now() < recuo.nextRetryAt) continue;
      orcamento -= 1;

      let password: string;
      try { password = this.cryptoService.decrypt(camera.passwordEncrypted); }
      catch { continue; }

      const candidatas = candidateOnvifPorts(camera, irmasPorIp.get(camera.ip) ?? []);
      let encontrada: number | null = null;
      for (const porta of candidatas) {
        if (await this.confirmOnvifPort(camera, porta, password)) { encontrada = porta; break; }
      }

      if (encontrada === null) {
        const falha = this.portDiscoveryFailures.get(camera.id) ?? { count: 0, nextRetryAt: 0 };
        falha.count += 1;
        // Recuo crescente até 6h: câmera sem ONVIF de verdade não deve custar
        // seis conexões a cada 15 minutos pelo resto da vida da instalação.
        falha.nextRetryAt = Date.now() + Math.min(falha.count, 24) * 15 * 60_000;
        this.portDiscoveryFailures.set(camera.id, falha);
        if (falha.count <= 2) {
          this.logger.log(`Porta ONVIF não encontrada em ${camera.name} (tentadas: ${candidatas.join(', ')}).`);
        }
        continue;
      }

      this.portDiscoveryFailures.delete(camera.id);
      await this.prisma.camera.update({ where: { id: camera.id }, data: { onvifPort: encontrada } });
      this.logger.log(`Porta ONVIF descoberta em ${camera.name}: ${encontrada} (confirmada pela própria câmera).`);
      void this.registerCameraEvent(camera.id, 'ONVIF_PORT_DISCOVERED', 'INFO',
        `Porta ONVIF ${encontrada} descoberta e confirmada automaticamente.`, { port: encontrada });
    }
  }

  // ── AUTO-PROBE ─────────────────────────────────────────────────────────────
  /**
   * Sonda uma câmera via ONVIF e diz se ela publica eventos de movimento.
   * Retorna true (suporta), false (ONVIF ok e RESPONDEU as propriedades, mas sem
   * tópico de movimento) ou null (inalcançável/sem porta/erro transitório no
   * serviço de eventos — indeterminado, NÃO mexe na config; um soluço de rede
   * não pode rebaixar uma câmera 'CAMERA' que funciona).
   */
  private probeMotionSupport(camera: any): Promise<boolean | null> {
    return new Promise((resolve) => {
      if (!camera.onvifPort) return resolve(null); // sem porta ONVIF → não dá pra sondar
      try {
        assertCameraTargetAllowed(camera.ip, camera.onvifPort);
      } catch {
        return resolve(null);
      }
      let settled = false;
      const finish = (v: boolean | null) => { if (!settled) { settled = true; resolve(v); } };
      const timer = setTimeout(() => finish(null), 6000);
      let password: string;
      try { password = this.cryptoService.decrypt(camera.passwordEncrypted); }
      catch { clearTimeout(timer); return finish(null); }
      try {
        const cam = new onvif.Cam(
          { hostname: camera.ip, username: camera.username, password, port: camera.onvifPort, timeout: 5000 },
          (err: any) => {
            if (settled) return;
            if (err) { clearTimeout(timer); return finish(null); }
            cam.getEventProperties((e2: any, data: any) => {
              if (settled) return;
              clearTimeout(timer);
              // Erro ao LER as propriedades ≠ "sem suporte": pode ser transitório.
              if (e2) return finish(null);
              finish(MOTION_TOPIC_RE.test(JSON.stringify(data || {})));
            });
          },
        );
        cam.on('error', () => {});
      } catch { clearTimeout(timer); finish(null); }
    });
  }

  /**
   * Sonda todas as câmeras e ajusta motionTrigger automaticamente, SINCRONIZANDO
   * a análise local no mesmo instante do flip (sem gap até o próximo restart):
   *  - → 'CAMERA' (armada): a MOG2 fica LIGADA como reserva até a primeira prova
   *    de vida (evento real da câmera); depois desliga sozinha.
   *  - → 'SYSTEM' (armada): liga a MOG2 imediatamente.
   */
  private async probeAllCameras() {
    if (this.isDisabled()) return;
    try {
      // Primeiro preenche as portas em branco: sem porta, a sonda abaixo desiste
      // e a câmera fica presa em SYSTEM. Descoberta e sonda no mesmo ciclo.
      await this.discoverMissingOnvifPorts().catch((error: any) =>
        this.logger.warn(`Falha na descoberta de porta ONVIF: ${error.message}`));

      const cameras = await this.prisma.camera.findMany({
        select: { id: true, name: true, ip: true, onvifPort: true, username: true, passwordEncrypted: true, motionTrigger: true, recordingMode: true, enabled: true },
      });
      for (const cam of cameras) {
        if (cam.enabled === false) continue;
        const supports = await this.probeMotionSupport(cam);
        if (supports === null) continue; // indeterminado → não mexe
        const target = supports ? 'CAMERA' : 'SYSTEM';
        if (cam.motionTrigger === target) continue;

        await this.prisma.camera.update({ where: { id: cam.id }, data: { motionTrigger: target } });
        this.logger.log(`Auto-detecção de movimento: ${cam.name} → ${target} (ONVIF ${supports ? 'com' : 'sem'} movimento).`);

        const armed = cam.recordingMode === 'motion';
        if (!armed) continue;
        if (target === 'SYSTEM') {
          // Perdeu a detecção nativa: a local assume JÁ (não espera restart).
          this.getNativeState(cam.id).fallbackActive = false;
          await this.startLocalDetector(cam.id, false).catch(() => undefined);
        } else {
          // Promovida a nativa: mantém a local como reserva até a 1ª prova real.
          await this.activateFallback(cam.id, cam.name, 'aguardando a primeira prova de vida da detecção nativa', 'INFO');
        }
      }
    } catch (error: any) {
      this.logger.warn(`Falha no auto-probe ONVIF: ${error.message}`);
    }
  }

  // ── RESERVA (MOG2 local como fallback da nativa) ───────────────────────────
  private async startLocalDetector(cameraId: string, asFallback: boolean) {
    const aiManager = this.moduleRef.get(AiManagerService, { strict: false });
    await aiManager.startCamera(cameraId, asFallback ? { allowCameraTrigger: true } : undefined);
  }

  private async stopLocalDetector(cameraId: string) {
    const aiService = this.moduleRef.get(AiService, { strict: false });
    await aiService.stopAnalysis(cameraId).catch(() => undefined);
  }

  private async activateFallback(cameraId: string, cameraName: string, reason: string, severity: 'INFO' | 'WARNING' = 'WARNING') {
    const state = this.getNativeState(cameraId);
    if (state.fallbackActive) return;
    state.fallbackActive = true;
    try {
      await this.startLocalDetector(cameraId, true);
      this.logger.warn(`Detecção nativa sem sinal em ${cameraName} (${reason}) — detector LOCAL ativado como reserva.`);
      await this.registerCameraEvent(cameraId, 'HEALTH_MOTION_NATIVE_DOWN', severity,
        'Detecção de movimento nativa sem sinal — detector local ativado como reserva.', { reason });
    } catch (error) {
      state.fallbackActive = false;
      this.logger.warn(`Falha ao ativar detector local reserva de ${cameraName}: ${(error as Error).message}`);
    }
  }

  private async deactivateFallback(cameraId: string) {
    const state = this.getNativeState(cameraId);
    if (!state.fallbackActive) return;
    state.fallbackActive = false;
    await this.stopLocalDetector(cameraId);
    this.logger.log(`Detecção nativa deu prova de vida (câmera ${cameraId}) — detector local reserva DESLIGADO.`);
    await this.registerCameraEvent(cameraId, 'HEALTH_MOTION_NATIVE_RECOVERED', 'INFO',
      'Detecção de movimento nativa voltou a enviar eventos — reserva local desligada.', {});
  }

  // ── ESCUTA + WATCHDOG + GRAVAÇÃO DIRETA ────────────────────────────────────
  private async syncCameras() {
    if (this.isDisabled()) return;
    try {
      const cameras = await this.prisma.camera.findMany({ where: { motionTrigger: 'CAMERA' } });
      const currentIds = new Set(cameras.map((c) => c.id));

      for (const [id, state] of this.activeCams.entries()) {
        if (!currentIds.has(id)) {
          this.logger.log(`Removendo escuta ONVIF da câmera ${id}`);
          this.activeCams.delete(id);
          continue;
        }
        // Re-assinatura forçada periódica: pull-point pode morrer em silêncio
        // (renovação expirada, câmera reiniciada) sem emitir 'error'. Derrubar a
        // escuta aqui faz o loop abaixo reconectar do zero — barato e garante vida.
        if (state?.cam && state.connectedAt && Date.now() - state.connectedAt > this.resubscribeAfterMs()) {
          this.logger.log(`Re-assinando eventos ONVIF da câmera ${id} (rotina de vida).`);
          this.activeCams.delete(id);
        }
      }

      for (const c of cameras) {
        if (c.enabled === false) {
          this.activeCams.delete(c.id);
          continue;
        }
        if (this.activeCams.has(c.id)) continue;
        const backoff = this.connectFailures.get(c.id);
        if (backoff && backoff.count >= 3 && Date.now() < backoff.nextRetryAt) continue;
        this.connectCamera(c);
      }

      // WATCHDOG de reserva: só para câmeras nativas ARMADAS.
      for (const c of cameras) {
        if (c.enabled === false || c.recordingMode !== 'motion') continue;
        const state = this.getNativeState(c.id);
        const listener = this.activeCams.get(c.id);
        const connected = Boolean(listener?.cam);

        if (!connected) {
          state.deadSyncs += 1;
          if (state.deadSyncs >= this.deadSyncsForFallback() && !state.fallbackActive) {
            await this.activateFallback(c.id, c.name, `escuta ONVIF sem conexão há ${state.deadSyncs} ciclos`);
          }
          continue;
        }
        state.deadSyncs = 0;

        // Conectada mas MUDA há tempo demais: cena parada por horas é possível,
        // mas acima do limiar preferimos gastar ~2% de CPU na reserva a arriscar
        // perder gravação por uma detecção nativa quebrada/desconfigurada.
        const sinceMs = Date.now() - Math.max(state.lastEventAt ?? 0, listener?.connectedAt ?? 0);
        if (!state.fallbackActive && state.lastEventAt === null && sinceMs > this.silenceFallbackMs()) {
          await this.activateFallback(c.id, c.name, `nenhum evento de movimento recebido há ${Math.round(sinceMs / 3_600_000)}h`);
        }
      }
    } catch (error: any) {
      this.logger.error(`Erro ao sincronizar câmeras ONVIF: ${error.message}`);
    }
  }

  private connectCamera(camera: any) {
    try {
      assertCameraTargetAllowed(camera.ip, camera.onvifPort || 80);
    } catch {
      this.activeCams.delete(camera.id);
      return;
    }
    this.logger.log(`Conectando ONVIF na câmera ${camera.name} (${camera.ip})`);
    this.activeCams.set(camera.id, { cam: null, connectedAt: null }); // marca p/ não reconectar em loop

    let password: string;
    try { password = this.cryptoService.decrypt(camera.passwordEncrypted); }
    catch { this.activeCams.delete(camera.id); return; }

    const cam = new onvif.Cam(
      { hostname: camera.ip, username: camera.username, password, port: camera.onvifPort || 80 },
      (err: any) => {
        if (err) {
          const failure = this.connectFailures.get(camera.id) ?? { count: 0, nextRetryAt: 0 };
          failure.count += 1;
          failure.nextRetryAt = Date.now() + 10 * 60_000;
          this.connectFailures.set(camera.id, failure);
          // Loga as 3 primeiras falhas e depois só 1 a cada ~10min (backoff) —
          // porta ONVIF fechada não deve virar spam de WARN a cada 60s.
          if (failure.count <= 3 || failure.count % 10 === 0) {
            this.logger.warn(`Falha na conexão ONVIF com ${camera.name}: ${err.message}${failure.count >= 3 ? ` (tentativa ${failure.count}; próxima em ~10min)` : ''}`);
          }
          this.activeCams.delete(camera.id);
          return;
        }
        this.connectFailures.delete(camera.id);
        this.logger.log(`Conectado à câmera ${camera.name}, iniciando escuta de eventos...`);
        this.activeCams.set(camera.id, { cam, connectedAt: Date.now() });

        cam.on('event', (camMessage: any) => {
          // ANTES: uma pergunta só — "casa com /motion/?" — e o resto ia para o
          // lixo em silêncio. A sondagem da frota (07/08/2026) mostrou o que
          // estava sendo descartado: Cam-04/05/06 declaram
          // `ruleEngine/lineDetector/crossed` (cruzamento de linha, COM
          // direção) e `ruleEngine/fieldDetector/objectsInside`; outras,
          // `userAlarm/IVA/humanShapeDetect`. A câmera gritava "alguém cruzou a
          // linha" e o sistema desligava na cara dela.
          const evento = classificarEventoOnvif(camMessage);
          if (!deveGravar(evento.tipo)) return;
          this.onCameraEvent(camera.id, evento);
        });
        // Erro DEPOIS de conectado (queda de rede/câmera reiniciou): derruba a
        // escuta para o sync de 60s reconectar. Antes o erro era engolido e a
        // câmera ficava SURDA para sempre, sem registro nenhum.
        cam.on('error', (error: any) => {
          const current = this.activeCams.get(camera.id);
          if (current?.cam !== cam) return; // instância antiga — ignora
          this.logger.warn(`Escuta ONVIF caiu em ${camera.name}: ${error?.message ?? 'erro desconhecido'} — reconectando no próximo ciclo.`);
          this.activeCams.delete(camera.id);
        });
      },
    );
    cam.on('error', () => {});
  }

  /**
   * Movimento reportado pela câmera → registra MOTION_DETECTED (timeline/alarmes,
   * como o detector local) e dispara a gravação DIRETO (se armada). Prova de vida
   * da nativa: desliga a reserva local, se estava ligada. Cooldown evita enxurrada.
   */
  private onCameraEvent(cameraId: string, evento: EventoOnvifClassificado) {
    const cooldownMs = envNumber('AI_ONVIF_TRIGGER_COOLDOWN_MS', 5000);
    const now = Date.now();
    const state = this.getNativeState(cameraId);
    state.lastEventAt = now;
    if (state.fallbackActive) void this.deactivateFallback(cameraId);

    // PERÍMETRO NÃO ESPERA. O intervalo de silêncio existe para o movimento,
    // que dispara em rajada por natureza (medido: ~222/hora em cena vazia).
    // Cruzamento de linha e intrusão são raros e caros de perder: alguém pode
    // cruzar duas vezes em 5 segundos, e a segunda é justamente a que importa.
    const ehPerimetro = evento.tipo === 'linha-cruzada' || evento.tipo === 'intrusao';
    if (!ehPerimetro && now - (this.lastTriggerByCamera.get(cameraId) ?? 0) < cooldownMs) return;
    this.lastTriggerByCamera.set(cameraId, now);
    void this.handleNativeMotion(cameraId, evento);
  }

  /**
   * Fluxo de um evento de movimento NATIVO (ONVIF), agora com CONFIRMAÇÃO
   * SEMÂNTICA opcional. As câmeras disparam ruído em cena vazia (medido:
   * ~222/hora de madrugada); confirmar que há objeto real antes de gravar mata
   * esse ruído e evita encher o disco de gravações de nada.
   *
   * Falha SEMPRE segura: se a IA está desligada, fora do ar, lenta ou não tem
   * certeza (confirmed=null), GRAVA mesmo assim. Só suprime quando a IA leu o
   * frame e afirmou que NÃO há objeto (confirmed=false). Perder gravação real
   * por causa da IA é inaceitável; gravar um evento sem objeto é só custo.
   */
  private async handleNativeMotion(cameraId: string, evento?: EventoOnvifClassificado) {
    const tipo = evento?.tipo ?? 'movimento';
    // Perímetro (linha/intrusão) e forma humana já SÃO a decisão da câmera
    // sobre haver algo relevante. Rodar o YOLO em cima disso é pagar duas
    // vezes pela mesma resposta — e a confirmação semântica está desligada
    // nesta instalação justamente pelo custo. Só movimento cru é confirmado.
    const ehPerimetro = tipo === 'linha-cruzada' || tipo === 'intrusao' || tipo === 'forma-humana';
    const filterEnabled = !ehPerimetro && String(process.env.AI_ONVIF_SEMANTIC_FILTER ?? 'true').trim().toLowerCase() !== 'false';

    let confirmation: { confirmed: boolean | null; labels: string[]; confidence?: number; reason?: string | null } | null = null;
    if (filterEnabled) {
      // Só vale a pena confirmar se a câmera está ARMADA para gravar por
      // movimento — senão o evento é apenas informativo e não custeia um YOLO.
      const cam = await this.prisma.camera.findUnique({
        where: { id: cameraId },
        select: { recordingMode: true, enabled: true },
      }).catch(() => null);
      if (cam && cam.enabled !== false && cam.recordingMode === 'motion') {
        confirmation = await this.confirmNativeMotion(cameraId).catch(() => null);
      }
    }

    // confirmed === false → frame lido e SEM objeto: suprime a gravação, mas
    // deixa um rastro leve para diagnóstico (não polui a timeline de alarmes).
    if (confirmation?.confirmed === false) {
      void this.registerCameraEvent(cameraId, 'MOTION_SUPPRESSED', 'INFO',
        'Movimento nativo sem objeto reconhecido — gravação não acionada.',
        { source: 'onvif', reason: confirmation.reason ?? 'no_object' });
      return;
    }

    const semanticLabel = confirmation?.confirmed === true ? (confirmation.labels[0] ?? null) : null;

    // O evento registrado reflete o que a CÂMERA disse. Antes tudo virava
    // MOTION_DETECTED — um cruzamento de linha e um galho balançando ficavam
    // indistinguíveis no histórico, e a Revisão não tinha como priorizar.
    const tipoDoSistema = tipoDeEventoDoSistema(tipo) ?? 'MOTION_DETECTED';
    const severidade = ehPerimetro && tipo !== 'forma-humana' ? 'WARNING' : 'INFO';
    const ondeDiz = evento?.regra ? ` (${evento.regra})` : '';
    const descricao =
      tipo === 'linha-cruzada'
        ? `Cruzamento de linha detectado pela câmera${ondeDiz}${evento?.direcao ? ` — sentido ${evento.direcao}` : ''}.`
        : tipo === 'intrusao'
          ? `Intrusão em área detectada pela câmera${ondeDiz}.`
          : tipo === 'forma-humana'
            ? 'Pessoa detectada pela própria câmera.'
            : semanticLabel
              ? `${semanticLabel} detectado(a) pela câmera (ONVIF).`
              : 'Movimento detectado pela própria câmera (ONVIF).';

    void this.registerCameraEvent(cameraId, tipoDoSistema, severidade, descricao,
      {
        source: 'onvif',
        ...(tipo !== 'movimento' ? { perimetro: tipo } : {}),
        ...(evento?.direcao ? { direcao: evento.direcao } : {}),
        ...(evento?.regra ? { regra: evento.regra } : {}),
        ...(evento?.topico ? { topico: evento.topico } : {}),
        ...(semanticLabel ? { semanticLabel, semanticConfirmed: true, semanticConfidence: confirmation?.confidence } : {}),
      });

    try {
      const recordingManager = this.moduleRef.get(RecordingProcessManagerService, { strict: false });
      void recordingManager.handleMotionDetected(cameraId, {
        source: 'onvif',
        ...(semanticLabel ? { semanticLabel } : {}),
      }).catch(() => undefined);
    } catch {
      // recording manager indisponível — ignora (não derruba a escuta)
    }
  }

  /** Resolve o path de grade da câmera e pede confirmação de objeto ao ai-service. */
  private async confirmNativeMotion(cameraId: string) {
    try {
      const mediamtx = this.moduleRef.get(MediamtxProxyService, { strict: false });
      const pathName = mediamtx.getPathNameForCamera(cameraId, 'grid');
      const rtspUrl = mediamtx.buildInternalRtspUrl(pathName);
      if (!rtspUrl) return { confirmed: null as boolean | null, labels: [] as string[] };
      const aiService = this.moduleRef.get(AiService, { strict: false });
      return await aiService.confirmMotion(cameraId, rtspUrl);
    } catch {
      return { confirmed: null as boolean | null, labels: [] as string[] };
    }
  }
}
