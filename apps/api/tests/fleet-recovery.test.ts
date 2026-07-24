import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MediamtxProxyService } from '../src/camera-stream/mediamtx-proxy.service';

// ─────────────────────────────────────────────────────────────────────────────
// D1 (2.2): recuperação de paths travados em PARALELO (limite), no lugar do
// booleano global `recovering` que serializava. Guard por-path evita recuperar o
// mesmo path duas vezes concorrentemente. Testado via override dos seams.
// ─────────────────────────────────────────────────────────────────────────────

function makeProxy() {
  const config = { get: () => undefined } as any;
  const mgr = new MediamtxProxyService(config, {} as any, {} as any, {} as any) as any;
  mgr.logger = { error() {}, warn() {}, log() {}, debug() {} };
  return mgr;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const validPath = (h: string) => `cam_${h.repeat(32).slice(0, 32)}`;

test('D1 2.2: recoverStuckPaths recupera vários paths CONCORRENTEMENTE (não serial)', async () => {
  const mgr = makeProxy();
  let active = 0;
  let peak = 0;
  const recovered: string[] = [];
  mgr.recoverStuckPath = async (name: string) => {
    active++;
    peak = Math.max(peak, active);
    await delay(15);
    recovered.push(name);
    active--;
  };
  const stuck = [validPath('a'), validPath('b'), validPath('c')].map((name) => ({ name, ready: false, readers: 1 }));
  await mgr.recoverStuckPaths(stuck);
  assert.equal(recovered.length, 3, 'todos os paths travados são recuperados');
  assert.ok(peak >= 2, `recuperações devem ser concorrentes (pico observado=${peak})`);
});

test('D1 2.2: guard por-path evita recuperar o MESMO path duas vezes ao mesmo tempo', async () => {
  const mgr = makeProxy();
  let ensureCalls = 0;
  mgr.invalidateMainCodecCache = () => {};
  mgr.apiRequest = async () => '';
  mgr.ensurePathForCamera = async () => { ensureCalls++; await delay(15); };
  const name = validPath('a');
  // Duas recuperações concorrentes do MESMO path: a 2ª deve sair pelo guard.
  await Promise.all([mgr.recoverStuckPath(name, false, 1), mgr.recoverStuckPath(name, false, 1)]);
  assert.equal(ensureCalls, 1, 'o mesmo path não é reconfigurado duas vezes em paralelo');
});
