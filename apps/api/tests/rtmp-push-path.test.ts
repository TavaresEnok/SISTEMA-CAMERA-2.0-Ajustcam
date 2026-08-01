import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MediamtxProxyService } from '../src/camera-stream/mediamtx-proxy.service';
import {
  generateIngestKey,
  ingestPathName,
  SOURCE_MODE_PULL,
  SOURCE_MODE_PUSH,
} from '../src/cameras/helpers/rtmp-ingest.helper';

// ─────────────────────────────────────────────────────────────────────────────
// A INVARIANTE QUE PROTEGE A FROTA EXISTENTE
//
// A ingestão por RTMP é um recurso novo, e o requisito do dono foi explícito:
// não pode atrapalhar o que já funciona. A garantia técnica disso é estrutural
// — o desvio para o modo push acontece ANTES de qualquer trabalho, e as 21
// câmeras da instalação (todas em 'rtsp_pull') nunca entram nesse ramo.
//
// Estes testes existem para que essa separação não se perca numa refatoração:
// se alguém um dia fizer o caminho pull passar pela lógica de push, cai aqui.
// ─────────────────────────────────────────────────────────────────────────────

const CAMERA_ID = '5b55e86c16cd4976bc23a08e699aa5f3';

function makeProxy(overrides: Record<string, unknown> = {}) {
  const config = { get: () => undefined } as any;
  const mgr = new MediamtxProxyService(config, {} as any, {} as any, {} as any) as any;
  mgr.logger = { error() {}, warn() {}, log() {}, debug() {} };
  Object.assign(mgr, overrides);
  return mgr;
}

/** Câmera de teste no modo push, com chave cifrada simulada. */
function cameraPush(chave: string, extra: Record<string, unknown> = {}) {
  return {
    id: CAMERA_ID,
    name: 'Portaria (4G)',
    enabled: true,
    sourceMode: SOURCE_MODE_PUSH,
    rtmpIngestKeyEncrypted: `cifrado:${chave}`,
    passwordEncrypted: 'irrelevante-no-modo-push',
    ...extra,
  };
}

test('câmera em push lê do path de ingestão, sem discar para a câmera', async () => {
  const chave = generateIngestKey();
  const chamadas: Array<{ metodo: string; rota: string; corpo?: any }> = [];
  const mgr = makeProxy({
    cryptoService: { decrypt: (v: string) => v.replace(/^cifrado:/, '') },
    pathNameFromCameraId: () => `cam_${CAMERA_ID}_grid`,
    buildInternalRtspUrl: (p: string) => `rtsp://mediamtx:8554/${p}`,
    getPath: async () => { throw new Error('não existe'); },
    apiRequest: async (metodo: string, rota: string, corpo?: any) => {
      chamadas.push({ metodo, rota, corpo });
      return '{}';
    },
  });

  const r = await mgr.configurePushSourcedPath(cameraPush(chave), 'grid');

  assert.equal(r.sourceUrl, `rtsp://mediamtx:8554/${ingestPathName(chave)}`);
  assert.equal(r.sourceVideoCodec, 'h264', 'RTMP clássico entrega H.264');
  assert.equal(r.transcodedForLive, false, 'push não pode custar transcode');
  assert.equal(r.deliveryMode, 'grid');

  const criado = chamadas.find((c) => c.metodo === 'POST');
  assert.ok(criado, 'o path deveria ter sido criado');
  assert.equal(criado!.corpo.source, `rtsp://mediamtx:8554/${ingestPathName(chave)}`);
  assert.equal(criado!.corpo.sourceOnDemand, true, 'repasse só enquanto alguém assiste');
  assert.notEqual(criado!.corpo.source, 'publisher', 'não deve subir FFmpeg para câmera que publica');
});

test('os três modos leem a MESMA ingestão — quem publica manda um fluxo só', async () => {
  const chave = generateIngestKey();
  const fontes: string[] = [];
  for (const modo of ['grid', 'selected', 'original'] as const) {
    const mgr = makeProxy({
      cryptoService: { decrypt: (v: string) => v.replace(/^cifrado:/, '') },
      pathNameFromCameraId: (_id: string, m: string) => `cam_${CAMERA_ID}_${m}`,
      buildInternalRtspUrl: (p: string) => `rtsp://mediamtx:8554/${p}`,
      getPath: async () => { throw new Error('não existe'); },
      apiRequest: async () => '{}',
    });
    const r = await mgr.configurePushSourcedPath(cameraPush(chave), modo);
    fontes.push(r.sourceUrl);
  }
  assert.equal(new Set(fontes).size, 1, 'grade, selecionada e original devem partir da mesma ingestão');
});

test('path já correto não é recriado — recriar derruba quem está assistindo', async () => {
  const chave = generateIngestKey();
  const fonte = `rtsp://mediamtx:8554/${ingestPathName(chave)}`;
  const chamadas: string[] = [];
  const mgr = makeProxy({
    cryptoService: { decrypt: (v: string) => v.replace(/^cifrado:/, '') },
    pathNameFromCameraId: () => `cam_${CAMERA_ID}_grid`,
    buildInternalRtspUrl: (p: string) => `rtsp://mediamtx:8554/${p}`,
    getPath: async () => ({ source: fonte, rtspTransport: 'tcp', sourceOnDemand: true }),
    apiRequest: async (metodo: string) => { chamadas.push(metodo); return '{}'; },
  });

  const r = await mgr.configurePushSourcedPath(cameraPush(chave), 'grid');
  assert.equal(r.sourceUrl, fonte);
  assert.deepEqual(chamadas, [], 'nenhuma mutação deveria ocorrer quando a config já está certa');
});

test('modo push sem chave gerada falha explicitamente, não fica "Conectando"', async () => {
  const mgr = makeProxy({
    cryptoService: { decrypt: () => { throw new Error('sem chave'); } },
    pathNameFromCameraId: () => `cam_${CAMERA_ID}_grid`,
    buildInternalRtspUrl: (p: string) => `rtsp://mediamtx:8554/${p}`,
    getPath: async () => { throw new Error('não existe'); },
    apiRequest: async () => '{}',
  });
  await assert.rejects(
    () => mgr.configurePushSourcedPath(cameraPush('x') as any, 'grid'),
    /chave de ingestão/i,
  );
});

test('chave corrompida no cadastro não vira path inválido', async () => {
  const mgr = makeProxy({
    cryptoService: { decrypt: () => 'NAO-E-UMA-CHAVE-HEXA' },
    pathNameFromCameraId: () => `cam_${CAMERA_ID}_grid`,
    buildInternalRtspUrl: (p: string) => `rtsp://mediamtx:8554/${p}`,
    getPath: async () => { throw new Error('não existe'); },
    apiRequest: async () => { throw new Error('não deveria chegar aqui'); },
  });
  await assert.rejects(() => mgr.configurePushSourcedPath(cameraPush('x') as any, 'grid'));
});

test('câmera em rtsp_pull JAMAIS entra no ramo de push', () => {
  // A separação é decidida por isPushSourced, e o padrão do banco é rtsp_pull.
  // Este teste documenta o contrato: só o valor exato desvia o fluxo.
  const { isPushSourced } = require('../src/cameras/helpers/rtmp-ingest.helper');
  assert.equal(isPushSourced({ sourceMode: SOURCE_MODE_PULL }), false);
  assert.equal(isPushSourced({ sourceMode: undefined }), false, 'instalação antiga sem a coluna');
  assert.equal(isPushSourced({ sourceMode: SOURCE_MODE_PUSH }), true);
});
