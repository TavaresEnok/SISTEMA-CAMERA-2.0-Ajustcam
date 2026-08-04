import { Injectable, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { AuthUser } from '../common/types/auth-user.type';
import { AccessControlService } from '../access-control/access-control.service';
import { CreateCameraGroupDto } from './dto/create-camera-group.dto';
import { UpdateCameraGroupDto } from './dto/update-camera-group.dto';

@Injectable()
export class CameraGroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accessControlService: AccessControlService,
  ) {}

  async list(user: AuthUser) {
    const includeCameras = { cameras: true };
    if (user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN) {
      return this.prisma.cameraGroup.findMany({ where: { isActive: true }, include: includeCameras, orderBy: { name: 'asc' } });
    }

    const cameraIds = await this.accessControlService.getAccessibleCameraIds(user);
    return this.prisma.cameraGroup.findMany({
      where: { cameras: { some: { id: { in: cameraIds } } }, isActive: true },
      include: includeCameras,
      orderBy: { name: 'asc' },
    });
  }

  async getById(id: string, user: AuthUser) {
    const group = await this.prisma.cameraGroup.findUnique({ where: { id }, include: { cameras: true } });
    if (!group) {
      throw new NotFoundException('Grupo não encontrado.');
    }
    if (user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN) {
      return group;
    }

    const cameraIds = new Set(await this.accessControlService.getAccessibleCameraIds(user));
    if (!group.isActive || !group.cameras.some((camera) => cameraIds.has(camera.id))) {
      throw new NotFoundException('Grupo não encontrado.');
    }

    return group;
  }

  private async ensureExists(id: string) {
    const group = await this.prisma.cameraGroup.findUnique({ where: { id } });
    if (!group) {
      throw new NotFoundException('Grupo não encontrado.');
    }
    return group;
  }

  create(dto: CreateCameraGroupDto) {
    return this.prisma.cameraGroup.create({ data: dto, include: { cameras: true } });
  }

  async update(id: string, dto: UpdateCameraGroupDto) {
    await this.ensureExists(id);
    return this.prisma.cameraGroup.update({ where: { id }, data: dto, include: { cameras: true } });
  }

  async softDelete(id: string) {
    await this.ensureExists(id);
    await this.prisma.camera.updateMany({ where: { groupId: id }, data: { groupId: null } });
    return this.prisma.cameraGroup.update({ where: { id }, data: { isActive: false }, include: { cameras: true } });
  }

  async setAlarmsForGroup(groupId: string, enabled: boolean) {
    await this.ensureExists(groupId);
    const result = await this.prisma.camera.updateMany({
      where: { groupId },
      data: { alarmsEnabled: enabled },
    });
    return { groupId, enabled, affected: result.count };
  }

  /**
   * Define a retenção (dias) de TODAS as câmeras do grupo de uma vez. Isto
   * SOBRESCREVE o valor individual de cada câmera — a UI avisa antes de aplicar.
   */
  async setRetentionForGroup(groupId: string, retentionDays: number) {
    await this.ensureExists(groupId);
    // Grava no GRUPO, não em cada câmera.
    //
    // Antes isto era um `updateMany` sobre `Camera`: aplicar a retenção do grupo
    // APAGAVA o número individual de todas elas. As exceções ajustadas à mão se
    // perdiam a cada mexida no grupo, sem volta — e o operador só descobria
    // quando o acervo de uma câmera específica encurtava sozinho.
    //
    // Agora o grupo guarda a política e cada câmera decide se a segue. Quem
    // segue passa a valer o número novo na hora; quem é exceção não é tocada.
    await this.prisma.cameraGroup.update({
      where: { id: groupId },
      data: { retentionDays },
    });
    const seguindo = await this.prisma.camera.count({ where: { groupId, retentionFollowsGroup: true } });
    const excecoes = await this.prisma.camera.count({ where: { groupId, retentionFollowsGroup: false } });
    return { groupId, retentionDays, affected: seguindo, excecoes };
  }

  async addCamera(groupId: string, cameraId: string) {
    const group = await this.prisma.cameraGroup.findUnique({ where: { id: groupId } });
    if (!group) throw new NotFoundException('Grupo não encontrado.');

    const camera = await this.prisma.camera.findUnique({ where: { id: cameraId } });
    if (!camera) throw new NotFoundException('Câmera não encontrada.');

    await this.prisma.camera.update({ where: { id: cameraId }, data: { groupId } });
    return this.prisma.cameraGroup.findUnique({ where: { id: groupId }, include: { cameras: true } });
  }

  async removeCamera(groupId: string, cameraId: string) {
    const group = await this.prisma.cameraGroup.findUnique({ where: { id: groupId } });
    if (!group) throw new NotFoundException('Grupo não encontrado.');

    const camera = await this.prisma.camera.findUnique({ where: { id: cameraId } });
    if (!camera) throw new NotFoundException('Câmera não encontrada.');

    if (camera.groupId !== groupId) {
      throw new NotFoundException('Câmera não pertence ao grupo informado.');
    }

    await this.prisma.camera.update({ where: { id: cameraId }, data: { groupId: null } });
    return this.prisma.cameraGroup.findUnique({ where: { id: groupId }, include: { cameras: true } });
  }
}
