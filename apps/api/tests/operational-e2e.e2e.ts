import assert from 'node:assert/strict';

type TestCase = { name: string; run: () => Promise<void> };

const baseUrl = (process.env.DRAC_E2E_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const email = process.env.DRAC_E2E_EMAIL ?? '';
const password = process.env.DRAC_E2E_PASSWORD ?? '';
const cameraId = process.env.DRAC_E2E_CAMERA_ID ?? '';
const recordingId = process.env.DRAC_E2E_RECORDING_ID ?? '';
const allowRecordingMutation = process.env.DRAC_E2E_RECORDING_MUTATION === '1';

function requireE2eEnabled() {
  if (process.env.DRAC_E2E !== '1') {
    console.log('skip - defina DRAC_E2E=1 para executar o teste operacional contra uma instalacao real.');
    process.exit(0);
  }
}

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
  }
  return { response, body, text };
}

async function jsonRequest(path: string, token: string, init: RequestInit = {}) {
  return request(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
}

async function login() {
  assert.ok(email, 'DRAC_E2E_EMAIL e obrigatorio');
  assert.ok(password, 'DRAC_E2E_PASSWORD e obrigatorio');
  const { response, body } = await request('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 201, `login deveria retornar 201; retornou ${response.status}: ${JSON.stringify(body)}`);
  assert.ok(body.accessToken, 'login deve retornar accessToken');
  return body.accessToken as string;
}

const tests: TestCase[] = [
  {
    name: 'health: API responde ok',
    run: async () => {
      const { response, body } = await request('/health');
      assert.equal(response.status, 200);
      assert.equal(body.status, 'ok');
    },
  },
  {
    name: 'auth + cameras: login e listagem autenticada',
    run: async () => {
      const token = await login();
      const { response, body } = await jsonRequest('/cameras', token);
      assert.equal(response.status, 200, `GET /cameras falhou: ${JSON.stringify(body)}`);
      assert.equal(Array.isArray(body), true);
    },
  },
  {
    name: 'camera stream: gera token temporario para camera alvo',
    run: async () => {
      if (!cameraId) {
        console.log('skip - DRAC_E2E_CAMERA_ID nao definido.');
        return;
      }
      const token = await login();
      const { response, body } = await jsonRequest(`/camera-stream/${cameraId}/token`, token, { method: 'POST' });
      assert.equal(response.status, 201, `token de stream falhou: ${JSON.stringify(body)}`);
      assert.ok(body.streamToken);
      assert.ok(body.expiresAt);
    },
  },
  {
    name: 'recording: start/stop opcional para camera alvo',
    run: async () => {
      if (!cameraId || !allowRecordingMutation) {
        console.log('skip - defina DRAC_E2E_CAMERA_ID e DRAC_E2E_RECORDING_MUTATION=1 para testar start/stop.');
        return;
      }
      const token = await login();
      const start = await jsonRequest(`/cameras/${cameraId}/recording/start`, token, { method: 'POST' });
      assert.ok([200, 201, 409].includes(start.response.status), `start gravacao falhou: ${start.response.status} ${JSON.stringify(start.body)}`);

      const stop = await jsonRequest(`/cameras/${cameraId}/recording/stop`, token, { method: 'POST' });
      assert.ok([200, 201, 404, 409].includes(stop.response.status), `stop gravacao falhou: ${stop.response.status} ${JSON.stringify(stop.body)}`);
    },
  },
  {
    name: 'playback: gera token para gravacao existente',
    run: async () => {
      if (!recordingId) {
        console.log('skip - DRAC_E2E_RECORDING_ID nao definido.');
        return;
      }
      const token = await login();
      const { response, body } = await jsonRequest(`/recordings/${recordingId}/play-token`, token, { method: 'POST' });
      assert.equal(response.status, 201, `play-token falhou: ${JSON.stringify(body)}`);
      assert.ok(body.playToken);
      assert.ok(body.expiresAt);
    },
  },
];

async function main() {
  requireE2eEnabled();
  let failures = 0;
  for (const item of tests) {
    try {
      await item.run();
      console.log(`ok - ${item.name}`);
    } catch (error) {
      failures += 1;
      console.error(`not ok - ${item.name}`);
      console.error(error);
    }
  }

  if (failures > 0) {
    console.error(`${failures} teste(s) e2e falharam.`);
    process.exit(1);
  }

  console.log(`${tests.length} teste(s) e2e concluidos.`);
}

void main();
