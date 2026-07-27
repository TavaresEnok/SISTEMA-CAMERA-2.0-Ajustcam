// ─────────────────────────────────────────────────────────────────────────────
// Registro EM MEMÓRIA de eventos operacionais por câmera (segmento gravado,
// reinício de gravação, recuperação de path do MediaMTX).
//
// Por que em memória e não no banco: estes contadores são lidos pelo /metrics
// PÚBLICO (scrape a cada poucos segundos, sem autenticação). Consultar o
// Postgres a cada scrape transformaria o endpoint público num amplificador de
// carga/negação de serviço sobre o banco que sustenta a gravação. O custo é que
// as janelas reiniciam junto com o processo — aceitável para um sinal
// operacional (o dado durável do último segmento continua no Recording).
//
// Invariantes desta classe:
//  • JANELA DESLIZANTE de 1h (guarda timestamps, poda na escrita e na leitura).
//  • MEMÓRIA LIMITADA: teto de eventos por série E teto de câmeras rastreadas.
//    A API roda meses sem reiniciar; um Map sem teto seria um vazamento.
//  • NUNCA LANÇA: é chamada de dentro do caminho de gravação/stream. Uma falha
//    de métrica não pode derrubar uma câmera.
//  • Só guarda cameraId — nada de nome/IP/URL (o /metrics é público; ver a
//    regra de PII/LGPD no camera-prometheus.helper.ts).
// ─────────────────────────────────────────────────────────────────────────────

export const CAMERA_METRICS_WINDOW_MS = 60 * 60 * 1000;
/** Teto de eventos guardados por série/câmera (memória limitada por câmera). */
export const CAMERA_METRICS_MAX_EVENTS_PER_SERIES = 512;
/** Teto de câmeras rastreadas (frota real é ordens de grandeza menor). */
export const CAMERA_METRICS_MAX_CAMERAS = 1000;
/** Ids maiores que isto são lixo (um UUID tem 36 chars) e são descartados. */
const MAX_CAMERA_ID_LENGTH = 128;

export type CameraMetricsSnapshot = {
  cameraId: string;
  segmentsLastHour: number;
  restartsLastHour: number;
  recoveriesLastHour: number;
  /** Vezes que o freio anti-tempestade do watchdog PAROU de tentar recuperar. */
  brakesLastHour: number;
  segmentsTotal: number;
  restartsTotal: number;
  recoveriesTotal: number;
  brakesTotal: number;
  lastSegmentAt: Date | null;
  lastRecoveryAt: Date | null;
  lastBrakeAt: Date | null;
};

type SeriesKind = 'segments' | 'restarts' | 'recoveries' | 'brakes';

type CameraEntry = {
  segments: number[];
  restarts: number[];
  recoveries: number[];
  brakes: number[];
  segmentsTotal: number;
  restartsTotal: number;
  recoveriesTotal: number;
  brakesTotal: number;
  lastSegmentAtMs: number | null;
  lastRecoveryAtMs: number | null;
  lastBrakeAtMs: number | null;
  touchedAtMs: number;
};

const EMPTY_SNAPSHOT = (cameraId: string): CameraMetricsSnapshot => ({
  cameraId,
  segmentsLastHour: 0,
  restartsLastHour: 0,
  recoveriesLastHour: 0,
  brakesLastHour: 0,
  segmentsTotal: 0,
  restartsTotal: 0,
  recoveriesTotal: 0,
  brakesTotal: 0,
  lastSegmentAt: null,
  lastRecoveryAt: null,
  lastBrakeAt: null,
});

export class CameraMetricsService {
  private readonly cameras = new Map<string, CameraEntry>();
  private readonly clock: () => number;

  /** `clock` é costura de teste; em produção é o relógio do sistema. */
  constructor(clock: () => number = () => Date.now()) {
    this.clock = clock;
  }

  /** Um segmento foi REGISTRADO com sucesso (linha nova em Recording). */
  recordSegment(cameraId: string): void {
    this.safe(cameraId, (entry, now) => {
      this.push(entry.segments, now);
      entry.segmentsTotal += 1;
      if (entry.lastSegmentAtMs == null || now > entry.lastSegmentAtMs) entry.lastSegmentAtMs = now;
    });
  }

  /** O processo de gravação terminou SEM ter sido pedido (queda/erro/reinício). */
  recordRecordingRestart(cameraId: string): void {
    this.safe(cameraId, (entry, now) => {
      this.push(entry.restarts, now);
      entry.restartsTotal += 1;
    });
  }

  /** O watchdog reconfigurou um path travado do MediaMTX. */
  recordStreamRecovery(cameraId: string): void {
    this.safe(cameraId, (entry, now) => {
      this.push(entry.recoveries, now);
      entry.recoveriesTotal += 1;
      if (entry.lastRecoveryAtMs == null || now > entry.lastRecoveryAtMs) entry.lastRecoveryAtMs = now;
    });
  }

  /**
   * O FREIO ANTI-TEMPESTADE armou: o watchdog DESISTIU de recuperar este path
   * por um tempo (recuperações demais numa janela curta, todas fúteis). É o
   * sinal de "a câmera não vai voltar sozinha, alguém precisa ir lá" — por isso
   * ele é uma série própria, e não mais uma recuperação.
   */
  recordStreamRecoveryBrake(cameraId: string): void {
    this.safe(cameraId, (entry, now) => {
      this.push(entry.brakes, now);
      entry.brakesTotal += 1;
      if (entry.lastBrakeAtMs == null || now > entry.lastBrakeAtMs) entry.lastBrakeAtMs = now;
    });
  }

  /**
   * Semeia a marca-d'água do último segmento a partir de uma fonte DURÁVEL (o
   * banco). Só AVANÇA o relógio — nunca conta como evento novo, senão a leitura
   * autenticada inflaria a janela do /metrics. Serve para o /metrics não ficar
   * cego logo após um restart da API.
   */
  observeLastSegmentAt(cameraId: string, at: Date | number | null | undefined): void {
    if (at == null) return;
    const ms = at instanceof Date ? at.getTime() : Number(at);
    if (!Number.isFinite(ms)) return;
    this.safe(cameraId, (entry) => {
      if (entry.lastSegmentAtMs == null || ms > entry.lastSegmentAtMs) entry.lastSegmentAtMs = ms;
    });
  }

  /** Leitura NÃO aloca entrada (câmera desconhecida devolve zeros). */
  snapshot(cameraId: string): CameraMetricsSnapshot {
    const id = this.normalizeId(cameraId);
    if (!id) return EMPTY_SNAPSHOT(String(cameraId ?? ''));
    const entry = this.cameras.get(id);
    if (!entry) return EMPTY_SNAPSHOT(id);
    const now = this.clock();
    return {
      cameraId: id,
      segmentsLastHour: this.countWindow(entry.segments, now),
      restartsLastHour: this.countWindow(entry.restarts, now),
      recoveriesLastHour: this.countWindow(entry.recoveries, now),
      brakesLastHour: this.countWindow(entry.brakes, now),
      segmentsTotal: entry.segmentsTotal,
      restartsTotal: entry.restartsTotal,
      recoveriesTotal: entry.recoveriesTotal,
      brakesTotal: entry.brakesTotal,
      lastSegmentAt: entry.lastSegmentAtMs == null ? null : new Date(entry.lastSegmentAtMs),
      lastRecoveryAt: entry.lastRecoveryAtMs == null ? null : new Date(entry.lastRecoveryAtMs),
      lastBrakeAt: entry.lastBrakeAtMs == null ? null : new Date(entry.lastBrakeAtMs),
    };
  }

  snapshotAll(): CameraMetricsSnapshot[] {
    return [...this.cameras.keys()].map((id) => this.snapshot(id));
  }

  knownCameraIds(): string[] {
    return [...this.cameras.keys()];
  }

  get size(): number {
    return this.cameras.size;
  }

  /** Limpa tudo (uso em teste; não há caminho de produção que chame). */
  reset(): void {
    this.cameras.clear();
  }

  /** Introspecção do array interno — existe para o teste do teto de memória. */
  debugSeriesLength(cameraId: string, kind: SeriesKind): number {
    const id = this.normalizeId(cameraId);
    const entry = id ? this.cameras.get(id) : undefined;
    return entry ? entry[kind].length : 0;
  }

  // ── internos ───────────────────────────────────────────────────────────────

  private normalizeId(cameraId: unknown): string | null {
    if (typeof cameraId !== 'string') return null;
    const id = cameraId.trim();
    if (!id || id.length > MAX_CAMERA_ID_LENGTH) return null;
    return id;
  }

  /** Executa a mutação sem NUNCA deixar uma exceção escapar para o chamador. */
  private safe(cameraId: string, mutate: (entry: CameraEntry, now: number) => void): void {
    try {
      const id = this.normalizeId(cameraId);
      if (!id) return;
      const now = this.clock();
      const entry = this.ensureEntry(id, now);
      mutate(entry, now);
      entry.touchedAtMs = now;
    } catch {
      /* métrica é observabilidade: jamais propaga erro para gravação/stream */
    }
  }

  private ensureEntry(id: string, now: number): CameraEntry {
    const existing = this.cameras.get(id);
    if (existing) return existing;
    if (this.cameras.size >= CAMERA_METRICS_MAX_CAMERAS) this.evictOldest();
    const entry: CameraEntry = {
      segments: [],
      restarts: [],
      recoveries: [],
      brakes: [],
      segmentsTotal: 0,
      restartsTotal: 0,
      recoveriesTotal: 0,
      brakesTotal: 0,
      lastSegmentAtMs: null,
      lastRecoveryAtMs: null,
      lastBrakeAtMs: null,
      touchedAtMs: now,
    };
    this.cameras.set(id, entry);
    return entry;
  }

  private evictOldest(): void {
    let oldestId: string | null = null;
    let oldestAt = Infinity;
    for (const [id, entry] of this.cameras) {
      if (entry.touchedAtMs < oldestAt) {
        oldestAt = entry.touchedAtMs;
        oldestId = id;
      }
    }
    if (oldestId != null) this.cameras.delete(oldestId);
  }

  private push(series: number[], now: number): void {
    this.prune(series, now);
    series.push(now);
    if (series.length > CAMERA_METRICS_MAX_EVENTS_PER_SERIES) {
      series.splice(0, series.length - CAMERA_METRICS_MAX_EVENTS_PER_SERIES);
    }
  }

  /** Descarta o que saiu da janela de 1h (os timestamps são crescentes). */
  private prune(series: number[], now: number): void {
    const cutoff = now - CAMERA_METRICS_WINDOW_MS;
    let drop = 0;
    while (drop < series.length && series[drop] < cutoff) drop += 1;
    if (drop > 0) series.splice(0, drop);
  }

  private countWindow(series: number[], now: number): number {
    this.prune(series, now);
    return series.length;
  }
}

// Instância ÚNICA do processo. Os hooks de gravação/stream a importam direto
// (sem DI) para que instrumentar não exija mexer nos construtores desses
// serviços críticos; o módulo Nest publica ESTA MESMA instância como provider
// (useValue), então API e /metrics leem exatamente o mesmo registro.
export const cameraMetrics = new CameraMetricsService();
