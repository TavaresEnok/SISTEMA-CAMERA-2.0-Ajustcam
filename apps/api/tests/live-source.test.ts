import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MediamtxProxyService } from '../src/camera-stream/mediamtx-proxy.service';

// ─────────────────────────────────────────────────────────────────────────────
// D1 (ingestão) — escolha de fonte do mediamtx-proxy.
// Helpers puros de troca de protocolo (Hik↔Dahua) + a decisão real de
// chooseLiveSource (recuperar main degradado escolhendo a MAIOR resolução),
// testada sobrescrevendo os seams de I/O (probeStreamVideoMetadata). Sem tocar
// produção, sem subir ffprobe.
// ─────────────────────────────────────────────────────────────────────────────

function makeProxy() {
  const config = { get: () => undefined } as any;
  const mgr = new MediamtxProxyService(config, {} as any, {} as any, {} as any) as any;
  mgr.logger = { error() {}, warn() {}, log() {}, debug() {} };
  return mgr;
}

// ── Helpers puros de troca de protocolo ──────────────────────────────────────

test('D1 alternateMainPath: Dahua↔Hikvision para o MAIN (subtype 0 → 01)', () => {
  const mgr = makeProxy();
  assert.equal(mgr.alternateMainPath('/cam/realmonitor?channel=1&subtype=0', 1), '/Streaming/Channels/101');
  assert.equal(mgr.alternateMainPath('/Streaming/Channels/101', 2), '/cam/realmonitor?channel=2&subtype=0');
  assert.equal(mgr.alternateMainPath('/algo/desconhecido', 1), null, 'path não reconhecido → sem alternativa');
});

test('D1 alternateSubPath: Dahua↔Hikvision para o SUB (subtype 1 → 02)', () => {
  const mgr = makeProxy();
  assert.equal(mgr.alternateSubPath('/Streaming/Channels/101', 1), '/cam/realmonitor?channel=1&subtype=1');
  assert.equal(mgr.alternateSubPath('/cam/realmonitor?channel=1&subtype=1', 3), '/Streaming/Channels/302');
  assert.equal(mgr.alternateSubPath('/nada', 1), null);
});

test('D1 streamPixels: área do stream, 0 quando ausente/ inválido', () => {
  const mgr = makeProxy();
  assert.equal(mgr.streamPixels({ width: 1920, height: 1080 }), 2073600);
  assert.equal(mgr.streamPixels(null), 0);
  assert.equal(mgr.streamPixels({ width: null, height: 720 }), 0);
});

// ── chooseLiveSource: recuperação de main degradado ──────────────────────────

const degradedCamera = () => ({
  username: 'admin', ip: '10.0.0.20', rtspPort: 554,
  rtspPath: '/Streaming/Channels/101',
  updatedAt: new Date('2026-07-24T00:00:00Z'),
  detectedWidth: 640, detectedHeight: 360, // < 720p → dispara a checagem de main alternativo
  streamWidth: null, streamHeight: null,
  detectedVideoCodec: 'h264',
});

test('D1 chooseLiveSource: main degradado → escolhe o path alternativo de MAIOR resolução', async () => {
  const mgr = makeProxy();
  mgr.probeStreamVideoMetadata = async (url: string) =>
    url.includes('realmonitor')
      ? { codec: 'h264', width: 1920, height: 1080 }
      : { codec: 'h264', width: 640, height: 360 };
  const result = await mgr.chooseLiveSource('cam-1', degradedCamera(), 'senha', 'tcp');
  assert.match(result.sourceUrl, /\/cam\/realmonitor\?channel=1&subtype=0$/, 'deve migrar para o main de 1080p');
  assert.equal(result.isHevc, false);
});

test('D1 chooseLiveSource: alternativo NÃO é melhor → mantém o principal', async () => {
  const mgr = makeProxy();
  mgr.probeStreamVideoMetadata = async (url: string) =>
    url.includes('realmonitor')
      ? { codec: 'h264', width: 640, height: 360 }
      : { codec: 'h264', width: 1920, height: 1080 };
  const result = await mgr.chooseLiveSource('cam-1', degradedCamera(), 'senha', 'tcp');
  assert.match(result.sourceUrl, /\/Streaming\/Channels\/101$/, 'não troca por uma fonte pior');
});

test('D1 chooseLiveSource: main já saudável NÃO sonda alternativa', async () => {
  const mgr = makeProxy();
  let probeCalls = 0;
  mgr.probeStreamVideoMetadata = async () => { probeCalls++; return null; };
  mgr.resolveLiveStreamIsHevc = async () => false; // evita ffprobe real do codec
  const healthy = { ...degradedCamera(), detectedWidth: 1920, detectedHeight: 1080 };
  const result = await mgr.chooseLiveSource('cam-1', healthy, 'senha', 'tcp');
  assert.equal(probeCalls, 0, 'main saudável não deve custear probes de alternativa');
  assert.match(result.sourceUrl, /\/Streaming\/Channels\/101$/);
});
