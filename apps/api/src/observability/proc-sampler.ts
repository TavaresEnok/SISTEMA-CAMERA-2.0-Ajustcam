import { readFileSync } from 'fs';
import { cpus } from 'os';

// ─────────────────────────────────────────────────────────────────────────────
// CUSTO POR PROCESSO (CPU% e RSS) lido do /proc do Linux.
//
// Derivado de Frigate (MIT) — frigate/util/services.py::get_cpu_stats
//   Copyright (c) Blake Blackshear and Frigate contributors.
// Aproveitado dali: os índices dos campos de /proc/<pid>/stat (utime=14,
// stime=15, starttime=22) e a ideia de atribuir o custo do host por PID.
//
// O QUE MUDOU DE PROPÓSITO (as três diferenças importam):
//  1. PRIVACIDADE. O Frigate publica `cmdline` como rótulo do Prometheus. Aqui
//     isso é proibido: a linha de comando do FFmpeg de gravação carrega a URL
//     RTSP COM SENHA e o nosso /metrics é público. Deste arquivo não sai NADA
//     que identifique o processo além do PID — e o PID não vira rótulo.
//  2. DERIVADA, não média de vida. O Frigate calcula usage/elapsed desde o
//     início do processo. Um FFmpeg de pé há uma semana mostraria uma média
//     mansa mesmo comendo 80% de um núcleo agora. Como esta métrica existe para
//     responder "cabe mais câmera neste host?", ela é a derivada entre DUAS
//     amostras.
//  3. CUSTO. O Frigate varre TODOS os processos do host (psutil.process_iter) e
//     casa por cmdline. Aqui só se lê o /proc dos PIDs REGISTRADOS: 2 leituras
//     de arquivo por processo da frota, nada de spawn de `ps`.
//
// À PROVA DE FALHA: em SO sem /proc, com /proc ilegível ou com formato
// inesperado, a métrica simplesmente NÃO EXISTE. Nada aqui lança para o
// chamador — observabilidade não pode derrubar gravação.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * USER_HZ. O kernel expõe os tempos de /proc em "ticks de usuário", que valem
 * 100 Hz na ABI de userspace do Linux independentemente do CONFIG_HZ com que o
 * kernel foi compilado (é o valor que `getconf CLK_TCK` devolve). O Node não
 * tem sysconf(); em vez de spawnar `getconf` deixamos o valor explícito e
 * sobrescrevível por ambiente.
 */
export const DEFAULT_CLOCK_TICKS_PER_SECOND = 100;

/** Índices no vetor de campos que vem DEPOIS do `comm` (campo 3 = índice 0). */
const FIELD_UTIME = 11; // campo 14
const FIELD_STIME = 12; // campo 15
const FIELD_STARTTIME = 19; // campo 22

export type ProcStatSample = {
  pid: number;
  utimeTicks: number;
  stimeTicks: number;
  /** Instante do nascimento do processo, em ticks desde o boot: identidade do PID. */
  startTimeTicks: number;
};

/**
 * Lê uma linha de /proc/<pid>/stat.
 *
 * A sutileza que quebra o parser ingênuo: o campo 2 é o `comm`, escrito entre
 * parênteses e SEM escape nenhum. Um processo chamado "ff mpeg (rec)" desloca
 * todos os campos num split por espaço — e aí "CPU" passaria a ler prioridade
 * ou nº de threads. Por isso o corte é pelo ÚLTIMO ')' da linha.
 */
export function parseProcStat(raw: string): ProcStatSample | null {
  if (typeof raw !== 'string' || !raw) return null;
  const open = raw.indexOf('(');
  const close = raw.lastIndexOf(')');
  if (open < 0 || close < 0 || close < open) return null;

  const pid = Number(raw.slice(0, open).trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;

  const fields = raw.slice(close + 1).trim().split(/\s+/);
  const utimeTicks = Number(fields[FIELD_UTIME]);
  const stimeTicks = Number(fields[FIELD_STIME]);
  const startTimeTicks = Number(fields[FIELD_STARTTIME]);
  if (!Number.isFinite(utimeTicks) || !Number.isFinite(stimeTicks) || !Number.isFinite(startTimeTicks)) return null;
  if (utimeTicks < 0 || stimeTicks < 0 || startTimeTicks < 0) return null;

  return { pid, utimeTicks, stimeTicks, startTimeTicks };
}

/**
 * RSS em bytes a partir de /proc/<pid>/status (VmRSS, em kB).
 *
 * Usamos VmRSS e não o campo 24 do stat porque é o mesmo número que o operador
 * vê no `top`/`ps` — quando alguém contesta a conta de memória, os dois têm que
 * bater. Zumbi não tem VmRSS: devolve null (desconhecido), nunca 0 (que seria
 * "não consome nada").
 */
export function parseVmRssBytes(raw: string): number | null {
  if (typeof raw !== 'string' || !raw) return null;
  const match = /^VmRSS:\s*(\d+)\s*kB/m.exec(raw);
  if (!match) return null;
  const kb = Number(match[1]);
  if (!Number.isFinite(kb) || kb < 0) return null;
  return kb * 1024;
}

export type CpuTickPoint = { cpuTicks: number; atMs: number };

/**
 * CPU% entre duas amostras. 100 = um núcleo saturado (um transcode
 * multi-thread passa disso, e deve mesmo passar).
 *
 * A normalização pelo TEMPO DECORRIDO é o ponto: sem ela o número passaria a
 * depender do intervalo de amostragem, e trocar o intervalo de 10s para 5s
 * dobraria o "consumo" de toda a frota nos gráficos.
 *
 * Devolve null (desconhecido) em vez de número quando não dá para saber:
 * relógio parado/para trás, ou contador que regrediu (PID reciclado).
 */
export function computeCpuPercent(
  prev: CpuTickPoint,
  next: CpuTickPoint,
  ticksPerSecond: number = DEFAULT_CLOCK_TICKS_PER_SECOND,
): number | null {
  const elapsedMs = next.atMs - prev.atMs;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
  const deltaTicks = next.cpuTicks - prev.cpuTicks;
  if (!Number.isFinite(deltaTicks) || deltaTicks < 0) return null;
  const hz = Number.isFinite(ticksPerSecond) && ticksPerSecond > 0 ? ticksPerSecond : DEFAULT_CLOCK_TICKS_PER_SECOND;
  const cpuSeconds = deltaTicks / hz;
  const elapsedSeconds = elapsedMs / 1000;
  return round(cpuSeconds / elapsedSeconds * 100, 2);
}

// ── orçamento de CPU: o DENOMINADOR de "o host está no limite?" ─────────────

/**
 * cgroup v2: `<quota> <period>` em microssegundos, ou "max <period>".
 * Dentro de container a cota vale MAIS que o nº de núcleos do host — dizer
 * "sobram 8 núcleos" para um container limitado a 2 é como vender o servidor
 * do vizinho.
 */
export function parseCgroupCpuMax(raw: string): number | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 2) return null;
  if (parts[0] === 'max') return null;
  const quota = Number(parts[0]);
  const period = Number(parts[1]);
  if (!Number.isFinite(quota) || !Number.isFinite(period) || quota <= 0 || period <= 0) return null;
  return quota / period;
}

/** cgroup v1: cpu.cfs_quota_us / cpu.cfs_period_us (quota -1 = sem limite). */
export function parseCgroupCpuV1(quotaRaw: string, periodRaw: string): number | null {
  const quota = Number(String(quotaRaw ?? '').trim());
  const period = Number(String(periodRaw ?? '').trim());
  if (!Number.isFinite(quota) || !Number.isFinite(period) || quota <= 0 || period <= 0) return null;
  return quota / period;
}

export type CpuBudgetDeps = {
  readFile?: (path: string) => string;
  coreCount?: () => number;
};

/** Núcleos REALMENTE disponíveis: cota do cgroup se houver, senão os do host. */
export function readCpuBudgetCores(deps: CpuBudgetDeps = {}): number {
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  try {
    const v2 = parseCgroupCpuMax(readFile('/sys/fs/cgroup/cpu.max'));
    if (v2 != null && v2 > 0) return v2;
  } catch { /* sem cgroup v2 */ }
  try {
    const v1 = parseCgroupCpuV1(
      readFile('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'),
      readFile('/sys/fs/cgroup/cpu/cpu.cfs_period_us'),
    );
    if (v1 != null && v1 > 0) return v1;
  } catch { /* sem cgroup v1 */ }
  try {
    const count = (deps.coreCount ?? (() => cpus().length))();
    if (Number.isFinite(count) && count > 0) return count;
  } catch { /* ambiente sem os.cpus() */ }
  return 1;
}

let cachedCpuBudget: number | null = null;

/** Igual ao acima, memoizado: é lido a cada scrape do /metrics. */
export function resolveCpuBudgetCores(): number {
  if (cachedCpuBudget == null) cachedCpuBudget = readCpuBudgetCores();
  return cachedCpuBudget;
}

// ── a pergunta comercial: quantas câmeras cabem neste servidor ───────────────

export type CapacityInput = {
  /** Soma do CPU% atribuído a câmeras (100 = um núcleo). */
  cpuPercentTotal: number;
  /** Quantas câmeras entraram nessa soma COM MEDIDA (n da amostra). */
  cameras: number;
  cpuBudgetCores: number;
  /** Folga reservada para pico/OS/banco. Padrão 20%. */
  headroomRatio?: number;
};

export type CapacityEstimate = {
  cpuPercentPerCamera: number | null;
  /** 0..1+ do orçamento de CPU consumido pelas câmeras. */
  cpuSaturation: number | null;
  estimatedCameraCapacity: number | null;
};

/**
 * Extrapola a média medida. Deliberadamente conservador e deliberadamente
 * MUDO quando não há base: com n=0 câmeras medidas a resposta é null, não um
 * número — palpite com n=0 é exatamente o que faz vender hardware errado (sobra
 * = margem jogada fora, falta = SLA quebrado).
 *
 * Se o host já está estourado, a conta devolve MENOS câmeras do que as
 * instaladas. É a resposta honesta: "tira duas daqui".
 */
export function estimateCameraCapacity(input: CapacityInput): CapacityEstimate {
  const cores = Number(input.cpuBudgetCores);
  const budgetPercent = Number.isFinite(cores) && cores > 0 ? cores * 100 : null;
  const total = Number.isFinite(input.cpuPercentTotal) ? input.cpuPercentTotal : 0;
  const cameras = Number.isFinite(input.cameras) && input.cameras > 0 ? Math.floor(input.cameras) : 0;

  const headroom = Number.isFinite(input.headroomRatio as number)
    ? Math.min(0.9, Math.max(0, input.headroomRatio as number))
    : 0.2;

  const cpuPercentPerCamera = cameras > 0 ? round(total / cameras, 2) : null;
  const cpuSaturation = budgetPercent == null ? null : round(total / budgetPercent, 4);

  let estimatedCameraCapacity: number | null = null;
  if (budgetPercent != null && cpuPercentPerCamera != null && cpuPercentPerCamera > 0) {
    estimatedCameraCapacity = Math.floor(budgetPercent * (1 - headroom) / cpuPercentPerCamera);
  }

  return { cpuPercentPerCamera, cpuSaturation, estimatedCameraCapacity };
}

// ── amostrador ───────────────────────────────────────────────────────────────

export type ProcessUsageReading = {
  pid: number;
  /** null = ainda desconhecido (primeira amostra ou base inválida). */
  cpuPercent: number | null;
  rssBytes: number | null;
  startTimeTicks: number;
  atMs: number;
};

export type ProcessSampleResult = {
  readings: ProcessUsageReading[];
  /** PIDs que sumiram do /proc: o chamador deve desregistrá-los. */
  deadPids: number[];
};

export type ProcessUsageSamplerOptions = {
  readFile?: (path: string) => string;
  clock?: () => number;
  ticksPerSecond?: number;
  procRoot?: string;
};

type Baseline = { cpuTicks: number; atMs: number; startTimeTicks: number };

export class ProcessUsageSampler {
  private readonly baselines = new Map<number, Baseline>();
  private readonly readFile: (path: string) => string;
  private readonly clock: () => number;
  private readonly ticksPerSecond: number;
  private readonly procRoot: string;
  /** false = este SO não tem /proc legível; a métrica some, nada quebra. */
  readonly available: boolean;

  constructor(options: ProcessUsageSamplerOptions = {}) {
    this.readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
    this.clock = options.clock ?? (() => Date.now());
    this.procRoot = options.procRoot ?? '/proc';
    const envHz = Number(process.env.PROC_CLOCK_TICKS_PER_SECOND);
    this.ticksPerSecond = options.ticksPerSecond
      ?? (Number.isFinite(envHz) && envHz > 0 ? envHz : DEFAULT_CLOCK_TICKS_PER_SECOND);
    this.available = this.probe();
  }

  private probe(): boolean {
    try {
      return parseProcStat(this.readFile(`${this.procRoot}/self/stat`)) != null;
    } catch {
      return false;
    }
  }

  /**
   * Lê os PIDs pedidos. NUNCA lança.
   *
   * Cuidado deliberado: com o /proc indisponível NENHUM PID é reportado morto.
   * Marcar processos vivos como mortos apagaria do relatório de custo justamente
   * as câmeras que estão consumindo o host.
   */
  sample(pids: Iterable<number>): ProcessSampleResult {
    const readings: ProcessUsageReading[] = [];
    const deadPids: number[] = [];
    if (!this.available) return { readings, deadPids };

    const requested = new Set<number>();
    const now = this.clock();

    try {
      for (const candidate of pids ?? []) {
        const pid = Number(candidate);
        if (!Number.isInteger(pid) || pid <= 0 || requested.has(pid)) continue;
        requested.add(pid);

        let statRaw: string;
        try {
          statRaw = this.readFile(`${this.procRoot}/${pid}/stat`);
        } catch (error) {
          // Sumiu do /proc = morreu. Qualquer OUTRO erro (permissão, I/O) é
          // ignorado: o processo continua vivo e continua custando CPU.
          if (isMissing(error)) {
            deadPids.push(pid);
            this.baselines.delete(pid);
          }
          continue;
        }

        const stat = parseProcStat(statRaw);
        if (!stat) continue;

        const cpuTicks = stat.utimeTicks + stat.stimeTicks;
        let rssBytes: number | null = null;
        try {
          rssBytes = parseVmRssBytes(this.readFile(`${this.procRoot}/${pid}/status`));
        } catch {
          rssBytes = null; // stat leu: o processo existe. RSS fica desconhecido.
        }

        const previous = this.baselines.get(pid);
        // starttime diferente = o SO reciclou o PID. A base anterior é de OUTRO
        // processo; usá-la produziria um CPU% absurdo (ou negativo).
        const cpuPercent = previous && previous.startTimeTicks === stat.startTimeTicks
          ? computeCpuPercent(previous, { cpuTicks, atMs: now }, this.ticksPerSecond)
          : null;

        this.baselines.set(pid, { cpuTicks, atMs: now, startTimeTicks: stat.startTimeTicks });
        readings.push({ pid, cpuPercent, rssBytes, startTimeTicks: stat.startTimeTicks, atMs: now });
      }

      // A memória do amostrador acompanha o registro, não o histórico.
      for (const pid of [...this.baselines.keys()]) {
        if (!requested.has(pid)) this.baselines.delete(pid);
      }
    } catch {
      /* iterável quebrado: devolve o que já deu */
    }

    return { readings, deadPids };
  }

  forget(pid: number): void {
    this.baselines.delete(pid);
  }

  get baselineSize(): number {
    return this.baselines.size;
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ESRCH';
}

function round(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
