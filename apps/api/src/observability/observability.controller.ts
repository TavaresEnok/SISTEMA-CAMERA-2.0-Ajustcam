import { Controller, Get } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../role-permissions/require-permission.decorator';
import { CameraObservabilityService, type CameraHealthReport } from './camera-observability.service';

// Contrato A — saúde por câmera com DADOS RICOS (nome incluso).
//
// AUTENTICADA de propósito: NÃO leva @Public. O JwtAuthGuard global barra quem
// não tem token; @Roles(ADMIN) + @RequirePermission('serverConfig') seguem o
// mesmo padrão das demais rotas de diagnóstico do servidor (camera-stream/stats,
// ai/rollout/summary). O gêmeo público é o /metrics — e lá só entra camera_id.
@Controller('observability')
export class ObservabilityController {
  constructor(private readonly cameraObservability: CameraObservabilityService) {}

  @Roles(UserRole.ADMIN)
  @RequirePermission('serverConfig')
  @Get('cameras')
  async cameras(): Promise<CameraHealthReport> {
    return this.cameraObservability.getCamerasHealth();
  }
}
