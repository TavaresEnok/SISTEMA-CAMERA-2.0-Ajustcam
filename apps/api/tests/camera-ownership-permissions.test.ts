import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BadRequestException } from '@nestjs/common';
import { CameraPermissionLevel, Prisma, UserRole } from '@prisma/client';
import { CamerasService } from '../src/cameras/cameras.service';
import { CameraPermissionsService } from '../src/camera-permissions/camera-permissions.service';
import { UsersService } from '../src/users/users.service';
import type { AuthUser } from '../src/common/types/auth-user.type';

const admin: AuthUser = {
  id: 'admin',
  email: 'admin@test.local',
  name: 'Admin',
  role: UserRole.SUPER_ADMIN,
};

test('transferência troca owner e revoga somente a permissão direta do dono anterior', async () => {
  const calls: string[] = [];
  const camera = {
    id: 'cam-private',
    isPrivate: true,
    ownerUserId: 'owner-old',
    passwordEncrypted: 'cipher',
  };
  const tx = {
    cameraPermission: {
      deleteMany: async (args: any) => {
        calls.push(`revoke:${args.where.userId}:${args.where.cameraId}`);
      },
      findFirst: async () => null,
      create: async (args: any) => {
        calls.push(`grant:${args.data.userId}:${args.data.level}`);
      },
      update: async () => {
        throw new Error('não deveria atualizar grant ausente');
      },
    },
    camera: {
      update: async (args: any) => {
        calls.push(`owner:${args.data.ownerUserId}`);
        return { ...camera, ownerUserId: args.data.ownerUserId };
      },
    },
  };
  const prisma = {
    camera: { findUnique: async () => ({ ...camera }) },
    user: { findUnique: async () => ({ id: 'owner-new', isActive: true }) },
    $transaction: async (callback: (client: any) => unknown) => callback(tx),
  };
  const service = new CamerasService(
    prisma as any,
    { get: () => undefined } as any,
    {} as any,
    {} as any,
    {} as any,
  );

  const result = await service.transferPrivateCameraOwner('cam-private', 'owner-new');
  assert.equal((result as any).ownerUserId, 'owner-new');
  assert.deepEqual(calls, [
    'revoke:owner-old:cam-private',
    `grant:owner-new:${CameraPermissionLevel.ADMIN}`,
    'owner:owner-new',
  ]);
});

test('exclusão definitiva recusa usuário que ainda possui câmera privada', async () => {
  let deleted = false;
  const service = new UsersService(
    {
      user: {
        findUnique: async () => ({
          id: 'owner',
          role: UserRole.VIEWER,
        }),
        delete: async () => {
          deleted = true;
        },
      },
      camera: { count: async () => 2 },
    } as any,
    { canAssignRole: () => true } as any,
    {} as any,
    {} as any,
  );

  await assert.rejects(
    () => service.hardDelete(admin, 'owner'),
    BadRequestException,
  );
  assert.equal(deleted, false);
});

test('grant concorrente transforma P2002 em update idempotente da linha vencedora', async () => {
  const updates: any[] = [];
  const unique = new Prisma.PrismaClientKnownRequestError('unique', {
    code: 'P2002',
    clientVersion: '5.22.0',
  });
  const service = new CameraPermissionsService({
    user: { findUnique: async () => ({ id: 'user-1' }) },
    camera: { findUnique: async () => ({ id: 'camera-1' }) },
    cameraPermission: {
      findFirst: async (args: any) => (
        args.select?.id ? { id: 'permission-winner' } : null
      ),
      create: async () => {
        throw unique;
      },
      update: async (args: any) => {
        updates.push(args);
        return { id: args.where.id, level: args.data.level };
      },
    },
  } as any, {} as any);

  const result = await service.grant(admin, {
    userId: 'user-1',
    cameraId: 'camera-1',
    level: CameraPermissionLevel.CONTROL,
  });
  assert.equal((result as any).id, 'permission-winner');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.level, CameraPermissionLevel.CONTROL);
});

test('migration usa menor privilégio, unicidade parcial e FK RESTRICT', () => {
  const sql = readFileSync(
    'prisma/migrations/20260728193000_harden_camera_ownership_permissions/migration.sql',
    'utf8',
  );
  assert.match(sql, /CameraPermission_exactly_one_target_check/);
  assert.match(sql, /CameraPermission_user_camera_unique/);
  assert.match(sql, /CameraPermission_user_group_unique/);
  assert.match(sql, /WHEN 'VIEW' THEN 1/);
  assert.match(sql, /Camera_ownerUserId_fkey/);
  assert.match(sql, /ON DELETE RESTRICT/);
  assert.doesNotMatch(sql, /\bctid\b/i);
});
