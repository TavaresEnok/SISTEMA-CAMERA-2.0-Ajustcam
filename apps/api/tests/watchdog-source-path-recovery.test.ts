import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MediamtxProxyService } from '../src/camera-stream/mediamtx-proxy.service';

// ─────────────────────────────────────────────────────────────────────────────
// WATCHDOG x PATHS PRIVADOS (`..._source`)
//
// Quem segura a conexão RTSP com a câmera não é o path público — é o PRIVADO.
// Quando a fonte precisa de transcode (sub H.265, áudio p/ WebRTC, sanitização),
// o público vira `source: publisher` e quem fala com o DVR é `cam_<hex>_grid_source`.
//
// DEFEITO QUE ESTE TESTE FIXA: o scan do watchdog coleta qualquer path que
// comece com `cam_`, então os `_source` CHEGAVAM à recuperação — mas o parser
// (`cameraIdFromPathName`) só reconhecia `cam_<hex>[_grid|_orig]`, devolvia null
// e a recuperação retornava em silêncio. Resultado: o path que de fato importa
// ficava travado para sempre, sem log e sem métrica, enquanto o público seco
// era "recuperado" repetidamente sem efeito.
//
// Na prática isso é a câmera que fica em 0 fps e não volta sozinha — exatamente
// o sintoma que motivou a investigação.
// ─────────────────────────────────────────────────────────────────────────────

const HEX = 'a'.repeat(32);
const CAM_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

type Ensure = { cameraId: string; deliveryMode: string };

function makeProxy() {
  const ensured: Ensure[] = [];
  const deleted: string[] = [];
  const config = { get: () => undefined } as any;
  const mgr = new MediamtxProxyService(config, {} as any, {} as any, {} as any) as any;
  mgr.logger = { error() {}, warn() {}, log() {}, debug() {} };
  mgr.invalidateMainCodecCache = () => {};
  mgr.apiRequest = async (method: string, url: string) => {
    if (method === 'DELETE') deleted.push(decodeURIComponent(url.split('/').pop() ?? ''));
    return '';
  };
  mgr.ensurePathForCamera = async (cameraId: string, deliveryMode: string) => {
    ensured.push({ cameraId, deliveryMode });
  };
  return { mgr, ensured, deleted };
}

test('path privado _grid_source travado é recuperado (antes: ignorado em silêncio)', async () => {
  const { mgr, ensured, deleted } = makeProxy();

  await mgr.recoverStuckPath(`cam_${HEX}_grid_source`, true, 1);

  assert.equal(ensured.length, 1, 'o watchdog precisa recuperar a câmera dona do path privado');
  assert.equal(ensured[0].cameraId, CAM_ID);
  assert.equal(
    ensured[0].deliveryMode,
    'grid',
    'o sufixo _source não pode confundir o modo: _grid_source pertence à GRADE',
  );
  // O DELETE tem de mirar o path REALMENTE travado (o privado), não o público:
  // apagar o público deixaria a fonte congelada intacta e o problema de pé.
  assert.ok(
    deleted.includes(`cam_${HEX}_grid_source`),
    `esperava DELETE em cam_${HEX}_grid_source, veio ${JSON.stringify(deleted)}`,
  );
});

test('_source dos demais modos também é reconhecido', async () => {
  for (const [suffix, mode] of [['_source', 'selected'], ['_orig_source', 'original']] as const) {
    const { mgr, ensured } = makeProxy();
    await mgr.recoverStuckPath(`cam_${HEX}${suffix}`, true, 1);
    assert.equal(ensured.length, 1, `${suffix} deveria recuperar`);
    assert.equal(ensured[0].deliveryMode, mode, `${suffix} → modo ${mode}`);
  }
});

test('paths públicos continuam recuperando como antes (sem regressão)', async () => {
  for (const [suffix, mode] of [['', 'selected'], ['_grid', 'grid'], ['_orig', 'original']] as const) {
    const { mgr, ensured, deleted } = makeProxy();
    await mgr.recoverStuckPath(`cam_${HEX}${suffix}`, true, 1);
    assert.equal(ensured.length, 1, `cam_<hex>${suffix} deveria recuperar`);
    assert.equal(ensured[0].deliveryMode, mode);
    assert.ok(deleted.includes(`cam_${HEX}${suffix}`));
  }
});

test('nome que não é de câmera segue ignorado (não vira recuperação fantasma)', async () => {
  for (const name of ['mtx-scratch', 'cam_naohex_grid_source', `cam_${HEX}_grid_source_extra`]) {
    const { mgr, ensured, deleted } = makeProxy();
    await mgr.recoverStuckPath(name, true, 1);
    assert.equal(ensured.length, 0, `${name} não deveria disparar recuperação`);
    assert.equal(deleted.length, 0, `${name} não deveria apagar path nenhum`);
  }
});
