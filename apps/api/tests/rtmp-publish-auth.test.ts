import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CameraStreamController } from '../src/camera-stream/camera-stream.controller';
import { PendingIngestRegistry } from '../src/cameras/pending-ingest.registry';
import {
  compactIngestPathName,
  generateIngestKey,
  hashIngestKey,
  ingestPathName,
  SOURCE_MODE_PUSH,
} from '../src/cameras/helpers/rtmp-ingest.helper';

// ─────────────────────────────────────────────────────────────────────────────
// O PORTÃO DE PUBLICAÇÃO
//
// Até esta funcionalidade, PUBLICAR só era possível com a credencial
// administrativa do MediaMTX: `action !== 'read' && action !== 'playback'` caía
// direto no 401. Abrir uma exceção nesse portão é a mudança de maior risco de
// todo o recurso — quem chama aqui ainda não provou nada.
//
// Estes testes fixam as quatro condições que a exceção exige, e o fato de que
// publicar NÃO passa a valer como permissão de leitura.
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN_INTERNO = 'x'.repeat(48);

/** Resposta mínima no formato do Express, capturando o que foi respondido. */
function respostaFalsa() {
  const capturado: { status?: number; corpo?: any } = {};
  const res: any = {
    status(codigo: number) { capturado.status = codigo; return res; },
    json(corpo: any) { capturado.corpo = corpo; return res; },
  };
  return { res, capturado };
}

/** Controller com apenas o que o caminho de autenticação toca. */
function montarController(opcoes: { cameraPorChave?: (k: unknown) => Promise<any>; cameraPorCaminho?: (p: unknown) => Promise<any> } = {}) {
  const config: any = {
    get: (chave: string) => {
      if (chave === 'mediaMtxAuthCallbackToken') return TOKEN_INTERNO;
      if (chave === 'mediaMtxApiUser') return 'admin-interno';
      if (chave === 'mediaMtxApiPass') return 'senha-interna-muito-longa';
      return undefined;
    },
  };
  const cameras: any = {
    findCameraByIngestKey: opcoes.cameraPorChave ?? (async () => null),
    // Sem vínculo aprendido, salvo quando o teste disser o contrário.
    findCameraByIngestPath: (opcoes as any).cameraPorCaminho ?? (async () => null),
  };
  // O registro de tentativas entra aqui: recusar em silêncio foi o que
  // transformou a primeira tentativa de campo num mistério.
  const pendentes = new PendingIngestRegistry();
  return new CameraStreamController(
    null as any, null as any, null as any, cameras,
    null as any, null as any, null as any, null as any, null as any, config,
    pendentes,
  );
}

async function autorizar(body: Record<string, unknown>, opcoes = {}) {
  const { res, capturado } = respostaFalsa();
  const controller = montarController(opcoes);
  await controller.authorizeMediaMtx(body as any, TOKEN_INTERNO, res);
  return capturado;
}

const CHAVE = generateIngestKey();
const CAMERA_VALIDA = {
  id: 'abc', name: 'Portaria', enabled: true,
  sourceMode: SOURCE_MODE_PUSH, rtmpIngestKeyHash: hashIngestKey(CHAVE),
};

test('publicação com chave válida por RTMP é autorizada', async () => {
  const r = await autorizar(
    { action: 'publish', protocol: 'rtmp', path: ingestPathName(CHAVE) },
    { cameraPorChave: async (k: unknown) => (k === CHAVE ? CAMERA_VALIDA : null) },
  );
  assert.equal(r.status, 200);
  assert.equal(r.corpo?.authorized, true);
});

test('publicação pelo alias curto Base64URL resolve a mesma chave de 128 bits', async () => {
  const r = await autorizar(
    { action: 'publish', protocol: 'rtmp', path: compactIngestPathName(CHAVE) },
    { cameraPorChave: async (k: unknown) => (k === CHAVE ? CAMERA_VALIDA : null) },
  );
  assert.equal(r.status, 200);
  assert.equal(r.corpo?.authorized, true);
});

test('RTMPS também é aceito', async () => {
  const r = await autorizar(
    { action: 'publish', protocol: 'rtmps', path: ingestPathName(CHAVE) },
    { cameraPorChave: async () => CAMERA_VALIDA },
  );
  assert.equal(r.status, 200);
});

test('chave desconhecida é recusada', async () => {
  const r = await autorizar(
    { action: 'publish', protocol: 'rtmp', path: ingestPathName(generateIngestKey()) },
    { cameraPorChave: async () => null },
  );
  assert.equal(r.status, 401);
});

test('câmera desabilitada ou fora do modo push não publica', async () => {
  // A resolução da chave devolve null nesses casos (regra em findCameraByIngestKey);
  // aqui garantimos que o controller trata null como negação, sem exceção.
  const r = await autorizar(
    { action: 'publish', protocol: 'rtmp', path: ingestPathName(CHAVE) },
    { cameraPorChave: async () => null },
  );
  assert.equal(r.status, 401);
});

test('erro ao consultar o banco nega, não libera', async () => {
  const r = await autorizar(
    { action: 'publish', protocol: 'rtmp', path: ingestPathName(CHAVE) },
    { cameraPorChave: async () => { throw new Error('banco fora'); } },
  );
  assert.equal(r.status, 401, 'falha de infraestrutura jamais pode virar autorização');
});

test('publicar por outro protocolo é recusado mesmo com chave boa', async () => {
  for (const protocolo of ['rtsp', 'webrtc', 'srt', 'hls', '', undefined]) {
    const r = await autorizar(
      { action: 'publish', protocol: protocolo, path: ingestPathName(CHAVE) },
      { cameraPorChave: async () => CAMERA_VALIDA },
    );
    assert.equal(r.status, 401, `protocolo ${protocolo} não deveria publicar`);
  }
});

test('PUBLICADOR NÃO ASSUME PATH DE CÂMERA — a garantia central', async () => {
  const alvos = [
    'cam_5b55e86c16cd4976bc23a08e699aa5f3',
    'cam_5b55e86c16cd4976bc23a08e699aa5f3_grid',
    'cam_5b55e86c16cd4976bc23a08e699aa5f3_orig',
    'cam_5b55e86c16cd4976bc23a08e699aa5f3_source',
    `drac/${CHAVE}/../cam_5b55e86c16cd4976bc23a08e699aa5f3`,
    `${compactIngestPathName(CHAVE)}/../cam_5b55e86c16cd4976bc23a08e699aa5f3`,
  ];
  for (const alvo of alvos) {
    const r = await autorizar(
      { action: 'publish', protocol: 'rtmp', path: alvo },
      // Mesmo que a resolução de chave fosse permissiva, o path já barra.
      { cameraPorChave: async () => CAMERA_VALIDA },
    );
    assert.equal(r.status, 401, `${alvo} jamais pode aceitar publicação`);
  }
});

test('publicar não vira permissão de leitura', async () => {
  // Sem streamToken, ler o path de uma câmera continua negado — a exceção de
  // publicação não pode ter afrouxado o caminho de leitura.
  const r = await autorizar(
    { action: 'read', protocol: 'webrtc', path: 'cam_5b55e86c16cd4976bc23a08e699aa5f3_grid' },
    { cameraPorChave: async () => CAMERA_VALIDA },
  );
  assert.equal(r.status, 401);
});

test('ler o path de ingestão sem token continua negado', async () => {
  const r = await autorizar(
    { action: 'read', protocol: 'webrtc', path: ingestPathName(CHAVE) },
    { cameraPorChave: async () => CAMERA_VALIDA },
  );
  assert.equal(r.status, 401, 'a chave de publicação não pode servir para assistir');
});

test('callback sem o token interno é recusado antes de tudo', async () => {
  const { res, capturado } = respostaFalsa();
  const controller = montarController({ cameraPorChave: async () => CAMERA_VALIDA });
  await controller.authorizeMediaMtx(
    { action: 'publish', protocol: 'rtmp', path: ingestPathName(CHAVE) } as any,
    'token-errado',
    res,
  );
  assert.equal(capturado.status, 401);
});

test('ações desconhecidas seguem negadas', async () => {
  for (const acao of ['delete', 'admin', 'api', '', 'PUBLISH']) {
    const r = await autorizar(
      { action: acao, protocol: 'rtmp', path: ingestPathName(CHAVE) },
      { cameraPorChave: async () => CAMERA_VALIDA },
    );
    assert.equal(r.status, 401, `ação "${acao}" não deveria passar`);
  }
});
