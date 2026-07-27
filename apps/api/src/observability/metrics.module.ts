import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { RecordingsModule } from '../recordings/recordings.module';
import { CameraMetricsService, cameraMetrics } from './camera-metrics.service';
import { CameraObservabilityService } from './camera-observability.service';
import { MetricsController } from './metrics.controller';
import { ObservabilityController } from './observability.controller';

@Module({
  imports: [RecordingsModule, PrismaModule],
  controllers: [MetricsController, ObservabilityController],
  providers: [
    // useValue com a instância de módulo: os hooks em recording-process-manager
    // e mediamtx-proxy escrevem no singleton importado direto. Se aqui o Nest
    // instanciasse uma classe NOVA, a API leria um registro sempre vazio.
    { provide: CameraMetricsService, useValue: cameraMetrics },
    CameraObservabilityService,
  ],
  exports: [CameraMetricsService],
})
export class MetricsModule {}
