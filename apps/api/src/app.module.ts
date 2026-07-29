import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { envConfig } from './config/env.config';
import { PrismaModule } from './common/prisma/prisma.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './observability/metrics.module';
import { CamerasModule } from './cameras/cameras.module';
import { CameraStreamModule } from './camera-stream/camera-stream.module';
import { PtzModule } from './ptz/ptz.module';
import { JobsModule } from './jobs/jobs.module';
import { RecordingsModule } from './recordings/recordings.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { AuditModule } from './audit/audit.module';
import { SitesModule } from './sites/sites.module';
import { AreasModule } from './areas/areas.module';
import { CameraGroupsModule } from './camera-groups/camera-groups.module';
import { ReviewModule } from './review/review.module';
import { CameraPermissionsModule } from './camera-permissions/camera-permissions.module';
import { AiModule } from './ai/ai.module';
import { SiteMapLayoutsModule } from './site-map-layouts/site-map-layouts.module';
import { EvidenceModule } from './evidence/evidence.module';
import { AlarmsModule } from './alarms/alarms.module';
import { NotificationsModule } from './notifications/notifications.module';
import { IntegrityModule } from './integrity/integrity.module';
import { InvestigationsModule } from './investigations/investigations.module';
import { SettingsModule } from './settings/settings.module';
import { GpuModule } from './gpu/gpu.module';
import { RolePermissionsModule } from './role-permissions/role-permissions.module';
import { CloudConnectorModule } from './cloud-connector/cloud-connector.module';
import { CloudStorageModule } from './cloud-storage/cloud-storage.module';
import { CommercialPolicyModule } from './commercial-policy/commercial-policy.module';
import { AppBuilderModule } from './app-builder/app-builder.module';
import { LiveLayoutsModule } from './live-layouts/live-layouts.module';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [envConfig],
    }),
    ThrottlerModule.forRoot([
      // Default rate limit: 300 requests per 60 seconds (~5 req/sec)
      // This is more lenient to support grid views with multiple cameras
      {
        ttl: 60000,
        limit: 300,
      },
    ]),
    PrismaModule,
    CommercialPolicyModule,
    SettingsModule,
    AppBuilderModule,
    LiveLayoutsModule,
    GpuModule,
    RolePermissionsModule,
    CloudConnectorModule,
    CloudStorageModule,
    MetricsModule,
    HealthModule,
    AuthModule,
    UsersModule,
    AuditModule,
    SitesModule,
    AreasModule,
    SiteMapLayoutsModule,
    EvidenceModule,
    AlarmsModule,
    NotificationsModule,
    IntegrityModule,
    InvestigationsModule,
    CameraGroupsModule,
    ReviewModule,
    CameraPermissionsModule,
    CamerasModule,
    CameraStreamModule,
    PtzModule,
    RecordingsModule,
    JobsModule,
    AiModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
