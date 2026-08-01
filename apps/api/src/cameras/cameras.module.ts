import { PendingIngestRegistry } from './pending-ingest.registry';
import { forwardRef, Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { AlarmsModule } from '../alarms/alarms.module';
import { AuditModule } from '../audit/audit.module';
import { RecordingsModule } from '../recordings/recordings.module';
import { CamerasController } from './cameras.controller';
import { CamerasService } from './cameras.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { PortCheckerService } from '../common/network/port-checker.service';
import { OnvifEventsService } from './onvif-events.service';

@Module({
  imports: [AuditModule, AccessControlModule, AlarmsModule, forwardRef(() => RecordingsModule)],
  controllers: [CamerasController],
  providers: [PendingIngestRegistry, CamerasService, CryptoService, PortCheckerService, OnvifEventsService],
  exports: [PendingIngestRegistry, CamerasService, CryptoService, PortCheckerService, OnvifEventsService],
})
export class CamerasModule {}
