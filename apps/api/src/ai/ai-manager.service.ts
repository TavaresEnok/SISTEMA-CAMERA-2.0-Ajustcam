import { BadRequestException, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { CamerasService } from '../cameras/cameras.service';
import { AiService } from './ai.service';
import { SourceGatewayService } from '../camera-stream/source-gateway.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  buildRtspUrl,
  isHevcCodec,
  resolveAnalyticsRtspProfile,
  resolveLiveRtspProfile,
  resolveRecordingRtspProfile,
  sanitizeRtspUrl,
} from '../cameras/helpers/rtsp-url.helper';
import { MediamtxProxyService } from '../camera-stream/mediamtx-proxy.service';
import { CommercialPolicyService } from '../commercial-policy/commercial-policy.service';
import { envNumber } from '../common/config/env-number.helper';

const AI_MODES = ['motion', 'face', 'general'] as const;
type AiMode = typeof AI_MODES[number];

function normalizeAiCameraToken(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-');
}

function parseAiCameraSet(raw: string | undefined): Set<string> {
  return new Set(
    String(raw ?? '')
      .split(',')
      .map((item) => normalizeAiCameraToken(item))
      .filter(Boolean),
  );
}

function cameraMatchesAiToken(cam: any, token: string): boolean {
  if (!token) return false;
  return [cam.id, cam.name, cam.slug, cam.displayName]
    .map((value) => normalizeAiCameraToken(value))
    .filter(Boolean)
    .includes(token);
}

function isCameraAllowedByAiEnv(cam: any): boolean {
  const forceSingle = String(process.env.AI_FORCE_SINGLE_CAMERA ?? 'false').trim().toLowerCase();
  const singleEnabled = ['1', 'true', 'yes', 'on'].includes(forceSingle);
  const singleId = normalizeAiCameraToken(process.env.AI_SINGLE_CAMERA_ID);
  if (singleEnabled && singleId) {
    return cameraMatchesAiToken(cam, singleId);
  }

  const configured = [
    process.env.AI_ENABLED_CAMERA_IDS,
    process.env.AI_ACTIVE_CAMERA_IDS,
    process.env.AI_ANALYTICS_CAMERA_IDS,
  ].filter((value) => String(value ?? '').trim().length > 0);
  if (!configured.length) return true;

  const allowed = new Set<string>();
  for (const raw of configured) {
    for (const token of parseAiCameraSet(raw)) allowed.add(token);
  }
  return Array.from(allowed).some((token) => cameraMatchesAiToken(cam, token));
}

function asNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function asNullableNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asBool(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function avg(values: Array<number | null | undefined>): number | null {
  const filtered = values.filter((value): value is number => Number.isFinite(value as number));
  if (!filtered.length) return null;
  return Math.round((filtered.reduce((sum, value) => sum + value, 0) / filtered.length) * 1000) / 1000;
}

function pct(value: number | null | undefined): number | null {
  if (!Number.isFinite(value as number)) return null;
  return Math.round((value as number) * 10000) / 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// Watchdog de processadores DEGRADADOS: era 120s. Um detector cego (a fonte
// mudou por baixo dele) exige 2 ciclos para agir — 120s viravam 4 MINUTOS de
// câmera armada sem detectar movimento, ou seja, sem gravar. A 30s o mesmo
// diagnóstico sai em 1 minuto.
//
// Por que baixar é seguro: a frequência do TICK não é a frequência da AÇÃO. Toda
// recuperação continua travada por cooldown POR CÂMERA em tempo ABSOLUTO
// (AI_DEGRADED_RECOVERY_COOLDOWN_MS, piso de 2 min; 5 min para processador
// ausente), então tick mais rápido não vira tempestade de restart — encurta só a
// DETECÇÃO. O custo por tick é um GET /health no ai-service (barato, local).
//
// O piso existe para que ninguém consiga martelar o ai-service por env; e o
// fallback protege contra o defeito antigo `Math.max(60_000, Number('abc'))` =
// NaN, que fazia setInterval disparar a cada ~1ms.
// ─────────────────────────────────────────────────────────────────────────────
export const AI_DEGRADED_WATCHDOG_DEFAULT_INTERVAL_MS = 30_000;
export const AI_DEGRADED_WATCHDOG_MIN_INTERVAL_MS = 10_000;

export function resolveDegradedWatchdogIntervalMs(raw?: string | null): number {
  const parsed = Number(String(raw ?? '').trim());
  const wanted = Number.isFinite(parsed) && parsed > 0 ? parsed : AI_DEGRADED_WATCHDOG_DEFAULT_INTERVAL_MS;
  return Math.max(AI_DEGRADED_WATCHDOG_MIN_INTERVAL_MS, wanted);
}

// Cooldown POR CÂMERA da recuperação — é ELE que sustenta a justificativa acima
// para o tick de 30s. Estava lido cru:
//     Math.max(2 * 60_000, Number(process.env.X ?? 10 * 60_000))
// Com lixo no env isso vira NaN, e o uso é `if (agora - ultima < cooldown) continue`
// — comparação com NaN é sempre false, então o `continue` nunca acontece e o
// cooldown SOME. Um typo transformava a garantia "não vira tempestade de restart"
// na sua negação: reinício de análise a cada tick numa câmera já degradada.
export const AI_DEGRADED_RECOVERY_COOLDOWN_DEFAULT_MS = 10 * 60_000;
export const AI_DEGRADED_RECOVERY_COOLDOWN_MIN_MS = 2 * 60_000;

export function resolveDegradedRecoveryCooldownMs(): number {
  return envNumber('AI_DEGRADED_RECOVERY_COOLDOWN_MS', AI_DEGRADED_RECOVERY_COOLDOWN_DEFAULT_MS, {
    min: AI_DEGRADED_RECOVERY_COOLDOWN_MIN_MS,
  });
}

function parseCsvEnv(raw: string | undefined): string[] {
  return String(raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

@Injectable()
export class AiManagerService implements OnModuleInit {
  private readonly logger = new Logger(AiManagerService.name);
  private syncInFlight: Promise<any> | null = null;
  // Auto-recuperação de processadores degradados: exige 2 ciclos seguidos
  // "degraded" antes de agir (evita transientes) e respeita cooldown por câmera.
  private readonly degradedStrikes = new Map<string, number>();
  // Contagem de ticks em que um processador apareceu ÓRFÃO (ativo para câmera
  // não armada). Só paramos no 2º tick seguido: um teste manual rápido de IA
  // não pode morrer no meio por azar de timing do watchdog.
  private readonly strayStrikes = new Map<string, number>();
  private readonly lastDegradedRecoveryAt = new Map<string, number>();
  private degradedWatchdogTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly camerasService: CamerasService,
    private readonly aiService: AiService,
    private readonly cryptoService: CryptoService,
    private readonly prisma: PrismaService,
    private readonly mediamtxProxy: MediamtxProxyService,
    private readonly commercialPolicy: CommercialPolicyService,
    // Opcional: camada nova, DESLIGADA por default. Sem ela nada muda.
    @Optional() private readonly sourceGateway?: SourceGatewayService,
  ) {}

  async onModuleInit() {
    if (String(process.env.AI_AUTO_START_ENABLED ?? 'true') === 'false') {
      this.logger.log('Sincronização automática de IA desativada por AI_AUTO_START_ENABLED=false.');
      return;
    }
    this.logger.log('Sincronizando IA com as câmeras...');
    // Aguarda um pouco para os serviços estarem prontos
    setTimeout(() => void this.syncAll(), 5000);

    // Watchdog: um processador pode ficar "active" porém DEGRADED para sempre
    // quando a fonte muda por baixo dele (ex.: site caiu e voltou com outro
    // codec/URL — o detector fica cego sem se auto-curar). Aqui a análise é
    // reiniciada com a fonte RE-RESOLVIDA (buildAiSource) automaticamente.
    const watchdogIntervalMs = resolveDegradedWatchdogIntervalMs(process.env.AI_DEGRADED_WATCHDOG_INTERVAL_MS);
    this.degradedWatchdogTimer = setInterval(() => void this.recoverDegradedProcessors(), watchdogIntervalMs);
    this.logger.log(`Watchdog de IA degradada ativo (intervalo ${Math.round(watchdogIntervalMs / 1000)}s).`);
    if (typeof this.degradedWatchdogTimer.unref === 'function') this.degradedWatchdogTimer.unref();
  }

  private async recoverDegradedProcessors() {
    try {
      const health: any = await this.aiService.getHealth();
      const degraded: string[] = Array.isArray(health?.degraded_processors) ? health.degraded_processors : [];
      for (const cameraId of [...this.degradedStrikes.keys()]) {
        if (!degraded.includes(cameraId)) this.degradedStrikes.delete(cameraId);
      }

      // Processador AUSENTE (ex.: ai-service reiniciou e perdeu tudo): religa a
      // análise das câmeras armadas sem esperar um restart do api. O caso
      // "degraded" abaixo cobre processador vivo porém cego; este cobre o morto.
      if (health?.status === 'online' || health?.status === 'degraded') {
        const active: string[] = Array.isArray(health?.active_processors) ? health.active_processors : [];
        const settings = await this.getSettings();
        if (settings.enabled && settings.mode === 'motion') {
          const armed = await this.prisma.camera.findMany({
            where: { recordingMode: 'motion', motionTrigger: 'SYSTEM', enabled: true },
            select: { id: true, name: true },
          });
          for (const cam of armed) {
            if (active.includes(cam.id)) continue;
            const lastAt = this.lastDegradedRecoveryAt.get(cam.id) ?? 0;
            if (Date.now() - lastAt < 5 * 60_000) continue;
            this.lastDegradedRecoveryAt.set(cam.id, Date.now());
            this.logger.warn(`Processador de IA AUSENTE para câmera armada ${cam.name} — religando análise.`);
            // O RESULTADO precisa aparecer. `startCamera` tem vários retornos que
            // NÃO iniciam nada e não lançam — o mais traiçoeiro é `camera_disabled`,
            // quando a câmera está armada em SYSTEM (ou seja, depende do detector)
            // com o detector DESLIGADO.
            //
            // Sem este log, o ciclo dizia "religando" a cada 5 minutos, desistia em
            // silêncio, e a câmera ficava sem gravar nada com tudo parecendo normal.
            // Medido: 5 câmeras ONLINE, 10 horas, zero gravações — e o log só
            // repetindo "religando".
            const resultado = await this.startCamera(cam.id).catch((error) => {
              this.logger.warn(`Falha ao religar análise de ${cam.name}: ${(error as Error).message}`);
              return null;
            });
            const st = resultado ? String((resultado as { status?: string }).status ?? '') : '';
            if (resultado && st !== 'started' && st !== 'already_running' && st !== 'running') {
              const motivo = (resultado as { reason?: string }).reason;
              this.logger.error(
                `Câmera ${cam.name} está armada por movimento do SISTEMA mas a análise NÃO subiu ` +
                  `(${st}${motivo ? '/' + motivo : ''}). Enquanto isso, ela não grava nada.`,
              );
            }
          }

          // RECONCILIAÇÃO REVERSA: processador rodando para câmera NÃO armada é
          // ÓRFÃO — sobrou de um desarme, de um teste ou de uma época em que a
          // câmera gravava por movimento. O ai-service sobrevive a restarts da
          // API, então ninguém nunca mandava esses pararem: em produção
          // acumularam 9 processadores com UMA câmera armada. O custo é duplo e
          // invisível: CPU de análise E o transcode da grade preso ligado 24/7
          // (a IA é um leitor permanente do path _grid), deixando o live mais
          // lento para todo mundo — com o operador jurando que a IA estava
          // desligada, porque na Central ela ESTAVA.
          //
          // "Legítimo" = EXATAMENTE o conjunto que o auto-start ligaria
          // (câmera habilitada com o toggle de detecção `aiEnabled` ligado).
          // Usar um critério diferente do auto-start aqui vira CABO DE GUERRA:
          // a primeira versão desta reconciliação considerava legítima só quem
          // grava por movimento — e ficou parando processadores que o
          // auto-start religava um tick depois, para sempre. Quem decide se
          // uma câmera tem detecção é o toggle dela; o papel desta limpeza é
          // só matar o que NINGUÉM ligaria hoje (câmera desabilitada, toggle
          // desligado, sobra de teste).
          const legitimas = new Set(
            (await this.prisma.camera.findMany({
              where: { enabled: { not: false }, aiEnabled: { not: false } },
              select: { id: true },
            })).map((cam) => cam.id),
          );
          for (const cameraId of active) {
            if (legitimas.has(cameraId)) {
              this.strayStrikes.delete(cameraId);
              continue;
            }
            const strikes = (this.strayStrikes.get(cameraId) ?? 0) + 1;
            this.strayStrikes.set(cameraId, strikes);
            if (strikes < 2) continue;
            this.strayStrikes.delete(cameraId);
            this.logger.warn(
              `Processador de IA ÓRFÃO (câmera ${cameraId} não está armada) — parando análise e liberando o transcode da grade.`,
            );
            await this.aiService.stopAnalysis(cameraId).catch(() => undefined);
          }
        }
      }

      if (!degraded.length) return;

      const cooldownMs = resolveDegradedRecoveryCooldownMs();
      for (const cameraId of degraded) {
        const strikes = (this.degradedStrikes.get(cameraId) ?? 0) + 1;
        this.degradedStrikes.set(cameraId, strikes);
        if (strikes < 2) continue;
        const lastAt = this.lastDegradedRecoveryAt.get(cameraId) ?? 0;
        if (Date.now() - lastAt < cooldownMs) continue;
        this.lastDegradedRecoveryAt.set(cameraId, Date.now());
        this.degradedStrikes.delete(cameraId);

        this.logger.warn(`Processador de IA degradado (câmera ${cameraId}) — reiniciando análise com fonte re-resolvida.`);
        try {
          await this.aiService.stopAnalysis(cameraId).catch(() => undefined);
          // allowCameraTrigger: se um processador EXISTIA para esta câmera, alguém o
          // iniciou de propósito (fallback do ONVIF em câmera 'CAMERA', ou teste).
          // Sem isso, o watchdog PARAVA o processador degradado e o startCamera
          // recusava religar ('camera_self_detection') — matava a reserva em silêncio.
          const result: any = await this.startCamera(cameraId, { allowCameraTrigger: true });
          await this.camerasService.registerEvent(
            cameraId,
            'HEALTH_AI_PROCESSOR_RECOVERED',
            'WARNING',
            'Detector de IA degradado foi reiniciado automaticamente com a fonte re-resolvida.',
            { result: result?.status ?? 'restarted' },
          ).catch(() => undefined);
        } catch (error) {
          this.logger.warn(`Falha na auto-recuperação da IA da câmera ${cameraId}: ${(error as Error).message}`);
        }
      }
    } catch {
      // Watchdog é best-effort; falha de health check não pode derrubar nada.
    }
  }

  async syncAll() {
    if (this.syncInFlight) {
      this.logger.debug('Sincronização de IA já em execução; reutilizando operação atual.');
      return this.syncInFlight;
    }
    this.syncInFlight = this.performSyncAll();
    try {
      return await this.syncInFlight;
    } finally {
      this.syncInFlight = null;
    }
  }

  private async performSyncAll() {
    try {
      const settings = await this.getSettings();
      // ⚠️ `aiAdvanced` significa OBJETO/FACE, não "IA em geral". A detecção de
      // MOVIMENTO (MOG2) é o que ARMA a gravação por movimento e não pode ser
      // derrubada por essa checagem: com a política "somente movimento" — o
      // estado normal e desejado — `aiAdvanced` é false, e o stopAll cego aqui
      // deixava as câmeras armadas sem gravar, em silêncio. Só bloqueamos tudo
      // quando o próprio MOVIMENTO está proibido.
      const motionAllowed = await this.commercialPolicy.isAllowed('aiMotion').catch(() => true);
      if (!motionAllowed) {
        this.logger.log('IA bloqueada pela política comercial (movimento proibido). Parando processadores ativos.');
        await this.aiService.stopAll().catch(() => undefined);
        return { started: 0, skipped: 'commercial_restriction', settings };
      }
      if (settings.mode !== 'motion' && !(await this.commercialPolicy.isAllowed('aiAdvanced'))) {
        this.logger.log(`Modo de IA "${settings.mode}" bloqueado pela política comercial; seguindo apenas com movimento.`);
        settings.mode = 'motion';
      }
      if (!settings.enabled) {
        this.logger.log('IA global desativada. Parando processadores ativos.');
        await this.aiService.stopAll().catch(() => undefined);
        return { started: 0, skipped: 'disabled', settings };
      }

      const cameras = await this.camerasService.findAllInternal();
      const enabledCameras = cameras.filter((cam: any) => {
        if (cam.enabled === false) return false; // câmera desativada no sistema
        if (cam.aiEnabled === false || !isCameraAllowedByAiEnv(cam)) return false;
        // No modo 'motion' a detecção existe para servir à GRAVAÇÃO por
        // movimento: analisa APENAS as câmeras armadas (recordingMode='motion')
        // E que dependem da NOSSA detecção (motionTrigger='SYSTEM'). Câmeras com
        // detecção própria (motionTrigger='CAMERA') usam o evento ONVIF e não
        // gastam nossa CPU. Assim nada é analisado sem necessidade. Nos modos de
        // objetos (general/face) segue analisando todas as câmeras habilitadas.
        if (settings.mode === 'motion') {
          return cam.recordingMode === 'motion' && cam.motionTrigger === 'SYSTEM';
        }
        return true;
      });
      const runtimeMode = settings.mode === 'motion' ? 'motion' : `motion+${settings.mode}`;
      this.logger.log(`Iniciando IA modo '${runtimeMode}' para ${enabledCameras.length}/${cameras.length} câmeras...`);
      await this.aiService.stopAll().catch(() => undefined);
      await this.aiService.resetModels().catch(() => undefined);
      let started = 0;
      
      for (const cam of enabledCameras) {
        try {
          const source = await this.buildAiSource(cam);
          await this.aiService.startAnalysisWithConfig(cam.id, source.rtspUrl, settings.mode, source.info);
          started += 1;
          this.logger.log(`IA ${runtimeMode} iniciada para câmera: ${cam.name}`);
        } catch (err: any) {
          this.logger.warn(`Falha ao iniciar IA para ${cam.name}: ${err.message}`);
        }
      }
      return { started, settings };
    } catch (err: any) {
      this.logger.error(`Erro ao sincronizar IA: ${err.message}`);
      return { started: 0, error: err.message };
    }
  }

  async restartAll() {
    return this.syncAll();
  }

  async startCamera(cameraId: string, options?: { allowCameraTrigger?: boolean; liveAutoStart?: boolean }) {
    const settings = await this.getSettings();
    if (!settings.enabled) {
      return { status: 'disabled', cameraId };
    }
    // ⚠️ O portão é o da capacidade que ESTE start vai usar — a mesma lição de
    // `performSyncAll`, que aqui faltava. Abrir com `aiAdvanced` devolvia
    // `commercial_restriction` no estado NORMAL do produto ("somente
    // movimento"), em silêncio: sem log, sem erro, com cara de sucesso.
    //
    // Isso matava a auto-cura. Quando o ai-service reinicia ele perde todos os
    // processadores; o watchdog percebe e chama este método — que respondia
    // "desabilitado" e voltava. Câmera armada por movimento ficava sem detecção
    // e, portanto, SEM GRAVAR, até alguém reiniciar a API. Visto em produção
    // em 2026-07-28. O `.catch()` do watchdog não salvava: não havia exceção.
    //
    // Assimetria proposital no tratamento de erro: movimento falha ABERTO
    // (central fora do ar não pode significar "pare de gravar") e objeto/face
    // falham FECHADO (na dúvida, a IA pesada fica desligada).
    const motionAllowed = await this.commercialPolicy.isAllowed('aiMotion').catch(() => true);
    if (!motionAllowed) {
      return { status: 'disabled', cameraId, reason: 'commercial_restriction' };
    }
    if (settings.mode !== 'motion'
      && !(await this.commercialPolicy.isAllowed('aiAdvanced').catch(() => false))) {
      return { status: 'disabled', cameraId, reason: 'commercial_restriction' };
    }
    const cam = await this.camerasService.getCameraOrThrow(cameraId);
    if (cam.aiEnabled === false || !isCameraAllowedByAiEnv(cam)) {
      return { status: 'camera_disabled', cameraId };
    }
    // ABRIR O LIVE não pode criar processador PERSISTENTE em câmera que não
    // grava por movimento. O processador sobrevive ao fechar do live (só a
    // lease morre) e ao restart da API (mora no ai-service) — foi exatamente
    // assim que produção acumulou 9 processadores com UMA câmera armada:
    // cada tile aberto semeava um MOG2 eterno. No modo movimento, IA de
    // câmera desarmada não arma gravação nenhuma e não desenha nada (o
    // overlay de movimento foi removido de vez): é só custo. Objeto/face
    // (modo avançado) seguem podendo nascer do live — lá o overlay é real.
    if (options?.liveAutoStart && settings.mode === 'motion' && cam.recordingMode !== 'motion') {
      return { status: 'disabled', cameraId, reason: 'not_armed' };
    }
    // No modo 'motion', câmeras com detecção própria (motionTrigger='CAMERA')
    // usam o evento ONVIF (OnvifEventsService) e NÃO consomem nossa CPU.
    // allowCameraTrigger=true é o FALLBACK do OnvifEventsService: liga a MOG2
    // como reserva quando a detecção nativa está sem prova de vida.
    if (settings.mode === 'motion' && (cam as any).motionTrigger !== 'SYSTEM' && !options?.allowCameraTrigger) {
      return { status: 'camera_self_detection', cameraId };
    }
    const source = await this.buildAiSource(cam);
    return this.aiService.startAnalysisWithConfig(cameraId, source.rtspUrl, settings.mode, source.info);
  }

  async getSettings() {
    return this.prisma.aiSettings.upsert({
      where: { id: 'global' },
      update: {},
      create: { id: 'global', enabled: true, mode: 'motion' },
    });
  }

  async updateSettings(input: { enabled?: boolean; mode?: string }) {
    await this.commercialPolicy.assertFeature('aiAdvanced');
    const data: { enabled?: boolean; mode?: AiMode } = {};
    if (typeof input.enabled === 'boolean') data.enabled = input.enabled;
    if (input.mode !== undefined) {
      if (!AI_MODES.includes(input.mode as AiMode)) {
        throw new BadRequestException(`Modo de IA inválido: ${input.mode}`);
      }
      data.mode = input.mode as AiMode;
    }
    const settings = await this.prisma.aiSettings.upsert({
      where: { id: 'global' },
      update: data,
      create: {
        id: 'global',
        enabled: data.enabled ?? true,
        mode: data.mode ?? 'motion',
      },
    });
    const sync = await this.restartAll();
    return { settings, sync };
  }

  async getIntelligenceOverview(accessibleCameraIds?: string[]) {
    const [settings, health, cameras, commercialAllowed] = await Promise.all([
      this.getSettings(),
      this.aiService.getHealth(),
      this.camerasService.findAllInternal(),
      this.commercialPolicy.isAllowed('aiAdvanced').catch(() => false),
    ]);

    const allowedSet = Array.isArray(accessibleCameraIds) ? new Set(accessibleCameraIds) : null;
    const visibleCameras = allowedSet ? cameras.filter((camera: any) => allowedSet.has(camera.id)) : cameras;
    const processors = health?.processors && typeof health.processors === 'object' ? health.processors as Record<string, any> : {};
    const cameraRows = visibleCameras.map((camera: any) => this.buildIntelligenceCamera(camera, processors[camera.id], settings));
    const serviceOnline = health?.status === 'online';
    const enabledRows = cameraRows.filter((camera) => camera.participation.aiEnabled && camera.participation.allowedByPolicy);
    const runningRows = cameraRows.filter((camera) => camera.runtime.running);
    const criticalRows = cameraRows.filter((camera) => camera.health.severity === 'critical');
    const warningRows = cameraRows.filter((camera) => camera.health.severity === 'warning');

    const status = !commercialAllowed
      ? 'restricted'
      : !settings.enabled
        ? 'disabled'
        : !serviceOnline
          ? 'offline'
          : criticalRows.length
            ? 'critical'
            : warningRows.length
              ? 'attention'
              : 'ok';

    return {
      generatedAt: new Date().toISOString(),
      status,
      service: {
        online: serviceOnline,
        healthStatus: health?.status ?? 'offline',
        activeProcessors: Array.isArray(health?.active_processors) ? health.active_processors : Object.keys(processors),
        lastError: asString(health?.model_registry?.lastError ?? health?.last_error),
      },
      commercial: {
        aiAdvancedAllowed: commercialAllowed,
      },
      settings: {
        enabled: settings.enabled,
        mode: settings.mode,
        modeLabel: this.modeLabel(settings.mode),
        updatedAt: settings.updatedAt,
      },
      runtimePolicy: this.runtimePolicy(),
      model: this.modelState(health, settings.mode),
      summary: {
        totalCameras: cameraRows.length,
        onlineCameras: cameraRows.filter((camera) => camera.camera.online).length,
        aiEnabledCameras: cameraRows.filter((camera) => camera.participation.aiEnabled).length,
        allowedByPolicyCameras: cameraRows.filter((camera) => camera.participation.allowedByPolicy).length,
        expectedProcessors: enabledRows.length,
        runningProcessors: runningRows.length,
        directCameraSources: runningRows.filter((camera) => camera.source.kind === 'direct_camera').length,
        mediaMtxSources: runningRows.filter((camera) => camera.source.usesMediaMtx).length,
        hibernatingProcessors: runningRows.filter((camera) => camera.runtime.hibernating).length,
        activeLiveSessions: runningRows.reduce((sum, camera) => sum + camera.liveView.activeSessions, 0),
        avgCaptureFps: avg(runningRows.map((camera) => camera.stream.captureFps)),
        avgInferenceFps: avg(runningRows.map((camera) => camera.stream.inferenceFps)),
        avgFrameAgeMs: avg(runningRows.map((camera) => camera.stream.frameAgeAvgMs)),
        avgInferLatencyMs: avg(runningRows.map((camera) => camera.performance.inferAvgMs)),
        inferP95Ms: avg(runningRows.map((camera) => camera.performance.inferP95Ms)),
        poolBusyDrops: runningRows.reduce((sum, camera) => sum + camera.performance.poolBusyDrops, 0),
        advancedInferErrors: runningRows.reduce((sum, camera) => sum + camera.performance.advancedInferErrors, 0),
        captureDroppedFrames: runningRows.reduce((sum, camera) => sum + camera.stream.droppedFrames, 0),
      },
      recommendations: this.globalRecommendations({
        status,
        settings,
        serviceOnline,
        commercialAllowed,
        cameraRows,
      }),
      cameras: cameraRows,
    };
  }

  async getCameraIntelligence(cameraId: string) {
    const overview = await this.getIntelligenceOverview([cameraId]);
    const camera = overview.cameras.find((item: any) => item.camera.id === cameraId) ?? null;
    const latest = await this.aiService.getLatestDetections(cameraId, 1500, 20);
    return {
      generatedAt: new Date().toISOString(),
      overview: {
        status: overview.status,
        settings: overview.settings,
        model: overview.model,
        runtimePolicy: overview.runtimePolicy,
      },
      camera,
      latestDetections: latest,
    };
  }

  async restartCamera(cameraId: string) {
    await this.aiService.stopAnalysis(cameraId).catch(() => undefined);
    return this.startCamera(cameraId);
  }

  private buildIntelligenceCamera(cam: any, processor: any, settings: any) {
    const performance = processor?.performance ?? {};
    const stream = processor?.stream ?? {};
    const source = processor?.source ?? {};
    const liveView = processor?.live_view ?? {};
    const featureFlags = liveView?.feature_flags ?? {};
    const adaptiveMetrics = liveView?.adaptive?.metrics ?? {};
    const captureFramesEnqueued = asNumber(processor?.capture_frames_enqueued);
    const captureFramesDropped = asNumber(processor?.capture_frames_dropped);
    const captureDropRatio = captureFramesEnqueued + captureFramesDropped > 0
      ? captureFramesDropped / (captureFramesEnqueued + captureFramesDropped)
      : 0;
    const liveSubtype = cam.liveSubtype ?? cam.subtype ?? 0;
    const liveChannel = cam.liveChannel ?? cam.channel ?? 1;
    const recordingSubtype = cam.recordingSubtype ?? cam.subtype ?? 0;
    const recordingChannel = cam.recordingChannel ?? cam.channel ?? 1;
    const analyticsSubtype = cam.analyticsSubtype ?? 1;
    const analyticsChannel = cam.analyticsChannel ?? cam.channel ?? 1;
    const analyticsSeparated = analyticsSubtype !== liveSubtype || analyticsChannel !== liveChannel;
    const dbCodec = asString(cam.detectedVideoCodec ?? cam.streamVideoCodec ?? cam.recordingVideoCodec);
    const streamCodec = asString(stream?.codec ?? source?.analyticsSourceCodec ?? source?.analytics_source_codec ?? dbCodec);
    const sourceKind = asString(source?.kind) ?? (processor ? 'unknown' : 'not_started');
    const usesMediaMtx = asBool(source?.usesMediaMtx ?? source?.uses_mediamtx);
    const running = Boolean(processor?.running);
    const hibernating = Boolean(processor?.hibernating);
    const aiEnabled = cam.aiEnabled !== false;
    const allowedByPolicy = isCameraAllowedByAiEnv(cam);
    const liveActiveSessions = asNumber(liveView?.active_sessions);

    const row = {
      camera: {
        id: cam.id,
        name: cam.name,
        ip: cam.ip,
        online: cam.status === 'ONLINE',
        status: cam.status,
        site: cam.site?.name ?? null,
        area: cam.area?.name ?? null,
        group: cam.group?.name ?? null,
        lastSeenAt: cam.lastSeenAt ?? null,
      },
      participation: {
        aiEnabled,
        allowedByPolicy,
        expectedToRun: settings.enabled && aiEnabled && allowedByPolicy,
        blockedReason: !aiEnabled
          ? 'camera_ai_disabled'
          : !allowedByPolicy
            ? 'filtered_by_ai_env'
            : null,
      },
      profiles: {
        recording: {
          channel: recordingChannel,
          subtype: recordingSubtype,
          codec: cam.recordingVideoCodec ?? null,
          width: cam.recordingWidth ?? cam.detectedWidth ?? null,
          height: cam.recordingHeight ?? cam.detectedHeight ?? null,
          fps: cam.recordingFps ?? cam.detectedFps ?? null,
          mode: cam.recordingMode,
          enabled: Boolean(cam.recordingEnabled),
        },
        live: {
          channel: liveChannel,
          subtype: liveSubtype,
          protocol: cam.preferredLiveProtocol ?? 'webrtc',
          codec: cam.streamVideoCodec ?? cam.detectedVideoCodec ?? null,
          width: cam.streamWidth ?? cam.detectedWidth ?? null,
          height: cam.streamHeight ?? cam.detectedHeight ?? null,
          fps: cam.streamFps ?? cam.detectedFps ?? null,
        },
        analytics: {
          channel: analyticsChannel,
          subtype: analyticsSubtype,
          separatedFromLive: analyticsSeparated,
          expectedSource: 'direct_camera',
          audioExpected: false,
        },
      },
      source: {
        kind: sourceKind,
        usesMediaMtx,
        directCamera: sourceKind === 'direct_camera' && !usesMediaMtx,
        audioRequested: asBool(source?.audioRequested ?? source?.audio_requested),
        analyticsRtspUrl: asString(source?.analyticsSourceUrlSanitized ?? source?.analytics_source_url_sanitized ?? source?.analyticsRtspUrl ?? source?.analytics_rtsp_url),
        codec: streamCodec,
        transcodedForAi: asBool(source?.analyticsTranscodedForAi ?? source?.analytics_transcoded_for_ai),
        fallbackReason: asString(source?.analyticsFallbackReason ?? source?.analytics_fallback_reason),
      },
      runtime: {
        running,
        hibernating,
        analysisType: asString(processor?.analysis_type),
        advancedAnalysisType: asString(processor?.advanced_analysis_type),
        processFpsTarget: asNullableNumber(processor?.process_fps),
        advancedFpsTarget: asNullableNumber(processor?.advanced_process_fps),
        motionTrigger: asString(processor?.motion_trigger),
        lastSeen: processor?.last_seen ?? null,
        lastError: asString(processor?.last_error),
      },
      stream: {
        codec: streamCodec,
        width: asNullableNumber(stream?.width),
        height: asNullableNumber(stream?.height),
        fps: asNullableNumber(stream?.fps),
        captureFps: asNullableNumber(stream?.capture_fps),
        inferenceFps: asNullableNumber(stream?.inference_fps),
        frameAgeLastMs: asNullableNumber(stream?.frame_age_last_ms),
        frameAgeAvgMs: asNullableNumber(stream?.frame_age_avg_ms),
        latestFrameOnly: stream?.latest_frame_only !== false,
        bufferSize: asNumber(stream?.buffer_size, 1),
        queueSize: asNumber(stream?.queue_size),
        droppedFrames: asNumber(stream?.dropped_frames ?? captureFramesDropped),
        captureFramesEnqueued,
        captureFramesDropped,
        captureDropRatio,
      },
      performance: {
        processedFrames: asNumber(performance?.processed_frames),
        processFpsReal: asNullableNumber(performance?.process_fps_real),
        advancedInferRuns: asNumber(performance?.advanced_infer_runs),
        advancedInferErrors: asNumber(performance?.advanced_infer_errors),
        inferLastMs: asNullableNumber(performance?.advanced_infer_last_ms),
        inferAvgMs: asNullableNumber(performance?.advanced_infer_avg_ms),
        inferP95Ms: asNullableNumber(performance?.advanced_infer_p95_ms),
        poolBusyDrops: asNumber(performance?.pool_busy_drops),
        overlayPayloadFrames: asNumber(performance?.overlay_payload_frames),
        overlayEmptyFrames: asNumber(performance?.overlay_empty_frames),
        overlayPayloadRatio: asNullableNumber(performance?.overlay_payload_ratio),
      },
      liveView: {
        activeSessions: liveActiveSessions,
        qosMode: asString(liveView?.qos_mode),
        selectedSessions: asNumber(liveView?.sessions_by_mode?.selected),
        gridSessions: asNumber(liveView?.sessions_by_mode?.grid),
        qosLiveEnabled: asBool(featureFlags?.qos_live_enabled),
        adaptiveEnabledForCamera: asBool(featureFlags?.adaptive_enabled_for_camera),
        cpuPercent: asNullableNumber(adaptiveMetrics?.cpu_percent),
        dropRatio: asNullableNumber(adaptiveMetrics?.drop_ratio),
      },
      health: {
        state: 'unknown',
        severity: 'info',
        label: 'Sem diagnóstico',
      },
      recommendations: [] as Array<{ severity: 'info' | 'warning' | 'critical'; code: string; message: string }>,
    };

    const recommendations = this.cameraRecommendations(row);
    const worst = recommendations.find((item) => item.severity === 'critical')
      ?? recommendations.find((item) => item.severity === 'warning')
      ?? recommendations[0]
      ?? null;
    row.recommendations = recommendations;
    row.health = this.cameraHealth(row, worst);
    return row;
  }

  private cameraRecommendations(row: any) {
    const items: Array<{ severity: 'info' | 'warning' | 'critical'; code: string; message: string }> = [];
    if (!row.camera.online) {
      items.push({ severity: 'critical', code: 'camera_offline', message: 'Câmera offline; a IA não consegue capturar frames.' });
      return items;
    }
    if (!row.participation.aiEnabled) {
      items.push({ severity: 'info', code: 'camera_disabled', message: 'IA desativada nesta câmera.' });
      return items;
    }
    if (!row.participation.allowedByPolicy) {
      items.push({ severity: 'info', code: 'filtered_by_env', message: 'Câmera fora do filtro operacional de IA deste servidor.' });
      return items;
    }
    if (row.participation.expectedToRun && !row.runtime.running) {
      items.push({ severity: 'critical', code: 'processor_not_running', message: 'Câmera deveria estar em análise, mas não há processador ativo.' });
    }
    if (row.runtime.lastError) {
      items.push({ severity: 'critical', code: 'processor_error', message: `Erro no processador: ${row.runtime.lastError}` });
    }
    if (!row.profiles.analytics.separatedFromLive) {
      items.push({ severity: 'warning', code: 'analytics_not_separated', message: 'Analytics usa o mesmo perfil da live; prefira substream leve dedicado.' });
    }
    if (row.source.usesMediaMtx) {
      items.push({ severity: 'warning', code: 'analytics_via_mediamtx', message: 'IA está usando MediaMTX como fallback; ideal é RTSP direto da câmera.' });
    }
    if (row.source.audioRequested) {
      items.push({ severity: 'warning', code: 'audio_requested', message: 'IA recebeu solicitação de áudio; analytics deve ser vídeo sem áudio.' });
    }
    if (isHevcCodec(row.source.codec)) {
      items.push({ severity: 'warning', code: 'analytics_hevc', message: 'Stream de analytics em HEVC; H.264 no substream costuma reduzir travamentos de captura.' });
    }
    if (Number.isFinite(row.stream.captureFps) && row.stream.captureFps !== null && row.stream.captureFps < 0.8 && row.runtime.running) {
      items.push({ severity: 'warning', code: 'low_capture_fps', message: 'FPS real de captura baixo; verificar substream, codec ou rede da câmera.' });
    }
    if (Number.isFinite(row.stream.frameAgeAvgMs) && row.stream.frameAgeAvgMs !== null && row.stream.frameAgeAvgMs > 900) {
      items.push({ severity: 'warning', code: 'high_frame_age', message: 'Frames chegam envelhecidos; latest-frame-only pode estar descartando demais ou a captura está lenta.' });
    }
    if (row.performance.poolBusyDrops > 0) {
      items.push({ severity: 'warning', code: 'pool_busy', message: 'Pool de inferência ocupou totalmente em algum momento; reduzir FPS ou revisar threads se crescer.' });
    }
    if (row.performance.advancedInferErrors > 0) {
      items.push({ severity: 'critical', code: 'infer_errors', message: 'Há erros de inferência avançada nesta câmera.' });
    }
    if (!items.length) {
      items.push({ severity: 'info', code: 'healthy', message: 'Pipeline de IA saudável para a configuração atual.' });
    }
    return items;
  }

  private cameraHealth(row: any, worst: { severity: 'info' | 'warning' | 'critical'; code: string; message: string } | null) {
    if (!row.participation.aiEnabled || !row.participation.allowedByPolicy) {
      return { state: 'disabled', severity: 'info', label: 'Fora da IA' };
    }
    if (!row.camera.online) {
      return { state: 'offline', severity: 'critical', label: 'Câmera offline' };
    }
    if (!row.runtime.running) {
      return { state: 'stopped', severity: 'critical', label: 'IA parada' };
    }
    if (worst?.severity === 'critical') {
      return { state: worst.code, severity: 'critical', label: 'Falha na IA' };
    }
    if (worst?.severity === 'warning') {
      return { state: worst.code, severity: 'warning', label: 'Atenção' };
    }
    if (row.runtime.hibernating) {
      return { state: 'hibernating', severity: 'info', label: 'Hibernando' };
    }
    return { state: 'healthy', severity: 'info', label: 'Saudável' };
  }

  private globalRecommendations(input: {
    status: string;
    settings: any;
    serviceOnline: boolean;
    commercialAllowed: boolean;
    cameraRows: any[];
  }) {
    const items: Array<{ severity: 'info' | 'warning' | 'critical'; code: string; message: string }> = [];
    if (!input.commercialAllowed) {
      items.push({ severity: 'critical', code: 'commercial_restricted', message: 'Recurso de IA bloqueado pela política comercial.' });
    }
    if (!input.settings.enabled) {
      items.push({ severity: 'info', code: 'global_disabled', message: 'IA global desligada; live, gravação e reprodução continuam independentes.' });
    }
    if (input.settings.enabled && !input.serviceOnline) {
      items.push({ severity: 'critical', code: 'ai_service_offline', message: 'Serviço Python de IA não respondeu ao health check.' });
    }
    const expected = input.cameraRows.filter((camera) => camera.participation.expectedToRun);
    const missing = expected.filter((camera) => !camera.runtime.running);
    if (missing.length) {
      items.push({ severity: 'critical', code: 'missing_processors', message: `${missing.length} câmera(s) deveriam estar em análise, mas não têm processador ativo.` });
    }
    const mediaMtx = input.cameraRows.filter((camera) => camera.runtime.running && camera.source.usesMediaMtx);
    if (mediaMtx.length) {
      items.push({ severity: 'warning', code: 'mediamtx_fallback', message: `${mediaMtx.length} câmera(s) usando fallback via MediaMTX para analytics.` });
    }
    const busyDrops = input.cameraRows.reduce((sum, camera) => sum + camera.performance.poolBusyDrops, 0);
    if (busyDrops > 0) {
      items.push({ severity: 'warning', code: 'pool_busy_drops', message: `Pool de inferência registrou ${busyDrops} drop(s); observar antes de aumentar FPS/modelo.` });
    }
    if (!items.length) {
      items.push({ severity: 'info', code: 'ready', message: 'IA operacional, separada da live e sem gargalos críticos no momento.' });
    }
    return items;
  }

  private modelState(health: any, mode: string) {
    const staticProfiles = health?.static_profiles ?? {};
    const selectedProfile = staticProfiles?.[mode] ?? staticProfiles?.general ?? {};
    const registry = health?.model_registry ?? {};
    const detectors = registry?.detectors && typeof registry.detectors === 'object' ? registry.detectors : {};
    const detectorRows = Object.entries(detectors).map(([name, value]: [string, any]) => ({
      name,
      model: asString(value?.model),
      runtime: asString(value?.runtime ?? selectedProfile?.runtime),
      requestedPrecision: asString(value?.requested_precision),
      activePrecision: asString(value?.active_precision),
      inputSizes: Array.isArray(value?.available_input_sizes) ? value.available_input_sizes : [],
      selectedInputSize: asNullableNumber(value?.last_selected_input_size),
      poolBusyDrops: asNumber(value?.pool_busy_drops),
      inferenceThreads: asNullableNumber(value?.inference_threads),
      workers: asNullableNumber(value?.infer_workers),
      classes: Array.isArray(value?.active_class_ids) ? value.active_class_ids : selectedProfile?.class_ids ?? [],
      loadedModelPath: asString(value?.loaded_model_path),
      openvinoDevice: asString(value?.openvino_device),
      performanceHint: asString(value?.openvino_performance_hint),
    }));
    return {
      mode,
      profile: {
        model: selectedProfile?.model ?? (mode === 'motion' ? 'motion' : null),
        runtime: selectedProfile?.runtime ?? null,
        precision: selectedProfile?.precision ?? null,
        analysisWidth: selectedProfile?.analysis_width ?? null,
        analysisHeight: selectedProfile?.analysis_height ?? null,
        imgsz: selectedProfile?.imgsz ?? selectedProfile?.detector_size ?? null,
        detectionFps: selectedProfile?.detection_fps ?? null,
        classes: Array.isArray(selectedProfile?.classes) ? selectedProfile.classes : [],
        classIds: Array.isArray(selectedProfile?.class_ids) ? selectedProfile.class_ids : [],
        tracker: selectedProfile?.tracker ?? null,
        overlayMode: selectedProfile?.overlay_mode ?? null,
        overlayTtlMs: selectedProfile?.overlay_ttl_ms ?? null,
        lostTtlMs: selectedProfile?.lost_ttl_ms ?? null,
      },
      registry: {
        status: registry?.status ?? null,
        lastError: registry?.lastError ?? null,
        detectors: detectorRows,
      },
      threading: health?.inference_threading ?? null,
    };
  }

  private runtimePolicy() {
    return {
      autoStart: String(process.env.AI_AUTO_START_ENABLED ?? 'true') !== 'false',
      forceSingleCamera: ['1', 'true', 'yes', 'on'].includes(String(process.env.AI_FORCE_SINGLE_CAMERA ?? 'false').toLowerCase()),
      singleCameraId: asString(process.env.AI_SINGLE_CAMERA_ID),
      enabledCameraIds: parseCsvEnv(process.env.AI_ENABLED_CAMERA_IDS),
      activeCameraIds: parseCsvEnv(process.env.AI_ACTIVE_CAMERA_IDS),
      analyticsCameraIds: parseCsvEnv(process.env.AI_ANALYTICS_CAMERA_IDS),
      rtspStreamProfile: asString(process.env.AI_RTSP_STREAM_PROFILE) ?? 'analytics',
      rtspSubtype: asString(process.env.AI_RTSP_SUBTYPE) ?? 'auto',
      analyticsSource: asString(process.env.AI_ANALYTICS_SOURCE) ?? 'direct_camera',
      latestFrameOnly: String(process.env.AI_LATEST_FRAME_ONLY ?? 'true') !== 'false',
      hevcFallbackEnabled: String(process.env.AI_ANALYTICS_HEVC_FALLBACK ?? 'true').toLowerCase() !== 'false',
      cpuReservePercent: asNullableNumber(process.env.AI_CPU_RESERVE_PERCENT),
      inferenceThreadsOverride: asNullableNumber(process.env.AI_INFERENCE_THREADS_OVERRIDE),
      inferenceWorkerCount: asNullableNumber(process.env.AI_INFERENCE_WORKER_COUNT),
      frontendOverlayMaxAgeMs: asNullableNumber(process.env.FRONTEND_OVERLAY_MAX_AGE_MS),
    };
  }

  private modeLabel(mode: string) {
    if (mode === 'general') return 'Pessoa e veículos';
    if (mode === 'face') return 'Rosto';
    return 'Movimento';
  }

  /**
   * Corrida com prazo: usada para trabalho OPCIONAL (otimização) que nunca pode
   * segurar um caminho essencial. Rejeita ao estourar; o chamador decide o
   * fallback. Não cancela a promessa original (não dá, em JS) — apenas para de
   * esperar por ela.
   */
  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), Math.max(250, ms));
      if (typeof timer.unref === 'function') timer.unref();
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); },
      );
    });
  }

  private async buildAiSource(cam: any): Promise<{ rtspUrl: string; info: Record<string, unknown> }> {
    const password = this.cryptoService.decrypt(cam.passwordEncrypted);
    const rawSubtype = String(process.env.AI_RTSP_SUBTYPE ?? '').trim().toLowerCase();
    const configuredSubtype = rawSubtype === '' || rawSubtype === 'auto'
      ? Number.NaN
      : Number(rawSubtype);
    const analyticsProfile = resolveAnalyticsRtspProfile(cam);
    const liveProfile = resolveLiveRtspProfile(cam);
    const recordingProfile = resolveRecordingRtspProfile(cam);
    const subtype = Number.isFinite(configuredSubtype) && configuredSubtype >= 0
      ? configuredSubtype
      : analyticsProfile.subtype;
    const channel = analyticsProfile.channel;

    const rtspUrl = buildRtspUrl({
      username: cam.username,
      password,
      ip: cam.ip,
      rtspPort: cam.rtspPort || 554,
      rtspPath: cam.rtspPath,
      channel,
      subtype,
    });
    const sourceUrlSanitized = sanitizeRtspUrl(rtspUrl);
    const infoBase = {
      recordSubtype: recordingProfile.subtype,
      recordChannel: recordingProfile.channel,
      liveSubtype: liveProfile.subtype,
      liveChannel: liveProfile.channel,
      analyticsSubtype: subtype,
      analyticsChannel: channel,
      configuredAnalyticsSubtype: cam.analyticsSubtype ?? null,
      configuredAnalyticsChannel: cam.analyticsChannel ?? null,
      // Zonas de detecção (polígonos normalizados) seguem para o ai-service, que
      // as converte em máscara na resolução de análise. Ver detectors/motion.py.
      detectionZones: Array.isArray(cam.detectionZones) ? cam.detectionZones : [],
    };

    const rtspTransport = cam.preferredRtspTransport || process.env.FFMPEG_RTSP_TRANSPORT || 'tcp';
    const analyticsCodec = await this.mediamtxProxy.probeStreamVideoCodec(rtspUrl, rtspTransport).catch(() => null);
    const analyticsIsHevc = isHevcCodec(analyticsCodec);
    const hevcFallbackEnabled = String(process.env.AI_ANALYTICS_HEVC_FALLBACK ?? 'true').toLowerCase() !== 'false';

    if (analyticsIsHevc && hevcFallbackEnabled) {
      const fallback = await this.mediamtxProxy.ensurePathForCamera(cam.id, 'grid');
      const fallbackRtspUrl = this.mediamtxProxy.buildInternalRtspUrl(fallback.pathName);
      if (fallbackRtspUrl) {
        const fallbackRtspUrlSanitized = sanitizeRtspUrl(fallbackRtspUrl);
        this.logger.warn(`IA analytics de ${cam.name} esta em HEVC (${analyticsCodec}); usando path H.264 reduzido do MediaMTX: ${fallback.pathName}`);
        return {
          rtspUrl: fallbackRtspUrl,
          info: {
            ...infoBase,
            sourceKind: 'mediamtx_delivery_h264_fallback',
            usesMediaMtx: true,
            audioRequested: false,
            // Nunca expõe a credencial administrativa no health/overview da IA.
            analyticsRtspUrl: fallbackRtspUrlSanitized,
            analyticsSourceUrlSanitized: sourceUrlSanitized,
            analyticsOriginalRtspUrl: sourceUrlSanitized,
            analyticsSourceCodec: analyticsCodec,
            analyticsTranscodedForAi: Boolean(fallback.transcodedForLive),
            analyticsMediaMtxPath: fallback.pathName,
            analyticsFallbackReason: 'hevc_direct_capture_unstable',
          },
        };
      }
    }

    // Source Gateway (flag CAMERA_SOURCE_GATEWAY_ENABLED, default OFF): quando
    // ligado E já existe origem republicada, a IA lê do MediaMTX em vez de abrir
    // MAIS uma conexão na câmera. É o consumidor mais seguro para migrar primeiro:
    // a IA só precisa de QUADROS (não do bitstream original, como a gravação), e o
    // fail-safe da IA já trata fonte indisponível gravando assim mesmo.
    // Com a flag OFF, resolveSourceUrl devolve `rtspUrl` sem tocar em nada.
    // GARANTE a origem antes de perguntar. Sem isto havia uma corrida de ordem: se
    // ninguém tivesse aberto o live daquela câmera ainda, não existia origem
    // publicada, o gateway caía no fallback direto e a economia de conexão NUNCA
    // acontecia (medido em produção: 0 reroteamentos). É o mesmo mecanismo que o
    // fallback de HEVC logo acima já usa há tempos — a diferença é que agora vale
    // para toda câmera, não só as HEVC. Best-effort: falhar aqui só significa
    // seguir no direto, que é o comportamento de antes.
    // ⚠️ COM TIMEOUT, obrigatoriamente. `ensurePathForCamera` compartilha uma
    // promessa em voo por (câmera, modo): se essa promessa travar (MediaMTX lento
    // ou fora), TODO chamador seguinte fica pendurado nela para sempre — e um
    // `.catch()` não salva, porque nada é rejeitado, apenas nunca resolve.
    // Aconteceu em produção: a análise da câmera não voltava, sem erro nenhum no
    // log, e a detecção de movimento (que arma a gravação) ficou fora do ar.
    // O gateway é otimização; ele JAMAIS pode atrasar ou impedir a subida da IA.
    const ensured = await this.withTimeout(
      this.mediamtxProxy.ensurePathForCamera(cam.id, 'grid'),
      envNumber('AI_SOURCE_GATEWAY_ENSURE_TIMEOUT_MS', 4000),
    ).catch(() => null);
    const gatewayDecision = ensured?.pathName
      ? this.sourceGateway?.resolveSourceUrl({
        cameraId: cam.id,
        profile: 'sub',
        consumer: 'ai',
        directUrl: rtspUrl,
        internalUrl: this.mediamtxProxy.buildInternalRtspUrl(ensured.pathName),
      })
      : undefined;
    if (gatewayDecision && gatewayDecision.url !== rtspUrl) {
      const gatewayUrlSanitized = sanitizeRtspUrl(gatewayDecision.url);
      this.logger.log(`IA roteada pelo Source Gateway para a origem interna de ${cam.name}: ${gatewayUrlSanitized}`);
      return {
        rtspUrl: gatewayDecision.url,
        info: {
          ...infoBase,
          sourceKind: 'source_gateway_internal',
          usesMediaMtx: true,
          audioRequested: false,
          analyticsRtspUrl: gatewayUrlSanitized,
          analyticsSourceUrlSanitized: sourceUrlSanitized,
          analyticsOriginalRtspUrl: sourceUrlSanitized,
          analyticsSourceCodec: analyticsCodec,
          analyticsTranscodedForAi: false,
          analyticsGatewayReason: gatewayDecision.reason,
        },
      };
    }

    this.logger.debug(`IA usando RTSP direto analytics para ${cam.name}: ${sourceUrlSanitized}${analyticsCodec ? ` codec=${analyticsCodec}` : ''}`);
    return {
      rtspUrl,
      info: {
        ...infoBase,
        sourceKind: 'direct_camera',
        usesMediaMtx: false,
        audioRequested: false,
        analyticsRtspUrl: sourceUrlSanitized,
        analyticsSourceUrlSanitized: sourceUrlSanitized,
        analyticsSourceCodec: analyticsCodec,
        analyticsTranscodedForAi: false,
      },
    };
  }

}
