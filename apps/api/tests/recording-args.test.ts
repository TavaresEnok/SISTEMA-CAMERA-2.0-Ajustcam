import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecordingProcessManagerService } from '../src/recordings/recording-process-manager.service';

// ─────────────────────────────────────────────────────────────────────────────
// D2 (gravação zero-perda): buildArgs/resolveOutputVideoCodec são PURAS.
// Invariante central: no modo 'copy' (padrão de produção) NUNCA se reencoda —
// arquiva o bitstream original da câmera (inclusive HEVC). Transcode só quando
// o modo é forçado (h264/h265) E a fonte não casa. Captura sempre em MPEG-TS
// segmentado (tolerante a cortes), remuxada para MP4 depois.
// ─────────────────────────────────────────────────────────────────────────────

function makeManager(codecMode: 'copy' | 'h264' | 'h265' = 'copy') {
  const config = {
    get: (key: string) => {
      const map: Record<string, any> = {
        recordingCodecMode: codecMode,
        ffmpegRecordingAudioCodec: 'aac',
        ffmpegRtspTransport: 'tcp',
        ffmpegStimeoutUs: 8000000,
      };
      return map[key];
    },
  } as any;
  return new RecordingProcessManagerService(config, {} as any, {} as any, {} as any, {} as any, {} as any);
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const camera = (over: Record<string, any> = {}) =>
  ({ id: 'cam-1', preferredRtspTransport: null, recordingWidth: null, recordingHeight: null, recordingFps: null, recordingBitrateKbps: null, ...over }) as any;

function build(mgr: RecordingProcessManagerService, probedCodec: string | null, segmentSeconds = 60, cam = camera()) {
  return (mgr as any).buildArgs(cam, 'rtsp://x/live', '/rec/%Y.ts', segmentSeconds, probedCodec) as string[];
}

test('D2 copy: fonte H.264 arquiva em -c:v copy, SEM reencode', () => {
  const args = build(makeManager('copy'), 'h264');
  assert.equal(flagValue(args, '-c:v'), 'copy', 'modo copy deve usar -c:v copy');
  assert.equal(args.includes('libx264'), false, 'não pode transcodar');
  assert.equal(args.includes('libx265'), false);
  assert.equal(args.includes('-crf'), false, 'copy não tem -crf');
  assert.equal(args.includes('-preset'), false, 'copy não tem -preset');
});

test('D2 copy: fonte HEVC TAMBÉM é copiada (zero perda em H.265)', () => {
  const args = build(makeManager('copy'), 'hevc');
  assert.equal(flagValue(args, '-c:v'), 'copy', 'copy deve preservar HEVC sem reencode');
  assert.equal(args.includes('libx265'), false);
});

test('D2 captura sempre em MPEG-TS segmentado com o segment_time pedido', () => {
  const args = build(makeManager('copy'), 'h264', 120);
  assert.equal(flagValue(args, '-f'), 'segment');
  assert.equal(flagValue(args, '-segment_format'), 'mpegts');
  assert.equal(flagValue(args, '-segment_time'), '120', 'segment_time deve refletir o segmentSeconds pedido');
  assert.equal(flagValue(args, '-reset_timestamps'), '1');
});

test('D2 mapeia vídeo obrigatório e áudio opcional', () => {
  const args = build(makeManager('copy'), 'h264');
  assert.ok(args.includes('0:v:0'), 'vídeo obrigatório');
  assert.ok(args.includes('0:a:0?'), 'áudio opcional (não falha sem áudio)');
});

test('D2 modo h264 com fonte HEVC: transcodifica para libx264', () => {
  const args = build(makeManager('h264'), 'hevc');
  assert.equal(flagValue(args, '-c:v'), 'libx264');
  assert.equal(flagValue(args, '-preset'), 'veryfast');
  assert.equal(flagValue(args, '-crf'), '23');
});

test('D2 modo h264 com fonte JÁ H.264: copia (não reencoda à toa)', () => {
  const args = build(makeManager('h264'), 'h264');
  assert.equal(flagValue(args, '-c:v'), 'copy');
});

test('D2 modo h265 com fonte H.264: transcodifica para libx265 (preset medium)', () => {
  const args = build(makeManager('h265'), 'h264');
  assert.equal(flagValue(args, '-c:v'), 'libx265');
  assert.equal(flagValue(args, '-preset'), 'medium');
  assert.equal(flagValue(args, '-crf'), '28');
});

test('D2 transporte RTSP da câmera é respeitado', () => {
  const args = build(makeManager('copy'), 'h264', 60, camera({ preferredRtspTransport: 'udp' }));
  assert.equal(flagValue(args, '-rtsp_transport'), 'udp');
});

test('D2 limiar de gravação estagnada: piso de 180s e folga por segmento', () => {
  const mgr = makeManager('copy') as any;
  assert.equal(mgr.getRecordingStaleThresholdSeconds(60), 180, 'segmento curto fica no piso de 180s');
  assert.equal(mgr.getRecordingStaleThresholdSeconds(600), 750, '600 + folga(150) = 750');
  assert.equal(mgr.getRecordingStaleThresholdSeconds(null), 375, 'sem segmento usa default 300 + folga(75)');
});
