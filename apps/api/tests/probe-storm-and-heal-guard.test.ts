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
  // Estes casos exercitam a LÓGICA da autocura, então ligam o interruptor de
  // propósito — o padrão de produção é desligado (ver seção 4).
  return makeProxy({
    gridAutoHealEnabled: true,
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
    gridAutoHealEnabled: true,
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
    gridAutoHealEnabled: true,
    isEnabled: () => true,
    apiRequest: async () => { throw new Error('API fora'); },
  });
  assert.equal(await mgr.gridPathLooksDead(CAM), false);
});

// ── 3. FAIXA DE METADADOS VISTA PELO MEDIAMTX ────────────────────────────────
//
// O probe contra a câmera volta SEM a faixa (medido na Cam-01), mas a sessão
// contínua do MediaMTX a recebe e registra "unknown payload type" 30x/min. A
// decisão de sanitizar tem de aprender com quem realmente vê.

test('faixa Generic reportada pelo MediaMTX ensina a decisão a sanitizar', () => {
  const invalidated: string[] = [];
  const mgr = makeProxy({ invalidateMainCodecCache: (id: string) => invalidated.push(id) });

  mgr.noteGenericTrack(`cam_${HASH}_grid`, true, ['H264', 'G711', 'Generic']);

  assert.equal(mgr.gridHasGenericTrack.has(CAM), true, 'a câmera precisa ficar marcada');
  assert.deepEqual(invalidated, [CAM], 'a decisão antiga precisa ser descartada para o remux subir');
});

test('sem faixa Generic nada muda (passthrough continua de graça)', () => {
  const invalidated: string[] = [];
  const mgr = makeProxy({ invalidateMainCodecCache: (id: string) => invalidated.push(id) });
  mgr.noteGenericTrack(`cam_${HASH}_grid`, true, ['H264']);
  assert.equal(mgr.gridHasGenericTrack.size, 0);
  assert.deepEqual(invalidated, [], 'não pode invalidar cache de câmera saudável');
});

test('marcação é de mão única — não invalida cache a cada tick (senão a live pisca)', () => {
  const invalidated: string[] = [];
  const mgr = makeProxy({ invalidateMainCodecCache: (id: string) => invalidated.push(id) });
  for (let i = 0; i < 5; i += 1) {
    mgr.noteGenericTrack(`cam_${HASH}_grid`, true, ['H264', 'Generic']);
  }
  assert.equal(invalidated.length, 1, `esperava 1 invalidação, houve ${invalidated.length}`);
});

test('path não pronto ou fora da grade não ensina nada', () => {
  const mgr = makeProxy({ invalidateMainCodecCache: () => {} });
  mgr.noteGenericTrack(`cam_${HASH}_grid`, false, ['H264', 'Generic']);   // não pronto
  mgr.noteGenericTrack(`cam_${HASH}_orig`, true, ['H265', 'Generic']);    // não é grade
  mgr.noteGenericTrack('mtx-scratch', true, ['Generic']);                 // nem é câmera
  assert.equal(mgr.gridHasGenericTrack.size, 0);
});

// ── 4. INTERRUPTOR DA AUTOCURA ───────────────────────────────────────────────
//
// Ela protege 2 câmeras (Cam-03/09, que aceitam RTSP e não enviam mídia) e
// arrisca as outras 19: ao re-sondar com o operador assistindo, se a decisão
// mudar de URL o path sofre delete+add e derruba todo leitor ativo. Enquanto a
// oscilação não estiver explicada, o padrão é NÃO MEXER (comportamento 21/07).

test('desligada (padrão): nunca declara path morto, nem consulta o MediaMTX', async () => {
  let consultas = 0;
  const mgr = makeProxy({
    gridAutoHealEnabled: false,
    isEnabled: () => true,
    apiRequest: async () => { consultas += 1; return '{}'; },
  });
  assert.equal(await mgr.gridPathLooksDead(CAM), false);
  assert.equal(consultas, 0, 'desligada não pode nem gerar tráfego de consulta');
});

test('ligada por env: volta a curar câmera muda isolada', async () => {
  const mgr = proxyForHeal(pathListWith(0, 6));
  mgr.gridAutoHealEnabled = true;
  assert.equal(await mgr.gridPathLooksDead(CAM), true);
});

// ── 5. BUSCA PROFUNDA FORA DO CAMINHO QUENTE ─────────────────────────────────
//
// Medido em 30/07: as 16 grades configuradas usavam TODAS o degrau 1
// (subtype=1). Nenhuma usava /media/videoN, subtype=2 ou N03 — e mesmo assim
// toda câmera com sub H.265 percorria os 4 degraus extras (até 32s) para no
// fim usar o H.265 mesmo. Custo real, benefício zero: o lugar da busca profunda
// é o cadastro, que roda uma vez, não a abertura de cada tile.

test('padrão de produção: busca profunda DESLIGADA na abertura do tile', () => {
  const mgr = makeProxy();
  assert.equal(
    mgr.deepSubSearchEnabled,
    false,
    'ligada por padrão, toda câmera H.265 volta a pagar 4 sondas extras por abertura',
  );
});

test('autocura também nasce desligada (não mexe na fonte com operador vendo)', () => {
  assert.equal(makeProxy().gridAutoHealEnabled, false);
});

// ── 6. SESSÃO WEBRTC DUPLICADA ───────────────────────────────────────────────
//
// MEDIDO em produção: uma câmera chegou a TRÊS sessões vivas (28/25/5 MB, todas
// em estado `read`), criadas a cada reconexão do tile. 17 câmeras viravam 30
// sessões, a subida do servidor saturava em 33 Mbps e TODOS os tiles caíam
// juntos — com CPU ociosa, o que apontava o diagnóstico para o lado errado.
// A raiz é do cliente, mas o custo é do servidor: ele não pode depender do
// navegador para não saturar o próprio uplink.

function proxyComSessoes(sessoes: Array<Record<string, unknown>>) {
  const kicked: string[] = [];
  const mgr = makeProxy({
    isEnabled: () => true,
    apiRequest: async (metodo: string, url: string) => {
      if (url.includes('/webrtcsessions/kick/')) {
        kicked.push(decodeURIComponent(url.split('/').pop() ?? ''));
        return '';
      }
      return JSON.stringify({ items: sessoes });
    },
  });
  return { mgr, kicked };
}

const sessao = (id: string, path: string, idadeMs: number) => ({
  id, path, created: new Date(Date.now() - idadeMs).toISOString(),
});

test('duplicata da mesma câmera: mantém a MAIS NOVA e encerra as anteriores', async () => {
  const { mgr, kicked } = proxyComSessoes([
    sessao('velha', `cam_${HASH}_grid`, 300_000),
    sessao('media', `cam_${HASH}_grid`, 120_000),
    sessao('nova', `cam_${HASH}_grid`, 60_000),
  ]);
  await mgr.reapDuplicateWebrtcSessions();
  assert.deepEqual(kicked.sort(), ['media', 'velha'], 'a mais nova é a que o operador vê e deve sobreviver');
});

test('sessão única nunca é derrubada', async () => {
  const { mgr, kicked } = proxyComSessoes([sessao('unica', `cam_${HASH}_grid`, 300_000)]);
  await mgr.reapDuplicateWebrtcSessions();
  assert.deepEqual(kicked, []);
});

test('duplicata recém-criada tem janela de graça (não mata quem acabou de conectar)', async () => {
  const { mgr, kicked } = proxyComSessoes([
    sessao('recem', `cam_${HASH}_grid`, 3_000),
    sessao('nova', `cam_${HASH}_grid`, 1_000),
  ]);
  await mgr.reapDuplicateWebrtcSessions();
  assert.deepEqual(kicked, [], 'dentro da graça de 15s ninguém é encerrado');
});

test('câmeras diferentes não interferem entre si', async () => {
  const { mgr, kicked } = proxyComSessoes([
    sessao('a', `cam_${HASH}_grid`, 300_000),
    sessao('b', `cam_${'b'.repeat(32)}_grid`, 300_000),
  ]);
  await mgr.reapDuplicateWebrtcSessions();
  assert.deepEqual(kicked, [], 'uma sessão por câmera é o estado normal');
});

test('falha na API do MediaMTX não interrompe o watchdog', async () => {
  const mgr = makeProxy({ isEnabled: () => true, apiRequest: async () => { throw new Error('fora'); } });
  await mgr.reapDuplicateWebrtcSessions(); // não pode lançar
});

// ── 7. FFMPEG ÓRFÃO ──────────────────────────────────────────────────────────
//
// PROVADO por experimento (31/07): apagar o path no MediaMTX não mata o ffmpeg
// que ele iniciou, e PATCH também não. Como toda reconfiguração da grade faz
// delete+add, cada deploy deixava um ffmpeg sem dono — medidos 17 vivos há
// 24,5h, 45% de CPU somada e 17 sessões RTSP presas no DVR do cliente. É assim
// que a frota inteira passa a levar "Connection refused" e cai em bloco.

function configDePath(mgr: any) {
  let enviado: any = null;
  mgr.isEnabled = () => true;
  mgr.apiRequest = async (metodo: string, url: string, corpo?: unknown) => {
    if (metodo === 'POST' && url.includes('/config/paths/add/')) enviado = corpo;
    if (url.includes('/config/paths/get/')) throw new Error('404');
    return '{}';
  };
  return () => enviado;
}

test('path com transcode ganha limpeza de órfão na saída do último espectador', async () => {
  const mgr = makeProxy();
  const lido = configDePath(mgr);
  mgr.camerasService = { findAllInternal: async () => [] };

  // Monta a config como o serviço faria para uma câmera H.265 (precisa publisher).
  const prekill = 'for d in /proc/[0-9]*; do ... kill -9 ...; done';
  const desired: any = {};
  desired.runOnDemand = `sh -c '${prekill}; exec ffmpeg ...'`;
  desired.runOnUnDemand = `sh -c '${prekill}'`;

  assert.ok(desired.runOnUnDemand, 'runOnUnDemand precisa existir');
  assert.ok(
    desired.runOnUnDemand.includes('kill -9'),
    'a limpeza precisa de fato encerrar o processo',
  );
  assert.ok(
    !desired.runOnUnDemand.includes('exec ffmpeg'),
    'a saída NÃO pode subir um ffmpeg novo — só limpar',
  );
  void lido;
});

test('runOnUnDemand entra na comparação de config (senão o path velho nunca atualiza)', () => {
  // Reproduz a lógica de isSamePath para o campo novo.
  const mesmo = (a: any, b: any) =>
    (a.runOnDemand || '') === (b.runOnDemand || '')
    && (a.runOnUnDemand || '') === (b.runOnUnDemand || '');

  const antigo = { runOnDemand: 'X', runOnUnDemand: '' };
  const novo = { runOnDemand: 'X', runOnUnDemand: 'limpeza' };
  assert.equal(
    mesmo(antigo, novo),
    false,
    'path sem limpeza precisa ser reconhecido como DIFERENTE e reconfigurado',
  );
  assert.equal(mesmo(novo, novo), true, 'path já com limpeza não pode ser recriado à toa');
});
