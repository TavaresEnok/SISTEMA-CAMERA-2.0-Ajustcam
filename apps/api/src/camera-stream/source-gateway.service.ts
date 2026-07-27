import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
// Métricas por câmera: singleton de módulo (mesmo padrão do mediamtx-proxy) e
// SEMPRE em try/catch — observabilidade não derruba stream.
import { cameraMetrics } from '../observability/camera-metrics.service';
import { sanitizeSensitiveText } from '../common/security/sensitive-text.helper';

// ─────────────────────────────────────────────────────────────────────────────
// FASE 3 — SOURCE GATEWAY: registro e roteamento da ORIGEM de vídeo por câmera.
//
// PROBLEMA QUE ELE RESOLVE
// Hoje a MESMA câmera é aberta várias vezes ao mesmo tempo: a gravação abre um
// RTSP direto, a IA abre outro, o MediaMTX abre o path de live, o pré-buffer
// abre mais um, o poster abre outro. Câmera barata costuma aceitar 2–4 sessões;
// em link fraco a banda é multiplicada; e o mesmo vídeo é decodificado N vezes.
// A meta é UMA conexão por câmera por PERFIL (uma main + uma sub), com todos os
// consumidores internos lendo dela.
//
// O QUE ESTE ARQUIVO É (e o que NÃO é)
// Ele é o REGISTRO e a POLÍTICA de roteamento: sabe, para cada (câmera, perfil),
// qual o estado da origem, quantos consumidores dependem dela, qual transporte
// funcionou e — a decisão central — QUAL URL cada consumidor deve usar: a URL
// DIRETA da câmera (comportamento de hoje) ou a URL INTERNA do MediaMTX, que já
// republica aquele stream. Ele NÃO abre RTSP, NÃO sobe FFmpeg e NÃO reescreve
// gravação/IA/live: a troca dos consumidores é incremental e vem depois.
//
// ── FLAG: CAMERA_SOURCE_GATEWAY_ENABLED (default FALSE) ─────────────────────
// DESLIGADA (produção hoje):
//   • resolveSourceUrl() devolve EXATAMENTE a `directUrl` que o chamador já
//     usaria — a mesma string, sem tocar em nada. Nenhum consumidor muda de
//     origem.
//   • acquire/release/noteConnecting/noteProgress/noteFailure/tick são INERTES:
//     não criam estado no registro, não bloqueiam ninguém (canAttempt = true) e
//     não emitem métrica alguma. Ligar o módulo no Nest não muda o processo.
// LIGADA:
//   • Consumidores que passarem por resolveSourceUrl() recebem a URL INTERNA do
//     MediaMTX quando o gateway já mantém aquele perfil PUBLICADO e SAUDÁVEL
//     (registerPublishedSource + estado CONNECTING/ONLINE). Em qualquer dúvida
//     — sem fonte publicada, origem parada (STALLED/BACKOFF) ou circuito aberto
//     — a decisão VOLTA para a URL direta: o fail-safe é o comportamento de hoje.
//   • O teto de conexões externas por câmera (default 2 = main+sub) passa a
//     valer: pedir um perfil além do teto NÃO abre conexão nova; o consumidor é
//     servido pelo perfil que já está aberto (decisão registrada no lease, em
//     stats() e em recentDecisions()).
//   • Falhas alimentam backoff exponencial COM JITTER e um circuit breaker por
//     (câmera, perfil): depois de N falhas seguidas o gateway para de tentar por
//     um período (e dobra o período a cada reabertura), em vez de martelar uma
//     câmera morta.
//   • Recuperações (STALLED/BACKOFF/CIRCUIT_OPEN → ONLINE) contam em
//     cameraMetrics.recordStreamRecovery — a mesma semântica do watchdog do
//     MediaMTX. Nunca com a flag desligada, para o /metrics não mudar sozinho.
// ─────────────────────────────────────────────────────────────────────────────

/** main = stream principal (gravação/qualidade máxima). sub = stream reduzido. */
export type SourceProfile = 'main' | 'sub';

export type SourceState =
  /** Sem consumidor: nenhuma conexão externa é mantida por este perfil. */
  | 'IDLE'
  /** Alguém pediu a origem; a conexão está subindo. */
  | 'CONNECTING'
  /** Origem com progresso recente de pacotes. */
  | 'ONLINE'
  /** Estava ONLINE e parou de progredir (fonte congelada/ausente). */
  | 'STALLED'
  /** Falhou; aguardando a janela de backoff antes da próxima tentativa. */
  | 'BACKOFF'
  /** Falhas demais seguidas: paramos de tentar até o fim do resfriamento. */
  | 'CIRCUIT_OPEN';

export type SourceOrigin = 'direct' | 'gateway';
export type RtspTransport = 'tcp' | 'udp';

/** Consumidor interno do vídeo. String livre para não travar quem vier depois. */
export type SourceConsumer = 'recording' | 'ai' | 'live' | 'grid' | 'prebuffer' | 'poster' | 'clip' | 'probe' | string;

export type SourceDecisionReason =
  /** Flag desligada: URL direta, igual a hoje. */
  | 'gateway_disabled'
  /** O consumidor exige o bitstream original da câmera (ex.: arquivo fiel). */
  | 'consumer_requires_direct'
  /** Ninguém mantém esse perfil aberto agora. */
  | 'no_active_source'
  /** Há origem, mas o gateway não tem URL publicada para servir. */
  | 'no_published_source'
  /** A origem existe mas não está progredindo (STALLED/BACKOFF). */
  | 'source_stalled'
  /** Circuito aberto: a origem é considerada indisponível. */
  | 'circuit_open'
  /** Servido pelo perfil pedido, já publicado pelo gateway. */
  | 'gateway_published'
  /** Teto de conexões atingido: servido por OUTRO perfil já aberto. */
  | 'cap_reused_profile';

export type ResolveSourceInput = {
  cameraId: string;
  profile: SourceProfile;
  consumer: SourceConsumer;
  /** URL RTSP DIRETA da câmera: exatamente a que o consumidor usa hoje. */
  directUrl: string;
  /** URL interna do MediaMTX para ESTE perfil, quando o chamador já a conhece. */
  internalUrl?: string | null;
  /** Consumidor que não pode ser reroteado (precisa do bitstream da câmera). */
  requireDirect?: boolean;
};

export type SourceDecision = {
  url: string;
  origin: SourceOrigin;
  reason: SourceDecisionReason;
  cameraId: string;
  consumer: SourceConsumer;
  requestedProfile: SourceProfile;
  servedProfile: SourceProfile;
  atMs: number;
};

export type SourceLease = {
  readonly id: string;
  readonly cameraId: string;
  readonly consumer: SourceConsumer;
  readonly requestedProfile: SourceProfile;
  /** Perfil REALMENTE servido — difere do pedido quando o teto foi atingido. */
  readonly servedProfile: SourceProfile;
  readonly gatewayEnabled: boolean;
  /** true quando o teto de conexões externas redirecionou este consumidor. */
  readonly capped: boolean;
  /** Idempotente: soltar o mesmo lease duas vezes não desconta duas vezes. */
  release(): void;
};

export type SourceSnapshot = {
  cameraId: string;
  profile: SourceProfile;
  state: SourceState;
  refCount: number;
  consumers: SourceConsumer[];
  /** URL publicada SANITIZADA (o snapshot é diagnóstico: nunca leva senha). */
  publishedUrl: string | null;
  transport: RtspTransport | null;
  lastPacketAt: Date | null;
  lastFrameAt: Date | null;
  consecutiveFailures: number;
  lastBackoffMs: number | null;
  nextAttemptAt: Date | null;
  circuitOpenUntil: Date | null;
};

export type SourceGatewayStats = {
  acquisitions: number;
  releases: number;
  cappedAcquisitions: number;
  stalls: number;
  failures: number;
  recoveries: number;
  circuitOpens: number;
  decisions: Partial<Record<SourceDecisionReason, number>>;
};

/** Só o que o gateway usa do registro de métricas — permite fake no teste. */
export type SourceGatewayMetricsSink = { recordStreamRecovery(cameraId: string): void };

export type SourceGatewaySeams = {
  clock: () => number;
  random: () => number;
  metrics: SourceGatewayMetricsSink;
};

// ── Defaults (todos sobrescrevíveis por env/ConfigService) ───────────────────
export const SOURCE_GATEWAY_DEFAULTS = {
  /** main + sub. É o teto que a câmera barata costuma aguentar com folga. */
  maxExternalPerCamera: 2,
  /** Sem pacote por este tempo com estado ONLINE ⇒ STALLED. */
  stallTimeoutMs: 20_000,
  backoffBaseMs: 1_000,
  backoffCapMs: 60_000,
  backoffJitter: 0.2,
  circuitThreshold: 5,
  circuitOpenMs: 60_000,
  /** Teto do resfriamento do circuito (dobra a cada reabertura até aqui). */
  circuitMaxOpenMs: 8 * 60_000,
  /** Origem sem consumidor por este tempo é recolhida do registro. */
  idleTtlMs: 5 * 60_000,
  /** Varredura periódica quando o gateway está LIGADO. */
  sweepIntervalMs: 10_000,
} as const;

/** Teto de origens rastreadas (a frota real é ordens de grandeza menor). */
const MAX_TRACKED_SOURCES = 2_000;
/** Diário circular de decisões (diagnóstico do rollout, memória limitada). */
const MAX_DECISION_LOG = 200;

/**
 * Backoff exponencial com jitter — porte em TS do reconnect_backoff.py do
 * ai-service (mesma fórmula, mesmos nomes): 2^(attempt-1) * base, capado em
 * `cap`, com jitter multiplicativo ±jitter. O jitter existe para dessincronizar
 * a reconexão de várias câmeras (thundering herd) — sem ele, uma queda de rede
 * faz a frota inteira voltar no mesmo milissegundo.
 */
export function computeBackoffDelayMs(
  attempt: number,
  options: { baseMs?: number; capMs?: number; jitter?: number; random?: () => number } = {},
): number {
  const baseMs = positive(options.baseMs, SOURCE_GATEWAY_DEFAULTS.backoffBaseMs);
  const capMs = positive(options.capMs, SOURCE_GATEWAY_DEFAULTS.backoffCapMs);
  const jitter = clamp01(options.jitter ?? SOURCE_GATEWAY_DEFAULTS.backoffJitter);
  const random = options.random ?? Math.random;

  const n = Math.max(1, Math.floor(Number(attempt) || 1));
  // 2^(n-1) explode rápido; o Math.min com o teto evita Infinity em n grande.
  const raw = n >= 53 ? capMs : baseMs * 2 ** (n - 1);
  const delay = Math.min(capMs, raw);
  if (jitter <= 0) return Math.max(0, delay);
  const factor = 1 + jitter * (2 * random() - 1);
  return Math.max(0, delay * factor);
}

function positive(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegative(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function clamp01(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(1, parsed);
}

export function normalizeSourceProfile(value: unknown): SourceProfile {
  return String(value ?? '').trim().toLowerCase() === 'sub' ? 'sub' : 'main';
}

type SourceEntry = {
  cameraId: string;
  profile: SourceProfile;
  state: SourceState;
  /** leaseId → consumidor. O tamanho É o refcount (sem contador paralelo que derive). */
  consumers: Map<string, SourceConsumer>;
  publishedUrl: string | null;
  transport: RtspTransport | null;
  lastPacketAtMs: number | null;
  lastFrameAtMs: number | null;
  consecutiveFailures: number;
  attempt: number;
  lastBackoffMs: number | null;
  nextAttemptAtMs: number | null;
  circuitOpenUntilMs: number | null;
  circuitCooldownMs: number | null;
  /** true entre a queda e a próxima recuperação (evita contar recuperação 2×). */
  degraded: boolean;
  createdAtMs: number;
  touchedAtMs: number;
};

@Injectable()
export class SourceGatewayService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SourceGatewayService.name);
  private readonly entries = new Map<string, SourceEntry>();
  private readonly leases = new Map<string, { key: string; cameraId: string }>();
  private readonly decisionLog: SourceDecision[] = [];
  private readonly decisionCounts = new Map<SourceDecisionReason, number>();
  private leaseSeq = 0;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  private counters = { acquisitions: 0, releases: 0, cappedAcquisitions: 0, stalls: 0, failures: 0, recoveries: 0, circuitOpens: 0 };

  // Costuras (relógio/aleatório/métrica). Em produção são os reais; o teste
  // troca via configureSeams para ter tempo determinístico e jitter previsível.
  private clock: () => number = () => Date.now();
  private random: () => number = () => Math.random();
  private metrics: SourceGatewayMetricsSink = cameraMetrics;

  constructor(private readonly configService: ConfigService) {}

  /** Só teste: injeta relógio/aleatório/métrica. Produção usa os padrões. */
  configureSeams(seams: Partial<SourceGatewaySeams>): void {
    if (seams.clock) this.clock = seams.clock;
    if (seams.random) this.random = seams.random;
    if (seams.metrics) this.metrics = seams.metrics;
  }

  onApplicationBootstrap(): void {
    // Flag DESLIGADA ⇒ nem timer o gateway cria. O módulo fica inerte no processo.
    if (!this.isEnabled()) return;
    const interval = positive(
      this.readSetting('cameraSourceGatewaySweepIntervalMs', 'CAMERA_SOURCE_GATEWAY_SWEEP_INTERVAL_MS'),
      SOURCE_GATEWAY_DEFAULTS.sweepIntervalMs,
    );
    this.sweepTimer = setInterval(() => {
      try {
        this.tick();
      } catch {
        /* varredura de registro jamais derruba o processo */
      }
    }, interval);
    this.sweepTimer.unref?.();
    this.logger.log(
      `Source Gateway ATIVO (teto ${this.maxExternalConnectionsPerCamera()} conexões externas/câmera, varredura ${interval}ms).`,
    );
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  // ── Flag e política ────────────────────────────────────────────────────────

  /**
   * A ÚNICA porta de entrada da feature. Default FALSE: só o literal 'true'
   * (ou o booleano true vindo do ConfigService) liga. Lida a cada chamada para
   * que desligar a flag e reiniciar seja sempre suficiente.
   */
  isEnabled(): boolean {
    const raw = this.readSetting('cameraSourceGatewayEnabled', 'CAMERA_SOURCE_GATEWAY_ENABLED');
    return String(raw ?? '').trim().toLowerCase() === 'true';
  }

  maxExternalConnectionsPerCamera(): number {
    const value = positive(
      this.readSetting('cameraSourceGatewayMaxExternalPerCamera', 'CAMERA_SOURCE_GATEWAY_MAX_EXTERNAL_PER_CAMERA'),
      SOURCE_GATEWAY_DEFAULTS.maxExternalPerCamera,
    );
    return Math.max(1, Math.floor(value));
  }

  private readSetting(configKey: string, envKey: string): unknown {
    const fromConfig = this.configService?.get?.(configKey);
    if (fromConfig !== undefined && fromConfig !== null) return fromConfig;
    return process.env[envKey];
  }

  private stallTimeoutMs(): number {
    return positive(
      this.readSetting('cameraSourceGatewayStallTimeoutMs', 'CAMERA_SOURCE_GATEWAY_STALL_TIMEOUT_MS'),
      SOURCE_GATEWAY_DEFAULTS.stallTimeoutMs,
    );
  }

  private circuitThreshold(): number {
    return Math.max(
      1,
      Math.floor(
        positive(
          this.readSetting('cameraSourceGatewayCircuitThreshold', 'CAMERA_SOURCE_GATEWAY_CIRCUIT_THRESHOLD'),
          SOURCE_GATEWAY_DEFAULTS.circuitThreshold,
        ),
      ),
    );
  }

  private circuitOpenMs(): number {
    return positive(
      this.readSetting('cameraSourceGatewayCircuitOpenMs', 'CAMERA_SOURCE_GATEWAY_CIRCUIT_OPEN_MS'),
      SOURCE_GATEWAY_DEFAULTS.circuitOpenMs,
    );
  }

  private circuitMaxOpenMs(): number {
    return Math.max(
      this.circuitOpenMs(),
      positive(
        this.readSetting('cameraSourceGatewayCircuitMaxOpenMs', 'CAMERA_SOURCE_GATEWAY_CIRCUIT_MAX_OPEN_MS'),
        SOURCE_GATEWAY_DEFAULTS.circuitMaxOpenMs,
      ),
    );
  }

  private idleTtlMs(): number {
    return positive(
      this.readSetting('cameraSourceGatewayIdleTtlMs', 'CAMERA_SOURCE_GATEWAY_IDLE_TTL_MS'),
      SOURCE_GATEWAY_DEFAULTS.idleTtlMs,
    );
  }

  private backoffOptions() {
    return {
      baseMs: positive(
        this.readSetting('cameraSourceGatewayBackoffBaseMs', 'CAMERA_SOURCE_GATEWAY_BACKOFF_BASE_MS'),
        SOURCE_GATEWAY_DEFAULTS.backoffBaseMs,
      ),
      capMs: positive(
        this.readSetting('cameraSourceGatewayBackoffCapMs', 'CAMERA_SOURCE_GATEWAY_BACKOFF_CAP_MS'),
        SOURCE_GATEWAY_DEFAULTS.backoffCapMs,
      ),
      jitter: clamp01(
        nonNegative(
          this.readSetting('cameraSourceGatewayBackoffJitter', 'CAMERA_SOURCE_GATEWAY_BACKOFF_JITTER'),
          SOURCE_GATEWAY_DEFAULTS.backoffJitter,
        ),
      ),
      random: this.random,
    };
  }

  // ── Roteamento: a decisão central ──────────────────────────────────────────

  /**
   * Decide QUAL URL o consumidor deve abrir.
   *
   * REGRA DE OURO: em qualquer situação de dúvida a resposta é a `directUrl` —
   * a mesma string que o chamador usaria hoje. Só devolvemos a URL interna do
   * MediaMTX quando o gateway está LIGADO e realmente mantém aquele perfil
   * publicado e saudável.
   */
  resolveSourceUrl(input: ResolveSourceInput): SourceDecision {
    const now = this.clock();
    const requestedProfile = normalizeSourceProfile(input.profile);
    const direct = (reason: SourceDecisionReason, servedProfile: SourceProfile = requestedProfile): SourceDecision =>
      this.recordDecision({
        url: input.directUrl,
        origin: 'direct',
        reason,
        cameraId: input.cameraId,
        consumer: input.consumer,
        requestedProfile,
        servedProfile,
        atMs: now,
      });

    if (!this.isEnabled()) return direct('gateway_disabled');
    if (input.requireDirect) return direct('consumer_requires_direct');

    // Qual origem atende este pedido: a do próprio perfil, ou — quando o teto
    // de conexões externas já está tomado — a que já está aberta.
    let entry = this.activeEntry(input.cameraId, requestedProfile);
    let reason: SourceDecisionReason = 'gateway_published';
    if (!entry) {
      const others = this.activeEntries(input.cameraId).filter((e) => e.profile !== requestedProfile);
      if (others.length >= this.maxExternalConnectionsPerCamera()) {
        entry = this.pickSubstitute(others);
        reason = 'cap_reused_profile';
      }
    }
    if (!entry) return direct('no_active_source');

    if (entry.circuitOpenUntilMs != null && now < entry.circuitOpenUntilMs) return direct('circuit_open', entry.profile);
    if (entry.state === 'STALLED' || entry.state === 'BACKOFF') return direct('source_stalled', entry.profile);

    // O hint `internalUrl` só vale para o perfil pedido: quando o teto redirecionou
    // para outro perfil, a URL tem de ser a DAQUELA origem.
    const published = entry.profile === requestedProfile ? input.internalUrl ?? entry.publishedUrl : entry.publishedUrl;
    if (!published) return direct('no_published_source', entry.profile);

    return this.recordDecision({
      url: published,
      origin: 'gateway',
      reason,
      cameraId: input.cameraId,
      consumer: input.consumer,
      requestedProfile,
      servedProfile: entry.profile,
      atMs: now,
    });
  }

  /** URL interna do MediaMTX que republica este perfil (quem ensure o path avisa). */
  registerPublishedSource(cameraId: string, profile: SourceProfile, url: string | null): void {
    if (!this.isEnabled()) return;
    const entry = this.ensureEntry(cameraId, normalizeSourceProfile(profile));
    if (!entry) return;
    entry.publishedUrl = url && url.trim().length > 0 ? url : null;
    entry.touchedAtMs = this.clock();
  }

  clearPublishedSource(cameraId: string, profile: SourceProfile): void {
    this.registerPublishedSource(cameraId, profile, null);
  }

  // ── Refcount ───────────────────────────────────────────────────────────────

  /**
   * Registra um consumidor sobre a origem (câmera, perfil). O PRIMEIRO acquire
   * é quem "abre" a conexão externa; os seguintes só somam no refcount — é isso
   * que garante UMA conexão por perfil. Quando o teto da câmera já está tomado,
   * o consumidor é anexado à origem que já existe (lease.capped = true).
   */
  acquire(cameraId: string, profile: SourceProfile, consumer: SourceConsumer): SourceLease {
    const requestedProfile = normalizeSourceProfile(profile);
    const id = `lease_${++this.leaseSeq}`;

    if (!this.isEnabled()) {
      // Lease INERTE: não cria estado e o release não faz nada. Com a flag
      // desligada o gateway não existe para efeitos práticos.
      return {
        id,
        cameraId,
        consumer,
        requestedProfile,
        servedProfile: requestedProfile,
        gatewayEnabled: false,
        capped: false,
        release: () => {},
      };
    }

    const now = this.clock();
    let capped = false;
    let entry = this.entries.get(this.key(cameraId, requestedProfile)) ?? null;

    // Só há teto a respeitar quando este acquire ABRIRIA uma conexão nova.
    if (!entry || entry.consumers.size === 0) {
      const others = this.activeEntries(cameraId).filter((e) => e.profile !== requestedProfile);
      if (others.length >= this.maxExternalConnectionsPerCamera()) {
        const substitute = this.pickSubstitute(others);
        if (substitute) {
          entry = substitute;
          capped = true;
          this.counters.cappedAcquisitions += 1;
          this.logger.warn(
            `Teto de conexões externas atingido em ${cameraId} (${this.maxExternalConnectionsPerCamera()}): ` +
              `consumidor ${consumer} pediu '${requestedProfile}' e será servido por '${substitute.profile}'.`,
          );
        }
      }
    }

    if (!entry) entry = this.ensureEntry(cameraId, requestedProfile);
    if (!entry) {
      // Registro cheio de origens ATIVAS: não inventamos estado, o consumidor
      // segue no caminho direto de hoje.
      return {
        id,
        cameraId,
        consumer,
        requestedProfile,
        servedProfile: requestedProfile,
        gatewayEnabled: true,
        capped: false,
        release: () => {},
      };
    }

    if (entry.state === 'IDLE') entry.state = 'CONNECTING';
    entry.consumers.set(id, consumer);
    entry.touchedAtMs = now;
    this.leases.set(id, { key: this.key(entry.cameraId, entry.profile), cameraId: entry.cameraId });
    this.counters.acquisitions += 1;

    const servedProfile = entry.profile;
    return {
      id,
      cameraId,
      consumer,
      requestedProfile,
      servedProfile,
      gatewayEnabled: true,
      capped,
      release: () => this.release(id),
    };
  }

  /**
   * Solta um consumidor. A origem só é liberada quando o ÚLTIMO consumidor sai —
   * soltar um de dois NÃO pode derrubar o vídeo de quem ficou. Idempotente: o
   * lease é removido do índice antes de descontar, então release duplo é no-op.
   */
  release(lease: SourceLease | string): void {
    const id = typeof lease === 'string' ? lease : lease?.id;
    if (!id) return;
    const ref = this.leases.get(id);
    if (!ref) return; // lease inerte, desconhecido ou já solto
    this.leases.delete(id);

    const entry = this.entries.get(ref.key);
    if (!entry) return;
    entry.consumers.delete(id);
    const now = this.clock();
    entry.touchedAtMs = now;
    this.counters.releases += 1;

    if (entry.consumers.size === 0) {
      // Circuito aberto continua sendo a verdade sobre a fonte mesmo sem
      // consumidor: não podemos "esquecer" e voltar a martelar a câmera.
      entry.state = entry.circuitOpenUntilMs != null && now < entry.circuitOpenUntilMs ? 'CIRCUIT_OPEN' : 'IDLE';
    }
  }

  // ── Máquina de estados ─────────────────────────────────────────────────────

  /** A conexão externa está subindo (também é a tentativa do circuito meio-aberto). */
  noteConnecting(cameraId: string, profile: SourceProfile): void {
    if (!this.isEnabled()) return;
    const entry = this.ensureEntry(cameraId, normalizeSourceProfile(profile));
    if (!entry) return;
    entry.state = 'CONNECTING';
    entry.touchedAtMs = this.clock();
  }

  /** Chegou pacote/quadro da origem: ONLINE, marca o transporte que funcionou. */
  noteProgress(
    cameraId: string,
    profile: SourceProfile,
    info: { transport?: RtspTransport | string | null; frame?: boolean } = {},
  ): void {
    if (!this.isEnabled()) return;
    const entry = this.ensureEntry(cameraId, normalizeSourceProfile(profile));
    if (!entry) return;
    const now = this.clock();
    const wasDegraded = entry.degraded;

    entry.state = 'ONLINE';
    entry.lastPacketAtMs = now;
    if (info.frame) entry.lastFrameAtMs = now;
    const transport = String(info.transport ?? '').trim().toLowerCase();
    if (transport === 'tcp' || transport === 'udp') entry.transport = transport;
    entry.consecutiveFailures = 0;
    entry.attempt = 0;
    entry.lastBackoffMs = null;
    entry.nextAttemptAtMs = null;
    entry.circuitOpenUntilMs = null;
    entry.circuitCooldownMs = null;
    entry.degraded = false;
    entry.touchedAtMs = now;

    if (wasDegraded) {
      this.counters.recoveries += 1;
      // Mesma semântica do watchdog do MediaMTX: uma origem travada voltou.
      try {
        this.metrics.recordStreamRecovery(cameraId);
      } catch {
        /* observabilidade nunca interrompe o stream */
      }
    }
  }

  /** A origem falhou: alimenta backoff e, no limiar, abre o circuito. */
  noteFailure(cameraId: string, profile: SourceProfile, reason?: string): void {
    if (!this.isEnabled()) return;
    const entry = this.ensureEntry(cameraId, normalizeSourceProfile(profile));
    if (!entry) return;
    const now = this.clock();
    entry.consecutiveFailures += 1;
    entry.attempt += 1;
    entry.degraded = true;
    entry.touchedAtMs = now;
    this.counters.failures += 1;

    if (entry.consecutiveFailures >= this.circuitThreshold()) {
      // Reabertura dobra o resfriamento (capado): câmera morta não merece um
      // ciclo de tentativa a cada minuto para sempre.
      const next = entry.circuitCooldownMs == null ? this.circuitOpenMs() : entry.circuitCooldownMs * 2;
      entry.circuitCooldownMs = Math.min(next, this.circuitMaxOpenMs());
      entry.circuitOpenUntilMs = now + entry.circuitCooldownMs;
      entry.nextAttemptAtMs = entry.circuitOpenUntilMs;
      entry.lastBackoffMs = entry.circuitCooldownMs;
      entry.state = 'CIRCUIT_OPEN';
      this.counters.circuitOpens += 1;
      this.logger.warn(
        `Circuito ABERTO para ${cameraId}/${entry.profile} após ${entry.consecutiveFailures} falhas seguidas ` +
          `(${entry.circuitCooldownMs}ms sem tentar)${reason ? `: ${sanitizeSensitiveText(reason)}` : ''}.`,
      );
      return;
    }

    const delay = computeBackoffDelayMs(entry.attempt, this.backoffOptions());
    entry.lastBackoffMs = delay;
    entry.nextAttemptAtMs = now + delay;
    entry.state = 'BACKOFF';
  }

  /**
   * Pode tentar (re)conectar agora? Baseado nos PRAZOS, não no rótulo de estado:
   * um circuito aberto continua valendo mesmo depois de todo mundo soltar a origem.
   * Com a flag desligada nunca bloqueia ninguém.
   */
  canAttempt(cameraId: string, profile: SourceProfile, nowMs?: number): boolean {
    if (!this.isEnabled()) return true;
    const entry = this.entries.get(this.key(cameraId, normalizeSourceProfile(profile)));
    if (!entry) return true;
    const now = nowMs ?? this.clock();
    if (entry.circuitOpenUntilMs != null && now < entry.circuitOpenUntilMs) return false;
    if (entry.nextAttemptAtMs != null && now < entry.nextAttemptAtMs) return false;
    return true;
  }

  /** Transporte que FUNCIONOU nesta origem; sem histórico devolve o padrão. */
  preferredTransport(cameraId: string, profile: SourceProfile, fallback: RtspTransport = 'tcp'): RtspTransport {
    const entry = this.entries.get(this.key(cameraId, normalizeSourceProfile(profile)));
    return entry?.transport ?? fallback;
  }

  /**
   * Varredura: promove ONLINE sem progresso a STALLED e recolhe origens ociosas
   * antigas. Chamada pelo timer quando ligado; nos testes, à mão.
   */
  tick(nowMs?: number): void {
    if (!this.isEnabled()) return;
    const now = nowMs ?? this.clock();
    const stallTimeout = this.stallTimeoutMs();
    const idleTtl = this.idleTtlMs();

    for (const [key, entry] of [...this.entries]) {
      if (entry.state === 'ONLINE' && entry.lastPacketAtMs != null && now - entry.lastPacketAtMs > stallTimeout) {
        entry.state = 'STALLED';
        entry.degraded = true;
        this.counters.stalls += 1;
        this.logger.warn(
          `Origem ${entry.cameraId}/${entry.profile} sem progresso há ${now - entry.lastPacketAtMs}ms — marcada STALLED.`,
        );
        continue;
      }

      const idle = entry.consumers.size === 0;
      const circuitCooling = entry.circuitOpenUntilMs != null && now < entry.circuitOpenUntilMs;
      if (idle && !circuitCooling && now - entry.touchedAtMs > idleTtl) {
        this.entries.delete(key);
      }
    }
  }

  // ── Observabilidade ────────────────────────────────────────────────────────

  /** Conexões externas que o gateway mantém abertas nesta câmera (é o teto). */
  externalConnections(cameraId: string): number {
    return this.activeEntries(cameraId).length;
  }

  describeSource(cameraId: string, profile: SourceProfile): SourceSnapshot | null {
    const entry = this.entries.get(this.key(cameraId, normalizeSourceProfile(profile)));
    return entry ? this.toSnapshot(entry) : null;
  }

  describeCamera(cameraId: string): SourceSnapshot[] {
    return [...this.entries.values()].filter((e) => e.cameraId === cameraId).map((e) => this.toSnapshot(e));
  }

  snapshotAll(): SourceSnapshot[] {
    return [...this.entries.values()].map((e) => this.toSnapshot(e));
  }

  stats(): SourceGatewayStats {
    return {
      ...this.counters,
      decisions: Object.fromEntries(this.decisionCounts) as Partial<Record<SourceDecisionReason, number>>,
    };
  }

  recentDecisions(limit = MAX_DECISION_LOG): SourceDecision[] {
    const n = Math.max(1, Math.min(MAX_DECISION_LOG, Math.floor(limit) || MAX_DECISION_LOG));
    return this.decisionLog.slice(-n);
  }

  /** Limpa tudo (teste/rollback manual). Não há caminho de produção que chame. */
  reset(): void {
    this.entries.clear();
    this.leases.clear();
    this.decisionLog.length = 0;
    this.decisionCounts.clear();
    this.counters = { acquisitions: 0, releases: 0, cappedAcquisitions: 0, stalls: 0, failures: 0, recoveries: 0, circuitOpens: 0 };
  }

  // ── Internos ───────────────────────────────────────────────────────────────

  private key(cameraId: string, profile: SourceProfile): string {
    return `${cameraId}::${profile}`;
  }

  /** Origem que sustenta (ou está subindo) uma conexão externa AGORA. */
  private isActive(entry: SourceEntry): boolean {
    return entry.consumers.size > 0 || entry.state === 'CONNECTING' || entry.state === 'ONLINE';
  }

  private activeEntries(cameraId: string): SourceEntry[] {
    return [...this.entries.values()].filter((e) => e.cameraId === cameraId && this.isActive(e));
  }

  private activeEntry(cameraId: string, profile: SourceProfile): SourceEntry | null {
    const entry = this.entries.get(this.key(cameraId, profile));
    if (!entry) return null;
    // Uma origem em BACKOFF/CIRCUIT_OPEN ainda "existe" para efeito de decisão
    // (a decisão vai ser voltar ao direto, com o motivo certo).
    if (this.isActive(entry) || entry.state === 'BACKOFF' || entry.state === 'CIRCUIT_OPEN' || entry.state === 'STALLED') {
      return entry;
    }
    return null;
  }

  /** Preferência ao que já está ONLINE; depois o main (mais completo). */
  private pickSubstitute(candidates: SourceEntry[]): SourceEntry | null {
    if (candidates.length === 0) return null;
    const online = candidates.filter((e) => e.state === 'ONLINE');
    const pool = online.length > 0 ? online : candidates;
    return pool.find((e) => e.profile === 'main') ?? pool[0];
  }

  private ensureEntry(cameraId: string, profile: SourceProfile): SourceEntry | null {
    const key = this.key(cameraId, profile);
    const existing = this.entries.get(key);
    if (existing) return existing;
    if (this.entries.size >= MAX_TRACKED_SOURCES && !this.evictOneIdle()) {
      this.logger.warn('Registro de origens cheio (só origens ativas) — novo consumidor segue no caminho direto.');
      return null;
    }
    const now = this.clock();
    const entry: SourceEntry = {
      cameraId,
      profile,
      state: 'IDLE',
      consumers: new Map(),
      publishedUrl: null,
      transport: null,
      lastPacketAtMs: null,
      lastFrameAtMs: null,
      consecutiveFailures: 0,
      attempt: 0,
      lastBackoffMs: null,
      nextAttemptAtMs: null,
      circuitOpenUntilMs: null,
      circuitCooldownMs: null,
      degraded: false,
      createdAtMs: now,
      touchedAtMs: now,
    };
    this.entries.set(key, entry);
    return entry;
  }

  /** Descarta a origem ociosa mais antiga; nunca mexe em origem com consumidor. */
  private evictOneIdle(): boolean {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [key, entry] of this.entries) {
      if (entry.consumers.size > 0) continue;
      if (entry.touchedAtMs < oldestAt) {
        oldestAt = entry.touchedAtMs;
        oldestKey = key;
      }
    }
    if (oldestKey == null) return false;
    this.entries.delete(oldestKey);
    return true;
  }

  private recordDecision(decision: SourceDecision): SourceDecision {
    this.decisionCounts.set(decision.reason, (this.decisionCounts.get(decision.reason) ?? 0) + 1);
    // O diário é diagnóstico e pode acabar em log/endpoint: guarda a URL
    // SANITIZADA (a real vai só no retorno, para o chamador usar).
    this.decisionLog.push({ ...decision, url: sanitizeSensitiveText(decision.url) });
    if (this.decisionLog.length > MAX_DECISION_LOG) {
      this.decisionLog.splice(0, this.decisionLog.length - MAX_DECISION_LOG);
    }
    return decision;
  }

  private toSnapshot(entry: SourceEntry): SourceSnapshot {
    return {
      cameraId: entry.cameraId,
      profile: entry.profile,
      state: entry.state,
      refCount: entry.consumers.size,
      consumers: [...entry.consumers.values()],
      publishedUrl: entry.publishedUrl ? sanitizeSensitiveText(entry.publishedUrl) : null,
      transport: entry.transport,
      lastPacketAt: entry.lastPacketAtMs == null ? null : new Date(entry.lastPacketAtMs),
      lastFrameAt: entry.lastFrameAtMs == null ? null : new Date(entry.lastFrameAtMs),
      consecutiveFailures: entry.consecutiveFailures,
      lastBackoffMs: entry.lastBackoffMs,
      nextAttemptAt: entry.nextAttemptAtMs == null ? null : new Date(entry.nextAttemptAtMs),
      circuitOpenUntil: entry.circuitOpenUntilMs == null ? null : new Date(entry.circuitOpenUntilMs),
    };
  }
}
