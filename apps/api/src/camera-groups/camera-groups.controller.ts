import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthUser } from '../common/types/auth-user.type';
import { RequirePermission } from '../role-permissions/require-permission.decorator';
import { CameraGroupsService } from './camera-groups.service';
import { CreateCameraGroupDto } from './dto/create-camera-group.dto';
import { UpdateCameraGroupDto } from './dto/update-camera-group.dto';

@Controller('camera-groups')
export class CameraGroupsController {
  constructor(
    private readonly cameraGroupsService: CameraGroupsService,
    private readonly auditService: AuditService,
  ) {}

  @Roles(UserRole.VIEWER)
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.cameraGroupsService.list(user);
  }

  @Roles(UserRole.VIEWER)
  @Get(':id')
  getById(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.cameraGroupsService.getById(id, user);
  }

  @Roles(UserRole.ADMIN)
  @RequirePermission('cameraConfig')
  @Post()
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateCameraGroupDto, @Req() req: Request) {
    const group = await this.cameraGroupsService.create(dto);
    await this.auditService.log(user.id, 'camera_group.create', 'CameraGroup', group.id, { name: group.name }, req);
    return group;
  }

  @Roles(UserRole.ADMIN)
  @RequirePermission('cameraConfig')
  @Patch(':id')
  async update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateCameraGroupDto, @Req() req: Request) {
    const group = await this.cameraGroupsService.update(id, dto);
    await this.auditService.log(user.id, 'camera_group.update', 'CameraGroup', group.id, { name: group.name, isActive: group.isActive }, req);
    return group;
  }

  @Roles(UserRole.ADMIN)
  @RequirePermission('cameraConfig')
  @Delete(':id')
  async softDelete(@CurrentUser() user: AuthUser, @Param('id') id: string, @Req() req: Request) {
    const group = await this.cameraGroupsService.softDelete(id);
    await this.auditService.log(user.id, 'camera_group.deactivate', 'CameraGroup', group.id, { name: group.name }, req);
    return group;
  }

  @Roles(UserRole.ADMIN)
  @RequirePermission('cameraConfig')
  @Post(':id/alarms')
  async setAlarms(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: { enabled?: boolean },
    @Req() req: Request,
  ) {
    const enabled = body?.enabled !== false;
    const result = await this.cameraGroupsService.setAlarmsForGroup(id, enabled);
    await this.auditService.log(user.id, 'camera_group.alarms_set', 'CameraGroup', id, { enabled, affected: result.affected }, req);
    return result;
  }

  @Roles(UserRole.ADMIN)
  @RequirePermission('cameraConfig')
  @Post(':id/retention')
  async setRetention(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: { retentionDays?: number },
    @Req() req: Request,
  ) {
    // Sobrescreve a retenção de TODAS as câmeras do grupo (a UI avisa antes).
    const retentionDays = Math.max(1, Math.min(3650, Math.floor(Number(body?.retentionDays ?? 3)) || 3));
    const result = await this.cameraGroupsService.setRetentionForGroup(id, retentionDays);
    await this.auditService.log(user.id, 'camera_group.retention_set', 'CameraGroup', id, { retentionDays, affected: result.affected }, req);
    return result;
  }

  @Roles(UserRole.ADMIN)
  @RequirePermission('cameraConfig')
  @Post(':id/cameras/:cameraId')
  async addCamera(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('cameraId') cameraId: string, @Req() req: Request) {
    const group = await this.cameraGroupsService.addCamera(id, cameraId);
    await this.auditService.log(user.id, 'camera_group.camera_add', 'CameraGroup', id, { cameraId }, req);
    return group;
  }

  @Roles(UserRole.ADMIN)
  @RequirePermission('cameraConfig')
  @Delete(':id/cameras/:cameraId')
  async removeCamera(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('cameraId') cameraId: string, @Req() req: Request) {
    const group = await this.cameraGroupsService.removeCamera(id, cameraId);
    await this.auditService.log(user.id, 'camera_group.camera_remove', 'CameraGroup', id, { cameraId }, req);
    return group;
  }
}
