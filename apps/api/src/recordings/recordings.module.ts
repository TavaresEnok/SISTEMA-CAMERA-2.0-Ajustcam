import { forwardRef, Module } from '@nestjs/common';
import { CloudConnectorModule } from '../cloud-connector/cloud-connector.module';
import { BullModule } from '@nestjs/bullmq';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { CamerasModule } from '../cameras/cameras.module';
import { PrismaModule } from '../common/prisma/prisma.module';
import { RecordingsController } from './recordings.controller';
import { RecordingProcessManagerService } from './recording-process-manager.service';
import { RecordingsService } from './recordings.service';
import { THUMBNAIL_GENERATION_QUEUE } from '../jobs/queues/thumbnail-generation.queue';
import { RECORDING_EXPORT_QUEUE } from '../jobs/queues/recording-export.queue';
import { InvestigationsModule } from '../investigations/investigations.module';

import { RetentionService } from './retention.service';

@Module({
  imports: [
    CloudConnectorModule,
    forwardRef(() => CamerasModule),
    PrismaModule,
    AuthModule,
    AuditModule,
    AccessControlModule,
    InvestigationsModule,
    BullModule.registerQueue({ name: THUMBNAIL_GENERATION_QUEUE }, { name: RECORDING_EXPORT_QUEUE }),
  ],
  controllers: [RecordingsController],
  providers: [RecordingProcessManagerService, RecordingsService, RetentionService],
  exports: [RecordingProcessManagerService, RecordingsService, RetentionService],
})
export class RecordingsModule {}
