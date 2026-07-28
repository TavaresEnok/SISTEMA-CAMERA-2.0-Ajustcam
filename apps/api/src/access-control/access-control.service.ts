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
    // BLOQUEIO COMERCIAL DO GRUPO: um grupo SUSPENSO (ou desativado) deixa de
    // conceder acesso — é como o dono da instalação corta um cliente final que
    // parou de pagar. Antes, `isActive:false` só escondia o grupo das listagens
    // enquanto o conteúdo continuava acessível: bloqueio puramente cosmético.
    // Precisa valer AQUI e no getMaxPermissionLevel: bloquear só um dos dois
    // esconderia a câmera da lista mas deixaria o acesso direto passar.
    const allowedGroupIds = groupIds.length ? await this.filterAllowedGroupIds(groupIds) : [];
    const groupCameras = allowedGroupIds.length
      ? await this.prisma.camera.findMany({ where: { groupId: { in: allowedGroupIds } }, select: { id: true, isPrivate: true } })
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

  /**
   * Dos grupos informados, quais AINDA concedem acesso. Um grupo SUSPENSO (ou
   * `isActive:false`, o estado legado) não concede nada. RESTRICTED continua
   * concedendo — ele limita playback/exportação, não o ao vivo (ver
   * `canPlaybackCamera`).
   */
  private async filterAllowedGroupIds(groupIds: string[]): Promise<string[]> {
    if (!groupIds.length) return [];
    const groups = await this.prisma.cameraGroup.findMany({
      where: { id: { in: groupIds }, isActive: true, accessStatus: { not: 'SUSPENDED' } },
      select: { id: true },
    });
    return groups.map((group) => group.id);
  }

  private async getMaxPermissionLevel(userId: string, cameraId: string): Promise<CameraPermissionLevel | null> {
    const camera = await this.prisma.camera.findUnique({ where: { id: cameraId }, select: { groupId: true } });
    if (!camera) return null;

    // Mesmo bloqueio da lista: um grupo suspenso não pode conceder permissão por
    // grupo. A permissão DIRETA na câmera continua valendo — ela é um vínculo
    // pessoa↔câmera, não do contrato do grupo.
    const allowedGroupIds = camera.groupId ? await this.filterAllowedGroupIds([camera.groupId]) : [];

    const perms = await this.prisma.cameraPermission.findMany({
      where: {
        userId,
        OR: [
          { cameraId },
          ...(allowedGroupIds.length ? [{ groupId: allowedGroupIds[0] }] : []),
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
   * Em câmera privada, o papel global não eleva a concessão de conteúdo. O
   * proprietário possui autoridade total e qualquer outro usuário fica
   * limitado exclusivamente à permissão direta recebida.
   */
  private async hasPrivateContentLevel(
    user: AuthUser,
    cameraId: string,
    minLevel: CameraPermissionLevel,
  ): Promise<boolean | null> {
    const camera = await this.prisma.camera.findUnique({
      where: { id: cameraId },
      select: { isPrivate: true, ownerUserId: true },
    });
    if (!camera?.isPrivate) return null;
    if (camera.ownerUserId === user.id) return true;

    const permissions = await this.prisma.cameraPermission.findMany({
      where: { userId: user.id, cameraId },
      select: { level: true },
    });
    return permissions.some(
      (permission) => levelWeight[permission.level] >= levelWeight[minLevel],
    );
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
    const privateAccess = await this.hasPrivateContentLevel(
      user,
      cameraId,
      CameraPermissionLevel.VIEW,
    );
    if (privateAccess !== null) return privateAccess;
    return this.hasLevel(user, cameraId, CameraPermissionLevel.VIEW);
  }

  async canControlCamera(user: AuthUser, cameraId: string): Promise<boolean> {
    // PTZ e relés são ações físicas sobre o ambiente observado. Administrar a
    // configuração técnica de uma câmera privada não concede acesso implícito
    // ao seu conteúdo nem autorização para movimentá-la.
    const privateAccess = await this.hasPrivateContentLevel(
      user,
      cameraId,
      CameraPermissionLevel.CONTROL,
    );
    if (privateAccess !== null) return privateAccess;
    return this.hasLevel(user, cameraId, CameraPermissionLevel.CONTROL);
  }

  async canRecordCamera(user: AuthUser, cameraId: string): Promise<boolean> {
    // Iniciar/parar a coleta altera o conteúdo de evidência. A mesma fronteira
    // de privacidade do playback/visualização precisa ser satisfeita primeiro.
    const privateAccess = await this.hasPrivateContentLevel(
      user,
      cameraId,
      CameraPermissionLevel.RECORD,
    );
    if (privateAccess !== null) return privateAccess;
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

  /**
   * Acesso ao HISTÓRICO (playback, gravações, exportação) — mais estrito que o
   * ao vivo. Um grupo RESTRITO segue vendo a câmera em tempo real, mas perde o
   * acervo: é a "meia-cobrança" que o dono da instalação aplica antes de cortar
   * de vez, espelhando o que a Central faz com a instalação inteira.
   *
   * O ADMIN da instalação nunca é barrado por aqui: ele precisa administrar o
   * cliente que bloqueou. A privacidade da câmera privada continua acima de
   * tudo — se `canViewCamera` nega, isto nega junto.
   */
  async canPlaybackCamera(user: AuthUser, cameraId: string): Promise<boolean> {
    if (!(await this.canViewCamera(user, cameraId))) return false;
    if (this.isPrivileged(user)) return true;

    const camera = await this.prisma.camera.findUnique({ where: { id: cameraId }, select: { groupId: true } });
    if (!camera?.groupId) return true;
    const group = await this.prisma.cameraGroup.findUnique({
      where: { id: camera.groupId },
      select: { accessStatus: true },
    });
    return group?.accessStatus !== 'RESTRICTED';
  }

  async assertCanPlaybackCamera(user: AuthUser, cameraId: string): Promise<void> {
    if (!(await this.canPlaybackCamera(user, cameraId))) {
      throw new ForbiddenException('Acesso ao histórico indisponível para este grupo. Fale com o administrador.');
    }
  }

  /**
   * Lista câmeras cujo histórico pode ser revelado ao usuário. Usar
   * `getAccessibleCameraIds` em consultas de gravação é insuficiente porque
   * RESTRICTED preserva o ao vivo, mas bloqueia inclusive os metadados do
   * acervo. A consulta em lote evita um check/N+1 por gravação.
   */
  async getPlaybackCameraIds(user: AuthUser): Promise<string[]> {
    const accessibleIds = await this.getAccessibleCameraIds(user);
    if (!accessibleIds.length || this.isPrivileged(user)) return accessibleIds;

    const cameras = await this.prisma.camera.findMany({
      where: { id: { in: accessibleIds } },
      select: { id: true, groupId: true },
    });
    const groupIds = Array.from(new Set(
      cameras.map((camera) => camera.groupId).filter((id): id is string => Boolean(id)),
    ));
    if (!groupIds.length) return cameras.map((camera) => camera.id);

    const restrictedGroups = await this.prisma.cameraGroup.findMany({
      where: { id: { in: groupIds }, accessStatus: 'RESTRICTED' },
      select: { id: true },
    });
    const restrictedIds = new Set(restrictedGroups.map((group) => group.id));
    return cameras
      .filter((camera) => !camera.groupId || !restrictedIds.has(camera.groupId))
      .map((camera) => camera.id);
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
