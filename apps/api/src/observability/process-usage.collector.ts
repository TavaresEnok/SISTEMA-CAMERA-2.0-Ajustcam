import { Injectable, Logger, Optional, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { CameraMetricsService } from './camera-metrics.service';
import { ProcessUsageSampler } from './proc-sampler';

// ─────────────────────────────────────────────────────────────────────────────
// Relógio da amostragem de custo por processo.
//
// Lê APENAS os PIDs registrados em CameraMetricsService (2 arquivos de /proc por
// processo da frota — nada de varrer o host, nada de spawnar `ps`). O intervalo
// é configurável porque ele é o compromisso entre custo e resolução: 10s dá um
// gráfico útil por ~0,1ms de leitura de arquivos.
//
// À PROVA DE FALHA em três camadas: sem /proc o coletor nem liga; uma exceção na
// coleta é engolida (e NÃO desregistra ninguém — processo vivo continua vivo); e
// o timer é `unref` para não segurar o desligamento da API.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_INTERVAL_MS = 10_000;
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 5 * 60_000;

@Injectable()
export class ProcessUsageCollector implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ProcessUsageCollector.name);
  private readonly sampler: ProcessUsageSampler;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly metrics: CameraMetricsService,
    @Optional() sampler?: ProcessUsageSampler,
  ) {
    this.sampler = sampler ?? new ProcessUsageSampler();
  }

  onModuleInit(): void {
    if (!this.enabled()) {
      this.logger.log('Custo por processo desativado (sem /proc ou PROCESS_METRICS_ENABLED=false).');
      return;
    }
    const intervalMs = this.intervalMs();
    this.timer = setInterval(() => this.collectOnce(), intervalMs);
    this.timer.unref();
    this.logger.log(`Custo por processo ativo (intervalo ${intervalMs}ms).`);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Uma rodada. NUNCA lança. */
  collectOnce(): void {
    if (!this.enabled()) return;
    try {
      const pids = this.metrics.trackedPids();
      if (!pids.length) return;
      const { readings, deadPids } = this.sampler.sample(pids);
      this.metrics.observeProcessUsage(readings);
      for (const pid of deadPids) {
        this.metrics.untrackProcess(pid);
        this.sampler.forget(pid);
      }
    } catch {
      // Uma falha de amostragem não pode desregistrar processo vivo nem
      // propagar para o caminho de gravação.
    }
  }

  private enabled(): boolean {
    if (!this.sampler?.available) return false;
    return String(process.env.PROCESS_METRICS_ENABLED ?? 'true').toLowerCase() !== 'false';
  }

  private intervalMs(): number {
    const raw = Number(process.env.PROCESS_METRICS_INTERVAL_MS);
    if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_INTERVAL_MS;
    return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(raw)));
  }
}
