import assert from 'node:assert/strict';
import test from 'node:test';
import { ServiceUnavailableException } from '@nestjs/common';
import { CamerasService } from '../src/cameras/cameras.service';
import { FfmpegMjpegService } from '../src/camera-stream/ffmpeg-mjpeg.service';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';

test('poster de câmera RTMP offline não tenta RTSP direto nem descriptografa marcador', async () => {
  let decryptCalls = 0;
  const service = new FfmpegMjpegService(
    { get: () => undefined } as any,
    { getCameraOrThrow: async () => ({ id: 'push-1', sourceMode: 'rtmp_push' }) } as any,
    { decrypt: () => { decryptCalls += 1; throw new Error('não deveria descriptografar'); } } as any,
    { resolveGridPosterSource: async () => { throw new Error('ainda sem publicação'); } } as any,
  );
  (service as any).checkFfmpegAvailable = () => true;
  (service as any).logger = { debug() {} };

  await assert.rejects(
    () => (service as any).generateLivePosterFrame('push-1'),
    (error: unknown) => error instanceof ServiceUnavailableException
      && error.message === 'Câmera RTMP ainda não está publicando vídeo.',
  );
  assert.equal(decryptCalls, 0);
});

test('edição de câmera RTMP ignora o marcador de rede sem afrouxar câmera RTSP', async () => {
  const existing = {
    id: 'push-1',
    name: 'Portaria',
    ip: '0.0.0.0',
    rtspPort: 554,
    onvifPort: null,
    sourceMode: 'rtmp_push',
    passwordEncrypted: 'encrypted-empty',
    enabled: true,
    recordingEnabled: false,
    recordingMode: 'manual',
    alarmsEnabled: true,
    hasEdgeAi: false,
    motionTrigger: 'SYSTEM',
  };
  const writes: any[] = [];
  let networkPolicyCalls = 0;
  const service = Object.create(CamerasService.prototype) as any;
  service.getCameraOrThrow = async () => existing;
  service.assertTestTargetAllowed = () => { networkPolicyCalls += 1; throw new Error('marcador não é destino'); };
  service.validateReferences = async () => undefined;
  service.normalizeProfileToDetected = () => ({
    streamWidth: undefined,
    streamHeight: undefined,
    streamFps: undefined,
    streamBitrateKbps: undefined,
    recordingWidth: undefined,
    recordingHeight: undefined,
    recordingFps: undefined,
    recordingBitrateKbps: undefined,
  });
  service.normalizeLiveProtocol = () => 'webrtc';
  service.cryptoService = { encrypt: () => 'encrypted' };
  service.prisma = {
    camera: {
      update: async (input: any) => {
        writes.push(input);
        return { ...existing, ...input.data, ip: existing.ip };
      },
    },
  };

  await service.update('push-1', {
    name: 'Portaria atualizada',
    ip: '0.0.0.0',
    rtspPort: 554,
    username: '',
    rtspPath: '',
    recordingMode: 'manual',
    retentionDays: 7,
    preferredRtspTransport: 'tcp',
    preferredLiveProtocol: 'webrtc',
    streamVideoCodec: 'h264',
    recordingVideoCodec: 'h264',
    audioEnabled: false,
    aiEnabled: false,
    alarmsEnabled: true,
    enabled: true,
  });

  assert.equal(networkPolicyCalls, 0);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].data.ip, undefined);
  assert.equal(writes[0].data.name, 'Portaria atualizada');

  service.getCameraOrThrow = async () => ({ ...existing, sourceMode: 'rtsp_pull', ip: '192.168.1.20' });
  service.assertTestTargetAllowed = (ip: string) => {
    networkPolicyCalls += 1;
    return ip;
  };
  await service.update('pull-1', { name: 'RTSP validada' });
  assert.equal(networkPolicyCalls, 1, 'câmera RTSP deve continuar passando pela política de rede');
});

test('filtro HTTP redige token tanto no log quanto na resposta de erro', () => {
  const secret = 'valor-que-nao-pode-aparecer';
  const logs: string[] = [];
  let body: any = null;
  const response = {
    status() { return response; },
    json(value: unknown) { body = value; return response; },
  };
  const filter = new HttpExceptionFilter();
  (filter as any).logger = {
    error: (message: string) => logs.push(message),
    warn: (message: string) => logs.push(message),
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({
        method: 'GET',
        url: `/camera-stream/cam/poster?token=${secret}&v=1`,
        headers: {},
      }),
    }),
  };

  filter.catch(new ServiceUnavailableException('offline'), host as any);

  assert.equal(String(body?.path).includes(secret), false);
  assert.equal(logs.join('\n').includes(secret), false);
  assert.match(String(body?.path), /token=<redacted>/);
});
