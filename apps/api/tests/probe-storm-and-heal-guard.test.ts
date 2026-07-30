import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MediamtxProxyService } from '../src/camera-stream/mediamtx-proxy.service';

// ─────────────────────────────────────────────────────────────────────────────
// TRÊS DEFEITOS QUE, JUNTOS, TRANSFORMAVAM OSCILAÇÃO DE REDE EM COLAPSO
//
// Comparação contra o estado estável de 21/07 (clone em "sistema antigo - drac")
// mostrou que a live não regrediu por uma linha ruim: regrediu porque três
// melhorias corretas, somadas, assumiam que a rede está boa.
//
//  1. A escada de descoberta do sub foi de 2 para 5 degraus SEQUENCIAIS, sem
//     teto global. Grade de 21 tiles com cache frio = até 105 ffprobe contra o
//     mesmo DVR — que é o equipamento do cliente, com uplink e sessões RTSP
//     limitados. A tempestade derruba a fonte que ela tentava descobrir.
//
//  2. A autocura tratava "não pronto + espectador + zero byte" como endpoint
//     errado. Mas isso descreve TAMBÉM link caído — e aí re-sondar só piora,
//     fechando um ciclo de realimentação a cada 60s por câmera.
//
//  3. A sanitização da faixa de metadados só valia para URLs /Streaming/Channels/,
//     deixando 15 das 19 câmeras da frota despejando "unknown payload type"
//     continuamente (30 avisos por minuto só na Cam-01), o que afoga erro real.
// ─────────────────────────────────────────────────────────────────────────────

function makeProxy(overrides: Record<string, unknown> = {}) {
  const config = { get: () => undefined } as any;
  const mgr = new MediamtxProxyService(config, {} as any, {} as any, {} as any) as any;
  mgr.logger = { error() {}, warn() {}, log() {}, debug() {} };
  Object.assign(mgr, overrides);
  return mgr;
}

const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((r) => { release = r; });
  return { promise, release };
};

// ── 1. TETO DE SONDAS ────────────────────────────────────────────────────────

test('sondas simultâneas respeitam o teto; o excedente espera na fila', async () => {
  const mgr = makeProxy();
  mgr.maxConcurrentProbes = 3;

  let running = 0;
  let peak = 0;
  const gates = Array.from({ length: 12 }, deferred);

  const tasks = gates.map((gate, i) =>
    mgr.withProbeSlot(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await gate.promise;
      running -= 1;
      return i;
    }),
  );

  // Nada foi liberado ainda: só o teto pode estar em execução.
  await new Promise((r) => setImmediate(r));
  assert.equal(running, 3, 'apenas 3 sondas podem rodar de uma vez');

  gates.forEach((g) => g.release());
  const results = await Promise.all(tasks);

  assert.equal(peak, 3, `pico de concorrência deveria ser 3, foi ${peak}`);
  assert.deepEqual(results, [...Array(12).keys()], 'nenhuma sonda pode ser perdida na fila');
  assert.equal(mgr.activeProbes, 0, 'o contador precisa zerar (senão a fila trava para sempre)');
});

test('sonda que falha devolve o slot (senão a fila entope e a live nunca abre)', async () => {
  const mgr = makeProxy();
  mgr.maxConcurrentProbes = 1;

  await assert.rejects(mgr.withProbeSlot(async () => { throw new Error('probe morreu'); }));
  assert.equal(mgr.activeProbes, 0, 'slot precisa ser devolvido mesmo com exceção');

  // O slot ficou de fato utilizável: sem isso, uma câmera doente travaria a frota.
  assert.equal(await mgr.withProbeSlot(async () => 'ok'), 'ok');
});

// ── 2. AUTOCURA CIENTE DA REDE ───────────────────────────────────────────────

const CAM = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const HASH = 'a'.repeat(32);

function pathListWith(muteOthers: number, healthyOthers: number) {
  const items: Array<Record<string, unknown>> = [
    { name: `cam_${HASH}_grid`, ready: false, bytesReceived: 0 },
  ];
  for (let i = 0; i < muteOthers; i += 1) {
    items.push({ name: `cam_${String(i).padStart(32, 'b')}_grid`, ready: false, bytesReceived: 0 });
  }
  for (let i = 0; i < healthyOthers; i += 1) {
    items.push({ name: `cam_${String(i).padStart(32, 'c')}_grid`, ready: true, bytesReceived: 999_999 });
  }
  return JSON.stringify({ items });
}

function proxyForHeal(list: string) {
  return makeProxy({
    isEnabled: () => true,
    apiRequest: async (_m: string, url: string) =>
      url.includes('/paths/list')
        ? list
        : JSON.stringify({ ready: false, tracks: [], readers: [{ id: 'r' }], bytesReceived: 0 }),
  });
}

test('câmera muda ISOLADA continua sendo re-sondada (autocura preservada)', async () => {
  // Vizinhança saudável ⇒ o problema é o endpoint desta câmera, e re-sondar cura.
  const mgr = proxyForHeal(pathListWith(0, 6));
  assert.equal(await mgr.gridPathLooksDead(CAM), true);
});

test('frota inteira muda NÃO dispara re-sonda (corta a realimentação)', async () => {
  // 6 vizinhos mudos ⇒ link/DVR caiu. Sondar aqui é jogar carga em quem já caiu.
  const mgr = proxyForHeal(pathListWith(6, 0));
  assert.equal(
    await mgr.gridPathLooksDead(CAM),
    false,
    'com a frota muda, a autocura precisa SEGURAR — foi assim que a queda de rede virou colapso',
  );
});

test('amostra pequena mantém o comportamento antigo (não inventa conclusão)', async () => {
  const mgr = proxyForHeal(pathListWith(1, 0)); // só 1 vizinho: não dá para concluir
  assert.equal(await mgr.gridPathLooksDead(CAM), true);
});

test('path pronto e sem faixa nenhuma segue sendo curado, chova ou faça sol', async () => {
  const mgr = makeProxy({
    isEnabled: () => true,
    apiRequest: async (_m: string, url: string) =>
      url.includes('/paths/list')
        ? pathListWith(6, 0) // até com a frota muda
        : JSON.stringify({ ready: true, tracks: [], readers: [], bytesReceived: 10 }),
  });
  assert.equal(await mgr.gridPathLooksDead(CAM), true);
});

test('falha ao consultar o MediaMTX nunca vira "morto" (não derruba live saudável)', async () => {
  const mgr = makeProxy({
    isEnabled: () => true,
    apiRequest: async () => { throw new Error('API fora'); },
  });
  assert.equal(await mgr.gridPathLooksDead(CAM), false);
});
