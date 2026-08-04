import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraStatus } from '@prisma/client';
import { CamerasService } from '../src/cameras/cameras.service';
import {
  compactIngestPathName,
  generateIngestKey,
  ingestPathName,
} from '../src/cameras/helpers/rtmp-ingest.helper';

function serviceFor(activePath: string | null, key: string) {
  const checked: string[] = [];
  const updates: any[] = [];
  const service = Object.create(CamerasService.prototype) as any;
  service.cryptoService = { decrypt: () => key };
  service.ingestPathIsLive = async (path: string) => {
    checked.push(path);
    return path === activePath;
  };
  service.prisma = {
    camera: {
      update: async (input: any) => {
        updates.push(input);
        return input;
      },
    },
  };
  service.logger = { log() {} };
  return { service, checked, updates };
}

const camera = (key: string) => ({
  id: 'camera-push',
  name: 'Portaria',
  status: CameraStatus.OFFLINE,
  rtmpIngestPath: null,
  rtmpIngestKeyEncrypted: `encrypted:${key}`,
});

test('status reconhece publicação pelo alias compacto como ONLINE', async () => {
  const key = generateIngestKey();
  const compactPath = compactIngestPathName(key);
  const { service, checked, updates } = serviceFor(compactPath, key);

  const result = await service.getPushSourcedStatus(camera(key), CameraStatus.OFFLINE, Date.now());

  assert.equal(result.status, CameraStatus.ONLINE);
  assert.deepEqual(checked, [compactPath]);
  assert.equal(updates[0]?.data?.status, CameraStatus.ONLINE);
});

test('status mantém compatibilidade com publicação hexadecimal antiga', async () => {
  const key = generateIngestKey();
  const compactPath = compactIngestPathName(key);
  const legacyPath = ingestPathName(key);
  const { service, checked } = serviceFor(legacyPath, key);

  const result = await service.getPushSourcedStatus(camera(key), CameraStatus.OFFLINE, Date.now());

  assert.equal(result.status, CameraStatus.ONLINE);
  assert.deepEqual(checked, [compactPath, legacyPath]);
});
