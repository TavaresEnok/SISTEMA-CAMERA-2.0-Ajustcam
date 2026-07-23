import { ForbiddenException, Injectable } from '@nestjs/common';
import { CameraPermissionLevel, UserRole } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { AuthUser } from '../common/types/auth-user.type';

const levelWeight: Record<CameraPermissionLevel, number> = {
  VIEW: 1,
  CONTROL: 2,
  RECORD: 3,
  ADMIN: 4,
};

@Injectable()
export class AccessControlService {
  constructor(private readonly prisma: PrismaService) {}

  private isPrivileged(user: AuthUser): boolean {
    return user.role === UserRole.SUPER_ADMIN || user.role === UserRole.ADMIN;
  }

  /**
   * IDs de câmeras cujo CONTEÚDO o usuário pode acessar (ao vivo, gravação, etc.).
   *
   * PRIVACIDADE: câmera privada (`isPrivate`) só entra para o DONO ou para quem o
   * dono autorizou por permissão DIRETA. O privilégio de admin NÃO abre câmera
   * privada — é o único ponto onde admin não vê tudo. Câmeras normais seguem a
   * regra de sempre (admin vê todas; demais por grupo/permissão direta).
   */
  async getAccessibleCameraIds(user: AuthUser): Promise<string[]> {
    // Câmeras privadas onde o usuário é o dono OU tem permissão DIRETA (o dono
    // compartilhou explicitamente). Valem para todos, inclusive admin.
    const [ownedPrivate, directPerms] = await Promise.all([
      this.prisma.camera.findMany({ where: { isPrivate: true, ownerUserId: user.id }, select: { id: true } }),
      this.prisma.cameraPermission.findMany({
        where: { userId: user.id, cameraId: { not: null } },
        select: { cameraId: true },
      }),
    ]);
    const directIds = directPerms.map((p) => p.cameraId).filter((id): id is string => Boolean(id));
    const directPrivate = directIds.length
      ? await this.prisma.camera.findMany({ where: { id: { in: directIds }, isPrivate: true }, select: { id: true } })
      : [];
    const authorizedPrivateIds = new Set<string>([
      ...ownedPrivate.map((c) => c.id),
      ...directPrivate.map((c) => c.id),
    ]);

    if (this.isPrivileged(user)) {
      // Admin: todas as NÃO-privadas + as privadas que ele mesmo possui/autorizado.
      const nonPrivate = await this.prisma.camera.findMany({ where: { isPrivate: false }, select: { id: true } });
      return Array.from(new Set([...nonPrivate.map((c) => c.id), ...authorizedPrivateIds]));
    }

    const byGroup = await this.prisma.cameraPermission.findMany({
      where: { userId: user.id, groupId: { not: null } },
      select: { groupId: true },
    });
    const groupIds = byGroup.map((item) => item.groupId).filter((id): id is string => Boolean(id));
    const groupCameras = groupIds.length
      ? await this.prisma.camera.findMany({ where: { groupId: { in: groupIds } }, select: { id: true, isPrivate: true } })
      : [];

    const candidate = Array.from(new Set([
      ...directIds,
      ...groupCameras.map((item) => item.id),
    ]));
    // Filtra privadas não-autorizadas: mesmo com acesso ao GRUPO, uma câmera
    // privada só aparece para o dono/autorizados (o conteúdo é dele).
    const privateSet = new Set(groupCameras.filter((c) => c.isPrivate).map((c) => c.id));
    return candidate.filter((id) => !privateSet.has(id) || authorizedPrivateIds.has(id));
  }

  async getAdminGroupIds(user: AuthUser): Promise<string[]> {
    if (this.isPrivileged(user)) {
      const groups = await this.prisma.cameraGroup.findMany({ select: { id: true } });
      return groups.map((group) => group.id);
    }

    const permissions = await this.prisma.cameraPermission.findMany({
      where: { userId: user.id, groupId: { not: null }, level: CameraPermissionLevel.ADMIN },
      select: { groupId: true },
    });

    return permissions.map((permission) => permission.groupId).filter((id): id is string => Boolean(id));
  }

  async canAdminGroup(user: AuthUser, groupId: string): Promise<boolean> {
    if (this.isPrivileged(user)) return true;
    const permission = await this.prisma.cameraPermission.findFirst({
      where: { userId: user.id, groupId, level: CameraPermissionLevel.ADMIN },
      select: { id: true },
    });
    return Boolean(permission);
  }

  async assertCanAdminGroup(user: AuthUser, groupId: string): Promise<void> {
    if (!(await this.canAdminGroup(user, groupId))) {
      throw new ForbiddenException('Sem permissão administrativa neste grupo.');
    }
  }

  private async getMaxPermissionLevel(userId: string, cameraId: string): Promise<CameraPermissionLevel | null> {
    const camera = await this.prisma.camera.findUnique({ where: { id: cameraId }, select: { groupId: true } });
    if (!camera) return null;

    const perms = await this.prisma.cameraPermission.findMany({
      where: {
        userId,
        OR: [
          { cameraId },
          ...(camera.groupId ? [{ groupId: camera.groupId }] : []),
        ],
      },
      select: { level: true },
    });

    if (!perms.length) {
      return null;
    }

    let max = perms[0].level;
    for (const perm of perms) {
      if (levelWeight[perm.level] > levelWeight[max]) {
        max = perm.level;
      }
    }
    return max;
  }

  private async hasLevel(user: AuthUser, cameraId: string, minLevel: CameraPermissionLevel): Promise<boolean> {
    if (this.isPrivileged(user)) {
      return true;
    }

    const max = await this.getMaxPermissionLevel(user.id, cameraId);
    if (!max) return false;
    return levelWeight[max] >= levelWeight[minLevel];
  }

  /**
   * Acesso ao CONTEÚDO da câmera (ao vivo, gravação, snapshot...). É o gate único
   * por onde passam todos os endpoints de conteúdo — a privacidade é garantida
   * aqui por construção.
   *
   * Câmera privada: SÓ o dono e quem ele autorizou por permissão DIRETA veem o
   * conteúdo. O atalho de privilégio de admin é ignorado — nem admin nem
   * super-admin abrem uma câmera privada de terceiro.
   */
  async canViewCamera(user: AuthUser, cameraId: string): Promise<boolean> {
    const camera = await this.prisma.camera.findUnique({
      where: { id: cameraId },
      select: { isPrivate: true, ownerUserId: true },
    });
    if (camera?.isPrivate) {
      if (camera.ownerUserId && camera.ownerUserId === user.id) return true;
      // Autorização do dono = permissão DIRETA na câmera (não por grupo/privilégio).
      const direct = await this.prisma.cameraPermission.findFirst({
        where: { userId: user.id, cameraId },
        select: { id: true },
      });
      return Boolean(direct);
    }
    return this.hasLevel(user, cameraId, CameraPermissionLevel.VIEW);
  }

  async canControlCamera(user: AuthUser, cameraId: string): Promise<boolean> {
    return this.hasLevel(user, cameraId, CameraPermissionLevel.CONTROL);
  }

  async canRecordCamera(user: AuthUser, cameraId: string): Promise<boolean> {
    return this.hasLevel(user, cameraId, CameraPermissionLevel.RECORD);
  }

  async canAdminCamera(user: AuthUser, cameraId: string): Promise<boolean> {
    return this.hasLevel(user, cameraId, CameraPermissionLevel.ADMIN);
  }

  async assertCanViewCamera(user: AuthUser, cameraId: string): Promise<void> {
    if (!(await this.canViewCamera(user, cameraId))) {
      throw new ForbiddenException('Sem permissão para visualizar esta câmera.');
    }
  }

  async assertCanControlCamera(user: AuthUser, cameraId: string): Promise<void> {
    if (!(await this.canControlCamera(user, cameraId))) {
      throw new ForbiddenException('Sem permissão para controlar esta câmera.');
    }
  }

  async assertCanRecordCamera(user: AuthUser, cameraId: string): Promise<void> {
    if (!(await this.canRecordCamera(user, cameraId))) {
      throw new ForbiddenException('Sem permissão para gravação nesta câmera.');
    }
  }

  async assertCanAdminCamera(user: AuthUser, cameraId: string): Promise<void> {
    if (!(await this.canAdminCamera(user, cameraId))) {
      throw new ForbiddenException('Sem permissão administrativa nesta câmera.');
    }
  }
}
