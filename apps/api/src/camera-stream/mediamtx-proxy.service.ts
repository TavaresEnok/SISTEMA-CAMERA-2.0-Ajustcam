import { BadRequestException, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Request } from 'express';
import { CamerasService } from '../cameras/cameras.service';
import {
  buildRtspUrl,
  isHevcCodec,
  resolveGridRtspProfile,
  resolveLiveRtspProfile,
} from '../cameras/helpers/rtsp-url.helper';
import { CryptoService } from '../common/crypto/crypto.service';
import { SettingsService } from '../settings/settings.service';
import { sanitizeSensitiveText } from '../common/security/sensitive-text.helper';
import { spawnWithSecretUrl } from '../common/process/secret-url-process.helper';
// Métricas por câmera: singleton de módulo (sem DI, para não mexer no construtor
// deste serviço) e sempre em try/catch — observabilidade não derruba stream.
import { cameraMetrics } from '../observability/camera-metrics.service';
import {
  GRID_LIVE_MAX_HEIGHT,
  GRID_LIVE_MAX_WIDTH,
  GRID_LIVE_TARGET_FPS,
  type LiveViewMode,
} from './helpers/live-delivery-profile.helper';
import { liveViewModeToSourceProfile } from './helpers/source-profile.helper';
import { SourceGatewayService } from './source-gateway.service';

type DeliveryUrls = {
  enabled: boolean;
  pathName: string | null;
  sourceUrl: string | null;
  webrtcUrl: string | null;
  whepUrl: string | null;
  hlsUrl: string | null;
  rtspProxyUrl: string | null;
};

type EnsuredCameraPath = {
  pathName: string | null;
  sourceUrl: string | null;
  sourceVideoCodec: string | null;
  transcodedForLive: boolean;
  liveProfile: { channel: number; subtype: number } | null;
  deliveryMode: LiveViewMode;
};

@Injectable()
export class MediamtxProxyService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MediamtxProxyService.name);
  private readonly liveCodecCache = new Map<string, { isHevc: boolean; at: number }>();
  private readonly liveSourceCache = new Map<string, { url: string; codec: string | null; width: number | null; height: number | null; at: number }>();
  // Cache da decisão da fonte da GRADE por câmera: URL escolhida + codec do sub
  // (url null = sem sub, usa o main). Evita ffprobe a cada (re)configuração.
  private readonly gridSourceCache = new Map<string, {
    url: string | null;
    codec: string | null;
    requiresSanitization: boolean;
    at: number;
  }>();
  private readonly pathEnsureInFlight = new Map<string, Promise<EnsuredCameraPath>>();
  private readonly pathEnsureCache = new Map<string, { value: EnsuredCameraPath; at: number }>();
  private static readonly LIVE_CODEC_TTL_MS = 30 * 60 * 1000;
  private static readonly PATH_ENSURE_TTL_MS = 30 * 1000;

  // Watchdog de stream: vigia paths de câmera com espectador mas SEM progresso de
  // vídeo (fonte congelada/ausente) e força reset. 3ª camada de segurança, além do
  // prekill no runOnDemand e do reaper de zumbis (tini). Conservador: só age após
  // ~60s de estagnação (bem além do cold start de ~15s), para nunca tocar em stream
  // saudável nem em cold start normal.
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private readonly watchdogState = new Map<string, { lastBytes: number; badTicks: number }>();
  private static readonly WATCHDOG_INTERVAL_MS = 20_000;
  private static readonly WATCHDOG_BAD_TICKS = 3; // 3 × 20s = ~60s antes de agir
  private readonly recoveringPaths = new Set<string>();

  // ── FREIO ANTI-TEMPESTADE ──────────────────────────────────────────────────
  // Técnica derivada do Frigate (MIT) — Copyright (c) Frigate, Inc.
  // (frigate/watchdog.py: MAX_RESTARTS / RESTART_WINDOW_S + is_restarting_too_fast).
  //
  // Sem ele, câmera MORTA (fonte offline, link caído, obra na rua) = ciclo eterno:
  // a cada ~80s o watchdog apaga e recria o path, roda ffprobe e sobe FFmpeg de
  // novo — CPU queimada 24/7 por uma fonte que não vai voltar sozinha, e log
  // inundado justamente quando alguém precisa ler o log.
  //
  // Diferença deliberada do Frigate: aqui o freio só arma quando a recuperação é
  // FÚTIL. Se o path volta a progredir (bytes crescendo com espectador), a janela
  // é ZERADA em clearRecoveryBrake — câmera que realmente se recupera nunca é
  // freada. Falso positivo que deixa câmera boa sem live é pior que o sintoma.
  //
  // Sob freio o watchdog NÃO desiste: espera o resfriamento (crescente) e volta a
  // tentar. Nada é apagado, nada é desabilitado — só espaçamos as tentativas.
  private static readonly BRAKE_MAX_RECOVERIES = 5;
  private static readonly BRAKE_WINDOW_MS = 10 * 60_000;
  private static readonly BRAKE_BASE_COOLDOWN_MS = 2 * 60_000;
  private static readonly BRAKE_MAX_COOLDOWN_MS = 30 * 60_000;
  private readonly recoveryBrake = new Map<string, { attempts: number[]; cooldownUntil: number; level: number }>();

  constructor(
    private readonly configService: ConfigService,
    private readonly camerasService: CamerasService,
    private readonly cryptoService: CryptoService,
    private readonly settingsService: SettingsService,
    // Opcional de propósito: o gateway é uma camada nova e DESLIGADA por default.
    // Sendo opcional, este serviço continua instanciável (inclusive nos testes que
    // o constroem à mão) sem conhecer o gateway.
    @Optional() private readonly sourceGateway?: SourceGatewayService,
  ) {}

  onApplicationBootstrap() {
    if (!this.isEnabled()) return;

    this.assertStrongApiCredentials();

    if (this.configService.get<boolean>('mediaMtxWarmPathsOnBoot') !== false) {
      void this.warmCameraPaths();
    }

    // O watchdog é independente do warm-on-boot: queremos a vigilância sempre que
    // o MediaMTX está habilitado.
    if (this.configService.get<boolean>('mediaMtxWatchdogEnabled') !== false) {
      this.watchdogTimer = setInterval(() => {
        void this.streamWatchdogTick();
      }, MediamtxProxyService.WATCHDOG_INTERVAL_MS);
      // unref: o timer não deve impedir o processo de encerrar.
      this.watchdogTimer.unref?.();
      this.logger.log('Watchdog de stream ativo (intervalo 20s, reset após ~60s de estagnação).');
    }
  }

  onModuleDestroy() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  /**
   * Um ciclo do watchdog: lê o estado em runtime de todos os paths e, para cada
   * path de câmera COM espectador mas sem progresso de bytes (fonte congelada) ou
   * sem fonte pronta, conta "ticks ruins". Após WATCHDOG_BAD_TICKS seguidos, força
   * o reset daquele path (DELETE + recriação), que sobe um restream novo e limpo.
   */
  /**
   * O MediaMTX guarda os paths criados por API apenas em memória: se o container
   * for recriado (upgrade de imagem, `compose up` que reavalia o serviço, OOM),
   * ele volta VAZIO — e o `pathEnsureCache` daqui continua achando que os paths
   * existem, então nada os recria. Resultado observado em produção 2026-07-21:
   * MediaMTX recriado às 21:19 → paths sumiram → live morto para TODAS as câmeras
   * até alguém reiniciar a API (o warm-on-boot era a única cura).
   *
   * Aqui o watchdog reconcilia sozinho: se o MediaMTX tem MUITO menos paths do que
   * as câmeras habilitadas exigem, limpa o cache e re-aquece. Barato (1 request por
   * tick) e cobre o modo de falha real.
   */
  private async reconcileMissingPaths(activePathNames: Set<string>) {
    try {
      const cameras = await this.camerasService.findAllInternal();
      const expected = cameras.filter((cam: any) => cam.enabled !== false);
      if (!expected.length) return;

      const missing = expected.filter((cam: any) => !activePathNames.has(this.pathNameFromCameraId(cam.id, 'grid')));
      // Tolerância: só age quando a maioria sumiu (assinatura de MediaMTX zerado).
      // Uma câmera isolada sem path é normal (on-demand/erro pontual) e já é
      // tratada pelo fluxo de ensurePathForCamera quando alguém abre a câmera.
      if (missing.length < Math.max(2, Math.ceil(expected.length * 0.5))) return;

      this.logger.warn(
        `MediaMTX está sem ${missing.length}/${expected.length} paths de grade (provável recriação do container). Re-aquecendo...`,
      );
      this.pathEnsureCache.clear();
      await this.warmCameraPaths();
    } catch (error) {
      this.logger.warn(`Falha ao reconciliar paths do MediaMTX: ${(error as Error).message}`);
    }
  }

  private async streamWatchdogTick() {
    let items: any[] = [];
    try {
      const text = await this.apiRequest('GET', '/v3/paths/list?itemsPerPage=1000');
      const data = JSON.parse(text);
      items = Array.isArray(data?.items) ? data.items : [];
    } catch {
      return; // MediaMTX indisponível neste tick; tenta no próximo.
    }

    await this.reconcileMissingPaths(new Set(items.map((item: any) => String(item?.name ?? ''))));

    const seen = new Set<string>();
    const stuck: Array<{ name: string; ready: boolean; readers: number }> = [];
    for (const item of items) {
      const name: string = item?.name ?? '';
      if (!name.startsWith('cam_')) continue;
      seen.add(name);

      const ready = Boolean(item?.ready);
      const readers = Array.isArray(item?.readers) ? item.readers.length : Number(item?.readers ?? 0);
      const bytes = Number(item?.bytesReceived ?? 0);

      // Sem espectador → nada a vigiar (cold close é normal).
      if (readers <= 0) {
        this.watchdogState.delete(name);
        continue;
      }

      const prev = this.watchdogState.get(name) ?? { lastBytes: -1, badTicks: 0 };
      // "Ruim" = sem fonte pronta, OU pronto porém sem bytes novos desde o último
      // tick (fonte congelada). A primeira observação nunca conta como ruim.
      const noProgress = prev.lastBytes < 0 ? false : ready ? bytes <= prev.lastBytes : true;
      const badTicks = noProgress ? prev.badTicks + 1 : 0;
      this.watchdogState.set(name, { lastBytes: bytes, badTicks });

      // PROVA de saúde (bytes novos com fonte pronta): a recuperação anterior
      // funcionou de verdade, então a janela do freio é zerada. Sem isto, uma
      // câmera intermitente porém CURÁVEL acabaria freada por acumular resets.
      if (prev.lastBytes >= 0 && ready && bytes > prev.lastBytes) {
        this.clearRecoveryBrake(name);
      }

      if (badTicks >= MediamtxProxyService.WATCHDOG_BAD_TICKS) {
        this.watchdogState.delete(name);
        stuck.push({ name, ready, readers });
      }
    }

    // Recupera os paths travados em PARALELO (limite interno), não um a um.
    await this.recoverStuckPaths(stuck);

    // Limpa estado de paths que não existem mais.
    for (const key of [...this.watchdogState.keys()]) {
      if (!seen.has(key)) this.watchdogState.delete(key);
    }
    // Idem para o freio: path que sumiu do MediaMTX não pode deixar estado para
    // trás (a API roda meses sem reiniciar — Map sem poda é vazamento).
    for (const key of [...this.recoveryBrake.keys()]) {
      if (!seen.has(key)) this.recoveryBrake.delete(key);
    }
  }

  /** Relógio do freio — costura de teste (produção usa o relógio do sistema). */
  private nowMs(): number {
    return Date.now();
  }

  /**
   * true → este path está em RESFRIAMENTO: não tentar recuperar agora.
   * Ao vencer o resfriamento, libera com a janela limpa (mas guarda o NÍVEL: se
   * a fonte continuar morta, o próximo freio é mais longo).
   */
  private isRecoveryBraked(pathName: string): boolean {
    const entry = this.recoveryBrake.get(pathName);
    if (!entry || entry.cooldownUntil <= 0) return false;
    const now = this.nowMs();
    if (now < entry.cooldownUntil) return true;
    entry.cooldownUntil = 0;
    entry.attempts.length = 0;
    this.logger.warn(`Watchdog: resfriamento de ${pathName} terminou — voltando a tentar recuperar.`);
    return false;
  }

  /**
   * Registra a tentativa e ARMA o freio quando N recuperações caem na janela.
   * Equivale ao deque(maxlen) + popleft do Frigate: a janela desliza, tentativas
   * antigas não contam.
   */
  private noteRecoveryAttempt(pathName: string, cameraId: string): void {
    const now = this.nowMs();
    const entry = this.recoveryBrake.get(pathName) ?? { attempts: [], cooldownUntil: 0, level: 0 };
    this.recoveryBrake.set(pathName, entry);

    // Janela DESLIZANTE: descarta tentativas mais velhas que a janela antes de
    // contar. Sem isto, uma câmera que cai de vez em quando acumularia tentativas
    // para sempre e acabaria freada — e armar o freio dispara alerta ("a fonte não
    // volta sozinha, manda alguém no local"). Chamado falso destrói a confiança no
    // alerta, então intermitente NÃO pode ser confundida com fonte morta.
    // Equivale ao deque(maxlen)+popleft do Frigate (watchdog.py).
    const janelaInicio = now - MediamtxProxyService.BRAKE_WINDOW_MS;
    entry.attempts = entry.attempts.filter((at) => at > janelaInicio);

    entry.attempts.push(now);
    if (entry.attempts.length < MediamtxProxyService.BRAKE_MAX_RECOVERIES) return;

    entry.level += 1;
    const cooldownMs = Math.min(
      MediamtxProxyService.BRAKE_MAX_COOLDOWN_MS,
      MediamtxProxyService.BRAKE_BASE_COOLDOWN_MS * 2 ** (entry.level - 1),
    );
    entry.cooldownUntil = now + cooldownMs;
    entry.attempts.length = 0;

    this.logger.error(
      `Watchdog: FREIO ANTI-TEMPESTADE em ${pathName} — ${MediamtxProxyService.BRAKE_MAX_RECOVERIES} recuperações ` +
        `em ${Math.round(MediamtxProxyService.BRAKE_WINDOW_MS / 60_000)} min sem a fonte voltar. Pausando novas ` +
        `tentativas por ${Math.round(cooldownMs / 1000)}s (nível ${entry.level}). A câmera provavelmente está ` +
        `offline de verdade: verifique link/energia no local. Gravação e demais câmeras seguem intactas.`,
    );
    try {
      cameraMetrics.recordStreamRecoveryBrake(cameraId);
    } catch { /* observabilidade nunca interrompe o watchdog */ }
  }

  /** Path provado saudável (ou inexistente): zera janela E escalonamento. */
  private clearRecoveryBrake(pathName: string): void {
    this.recoveryBrake.delete(pathName);
  }

  private async recoverStuckPaths(stuck: Array<{ name: string; ready: boolean; readers: number }>) {
    // Recupera em PARALELO com limite (antes: serial, uma de cada vez). Uma fleet
    // inteira travada reconstitui em ~max(tempo de 1 recuperação) × ceil(N/limite),
    // não na SOMA das recuperações. O limite evita uma tempestade de reconfigurações.
    const CONCURRENCY = 4;
    for (let i = 0; i < stuck.length; i += CONCURRENCY) {
      await Promise.all(
        stuck.slice(i, i + CONCURRENCY).map((s) => this.recoverStuckPath(s.name, s.ready, s.readers)),
      );
    }
  }

  private async recoverStuckPath(pathName: string, ready: boolean, readers: number) {
    const parsed = this.cameraIdFromPathName(pathName);
    if (!parsed) return;
    // Guard POR-PATH: evita recuperar o MESMO path duas vezes em paralelo (entre
    // ticks). Paths DIFERENTES recuperam concorrentemente (ver recoverStuckPaths).
    if (this.recoveringPaths.has(pathName)) return;
    // Freio anti-tempestade: em resfriamento, nem tenta (o log do freio já
    // explicou o porquê; aqui seria só ruído a cada tick).
    if (this.isRecoveryBraked(pathName)) {
      this.logger.debug?.(`Watchdog: ${pathName} em resfriamento do freio anti-tempestade — pulando.`);
      return;
    }
    this.noteRecoveryAttempt(pathName, parsed.cameraId);
    this.recoveringPaths.add(pathName);
    this.logger.warn(
      `Watchdog: path travado ${pathName} (ready=${ready}, readers=${readers}, sem progresso) — forçando reset.`,
    );
    try {
      this.invalidateMainCodecCache(parsed.cameraId);
      const encoded = encodeURIComponent(pathName);
      await this.apiRequest('DELETE', `/v3/config/paths/delete/${encoded}`).catch(() => undefined);
      await this.ensurePathForCamera(parsed.cameraId, parsed.deliveryMode);
      this.logger.log(`Watchdog: path ${pathName} reconfigurado com sucesso.`);
      // Métrica (aditiva): só conta recuperação que DEU CERTO — o caminho de
      // falha cai no catch abaixo e não infla o contador.
      try {
        cameraMetrics.recordStreamRecovery(parsed.cameraId);
      } catch { /* observabilidade nunca interrompe a recuperação */ }
    } catch (error) {
      this.logger.error(
        `Watchdog: falha ao recuperar ${pathName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.recoveringPaths.delete(pathName);
    }
  }

  /** Inverte pathNameFromCameraId: `cam_<32hex>[_grid|_orig]` → { cameraId(UUID), mode }. */
  private cameraIdFromPathName(pathName: string): { cameraId: string; deliveryMode: LiveViewMode } | null {
    const match = pathName.match(/^cam_([0-9a-fA-F]{32})(_grid|_orig)?$/);
    if (!match) return null;
    const h = match[1];
    const cameraId = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    return { cameraId, deliveryMode: match[2] === '_grid' ? 'grid' : match[2] === '_orig' ? 'original' : 'selected' };
  }

  /**
   * MEDIAMTX_API_PASS era o ÚNICO segredo sem validação de força (JWT_SECRET,
   * CAMERA_SECRET_KEY e INTERNAL_SERVICE_TOKEN já falham no boot com valor default/curto).
   * Como o .env.example traz `change_me_mediamtx_pass` e o compose só exige que a var
   * exista, uma instalação que copiasse o exemplo subia com credencial pública conhecida —
   * e essa credencial libera read/publish em QUALQUER câmera no MediaMTX.
   */
  private assertStrongApiCredentials() {
    const user = (this.configService.get<string>('mediaMtxApiUser') ?? '').trim();
    const pass = (this.configService.get<string>('mediaMtxApiPass') ?? '').trim();
    const callbackToken = (
      this.configService.get<string>('mediaMtxAuthCallbackToken') ?? ''
    ).trim();
    // O USUÁRIO não é segredo: basta existir e não ser o valor de exemplo (não exigir
    // tamanho — nomes curtos como "nexusguard" são legítimos). A SENHA é o segredo.
    if (!user || user.startsWith('change_me')) {
      throw new Error('MEDIAMTX_API_USER inválido. Defina um usuário e não use o valor de exemplo (change_me_*).');
    }
    if (!pass || pass.startsWith('change_me') || pass.length < 24) {
      throw new Error(
        'MEDIAMTX_API_PASS inválida. Defina um segredo forte (>= 24 chars) e não use o valor de exemplo (change_me_*).',
      );
    }
    if (
      !/^[a-f0-9]{48,128}$/i.test(callbackToken)
      || callbackToken.startsWith('change_me')
    ) {
      throw new Error(
        'MEDIAMTX_AUTH_CALLBACK_TOKEN inválido. Defina um token hexadecimal dedicado com pelo menos 24 bytes.',
      );
    }
  }

  isEnabled() {
    return this.configService.get<boolean>('mediaMtxEnabled') !== false;
  }

  private sanitizeRtspUrl(url: string) {
    return sanitizeSensitiveText(url);
  }

  private buildInternalPublishRtspUrl(pathName = '$MTX_PATH') {
    return `rtsp://127.0.0.1:$RTSP_PORT/${pathName}`;
  }

  private shellQuote(value: string) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }

  // Público para o Source Gateway: consumidores precisam saber o NOME do path
  // interno daquela câmera/perfil para pedir a URL republicada. Só leitura — a
  // função é pura (deriva o nome do id), não cria nem altera path nenhum.
  /**
   * O container que executa o FFmpeg do publisher tem NVENC?
   *
   * `GPU_TRANSCODE_AVAILABLE=true` é setado quando o stack sobe com a imagem
   * `mediamtx-nvenc`. Sem esse sinal assumimos CPU — falso negativo custa
   * desempenho; falso positivo custa a LIVE, então erramos para o lado seguro.
   */
  private transcodePipelineHasNvenc(): boolean {
    const raw = this.configService.get<string>('gpuTranscodeAvailable') ?? process.env.GPU_TRANSCODE_AVAILABLE ?? '';
    return String(raw).trim().toLowerCase() === 'true';
  }

  pathNameFromCameraId(cameraId: string, deliveryMode: LiveViewMode = 'selected') {
    const base = `cam_${cameraId.replace(/[^a-zA-Z0-9]/g, '')}`;
    // 'original' tem path PRÓPRIO (_orig): se compartilhasse o base com 'selected',
    // dois espectadores em modos diferentes ficariam reconfigurando o mesmo path
    // (transcode ↔ passthrough) um por cima do outro.
    if (deliveryMode === 'grid') return `${base}_grid`;
    if (deliveryMode === 'original') return `${base}_orig`;
    return base;
  }

  private privateSourcePathName(pathName: string) {
    return `${pathName}_source`;
  }

  private async ensurePrivateSourcePath(
    pathName: string,
    sourceUrl: string,
    rtspTransport: string,
    sourceOnDemandStartTimeout: string,
    sourceOnDemandCloseAfter: string,
  ) {
    const sourcePathName = this.privateSourcePathName(pathName);
    const encoded = encodeURIComponent(sourcePathName);
    const desired = {
      source: sourceUrl,
      sourceOnDemand: true,
      sourceOnDemandStartTimeout,
      sourceOnDemandCloseAfter,
      rtspTransport,
    };
    try {
      const current: any = await this.getPath(sourcePathName);
      if (
        current.source === desired.source
        && current.sourceOnDemand === true
        && current.rtspTransport === desired.rtspTransport
        && this.sameDuration(
          current.sourceOnDemandStartTimeout,
          desired.sourceOnDemandStartTimeout,
        )
        && this.sameDuration(
          current.sourceOnDemandCloseAfter,
          desired.sourceOnDemandCloseAfter,
        )
      ) {
        return sourcePathName;
      }
    } catch {
      // Ausente: criação abaixo.
    }
    await this.apiRequest(
      'DELETE',
      `/v3/config/paths/delete/${encoded}`,
    ).catch(() => undefined);
    await this.apiRequest('POST', `/v3/config/paths/add/${encoded}`, desired);
    return sourcePathName;
  }

  getPathNameForCamera(cameraId: string, deliveryMode: LiveViewMode = 'selected') {
    return this.pathNameFromCameraId(cameraId, deliveryMode);
  }

  private buildEnsureKey(cameraId: string, deliveryMode: LiveViewMode) {
    return `${cameraId}:${deliveryMode}`;
  }

  invalidateMainCodecCache(cameraId: string) {
    for (const key of this.liveCodecCache.keys()) {
      if (key.startsWith(`${cameraId}:`)) this.liveCodecCache.delete(key);
    }
    for (const key of [...this.gridSourceCache.keys()]) {
      if (key.startsWith(`grid:${cameraId}:`)) this.gridSourceCache.delete(key);
    }
    for (const key of [...this.pathEnsureCache.keys()]) {
      if (key.startsWith(`${cameraId}:`)) this.pathEnsureCache.delete(key);
    }
    for (const key of [...this.pathEnsureInFlight.keys()]) {
      if (key.startsWith(`${cameraId}:`)) this.pathEnsureInFlight.delete(key);
    }
  }

  // Sonda o codec do stream via ffprobe (assíncrono, não bloqueia o event loop).
  // Retorna null se falhar (câmera offline/instável), para o chamador decidir o fallback.
  probeStreamVideoCodec(sourceUrl: string, transport: string): Promise<string | null> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        const proc = spawnWithSecretUrl('ffprobe', [
          '-v', 'error',
          '-rtsp_transport', transport,
          '-i', sourceUrl,
          '-select_streams', 'v:0',
          '-show_entries', 'stream=codec_name',
          '-of', 'default=noprint_wrappers=1:nokey=1',
        ], sourceUrl);
        let stdout = '';
        proc.stdout!.on('data', (chunk) => { stdout += chunk.toString(); });
        const killTimer = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* ignore */ }
          finish(null);
        }, 12000);
        killTimer.unref();
        proc.on('error', () => { clearTimeout(killTimer); finish(null); });
        proc.on('close', (code) => {
          clearTimeout(killTimer);
          const codec = stdout.trim().split('\n')[0].trim().toLowerCase();
          if (code !== 0 || !codec) return finish(null);
          finish(codec);
        });
      } catch {
        finish(null);
      }
    });
  }

  private probeStreamVideoMetadata(
    sourceUrl: string,
    transport: string,
  ): Promise<{
    codec: string | null;
    width: number | null;
    height: number | null;
    hasDataTrack: boolean;
  } | null> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: {
        codec: string | null;
        width: number | null;
        height: number | null;
        hasDataTrack: boolean;
      } | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        const proc = spawnWithSecretUrl('ffprobe', [
          '-v', 'error',
          '-rtsp_transport', transport,
          '-timeout', '5000000',
          '-show_entries', 'stream=codec_name,codec_type,width,height',
          '-of', 'json',
          sourceUrl,
        ], sourceUrl);
        let stdout = '';
        proc.stdout!.on('data', (chunk) => { stdout += chunk.toString(); });
        const killTimer = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* ignore */ }
          finish(null);
        }, 8000);
        killTimer.unref();
        proc.on('error', () => { clearTimeout(killTimer); finish(null); });
        proc.on('close', (code) => {
          clearTimeout(killTimer);
          if (code !== 0) return finish(null);
          try {
            const streams = JSON.parse(stdout)?.streams ?? [];
            const stream = streams.find((item: any) => item?.codec_type === 'video') ?? {};
            finish({
              codec: String(stream.codec_name ?? '').trim().toLowerCase() || null,
              width: Number.isFinite(Number(stream.width)) ? Number(stream.width) : null,
              height: Number.isFinite(Number(stream.height)) ? Number(stream.height) : null,
              hasDataTrack: streams.some((item: any) => item?.codec_type === 'data'),
            });
          } catch {
            finish(null);
          }
        });
      } catch {
        finish(null);
      }
    });
  }

  private async probeStreamIsHevc(sourceUrl: string, transport: string): Promise<boolean | null> {
    const codec = await this.probeStreamVideoCodec(sourceUrl, transport);
    if (!codec) return null;
    return isHevcCodec(codec);
  }

  // Decide se o stream de Live é H.265 (precisa transcode). Usa cache curto para
  // não sondar a câmera a cada requisição de URLs. Em falha de probe, assume H.265
  // (transcode sempre entrega vídeo ao navegador; o pior caso é só custo de CPU).
  private async resolveLiveStreamIsHevc(cacheKey: string, sourceUrl: string, transport: string): Promise<boolean> {
    const cached = this.liveCodecCache.get(cacheKey);
    if (cached && Date.now() - cached.at < MediamtxProxyService.LIVE_CODEC_TTL_MS) {
      return cached.isHevc;
    }
    const probed = await this.probeStreamIsHevc(sourceUrl, transport);
    if (probed === null) {
      return true;
    }
    this.liveCodecCache.set(cacheKey, { isHevc: probed, at: Date.now() });
    return probed;
  }

  private alternateMainPath(rtspPath: string | null | undefined, channel: number): string | null {
    const p = (rtspPath || '').toLowerCase();
    if (p.includes('realmonitor')) return `/Streaming/Channels/${channel}01`;
    if (p.includes('/streaming/channels')) return `/cam/realmonitor?channel=${channel}&subtype=0`;
    return null;
  }

  private streamPixels(stream: { width: number | null; height: number | null } | null | undefined) {
    const width = Number(stream?.width ?? 0);
    const height = Number(stream?.height ?? 0);
    return Number.isFinite(width) && Number.isFinite(height) ? width * height : 0;
  }

  private async chooseLiveSource(cameraId: string, camera: any, password: string, transport: string) {
    const configuredProfile = resolveLiveRtspProfile(camera);
    const updatedAt = camera.updatedAt instanceof Date ? camera.updatedAt.toISOString() : String(camera.updatedAt ?? '');
    const sourceUrl = buildRtspUrl({
      username: camera.username,
      password,
      ip: camera.ip,
      rtspPort: camera.rtspPort,
      rtspPath: camera.rtspPath,
      channel: configuredProfile.channel,
      subtype: configuredProfile.subtype,
    });
    let chosenSourceUrl = sourceUrl;
    let chosenCodec: string | null = null;
    const detectedPixels = Number(camera.detectedWidth ?? 0) * Number(camera.detectedHeight ?? 0);
    const configuredPixels = Number(camera.streamWidth ?? 0) * Number(camera.streamHeight ?? 0);
    const shouldCheckAlternateMain =
      detectedPixels > 0 &&
      (detectedPixels < 1280 * 720 || (configuredPixels > 0 && detectedPixels < configuredPixels));
    const alternatePath = shouldCheckAlternateMain
      ? this.alternateMainPath(camera.rtspPath, configuredProfile.channel)
      : null;
    if (alternatePath) {
      const liveSourceCacheKey = `live-source:${cameraId}:${configuredProfile.channel}:${configuredProfile.subtype}:${updatedAt}`;
      const cached = this.liveSourceCache.get(liveSourceCacheKey);
      if (cached && Date.now() - cached.at < MediamtxProxyService.LIVE_CODEC_TTL_MS) {
        chosenSourceUrl = cached.url;
        chosenCodec = cached.codec;
      } else {
        const alternateUrl =
          `rtsp://${encodeURIComponent(camera.username)}:${encodeURIComponent(password)}@` +
          `${camera.ip}:${camera.rtspPort}${alternatePath}`;
        const [primaryMetadata, alternateMetadata] = await Promise.all([
          this.probeStreamVideoMetadata(sourceUrl, transport),
          this.probeStreamVideoMetadata(alternateUrl, transport),
        ]);
        const primaryPixels = this.streamPixels(primaryMetadata);
        const alternatePixels = this.streamPixels(alternateMetadata);
        if (alternateMetadata && alternatePixels > primaryPixels) {
          chosenSourceUrl = alternateUrl;
          chosenCodec = alternateMetadata.codec;
          this.logger.log(
            `Live principal alternativo escolhido para ${cameraId}: ` +
            `${primaryMetadata?.width ?? '?'}x${primaryMetadata?.height ?? '?'} -> ` +
            `${alternateMetadata.width ?? '?'}x${alternateMetadata.height ?? '?'}`,
          );
        } else {
          chosenCodec = primaryMetadata?.codec ?? null;
        }
        this.liveSourceCache.set(liveSourceCacheKey, {
          url: chosenSourceUrl,
          codec: chosenCodec,
          width: (chosenSourceUrl === alternateUrl ? alternateMetadata : primaryMetadata)?.width ?? null,
          height: (chosenSourceUrl === alternateUrl ? alternateMetadata : primaryMetadata)?.height ?? null,
          at: Date.now(),
        });
      }
    }
    const cacheKey = `${cameraId}:${configuredProfile.channel}:${configuredProfile.subtype}:${updatedAt}`;
    // Passthrough vs transcode. Confiamos no rótulo detectado SÓ quando ele diz
    // HEVC: a decisão vira "transcodar" e, se o rótulo estiver errado (fonte já é
    // H.264), o pior caso é custo de CPU — nunca tela preta. Quando o rótulo diz
    // H.264 (ou está vazio) a decisão seria PASSTHROUGH; aí errar = passar HEVC
    // cru pro WebRTC = TELA PRETA. E o codec da câmera muda na prática (operador
    // reconfigura, o rótulo fica velho). Por isso, antes de fazer passthrough,
    // confirmamos o codec real com um probe cacheado (barato, TTL curto).
    const detectedCodec = String(camera.detectedVideoCodec ?? '').trim().toLowerCase();
    const isHevc =
      chosenCodec
        ? isHevcCodec(chosenCodec)
        : detectedCodec && isHevcCodec(detectedCodec)
        ? true
        : await this.resolveLiveStreamIsHevc(cacheKey, chosenSourceUrl, transport);

    // A fonte Live e uma escolha operacional explicita. HEVC e convertido
    // para o navegador, mas nunca trocado silenciosamente por outro subtype.
    return { profile: configuredProfile, sourceUrl: chosenSourceUrl, isHevc };
  }

  /**
   * Escolhe a fonte para a GRADE (mosaico) com a "inteligência" de sub-stream:
   *  1) Tenta o SUB-stream (subtype 1). Se o ffprobe lê o codec:
   *       - H.264 → usa direto (o chamador faz PASSTHROUGH, sem transcodificar);
   *       - H.265 → usa o sub, mas o chamador transcodifica (do 480p, bem mais leve).
   *  2) Se a câmera NÃO tem sub-stream (probe falha) → cai para o MAIN (comportamento
   *     antigo: passthrough se H.264, transcode se H.265).
   * O resultado do probe é cacheado por câmera para não sondar a cada configuração.
   */
  // Caminho RTSP do SUB no protocolo ALTERNATIVO. Algumas câmeras OEM amarram cada
  // protocolo a um stream fixo: /Streaming/Channels/* sempre devolve o main e
  // /cam/realmonitor* sempre devolve o sub (H.264), ignorando o índice do canal.
  // Quando o sub no caminho configurado não é H.264, tentamos o protocolo oposto.
  private alternateSubPath(rtspPath: string | null | undefined, channel: number): string | null {
    const p = (rtspPath || '').toLowerCase();
    if (p.includes('/streaming/channels')) return `/cam/realmonitor?channel=${channel}&subtype=1`;
    if (p.includes('realmonitor')) return `/Streaming/Channels/${channel}02`;
    return null;
  }

  private async chooseGridSource(cameraId: string, camera: any, password: string, transport: string) {
    const subProfile = resolveGridRtspProfile(camera);
    const updatedAt = camera.updatedAt instanceof Date ? camera.updatedAt.toISOString() : String(camera.updatedAt ?? '');
    const cacheKey = `grid:${cameraId}:${updatedAt}`;

    // Cache: devolve a decisão pronta (url do sub OU null = usar o main).
    const cached = this.gridSourceCache.get(cacheKey);
    if (cached && Date.now() - cached.at < MediamtxProxyService.LIVE_CODEC_TTL_MS) {
      if (cached.url) {
        return {
          profile: subProfile,
          sourceUrl: cached.url,
          isHevc: cached.codec ? isHevcCodec(cached.codec) : false,
          usedSubStream: true,
          requiresSanitization: cached.requiresSanitization,
        };
      }
      const m = await this.chooseLiveSource(cameraId, camera, password, transport);
      return {
        profile: m.profile,
        sourceUrl: m.sourceUrl,
        isHevc: m.isHevc,
        usedSubStream: false,
        requiresSanitization: false,
      };
    }

    // Candidato 1: sub no caminho configurado (subtype 1 aplicado ao rtspPath).
    const primaryUrl = buildRtspUrl({
      username: camera.username, password, ip: camera.ip, rtspPort: camera.rtspPort,
      rtspPath: camera.rtspPath, channel: subProfile.channel, subtype: subProfile.subtype,
    });
    // Candidato 2: sub no protocolo alternativo (para as OEM Hik↔Dahua).
    const altPath = this.alternateSubPath(camera.rtspPath, subProfile.channel);
    const altUrl = altPath
      ? `rtsp://${encodeURIComponent(camera.username)}:${encodeURIComponent(password)}@${camera.ip}:${camera.rtspPort}${altPath}`
      : null;

    const found: Array<{
      url: string;
      codec: string;
      width: number | null;
      height: number | null;
      hasDataTrack: boolean;
    }> = [];
    const c1 = await this.probeStreamVideoMetadata(primaryUrl, transport);
    if (c1?.codec) found.push({
      url: primaryUrl,
      codec: c1.codec,
      width: c1.width,
      height: c1.height,
      hasDataTrack: c1.hasDataTrack,
    });
    // Só sonda o alternativo se o primeiro não for H.264 (economiza um probe).
    const has264 = found.some((f) => !isHevcCodec(f.codec));
    if (!has264 && altUrl) {
      const c2 = await this.probeStreamVideoMetadata(altUrl, transport);
      if (c2?.codec) found.push({
        url: altUrl,
        codec: c2.codec,
        width: c2.width,
        height: c2.height,
        hasDataTrack: c2.hasDataTrack,
      });
    }

    // Preferência: qualquer sub H.264 (passthrough) > sub H.265 de menor resolução
    // (transcode mais leve). Algumas OEMs devolvem 1080p em /Streaming/Channels/102
    // e 360p em /cam/realmonitor?subtype=1; para grade, o menor H.265 é o correto.
    const bySmallestResolution = (a: { width: number | null; height: number | null }, b: { width: number | null; height: number | null }) => {
      const ap = this.streamPixels(a) || Number.MAX_SAFE_INTEGER;
      const bp = this.streamPixels(b) || Number.MAX_SAFE_INTEGER;
      return ap - bp;
    };
    const chosen =
      found.filter((f) => !isHevcCodec(f.codec)).sort(bySmallestResolution)[0] ??
      found.filter((f) => isHevcCodec(f.codec)).sort(bySmallestResolution)[0] ??
      found[0];
    if (chosen) {
      // Alguns endpoints Hikvision/OEM expõem uma faixa de metadados sem
      // descrição RTP válida junto ao vídeo. O MediaMTX registra continuamente
      // "unknown payload type" ao receber essa faixa. Nesses casos isolados,
      // um remux FFmpeg com -map apenas de vídeo remove a faixa sem recodificar.
      const requiresSanitization =
        chosen.hasDataTrack && /\/Streaming\/Channels\//i.test(chosen.url);
      this.gridSourceCache.set(cacheKey, {
        url: chosen.url,
        codec: chosen.codec,
        requiresSanitization,
        at: Date.now(),
      });
      return {
        profile: subProfile,
        sourceUrl: chosen.url,
        isHevc: isHevcCodec(chosen.codec),
        usedSubStream: true,
        requiresSanitization,
      };
    }

    // Sem sub utilizável → usa a fonte principal (mesma do live).
    this.gridSourceCache.set(cacheKey, {
      url: null,
      codec: null,
      requiresSanitization: false,
      at: Date.now(),
    });
    const main = await this.chooseLiveSource(cameraId, camera, password, transport);
    this.logger.log(`Grade sem sub-stream para ${cameraId}; usando o stream principal.`);
    return {
      profile: main.profile,
      sourceUrl: main.sourceUrl,
      isHevc: main.isHevc,
      usedSubStream: false,
      requiresSanitization: false,
    };
  }

  /**
   * Resolve a melhor fonte para uma captura estática usando exatamente a mesma
   * regra da grade: sub-stream H.264 menor primeiro, sub-stream H.265 depois e
   * stream principal apenas como fallback.
   *
   * Retorna a URL RTSP da câmera diretamente. Não cria nem lê um path MediaMTX:
   * conectar ao path `selected` para extrair um único frame iniciava um encode
   * de 6 Mbps que permanecia ativo por 90s e saturava a CPU ao carregar os
   * posters de várias câmeras.
   */
  async resolveGridPosterSource(cameraId: string) {
    const camera = await this.camerasService.getCameraOrThrow(cameraId);
    if ((camera as { enabled?: boolean }).enabled === false) {
      throw new BadRequestException('Câmera desativada.');
    }
    const password = this.cryptoService.decrypt(camera.passwordEncrypted);
    const transport =
      camera.preferredRtspTransport
      ?? this.configService.get<string>('ffmpegRtspTransport')
      ?? 'tcp';
    const selected = await this.chooseGridSource(cameraId, camera, password, transport);
    return {
      sourceUrl: selected.sourceUrl,
      profile: selected.profile,
      sourceVideoCodec: selected.isHevc ? 'h265' : 'h264',
      usedSubStream: selected.usedSubStream,
    };
  }

  private durationToMilliseconds(value: string | undefined | null) {
    if (!value) return null;
    const matches = [...value.trim().matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)];
    if (!matches.length) return null;

    return matches.reduce((total, match) => {
      const amount = Number(match[1]);
      const unit = match[2];
      if (!Number.isFinite(amount)) return total;
      if (unit === 'ms') return total + amount;
      if (unit === 's') return total + amount * 1000;
      if (unit === 'm') return total + amount * 60 * 1000;
      if (unit === 'h') return total + amount * 60 * 60 * 1000;
      return total;
    }, 0);
  }

  private sameDuration(current: string | undefined, desired: string | undefined) {
    if (current === desired) return true;
    const currentMs = this.durationToMilliseconds(current);
    const desiredMs = this.durationToMilliseconds(desired);
    if (currentMs === null || desiredMs === null) return false;
    return currentMs === desiredMs;
  }

  private async apiRequest(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) {
    const base = this.configService.get<string>('mediaMtxApiBaseUrl') ?? 'http://mediamtx:9997';
    const apiUser = (this.configService.get<string>('mediaMtxApiUser') ?? '').trim();
    const apiPass = (this.configService.get<string>('mediaMtxApiPass') ?? '').trim();
    if (!apiUser || !apiPass) {
      throw new Error('Credenciais da API do MediaMTX não configuradas (MEDIAMTX_API_USER/MEDIAMTX_API_PASS).');
    }
    const basicAuth = Buffer.from(`${apiUser}:${apiPass}`).toString('base64');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${basicAuth}`,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        // A config que enviamos ao MediaMTX embute a URL RTSP da câmera COM credencial;
        // um erro pode ecoá-la de volta no corpo. Sanitiza antes de virar Error.message
        // (que sobe para logs e mensagens de diagnóstico).
        throw new Error(
          `MediaMTX API ${method} ${path} failed (${response.status}): ${sanitizeSensitiveText(text).slice(0, 160)}`,
        );
      }
      return await response.text().catch(() => '');
    } finally {
      clearTimeout(timeout);
    }
  }

  private async getPath(pathName: string) {
    const encodedPath = encodeURIComponent(pathName);
    const text = await this.apiRequest('GET', `/v3/config/paths/get/${encodedPath}`);
    return JSON.parse(text) as {
      source?: string;
      sourceOnDemand?: boolean;
      sourceOnDemandStartTimeout?: string;
      sourceOnDemandCloseAfter?: string;
      rtspTransport?: string;
    };
  }

  async getPathRuntimeSummaryForCamera(cameraId: string) {
    const pathName = this.pathNameFromCameraId(cameraId);
    if (!this.isEnabled()) {
      return {
        pathName,
        available: false,
        ready: false,
        readerCount: 0,
        readers: [] as Array<{ id: string | null; protocol: string | null; remoteAddr: string | null }>,
        bytesReceived: null as number | null,
        bytesSent: null as number | null,
        error: 'MediaMTX desabilitado.',
      };
    }

    try {
      const encodedPath = encodeURIComponent(pathName);
      const text = await this.apiRequest('GET', `/v3/paths/get/${encodedPath}`);
      const data = JSON.parse(text) as Record<string, any>;
      const rawReaders = Array.isArray(data.readers)
        ? data.readers
        : data.readers && typeof data.readers === 'object'
          ? Object.values(data.readers)
          : [];

      const readers = rawReaders.map((reader: any) => ({
        id: typeof reader?.id === 'string' ? reader.id : null,
        protocol: typeof reader?.type === 'string'
          ? reader.type
          : typeof reader?.protocol === 'string'
            ? reader.protocol
            : null,
        remoteAddr: typeof reader?.remoteAddr === 'string'
          ? reader.remoteAddr.replace(/:\d+$/, ':*')
          : null,
      }));

      return {
        pathName,
        available: true,
        ready: Boolean(data.ready ?? data.sourceReady ?? data.source?.ready),
        readerCount: readers.length,
        readers,
        bytesReceived: Number.isFinite(Number(data.bytesReceived)) ? Number(data.bytesReceived) : null,
        bytesSent: Number.isFinite(Number(data.bytesSent)) ? Number(data.bytesSent) : null,
        error: null as string | null,
      };
    } catch (error) {
      return {
        pathName,
        available: false,
        ready: false,
        readerCount: 0,
        readers: [] as Array<{ id: string | null; protocol: string | null; remoteAddr: string | null }>,
        bytesReceived: null as number | null,
        bytesSent: null as number | null,
        error: error instanceof Error ? error.message : 'Falha ao consultar runtime do MediaMTX.',
      };
    }
  }

  private async warmCameraPaths() {
    try {
      const cameras = (await this.camerasService.findAllInternal())
        .filter((camera) => (camera as { enabled?: boolean }).enabled !== false);
      if (!cameras.length) return;

      const warmSelectedPaths = this.configService.get<boolean>('mediaMtxWarmSelectedPathsOnBoot') === true;
      this.logger.log(
        warmSelectedPaths
          ? `Aquecendo paths MediaMTX de grade e selected para ${cameras.length} câmera(s)...`
          : `Aquecendo somente paths MediaMTX de grade para ${cameras.length} câmera(s)...`,
      );
      let nextIndex = 0;
      let warmed = 0;
      let failed = 0;
      const workerCount = Math.min(4, cameras.length);
      await Promise.all(Array.from({ length: workerCount }, async () => {
        while (nextIndex < cameras.length) {
          const camera = cameras[nextIndex++];
          try {
            const tasks: Array<Promise<EnsuredCameraPath>> = [this.ensurePathForCamera(camera.id, 'grid')];
            if (warmSelectedPaths) {
              tasks.push(this.ensurePathForCamera(camera.id, 'selected'));
            }
            await Promise.all(tasks);
            warmed += 1;
          } catch {
            failed += 1;
          }
        }
      }));
      if (failed > 0) {
        this.logger.warn(`Aquecimento MediaMTX parcial: ${warmed}/${cameras.length} path(s) prontos.`);
        return;
      }
      this.logger.log(`Aquecimento MediaMTX concluído: ${warmed}/${cameras.length} path(s) prontos.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'erro desconhecido';
      this.logger.warn(`Falha ao aquecer paths MediaMTX: ${message}`);
    }
  }

  /** Remove os paths (selected + grid) de uma câmera no MediaMTX — usado ao
   * DESATIVAR a câmera, para o vídeo parar imediatamente (sem esperar o
   * closeAfter do on-demand). Best-effort: path inexistente é ignorado. */
  async teardownPathsForCamera(cameraId: string): Promise<void> {
    if (!this.isEnabled()) return;
    for (const mode of ['selected', 'grid', 'original'] as const) {
      const pathName = this.pathNameFromCameraId(cameraId, mode);
      this.pathEnsureCache.delete(this.buildEnsureKey(cameraId, mode));
      await this.apiRequest('DELETE', `/v3/config/paths/delete/${encodeURIComponent(pathName)}`).catch(() => undefined);
      await this.apiRequest(
        'DELETE',
        `/v3/config/paths/delete/${encodeURIComponent(this.privateSourcePathName(pathName))}`,
      ).catch(() => undefined);
    }
    this.invalidateMainCodecCache(cameraId);
  }

  ensurePathForCamera(cameraId: string, deliveryMode: LiveViewMode = 'selected'): Promise<EnsuredCameraPath> {
    const ensureKey = this.buildEnsureKey(cameraId, deliveryMode);
    const cached = this.pathEnsureCache.get(ensureKey);
    if (cached && Date.now() - cached.at < MediamtxProxyService.PATH_ENSURE_TTL_MS) {
      return Promise.resolve(cached.value);
    }

    const existing = this.pathEnsureInFlight.get(ensureKey);
    if (existing) return existing;

    const request = this.configurePathForCamera(cameraId, deliveryMode)
      .then((value) => {
        this.pathEnsureCache.set(ensureKey, { value, at: Date.now() });
        // Avisa o Source Gateway que ESTE perfil tem origem republicada internamente.
        // Sem este aviso o gateway nunca teria o que oferecer e cairia sempre no
        // fallback direto — ou seja, ligar a flag não mudaria nada. Best-effort:
        // um erro aqui NUNCA pode derrubar a preparação do path de live.
        try {
          this.sourceGateway?.registerPublishedSource(
            cameraId,
            liveViewModeToSourceProfile(deliveryMode),
            value.pathName ? this.buildInternalRtspUrl(value.pathName) : null,
          );
        } catch {
          /* observabilidade não interfere no live */
        }
        return value;
      })
      .finally(() => {
        if (this.pathEnsureInFlight.get(ensureKey) === request) {
          this.pathEnsureInFlight.delete(ensureKey);
        }
      });
    this.pathEnsureInFlight.set(ensureKey, request);
    return request;
  }

  private async configurePathForCamera(cameraId: string, deliveryMode: LiveViewMode): Promise<EnsuredCameraPath> {
    if (!this.isEnabled()) {
      return {
        pathName: null as string | null,
        sourceUrl: null as string | null,
        sourceVideoCodec: null as string | null,
        transcodedForLive: false,
        liveProfile: null as { channel: number; subtype: number } | null,
        deliveryMode,
      };
    }

    const camera = await this.camerasService.getCameraOrThrow(cameraId);
    // Gate central: câmera desativada não ganha path (nem via warm/watchdog/live).
    // Também derruba paths que já existam, para o vídeo parar na hora.
    if ((camera as { enabled?: boolean }).enabled === false) {
      await this.teardownPathsForCamera(cameraId);
      throw new BadRequestException('Câmera desativada.');
    }
    const password = this.cryptoService.decrypt(camera.passwordEncrypted);

    const pathName = this.pathNameFromCameraId(cameraId, deliveryMode);
    const encodedPath = encodeURIComponent(pathName);
    const sourceOnDemand = this.configService.get<boolean>('mediaMtxSourceOnDemand') ?? false;
    const sourceOnDemandStartTimeout = this.configService.get<string>('mediaMtxSourceOnDemandStartTimeout') ?? '6s';
    const sourceOnDemandCloseAfter = this.configService.get<string>('mediaMtxSourceOnDemandCloseAfter') ?? '5m';
    const runOnDemandCloseAfter = this.configService.get<string>('mediaMtxRunOnDemandCloseAfter') ?? '5m';
    const selectedRunOnDemandCloseAfter =
      this.configService.get<string>('mediaMtxSelectedRunOnDemandCloseAfter') ?? runOnDemandCloseAfter;
    const effectiveRunOnDemandCloseAfter =
      deliveryMode === 'selected' ? selectedRunOnDemandCloseAfter : runOnDemandCloseAfter;
    const rtspTransport = camera.preferredRtspTransport ?? this.configService.get<string>('ffmpegRtspTransport') ?? 'tcp';

    // Live (tela cheia) respeita o perfil principal configurado. A GRADE usa o
    // sub-stream quando existe (mais leve e rápido); ver chooseGridSource.
    const selected = deliveryMode === 'grid'
      ? await this.chooseGridSource(cameraId, camera, password, rtspTransport)
      : await this.chooseLiveSource(cameraId, camera, password, rtspTransport);
    const liveProfile = selected.profile;
    const sourceUrl = selected.sourceUrl;
    const isHevc = selected.isHevc;
    const transcodeAudioForWebrtc = deliveryMode === 'selected' && Boolean(camera.audioEnabled);
    const sanitizeGridSource =
      deliveryMode === 'grid' &&
      !isHevc &&
      Boolean('requiresSanitization' in selected && selected.requiresSanitization);
    // A grade só precisa de publisher (transcode) quando a fonte é H.265. Fonte
    // H.264 — sub-stream OU principal — é entregue ao navegador via PASSTHROUGH
    // (sem ffmpeg, sem CPU), abrindo praticamente instantâneo. Antes a grade
    // SEMPRE transcodificava (era a causa principal da lentidão ao abrir o mosaico).
    //
    // Modo 'original' (máxima qualidade): NUNCA transcoda — passa o stream
    // principal como está (H.265 inclusive) direto pro HLS. O custo de CPU no
    // servidor é ~0; o celular decodifica o HEVC no hardware. Só HLS (WebRTC não
    // reproduz H.265), com latência maior — é o trade-off assumido pelo usuário.
    const needsPublisher =
      deliveryMode === 'original' ? false : (isHevc || transcodeAudioForWebrtc || sanitizeGridSource);
    const gpuAccel =
      needsPublisher && !sanitizeGridSource && (await this.settingsService.isGpuAccelerationEnabled());
    // Só é "transcodificado" quando o publisher FFmpeg existe de fato — no modo
    // 'original' (passthrough) a fonte HEVC segue intocada e o rótulo deve refletir isso.
    const transcodedForLive = needsPublisher && (isHevc || transcodeAudioForWebrtc);

    const desiredPath: any = {
      source: sourceUrl,
      // 'original' (máxima qualidade) puxa o stream PRINCIPAL direto da câmera em
      // passthrough. Sempre sob demanda com janela curta: senão o path seguraria
      // uma sessão RTSP + banda WAN do main 24/7 mesmo sem ninguém assistindo.
      sourceOnDemand: deliveryMode === 'original' ? true : sourceOnDemand,
      sourceOnDemandStartTimeout,
      sourceOnDemandCloseAfter: deliveryMode === 'original' ? selectedRunOnDemandCloseAfter : sourceOnDemandCloseAfter,
      rtspTransport,
    };

    if (needsPublisher) {
      const sourcePathName = await this.ensurePrivateSourcePath(
        pathName,
        sourceUrl,
        rtspTransport,
        sourceOnDemandStartTimeout,
        sourceOnDemandCloseAfter,
      );
      const privateSourceUrl =
        `rtsp://127.0.0.1:$RTSP_PORT/${sourcePathName}`;
      // Navegadores não reproduzem H.265 via WebRTC/HLS, e WebRTC não aceita o AAC
      // vindo dessas câmeras neste pipeline. O source vira 'publisher' e runOnDemand
      // sobe um ffmpeg que publica H.264 + Opus quando áudio estiver habilitado.
      desiredPath.source = 'publisher';
      // O publisher tambem normaliza H.264 quando ja precisa abrir FFmpeg para
      // o audio. Copiar um stream com fragmentos RTP perdidos repassa quadros
      // quebrados ao navegador e pode deixar a imagem verde ate o proximo IDR.
      // A grade limita fontes grandes, mas preserva a resolução nativa de fontes
      // menores. Sem o min(iw/ih), um sub-stream 640x360 era ampliado para
      // 1280x720: mais custo de encode sem criar detalhe real.
      const gridScaleFilter =
        `scale=w='min(iw,${GRID_LIVE_MAX_WIDTH})':h='min(ih,${GRID_LIVE_MAX_HEIGHT})':` +
        `force_original_aspect_ratio=decrease:force_divisible_by=2,` +
        `fps=${GRID_LIVE_TARGET_FPS}`;
      // Aceleração por GPU (NVENC): quando o admin liga o módulo de GPU em
      // Configurações, o encode H.264 sai da CPU (libx264) e vai para a placa
      // (h264_nvenc), mantendo o mesmo bitrate/GOP. O decode/scale segue na CPU
      // (compatível com qualquer driver); o ganho está no encode, que é a parte
      // mais cara quando há muitas câmeras. Exige imagem do MediaMTX com NVENC.
      // ⚠️ NÃO basta a configuração estar ligada: o encode roda no container do
      // MediaMTX, e emitir `-c:v h264_nvenc` num ffmpeg SEM NVENC faz o publisher
      // morrer na largada — com runOnDemandRestart=false, sem retry e sem
      // fallback, o que derruba a live daquela câmera. Isso era alcançável por um
      // admin clicando "Ativar GPU" num host INTEL (o hardware mais comum aqui),
      // porque o portão do painel aceitava vaapi/qsv mas o publisher só sabe NVENC.
      // Agora exigimos o sinal explícito de que o pipeline de transcode TEM NVENC.
      const useNvenc = gpuAccel && this.transcodePipelineHasNvenc();
      const videoArgs = sanitizeGridSource
        ? '-c:v copy'
        : useNvenc
        ? (deliveryMode === 'grid'
          ? '-c:v h264_nvenc -preset p4 -tune ll -profile:v main -rc cbr ' +
            '-b:v 1800k -maxrate 1800k -bufsize 3600k -pix_fmt yuv420p ' +
            `-g 40 -bf 0 -vf "${gridScaleFilter}"`
          : '-c:v h264_nvenc -preset p4 -tune ll -profile:v main -rc cbr ' +
            '-b:v 5000k -maxrate 5000k -bufsize 10000k -pix_fmt yuv420p ' +
            '-g 30 -bf 0')
        : (deliveryMode === 'grid'
          ? '-threads 4 -c:v libx264 -preset ultrafast -tune zerolatency -profile:v main ' +
            '-b:v 1800k -maxrate 1800k -bufsize 3600k -pix_fmt yuv420p ' +
            `-g 40 -keyint_min 20 -sc_threshold 0 -bf 0 -refs 1 -vf "${gridScaleFilter}"`
          : '-threads 4 -c:v libx264 -preset veryfast -tune zerolatency -profile:v high ' +
            '-b:v 6000k -maxrate 6000k -bufsize 12000k -pix_fmt yuv420p ' +
            '-g 30 -keyint_min 15 -sc_threshold 0 -bf 0 -refs 2');
      const audioArgs = transcodeAudioForWebrtc
        ? '-c:a libopus -ar 48000 -ac 2 -application lowdelay -b:a 96k'
        : '-an';
      // MediaMTX preenche $MTX_PATH e $RTSP_PORT automaticamente para o script.
      // -threads 4: limita libx264 a 4 threads por câmera (3 câmeras × 4 = 12 threads totais).
      // Sem este limite, libx264 cria automaticamente N threads = nº de núcleos lógicos,
      // causando 3 × 14 = 42 threads encode + 3 × 15 = 45 threads decode competindo,
      // sobrecarregando C0/C1 por efeito de scheduler clustering.
      const publishUrl = this.buildInternalPublishRtspUrl(pathName);
      const ffmpegCommand =
        `ffmpeg -nostdin -hide_banner -loglevel warning -fflags +genpts+discardcorrupt+nobuffer ` +
        // -analyzeduration/-probesize: o padrão do FFmpeg analisa até 5s/5MB do input
        // antes de começar a transcodificar. Para câmeras H.264/H.265 conhecidas isso é
        // exagero e adiciona vários segundos ao COLD START (quando o runOnDemand reabre
        // após os 5 min de runOnDemandCloseAfter). 1s/1MB já identifica o stream com
        // folga e corta esse atraso, deixando o retorno à câmera bem mais rápido.
        // +nobuffer evita o buffer de entrada extra do FFmpeg (menor latência ao vivo).
        `-analyzeduration 1000000 -probesize 1000000 ` +
        // careful: validates bitstream integrity and drops malformed packets
        // instead of passing corrupted NAL units downstream (which causes
        // green frames in the browser until the next IDR keyframe arrives).
        `-flags low_delay -err_detect careful -rtsp_transport ${rtspTransport} ` +
        `-i "${privateSourceUrl}" -map 0:v:0 -map 0:a:0? ${videoArgs} ${audioArgs} ` +
        `-f rtsp -rtsp_transport tcp -muxdelay 0.1 -pkt_size 1200 "${publishUrl}"`;
      // AUTO-RECUPERAÇÃO (anti-travamento). Antes de iniciar o restream, mata
      // qualquer ffmpeg ENCRAVADO deste MESMO path. Um ffmpeg que parou de publicar
      // mas continuou vivo segurava o antigo lock `flock -n` e fazia todo runOnDemand
      // seguinte falhar em silêncio → loop infinito "Nenhum protocolo iniciou". Aqui
      // não há lock para travar: cada start limpa o que ficou e sobe um processo novo.
      //
      // Segurança: só elimina processos cujo comm é exatamente `ffmpeg` E cuja linha
      // de comando publica NESTE path (`/<pathName> ` — o publishUrl é o último arg,
      // então é seguido pelo NUL final que vira espaço; o sufixo `_grid` distingue
      // grid de selected, evitando matar o path irmão). O runOnDemand só roda quando
      // o path está SEM fonte, então o publisher ativo nunca é alvo.
      const prekill =
        `for d in /proc/[0-9]*; do ` +
        `c=$(cat "$d/comm" 2>/dev/null); [ "$c" = ffmpeg ] || continue; ` +
        `tr "\\0" " " < "$d/cmdline" 2>/dev/null | grep -qF "/${pathName} " ` +
        `&& kill -9 "$(basename "$d")" 2>/dev/null; ` +
        `done`;
      desiredPath.runOnDemand = `sh -c ${this.shellQuote(`${prekill}; exec ${ffmpegCommand}`)}`;
      desiredPath.runOnDemandRestart = false;
      desiredPath.runOnDemandStartTimeout = '15s'; // Tempo para o ffmpeg começar a republicar.
      // Mantém o restream recente aquecido. Assim, voltar para uma câmera não
      // exige iniciar FFmpeg e aguardar um novo keyframe outra vez.
      desiredPath.runOnDemandCloseAfter = effectiveRunOnDemandCloseAfter;
      // Com runOnDemand como publisher, estes campos 'sourceOnDemand' são inválidos.
      delete desiredPath.sourceOnDemand;
      delete desiredPath.sourceOnDemandStartTimeout;
      delete desiredPath.sourceOnDemandCloseAfter;
    }

    try {
      const current: any = await this.getPath(pathName);
      const hasSameSource =
        current.source === desiredPath.source &&
        current.rtspTransport === desiredPath.rtspTransport;
      const hasSameCameraSourceSettings = needsPublisher
        ? true
        : current.sourceOnDemand === desiredPath.sourceOnDemand &&
          this.sameDuration(current.sourceOnDemandStartTimeout, desiredPath.sourceOnDemandStartTimeout) &&
          this.sameDuration(current.sourceOnDemandCloseAfter, desiredPath.sourceOnDemandCloseAfter);
      const hasSamePublisherSettings = needsPublisher
        ? (current.runOnDemand || '') === (desiredPath.runOnDemand || '') &&
          Boolean(current.runOnDemandRestart) === Boolean(desiredPath.runOnDemandRestart) &&
          this.sameDuration(current.runOnDemandStartTimeout, desiredPath.runOnDemandStartTimeout) &&
          this.sameDuration(current.runOnDemandCloseAfter, desiredPath.runOnDemandCloseAfter)
        : true;
      const isSamePath = hasSameSource && hasSameCameraSourceSettings && hasSamePublisherSettings;

      if (isSamePath) {
        return {
          pathName,
          sourceUrl,
          sourceVideoCodec: isHevc ? 'h265' : 'h264',
          transcodedForLive,
          liveProfile,
          deliveryMode,
        };
      }
    } catch {
      // Se não existe, cria abaixo. Se a API falhar temporariamente, a criação vai expor o erro real.
    }

    // Só recria quando a configuração mudou; recriar em toda leitura derruba muxers HLS/WebRTC ativos.
    try {
      await this.apiRequest('DELETE', `/v3/config/paths/delete/${encodedPath}`);
    } catch {
      // ignora quando ainda não existe
    }

    await this.apiRequest('POST', `/v3/config/paths/add/${encodedPath}`, desiredPath);

    this.logger.log(`Path MediaMTX pronto ${pathName} -> ${this.sanitizeRtspUrl(sourceUrl)}`);
    return {
      pathName,
      sourceUrl,
      sourceVideoCodec: isHevc ? 'h265' : 'h264',
      transcodedForLive,
      liveProfile,
      deliveryMode,
    };
  }


  buildInternalRtspUrl(pathName: string | null) {
    if (!pathName) return null;
    const base = (this.configService.get<string>('mediaMtxRtspInternalUrl') ?? 'rtsp://mediamtx:8554').replace(/\/+$/, '');
    const apiUser = (this.configService.get<string>('mediaMtxApiUser') ?? '').trim();
    const apiPass = (this.configService.get<string>('mediaMtxApiPass') ?? '').trim();
    if (!apiUser || !apiPass) {
      throw new Error('Credenciais internas do MediaMTX não configuradas (MEDIAMTX_API_USER/MEDIAMTX_API_PASS).');
    }

    const parsed = new URL(`${base}/${encodeURIComponent(pathName)}`);
    // O MediaMTX usa autenticação HTTP também para leitores RTSP internos. Sem
    // estas credenciais, IA/posters recebem 401 mesmo dentro da rede Docker.
    if (!parsed.username) parsed.username = apiUser;
    if (!parsed.password) parsed.password = apiPass;
    return parsed.toString();
  }

  buildPublicUrls(req: Request, pathName: string | null, sourceUrl: string | null): DeliveryUrls {
    const enabled = this.isEnabled() && Boolean(pathName);
    if (!enabled || !pathName) {
      return {
        enabled: false,
        pathName: null,
        sourceUrl,
        webrtcUrl: null,
        whepUrl: null,
        hlsUrl: null,
        rtspProxyUrl: null,
      };
    }

    const hostHeader = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? 'localhost';
    const requestHost = hostHeader.split(',')[0].trim().split(':')[0];
    const host = this.configService.get<string>('mediaMtxPublicHost') || requestHost || 'localhost';
    const reqProto = ((req.headers['x-forwarded-proto'] as string | undefined) ?? req.protocol ?? 'http')
      .split(',')[0]
      .trim();
    const scheme = this.configService.get<string>('mediaMtxPublicScheme') || reqProto || 'http';
    const configuredWebrtcBase = (this.configService.get<string>('mediaMtxPublicWebrtcUrl') ?? '').replace(/\/+$/, '');
    const configuredHlsBase = (this.configService.get<string>('mediaMtxPublicHlsUrl') ?? '').replace(/\/+$/, '');
    const webrtcPort = this.configService.get<number>('mediaMtxWebrtcPort') ?? 8889;
    const hlsPort = this.configService.get<number>('mediaMtxHlsPort') ?? 8888;
    const webrtcBase = configuredWebrtcBase || `${scheme}://${host}:${webrtcPort}`;
    const hlsBase = configuredHlsBase || `${scheme}://${host}:${hlsPort}`;

    return {
      enabled: true,
      pathName,
      sourceUrl,
      webrtcUrl: `${webrtcBase}/${pathName}/`,
      whepUrl: `${webrtcBase}/${pathName}/whep`,
      hlsUrl: `${hlsBase}/${pathName}/index.m3u8`,
      rtspProxyUrl: `rtsp://${host}:8554/${pathName}`,
    };
  }
}
