import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSecretConcatDocument,
  replaceSecretUrlWithPipe,
} from '../src/common/process/secret-url-process.helper';

const secretUrl = 'rtsp://camera-user:camera-password@192.168.50.20:554/live';

test('URL autenticada sai integralmente do argv e vira input por pipe', () => {
  const args = ['-rtsp_transport', 'tcp', '-i', secretUrl, '-f', 'null', '-'];
  const secured = replaceSecretUrlWithPipe(args, secretUrl);
  const argv = secured.join('\0');

  assert.equal(argv.includes('camera-user'), false);
  assert.equal(argv.includes('camera-password'), false);
  assert.equal(argv.includes(secretUrl), false);
  assert.deepEqual(secured.slice(0, 7), [
    '-protocol_whitelist',
    'file,pipe,tcp,udp,rtp,rtsp,http,https,tls',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
  ]);
  assert.equal(secured[7], 'pipe:3');
});

test('manifesto fica somente no pipe e escapa aspas do path', () => {
  const document = buildSecretConcatDocument(
    "rtsp://user:pass@192.168.50.20:554/camera's-stream",
    [['rtsp_transport', 'tcp']],
  );
  assert.match(document, /^ffconcat version 1\.0\n/);
  assert.match(document, /camera'\\''s-stream/);
  assert.match(document, /option rtsp_transport tcp/);
});

test('recusa URL ambígua, repetida, com controle ou protocolo local', () => {
  assert.throws(
    () => replaceSecretUrlWithPipe([secretUrl, secretUrl], secretUrl),
    /exatamente uma/,
  );
  assert.throws(
    () => buildSecretConcatDocument('rtsp://user:pass@host/live\nfile x'),
    /inválida/,
  );
  assert.throws(
    () => buildSecretConcatDocument('file:///etc/passwd'),
    /Protocolo não permitido/,
  );
});
