import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRtspUrl,
  sanitizeRtspUrl,
  isHevcCodec,
  resolveGridRtspProfile,
  resolveLiveRtspProfile,
  resolveRecordingRtspProfile,
  resolveDeliveryVideoCodec,
} from '../src/cameras/helpers/rtsp-url.helper';

// ─────────────────────────────────────────────────────────────────────────────
// D1 (ingestão) — rtsp-url.helper: PURO, crítico, sem cobertura até agora.
// Compatibilidade de fabricante (Hikvision vs Dahua), segurança de credencial
// (URL-encode + redação) e preferência de substream na grade.
// ─────────────────────────────────────────────────────────────────────────────

const base = { username: 'admin', password: 'senha', ip: '10.0.0.20', rtspPort: 554 };

test('D1 buildRtspUrl: sem rtspPath usa o caminho Dahua padrão com canal/subtype', () => {
  const url = buildRtspUrl({ ...base, channel: 1, subtype: 0 });
  assert.equal(url, 'rtsp://admin:senha@10.0.0.20:554/cam/realmonitor?channel=1&subtype=0');
});

test('D1 buildRtspUrl: reescreve query Dahua para o canal/subtype da câmera', () => {
  const url = buildRtspUrl({ ...base, rtspPath: '/cam/realmonitor?channel=1&subtype=0', channel: 2, subtype: 1 });
  assert.match(url, /channel=2&subtype=1$/);
});

test('D1 buildRtspUrl: reescreve path Hikvision /Streaming/Channels (subtype 0-based → 01)', () => {
  // canal 1, subtype 0 → 101 (inalterado para o caso base)
  assert.match(buildRtspUrl({ ...base, rtspPath: '/Streaming/Channels/101', channel: 1, subtype: 0 }), /\/Streaming\/Channels\/101$/);
  // canal 2, subtype 1 → 2 + (1+1=02) = 202
  assert.match(buildRtspUrl({ ...base, rtspPath: '/Streaming/Channels/101', channel: 2, subtype: 1 }), /\/Streaming\/Channels\/202$/);
});

test('D1 buildRtspUrl: credencial com caractere especial é URL-encoded (segurança)', () => {
  const url = buildRtspUrl({ ...base, username: 'adm in', password: 'p@ss/w:rd', channel: 1, subtype: 0 });
  assert.ok(url.includes('adm%20in'), 'usuário deve ser percent-encoded');
  assert.ok(url.includes('p%40ss%2Fw%3Ard'), 'senha deve ser percent-encoded (@ / : não podem quebrar a URL)');
  assert.equal(url.includes('p@ss'), false, 'senha crua nunca aparece');
});

test('D1 buildRtspUrl: garante barra inicial em rtspPath sem barra', () => {
  const url = buildRtspUrl({ ...base, rtspPath: 'live/stream', channel: 1, subtype: 0 });
  assert.match(url, /554\/live\/stream$/);
});

test('D1 sanitizeRtspUrl: redige a credencial embutida (invariante v)', () => {
  assert.equal(sanitizeRtspUrl('rtsp://admin:segredo@10.0.0.1:554/x'), 'rtsp://<redacted>@10.0.0.1:554/x');
  assert.equal(sanitizeRtspUrl('rtsp://10.0.0.1:554/x'), 'rtsp://10.0.0.1:554/x', 'sem credencial fica intacto');
});

test('D1 isHevcCodec: reconhece as variações de H.265', () => {
  for (const c of ['hevc', 'h265', 'H265', 'hvc1', 'video/265']) assert.equal(isHevcCodec(c), true, `${c} é HEVC`);
  for (const c of ['h264', 'avc', '', null, undefined]) assert.equal(isHevcCodec(c as any), false, `${c} não é HEVC`);
});

test('D1 resolveGridRtspProfile: grade SEMPRE prefere o substream (subtype 1)', () => {
  assert.equal(resolveGridRtspProfile({ channel: 1, subtype: 0 }).subtype, 1);
  assert.equal(resolveGridRtspProfile({ liveChannel: 3 }).channel, 3, 'mantém o canal do live');
});

test('D1 resolveLiveRtspProfile: usa live*, cai para channel/subtype, depois default', () => {
  assert.deepEqual(resolveLiveRtspProfile({ liveChannel: 2, liveSubtype: 1 }), { channel: 2, subtype: 1 });
  assert.deepEqual(resolveLiveRtspProfile({ channel: 4, subtype: 0 }), { channel: 4, subtype: 0 }, 'fallback para channel/subtype');
  assert.deepEqual(resolveLiveRtspProfile({}), { channel: 1, subtype: 0 }, 'default seguro');
});

test('D1 normalização: canal < 1 ou inválido cai para o default; subtype < 0 idem', () => {
  assert.equal(resolveLiveRtspProfile({ channel: 0 }).channel, 1, 'canal 0 é inválido → 1');
  assert.equal(resolveLiveRtspProfile({ channel: -5 }).channel, 1);
  assert.equal(resolveRecordingRtspProfile({ recordingSubtype: -1 }).subtype, 0, 'subtype negativo → 0');
});

test('D1 resolveDeliveryVideoCodec: codec configurado explícito vence', () => {
  assert.equal(resolveDeliveryVideoCodec({ streamVideoCodec: 'h264' }), 'h264');
});

test('D1 resolveDeliveryVideoCodec: "original" não-HEVC entrega o codec original', () => {
  assert.equal(
    resolveDeliveryVideoCodec({ streamVideoCodec: 'original', recordingVideoCodec: 'h264' }),
    'h264',
  );
});

test('D1 resolveDeliveryVideoCodec: original HEVC cai para o codec detectado', () => {
  assert.equal(
    resolveDeliveryVideoCodec({ streamVideoCodec: 'original', recordingVideoCodec: 'hevc', detectedVideoCodec: 'h264' }),
    'h264',
    'entrega HEVC como original é evitada — usa o detectado',
  );
});
