import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuditModule } from '../audit/audit.module';
import { CamerasModule } from '../cameras/cameras.module';
import { PtzController } from './ptz.controller';
import { OnvifPtzService } from './onvif-ptz.service';
import { PtzStateStore } from './ptz-state.store';
import { PtzCapabilityService } from './ptz-capability.service';

@Module({
  imports: [CamerasModule, AuditModule, AccessControlModule],
  controllers: [PtzController],
  providers: [OnvifPtzService, PtzStateStore, PtzCapabilityService],
  // Exportado para o cadastro de câmera e o health-check dispararem a sonda.
  // Eles pegam via ModuleRef (preguiçoso) porque este módulo já importa
  // CamerasModule — pedir o inverso criaria ciclo.
  exports: [PtzCapabilityService],
})
export class PtzModule {}
