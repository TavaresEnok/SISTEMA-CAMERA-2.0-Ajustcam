import { Controller, Get, Header } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { RecordingProcessManagerService } from '../recordings/recording-process-manager.service';
import { CameraMetricsService } from './camera-metrics.service';
import { buildCameraSeries, buildProcessSeries } from './camera-prometheus.helper';
import { formatPrometheus, type Metric } from './prometheus.helper';

// /metrics no formato Prometheus. As séries AGREGADAS seguem sem qualquer rótulo;
// as séries POR CÂMERA (contrato B) usam EXCLUSIVAMENTE o rótulo camera_id — este
// endpoint é @Public e nome/IP/URL entregariam o cliente e a topologia da
// instalação (regra de cardinalidade/PII do item 2.3). A correlação id→nome fica
// na rota AUTENTICADA GET /observability/cameras (e na Central).
//
// Nada aqui consulta o banco: um endpoint público que fosse ao Postgres a cada
// scrape viraria amplificador de carga sobre o banco que sustenta a gravação.
// As séries por câmera saem do registro EM MEMÓRIA.
@Controller()
export class MetricsController {
  constructor(
    private readonly recordings: RecordingProcessManagerService,
    private readonly cameraMetrics: CameraMetricsService,
  ) {}

  @Public()
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  metrics(): string {
    const mem = process.memoryUsage();
    const metrics: Metric[] = [
      { name: 'drac_api_up', help: 'API respondendo (sempre 1 quando o endpoint responde)', type: 'gauge', value: 1 },
      { name: 'drac_api_uptime_seconds', help: 'Uptime do processo da API em segundos', type: 'gauge', value: Math.round(process.uptime()) },
      { name: 'drac_api_resident_memory_bytes', help: 'Memória residente (RSS) do processo da API', type: 'gauge', value: mem.rss },
      { name: 'drac_api_heap_used_bytes', help: 'Heap V8 em uso', type: 'gauge', value: mem.heapUsed },
      { name: 'drac_recordings_active', help: 'Gravações locais ativas neste host', type: 'gauge', value: this.recordings.getActiveRecordingCount() },
    ];
    // ADITIVO: as séries por câmera entram DEPOIS das agregadas, que continuam
    // byte-a-byte como estavam (dashboards/alertas existentes não quebram).
    metrics.push(...this.buildCameraMetrics());
    // Custo (CPU/RSS) por câmera + agregado do host. Em bloco próprio: se a
    // amostragem de /proc falhar, ela some sozinha e o resto do /metrics fica.
    metrics.push(...this.buildProcessMetrics());
    return formatPrometheus(metrics);
  }

  private buildProcessMetrics(): Metric[] {
    try {
      return buildProcessSeries({
        usages: this.cameraMetrics.processUsageByCamera(),
        totals: this.cameraMetrics.processUsageTotals(),
      });
    } catch {
      return [];
    }
  }

  private buildCameraMetrics(): Metric[] {
    try {
      const activeCameraIds = this.recordings.getRuntimeSummary().activeCameraIds ?? [];
      return buildCameraSeries({ snapshots: this.cameraMetrics.snapshotAll(), activeCameraIds });
    } catch {
      // Uma falha na parte NOVA nunca pode derrubar o /metrics que já existia.
      return [];
    }
  }
}
