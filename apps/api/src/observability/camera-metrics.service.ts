import { estimateCameraCapacity, resolveCpuBudgetCores } from './proc-sampler';

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
/**
 * Teto de PROCESSOS rastreados. Uma frota real tem ~3 processos por câmera
 * (gravação + pré-buffer + transcode); 512 cobre com folga uma instalação
 * grande. O teto existe porque um untrackProcess que deixe de ser chamado (um
 * caminho de erro novo, um SIGKILL) viraria vazamento numa API que fica meses
 * de pé.
 */
export const CAMERA_METRICS_MAX_PROCESSES = 512;
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

/** Para que serve o processo que está custando CPU/memória nesta câmera. */
export type TrackedProcessKind = 'recording' | 'prebuffer' | 'transcode' | 'other';

const TRACKED_PROCESS_KINDS: readonly TrackedProcessKind[] = ['recording', 'prebuffer', 'transcode', 'other'];

export type ProcessUsageDetail = {
  pid: number;
  kind: TrackedProcessKind;
  /** null = ainda não medido (nunca 0: 0 seria "não consome nada"). */
  cpuPercent: number | null;
  memoryBytes: number | null;
  sampledAt: Date | null;
};

export type CameraProcessUsage = {
  cameraId: string;
  /** Soma do CPU% dos processos desta câmera (100 = um núcleo). */
  cpuPercent: number;
  memoryBytes: number;
  processes: number;
  /** Quantos desses já têm medida de CPU (o resto ainda não tem base). */
  measuredProcesses: number;
  details: ProcessUsageDetail[];
};

export type HostProcessUsage = {
  cpuPercent: number;
  memoryBytes: number;
  processes: number;
  measuredProcesses: number;
  /** Câmeras COM medida — é o `n` da extrapolação de capacidade. */
  cameras: number;
  cpuBudgetCores: number;
  cpuPercentPerCamera: number | null;
  cpuSaturation: number | null;
  estimatedCameraCapacity: number | null;
};

type ProcessEntry = {
  pid: number;
  cameraId: string;
  kind: TrackedProcessKind;
  cpuPercent: number | null;
  memoryBytes: number | null;
  sampledAtMs: number | null;
};

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
  /** PID → câmera dona. Ordem de inserção = ordem de despejo pelo teto. */
  private readonly processes = new Map<number, ProcessEntry>();
  private readonly clock: () => number;
  private readonly cpuBudgetCores: () => number;

  /**
   * `clock` e `cpuBudgetCores` são costuras de teste; em produção são o relógio
   * do sistema e a cota de CPU real (cgroup do container, senão os núcleos).
   */
  constructor(
    clock: () => number = () => Date.now(),
    cpuBudgetCores: () => number = () => resolveCpuBudgetCores(),
  ) {
    this.clock = clock;
    this.cpuBudgetCores = cpuBudgetCores;
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

  // ── custo por processo, atribuído à câmera ────────────────────────────────
  //
  // É a métrica que responde "quantas câmeras cabem neste servidor". Sem ela a
  // resposta é chute, e chute erra para os dois lados: sobra = margem jogada
  // fora; falta = SLA quebrado. Como TUDO aqui é chamado de dentro do caminho
  // de gravação, nenhum destes métodos lança.

  /**
   * Passa a contabilizar CPU/RSS de um PID na conta desta câmera.
   * Chamar logo após o spawn, com o pid do processo filho.
   */
  trackProcess(cameraId: string, kind: TrackedProcessKind, pid: number): void {
    try {
      const id = this.normalizeId(cameraId);
      if (!id) return;
      if (!Number.isInteger(pid) || pid <= 0) return;
      // Re-registrar o mesmo PID zera a medida: ou é outro processo (o SO
      // recicla PIDs) ou é outra câmera — em ambos os casos a amostra antiga
      // pertence a outra coisa.
      this.processes.delete(pid);
      if (this.processes.size >= CAMERA_METRICS_MAX_PROCESSES) this.evictOldestProcess();
      this.processes.set(pid, {
        pid,
        cameraId: id,
        kind: TRACKED_PROCESS_KINDS.includes(kind) ? kind : 'other',
        cpuPercent: null,
        memoryBytes: null,
        sampledAtMs: null,
      });
    } catch {
      /* observabilidade jamais interrompe gravação/stream */
    }
  }

  /** O processo morreu (ou foi parado): sai da conta. Idempotente. */
  untrackProcess(pid: number): void {
    try {
      if (!Number.isInteger(pid) || pid <= 0) return;
      this.processes.delete(pid);
    } catch {
      /* idem */
    }
  }

  /** Limpa todos os processos de uma câmera (parada/desativação). */
  untrackCameraProcesses(cameraId: string): void {
    try {
      const id = this.normalizeId(cameraId);
      if (!id) return;
      for (const [pid, entry] of this.processes) {
        if (entry.cameraId === id) this.processes.delete(pid);
      }
    } catch {
      /* idem */
    }
  }

  trackedPids(): number[] {
    return [...this.processes.keys()];
  }

  get trackedProcessCount(): number {
    return this.processes.size;
  }

  /** Aplica as leituras do amostrador. PID de ninguém é descartado. */
  observeProcessUsage(
    readings: Iterable<{ pid: number; cpuPercent: number | null; rssBytes: number | null }>,
  ): void {
    try {
      const now = this.clock();
      for (const reading of readings ?? []) {
        const entry = this.processes.get(Number(reading?.pid));
        if (!entry) continue;
        const cpu = Number(reading.cpuPercent);
        const rss = Number(reading.rssBytes);
        entry.cpuPercent = reading.cpuPercent != null && Number.isFinite(cpu) && cpu >= 0 ? cpu : null;
        entry.memoryBytes = reading.rssBytes != null && Number.isFinite(rss) && rss >= 0 ? rss : null;
        entry.sampledAtMs = now;
      }
    } catch {
      /* idem */
    }
  }

  /** Custo de UMA câmera. Câmera desconhecida devolve zeros sem alocar nada. */
  processUsage(cameraId: string): CameraProcessUsage {
    const id = this.normalizeId(cameraId) ?? String(cameraId ?? '');
    const usage = emptyProcessUsage(id);
    for (const entry of this.processes.values()) {
      if (entry.cameraId !== id) continue;
      accumulate(usage, entry);
    }
    usage.cpuPercent = round2(usage.cpuPercent);
    return usage;
  }

  /** Custo de TODAS as câmeras com processo rastreado, numa passada só. */
  processUsageByCamera(): CameraProcessUsage[] {
    const byCamera = new Map<string, CameraProcessUsage>();
    for (const entry of this.processes.values()) {
      let usage = byCamera.get(entry.cameraId);
      if (!usage) {
        usage = emptyProcessUsage(entry.cameraId);
        byCamera.set(entry.cameraId, usage);
      }
      accumulate(usage, entry);
    }
    for (const usage of byCamera.values()) usage.cpuPercent = round2(usage.cpuPercent);
    return [...byCamera.values()];
  }

  /** O agregado do host: "estamos no limite?" e "cabe mais quantas?". */
  processUsageTotals(): HostProcessUsage {
    const byCamera = this.processUsageByCamera();
    let cpuPercent = 0;
    let memoryBytes = 0;
    let processes = 0;
    let measuredProcesses = 0;
    let cameras = 0;
    for (const usage of byCamera) {
      cpuPercent += usage.cpuPercent;
      memoryBytes += usage.memoryBytes;
      processes += usage.processes;
      measuredProcesses += usage.measuredProcesses;
      // Só entra no `n` da extrapolação quem tem MEDIDA. Contar uma câmera
      // ainda não medida como 0% baixaria a média e responderia "cabe o dobro".
      if (usage.measuredProcesses > 0) cameras += 1;
    }

    const cpuBudgetCores = this.readCpuBudget();
    const capacity = estimateCameraCapacity({ cpuPercentTotal: cpuPercent, cameras, cpuBudgetCores });
    return {
      cpuPercent: round2(cpuPercent),
      memoryBytes,
      processes,
      measuredProcesses,
      cameras,
      cpuBudgetCores,
      ...capacity,
    };
  }

  private readCpuBudget(): number {
    try {
      const cores = Number(this.cpuBudgetCores());
      return Number.isFinite(cores) && cores > 0 ? cores : 0;
    } catch {
      return 0;
    }
  }

  private evictOldestProcess(): void {
    const oldest = this.processes.keys().next();
    if (!oldest.done) this.processes.delete(oldest.value);
  }

  get size(): number {
    return this.cameras.size;
  }

  /** Limpa tudo (uso em teste; não há caminho de produção que chame). */
  reset(): void {
    this.cameras.clear();
    this.processes.clear();
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

function emptyProcessUsage(cameraId: string): CameraProcessUsage {
  return { cameraId, cpuPercent: 0, memoryBytes: 0, processes: 0, measuredProcesses: 0, details: [] };
}

function accumulate(usage: CameraProcessUsage, entry: ProcessEntry): void {
  usage.processes += 1;
  if (entry.cpuPercent != null) {
    usage.cpuPercent += entry.cpuPercent;
    usage.measuredProcesses += 1;
  }
  if (entry.memoryBytes != null) usage.memoryBytes += entry.memoryBytes;
  usage.details.push({
    pid: entry.pid,
    kind: entry.kind,
    cpuPercent: entry.cpuPercent,
    memoryBytes: entry.memoryBytes,
    sampledAt: entry.sampledAtMs == null ? null : new Date(entry.sampledAtMs),
  });
}

/** Soma de floats vira 45.000000000000004: arredonda na saída, não na conta. */
function round2(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

// Instância ÚNICA do processo. Os hooks de gravação/stream a importam direto
// (sem DI) para que instrumentar não exija mexer nos construtores desses
// serviços críticos; o módulo Nest publica ESTA MESMA instância como provider
// (useValue), então API e /metrics leem exatamente o mesmo registro.
export const cameraMetrics = new CameraMetricsService();
