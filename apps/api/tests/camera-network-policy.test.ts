import test from 'node:test';
import assert from 'node:assert/strict';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  assertCameraTargetAllowed,
  CameraNetworkPolicyError,
} from '../src/common/network/safe-url.helper';
import { PortCheckerService } from '../src/common/network/port-checker.service';
import { buildRtspUrl } from '../src/cameras/helpers/rtsp-url.helper';
import { TestCameraConnectionDto } from '../src/cameras/dto/test-camera-connection.dto';

const production = (allowed = '192.168.50.0/24', denied = '') => ({
  NODE_ENV: 'production',
  CAMERA_ALLOWED_CIDRS: allowed,
  CAMERA_DENIED_CIDRS: denied,
});

test('política aceita somente IP literal dentro da VLAN autorizada', () => {
  assert.equal(
    assertCameraTargetAllowed('192.168.50.42', 554, production()),
    '192.168.50.42',
  );

  for (const target of [
    '192.168.51.42',
    'localhost',
    'camera.example.com',
    '127.1',
    '2130706433',
    '0x7f000001',
    '192.168.50.42@169.254.169.254',
  ]) {
    assert.throws(
      () => assertCameraTargetAllowed(target, 554, production()),
      CameraNetworkPolicyError,
      target,
    );
  }
});

test('loopback, link-local/metadata, CGNAT e multicast são sempre negados', () => {
  const broad = production('0.0.0.0/0,::/0');
  for (const target of [
    '0.0.0.0',
    '127.0.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fe80::1',
    'ff02::1',
  ]) {
    assert.throws(
      () => assertCameraTargetAllowed(target, 554, broad),
      /bloqueado pela política/,
      target,
    );
  }
});

test('produção sem allowlist falha fechada e denylist vence a allowlist', () => {
  assert.throws(
    () => assertCameraTargetAllowed('192.168.50.42', 554, production('')),
    /CAMERA_ALLOWED_CIDRS não está configurado/,
  );
  assert.throws(
    () => assertCameraTargetAllowed(
      '192.168.50.42',
      554,
      production('192.168.50.0/24', '192.168.50.42/32'),
    ),
    /bloqueado pela política/,
  );
});

test('IPv6 permitido é bracketizado e porta fora da faixa é recusada', () => {
  const source = production('fd12:3456:789a::/48');
  assert.equal(
    assertCameraTargetAllowed('fd12:3456:789a::20', 554, source),
    'fd12:3456:789a::20',
  );
  assert.throws(
    () => assertCameraTargetAllowed('fd12:3456:789a::20', 65536, source),
    /entre 1 e 65535/,
  );

  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    CAMERA_ALLOWED_CIDRS: process.env.CAMERA_ALLOWED_CIDRS,
  };
  process.env.NODE_ENV = 'production';
  process.env.CAMERA_ALLOWED_CIDRS = source.CAMERA_ALLOWED_CIDRS;
  try {
    assert.equal(
      buildRtspUrl({
        username: 'admin',
        password: 'senha',
        ip: 'fd12:3456:789a::20',
        rtspPort: 554,
      }),
      'rtsp://admin:senha@[fd12:3456:789a::20]:554/cam/realmonitor?channel=1&subtype=0',
    );
  } finally {
    if (previous.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.NODE_ENV;
    if (previous.CAMERA_ALLOWED_CIDRS === undefined) delete process.env.CAMERA_ALLOWED_CIDRS;
    else process.env.CAMERA_ALLOWED_CIDRS = previous.CAMERA_ALLOWED_CIDRS;
  }
});

test('DTO rejeita hostname, autoridade injetada e portas acima de 65535', async () => {
  for (const input of [
    { ip: 'localhost', rtspPort: 554 },
    { ip: '127.0.0.1@169.254.169.254', rtspPort: 554 },
    { ip: '192.168.50.42', rtspPort: 65536 },
  ]) {
    const errors = await validate(plainToInstance(TestCameraConnectionDto, input));
    assert.ok(errors.length > 0, JSON.stringify(input));
  }
});

test('PortChecker não abre socket para destino bloqueado', async () => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    CAMERA_ALLOWED_CIDRS: process.env.CAMERA_ALLOWED_CIDRS,
  };
  process.env.NODE_ENV = 'production';
  process.env.CAMERA_ALLOWED_CIDRS = '192.168.50.0/24';
  try {
    const checker = new PortCheckerService();
    assert.equal(await checker.check('127.0.0.1', 1, 10), false);
    assert.equal(await checker.check('169.254.169.254', 80, 10), false);
  } finally {
    if (previous.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.NODE_ENV;
    if (previous.CAMERA_ALLOWED_CIDRS === undefined) delete process.env.CAMERA_ALLOWED_CIDRS;
    else process.env.CAMERA_ALLOWED_CIDRS = previous.CAMERA_ALLOWED_CIDRS;
  }
});
