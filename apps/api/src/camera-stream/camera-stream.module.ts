import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { CamerasModule } from '../cameras/cameras.module';
import { CameraStreamController } from './camera-stream.controller';
import { ClipCaptureService } from './clip-capture.service';
import { FfmpegMjpegService } from './ffmpeg-mjpeg.service';
import { MediamtxProxyService } from './mediamtx-proxy.service';
// Fase 3: registro/roteamento de origem por câmera. Fica INERTE enquanto
// CAMERA_SOURCE_GATEWAY_ENABLED não for 'true' (default) — nenhum consumidor
// muda de origem, nenhum timer sobe. Ver source-gateway.service.ts.
import { SourceGatewayService } from './source-gateway.service';
import { StreamResourceAdvisorService } from './stream-resource-advisor.service';

@Module({
  imports: [CamerasModule, AuthModule, AuditModule, AccessControlModule],
  controllers: [CameraStreamController],
  providers: [
    ClipCaptureService,
    FfmpegMjpegService,
    MediamtxProxyService,
    SourceGatewayService,
    StreamResourceAdvisorService,
  ],
  exports: [FfmpegMjpegService, MediamtxProxyService, SourceGatewayService, StreamResourceAdvisorService],
})
export class CameraStreamModule {}
