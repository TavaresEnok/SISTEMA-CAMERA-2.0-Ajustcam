import { Controller, Get, Header } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { RecordingProcessManagerService } from '../recordings/recording-process-manager.service';
import { formatPrometheus, type Metric } from './prometheus.helper';

// /metrics no formato Prometheus. AGREGADO por design (sem labels de câmera/URL/IP)
// para não vazar PII nem explodir cardinalidade — a correlação por instalação fica
// na Central autenticada (regra de cardinalidade/PII do item 2.3).
@Controller()
export class MetricsController {
  constructor(private readonly recordings: RecordingProcessManagerService) {}

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
    return formatPrometheus(metrics);
  }
}
