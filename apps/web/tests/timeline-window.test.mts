import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TIMELINE_MAX_ZOOM,
  TIMELINE_TOTAL_MINUTES,
  chunkRanges,
  computeListWindow,
  computeVisibleWindow,
  coverageFromGaps,
  limitWindowAround,
  mergeByIdSorted,
  mergeRanges,
  orderRangesByDistance,
  planNextPage,
  planWindowFetch,
  selectThumbnailTargets,
  sliceVisibleSpans,
  subtractRanges,
  visibleSpanRange,
  decidirCentroAoMoverPlayhead,
} from '../src/lib/timeline-window.ts';

// Timeline por JANELA (item "timeline virtualizada"): a PlaybackPage não pode mais
// depender de baixar o DIA INTEIRO antes de desenhar a régua. Este módulo é a
// lógica PURA disso — janela visível, quais índices renderizar, quais itens
// precisam de token de miniatura e qual FAIXA de tempo ainda falta buscar.
//
// Invariante de VMS probatório que estes testes protegem: item PARCIALMENTE
// visível ENTRA na régua. Sumir com um trecho gravado da linha do tempo é pior
// do que renderizar um pouco a mais — o operador precisa VER que existe vídeo ali.

const DAY = TIMELINE_TOTAL_MINUTES;

// ── janela visível ────────────────────────────────────────────────────────────

test('computeVisibleWindow: zoom 1 mostra o dia inteiro', () => {
  const window = computeVisibleWindow({ zoom: 1, viewCenter: 480 });
  assert.deepEqual(window, { start: 0, end: DAY, windowMins: DAY, zoom: 1 });
});

test('computeVisibleWindow: janela centrada no viewCenter', () => {
  // zoom 2 → janela de 720 min centrada em 480 → 120..840.
  assert.deepEqual(computeVisibleWindow({ zoom: 2, viewCenter: 480 }), {
    start: 120,
    end: 840,
    windowMins: 720,
    zoom: 2,
  });
});

test('computeVisibleWindow: bordas do dia não deixam a janela escapar', () => {
  // Centro na meia-noite: a janela encosta em 0 (não vira negativa).
  assert.deepEqual(computeVisibleWindow({ zoom: 4, viewCenter: 0 }), {
    start: 0,
    end: 360,
    windowMins: 360,
    zoom: 4,
  });
  // Centro no fim do dia: encosta em 1440 (não passa do dia).
  assert.deepEqual(computeVisibleWindow({ zoom: 4, viewCenter: DAY }), {
    start: DAY - 360,
    end: DAY,
    windowMins: 360,
    zoom: 4,
  });
});

test('computeVisibleWindow: zoom mínimo e máximo são respeitados', () => {
  // Abaixo do mínimo → dia inteiro (não existe "menos que 24h de contexto").
  assert.deepEqual(computeVisibleWindow({ zoom: 0.1, viewCenter: 480 }).windowMins, DAY);
  assert.equal(computeVisibleWindow({ zoom: -5, viewCenter: 480 }).zoom, 1);
  // Acima do máximo → trava em TIMELINE_MAX_ZOOM (janela de 7,5 min).
  const deep = computeVisibleWindow({ zoom: 10_000, viewCenter: 600 });
  assert.equal(deep.zoom, TIMELINE_MAX_ZOOM);
  assert.equal(deep.windowMins, DAY / TIMELINE_MAX_ZOOM);
  assert.ok(Math.abs((deep.start + deep.end) / 2 - 600) < 1e-9);
});

test('computeVisibleWindow: entrada inválida cai no dia inteiro (nunca NaN)', () => {
  const nanZoom = computeVisibleWindow({ zoom: Number.NaN, viewCenter: 480 });
  assert.deepEqual(nanZoom, { start: 0, end: DAY, windowMins: DAY, zoom: 1 });
  const nanCenter = computeVisibleWindow({ zoom: 4, viewCenter: Number.NaN });
  assert.ok(Number.isFinite(nanCenter.start) && Number.isFinite(nanCenter.end));
  assert.equal(nanCenter.end - nanCenter.start, 360);
});

// ── virtualização da régua ────────────────────────────────────────────────────

const spans = [
  { start: 0, end: 100, id: 'a' },      // 0: todo antes da janela
  { start: 100, end: 210, id: 'b' },    // 1: entra pela borda esquerda (parcial)
  { start: 250, end: 300, id: 'c' },    // 2: dentro
  { start: 380, end: 500, id: 'd' },    // 3: entra pela borda direita (parcial)
  { start: 600, end: 700, id: 'e' },    // 4: todo depois da janela
];

test('sliceVisibleSpans seleciona SÓ os índices visíveis', () => {
  const visible = sliceVisibleSpans(spans, { start: 200, end: 400 });
  assert.deepEqual(visible.indices, [1, 2, 3]);
  assert.deepEqual(visible.items.map((item) => item.id), ['b', 'c', 'd']);
});

test('item PARCIALMENTE visível ENTRA na régua (não pode sumir)', () => {
  // Só 10 min de 'b' aparecem (200..210) e só 20 min de 'd' (380..400): os dois entram.
  const visible = sliceVisibleSpans(spans, { start: 200, end: 400 });
  assert.ok(visible.items.some((item) => item.id === 'b'), 'trecho cortado à esquerda sumiu da régua');
  assert.ok(visible.items.some((item) => item.id === 'd'), 'trecho cortado à direita sumiu da régua');
  // Encostar na borda por 1 ponto já conta como visível (mesma regra do filtro atual).
  assert.deepEqual(sliceVisibleSpans(spans, { start: 100, end: 100 }).indices, [0, 1]);
  // Trecho que ENGLOBA a janela inteira também entra (zoom fundo dentro de uma gravação).
  const wrapping = [{ start: 0, end: DAY, id: 'gap-dia' }];
  assert.deepEqual(sliceVisibleSpans(wrapping, { start: 700, end: 707.5 }).indices, [0]);
});

test('visibleSpanRange devolve uma fatia contígua que CONTÉM tudo que é visível', () => {
  const range = visibleSpanRange(spans, { start: 200, end: 400 });
  assert.ok(range.startIndex <= 1, 'fatia começa depois do primeiro item visível');
  assert.ok(range.endIndex >= 4, 'fatia termina antes do último item visível');
  // Nada fora da fatia pode ser visível.
  for (let index = 0; index < spans.length; index += 1) {
    const overlaps = spans[index].end >= 200 && spans[index].start <= 400;
    if (overlaps) assert.ok(index >= range.startIndex && index < range.endIndex);
  }
});

test('régua vazia não quebra nem inventa índice', () => {
  assert.deepEqual(sliceVisibleSpans([], { start: 0, end: DAY }), { items: [], indices: [], startIndex: 0, endIndex: 0 });
  assert.deepEqual(visibleSpanRange([], { start: 100, end: 200 }), { startIndex: 0, endIndex: 0 });
});

test('nenhum item visível quando a janela cai num vazio', () => {
  assert.deepEqual(sliceVisibleSpans(spans, { start: 520, end: 560 }).indices, []);
});

// ── virtualização da lista (linhas de altura fixa) ────────────────────────────

test('computeListWindow calcula as linhas visíveis a partir do scroll', () => {
  // 500 itens de 65px, viewport de 650px (10 linhas), rolado 6500px (linha 100).
  const window = computeListWindow({
    itemCount: 500,
    rowHeightPx: 65,
    scrollTopPx: 6500,
    viewportHeightPx: 650,
    overscanRows: 5,
  });
  assert.equal(window.startIndex, 95); // 100 - 5 de folga
  assert.equal(window.endIndex, 115); // 110 + 5 de folga
  assert.equal(window.totalHeightPx, 500 * 65);
  assert.equal(window.virtualized, true);
});

test('computeListWindow: bordas (topo e fim da lista) não estouram', () => {
  const top = computeListWindow({ itemCount: 500, rowHeightPx: 65, scrollTopPx: 0, viewportHeightPx: 650, overscanRows: 5 });
  assert.equal(top.startIndex, 0);
  const bottom = computeListWindow({ itemCount: 500, rowHeightPx: 65, scrollTopPx: 500 * 65, viewportHeightPx: 650, overscanRows: 5 });
  assert.equal(bottom.endIndex, 500);
  assert.ok(bottom.startIndex < 500);
});

test('computeListWindow: lista vazia e viewport não medido caem no comportamento de hoje', () => {
  assert.deepEqual(computeListWindow({ itemCount: 0, rowHeightPx: 65, scrollTopPx: 0, viewportHeightPx: 650 }), {
    startIndex: 0,
    endIndex: 0,
    totalHeightPx: 0,
    virtualized: false,
  });
  // Viewport ainda não medido (0): NÃO virtualiza — renderiza tudo, como hoje.
  const unmeasured = computeListWindow({ itemCount: 120, rowHeightPx: 65, scrollTopPx: 0, viewportHeightPx: 0 });
  assert.equal(unmeasured.virtualized, false);
  assert.deepEqual([unmeasured.startIndex, unmeasured.endIndex], [0, 120]);
  // Altura de linha inválida também desliga a virtualização.
  const badRow = computeListWindow({ itemCount: 120, rowHeightPx: 0, scrollTopPx: 0, viewportHeightPx: 650 });
  assert.equal(badRow.virtualized, false);
  assert.deepEqual([badRow.startIndex, badRow.endIndex], [0, 120]);
});

// ── token de miniatura só para o que está visível ─────────────────────────────

test('token é pedido SÓ para os itens visíveis (+ os fixados)', () => {
  const targets = selectThumbnailTargets({
    visibleIds: ['r2', 'r3'],
    pinnedIds: ['r9'], // gravação selecionada: sempre precisa de miniatura
    issuedAtMs: {},
    nowMs: 1_000_000,
  });
  assert.deepEqual(targets, ['r2', 'r3', 'r9']);
  // Gravações do dia que não estão na janela NÃO entram.
  assert.ok(!targets.includes('r1'));
  assert.ok(!targets.includes('r50'));
});

test('token já emitido e fresco não é pedido de novo', () => {
  const now = 1_000_000;
  const targets = selectThumbnailTargets({
    visibleIds: ['r1', 'r2'],
    issuedAtMs: { r1: now - 10_000 },
    nowMs: now,
    ttlMs: 240_000,
  });
  assert.deepEqual(targets, ['r2']);
  // Nada a fazer → lista vazia (a página não dispara request nenhum).
  assert.deepEqual(
    selectThumbnailTargets({ visibleIds: ['r1'], issuedAtMs: { r1: now }, nowMs: now, ttlMs: 240_000 }),
    [],
  );
});

test('token vencido é reemitido (miniatura não pode virar cadeado quebrado)', () => {
  const now = 1_000_000;
  const targets = selectThumbnailTargets({
    visibleIds: ['r1'],
    issuedAtMs: { r1: now - 300_000 }, // 5 min: além do TTL de 4 min
    nowMs: now,
    ttlMs: 240_000,
  });
  assert.deepEqual(targets, ['r1']);
});

test('lista de token é deduplicada e limitada ao lote do backend', () => {
  const many = Array.from({ length: 250 }, (_, index) => `r${index}`);
  const targets = selectThumbnailTargets({
    visibleIds: [...many, 'r0'],
    pinnedIds: ['r1'],
    issuedAtMs: {},
    nowMs: 0,
    max: 100,
  });
  assert.equal(targets.length, 100);
  assert.equal(new Set(targets).size, 100);
});

// ── faixas carregadas / o que ainda falta buscar ──────────────────────────────

test('mergeRanges funde faixas que se tocam ou sobrepõem', () => {
  assert.deepEqual(mergeRanges([{ start: 10, end: 20 }, { start: 20, end: 30 }, { start: 60, end: 70 }]), [
    { start: 10, end: 30 },
    { start: 60, end: 70 },
  ]);
  assert.deepEqual(mergeRanges([{ start: 60, end: 70 }, { start: 0, end: 65 }]), [{ start: 0, end: 70 }]);
  assert.deepEqual(mergeRanges([]), []);
});

test('subtractRanges devolve só os buracos', () => {
  assert.deepEqual(subtractRanges({ start: 0, end: 100 }, [{ start: 20, end: 40 }]), [
    { start: 0, end: 20 },
    { start: 40, end: 100 },
  ]);
  assert.deepEqual(subtractRanges({ start: 0, end: 100 }, [{ start: 0, end: 100 }]), []);
  assert.deepEqual(subtractRanges({ start: 0, end: 100 }, []), [{ start: 0, end: 100 }]);
});

test('planWindowFetch pede a janela com recuo p/ gravação que COMEÇOU antes', () => {
  // O backend filtra por startedAt: sem recuo, a gravação que começou 09:58 e
  // termina 10:05 NÃO viria numa consulta from=10:00 — e some da régua.
  const plan = planWindowFetch({
    window: { start: 600, end: 660 },
    loaded: [],
    padMinutes: 0,
    lookbackMinutes: 30,
  });
  assert.deepEqual(plan, [{ start: 570, end: 660 }]);
});

test('planWindowFetch não repete o que já foi carregado', () => {
  const loaded = [{ start: 570, end: 660 }];
  assert.deepEqual(planWindowFetch({ window: { start: 600, end: 660 }, loaded, padMinutes: 0, lookbackMinutes: 30 }), []);
  // Panorâmica p/ frente: só o pedaço novo é buscado (o recuo já está carregado).
  assert.deepEqual(
    planWindowFetch({ window: { start: 640, end: 700 }, loaded, padMinutes: 0, lookbackMinutes: 30 }),
    [{ start: 660, end: 700 }],
  );
});

test('limitWindowAround limita o DETALHE quando a janela é o dia inteiro', () => {
  // Zoom 1 mostra 24h: buscar o detalhe do dia inteiro seria o problema de novo.
  // O esqueleto do resumo cobre o resto; o detalhe fica num orçamento em volta de
  // onde o operador está.
  assert.deepEqual(limitWindowAround({ window: { start: 0, end: DAY }, center: 720, maxMinutes: 240 }), {
    start: 600,
    end: 840,
  });
  // Janela menor que o orçamento passa inteira (zoom fundo não perde nada).
  assert.deepEqual(limitWindowAround({ window: { start: 600, end: 660 }, center: 630, maxMinutes: 240 }), {
    start: 600,
    end: 660,
  });
  // Centro colado na borda: o orçamento desliza para dentro da janela em vez de
  // vazar para fora dela.
  assert.deepEqual(limitWindowAround({ window: { start: 0, end: DAY }, center: 10, maxMinutes: 240 }), {
    start: 0,
    end: 240,
  });
  assert.deepEqual(limitWindowAround({ window: { start: 0, end: DAY }, center: DAY, maxMinutes: 240 }), {
    start: DAY - 240,
    end: DAY,
  });
  // Orçamento inválido não estrangula a janela.
  assert.deepEqual(limitWindowAround({ window: { start: 0, end: 120 }, center: 60, maxMinutes: 0 }), {
    start: 0,
    end: 120,
  });
});

test('planWindowFetch fica dentro do dia', () => {
  const plan = planWindowFetch({ window: { start: 0, end: 60 }, loaded: [], padMinutes: 10, lookbackMinutes: 30 });
  assert.deepEqual(plan, [{ start: 0, end: 70 }]);
  const tail = planWindowFetch({ window: { start: DAY - 60, end: DAY }, loaded: [], padMinutes: 10, lookbackMinutes: 0 });
  assert.deepEqual(tail, [{ start: DAY - 70, end: DAY }]);
});

test('chunkRanges parte faixas grandes em pedaços digeríveis', () => {
  assert.deepEqual(chunkRanges([{ start: 0, end: 300 }], 120), [
    { start: 0, end: 120 },
    { start: 120, end: 240 },
    { start: 240, end: 300 },
  ]);
  // Faixa menor que o pedaço passa inteira; tamanho inválido não trava nem duplica.
  assert.deepEqual(chunkRanges([{ start: 0, end: 90 }], 120), [{ start: 0, end: 90 }]);
  assert.deepEqual(chunkRanges([{ start: 0, end: 90 }], 0), [{ start: 0, end: 90 }]);
});

test('orderRangesByDistance busca primeiro o que está perto da janela', () => {
  // Janela em ~700: a faixa que a contém vem primeiro (distância 0), depois a que
  // está 500 min à frente e por último a que está 580 min atrás.
  const ordered = orderRangesByDistance(
    [{ start: 0, end: 120 }, { start: 600, end: 720 }, { start: 1200, end: 1320 }],
    700,
  );
  assert.deepEqual(ordered.map((range) => range.start), [600, 1200, 0]);
});

// ── paginação por cursor (sem offset profundo) ────────────────────────────────

test('planNextPage: página incompleta encerra a faixa', () => {
  const next = planNextPage({
    plan: { from: 'A', to: 'Z', offset: 0 },
    pageLength: 12,
    pageSize: 200,
    lastTimestamp: '2026-07-27T10:00:00.000Z',
  });
  assert.equal(next, null);
});

test('planNextPage: página cheia avança pelo CURSOR (não por offset)', () => {
  const next = planNextPage({
    plan: { from: '2026-07-27T09:00:00.000Z', to: '2026-07-27T12:00:00.000Z', offset: 0 },
    pageLength: 200,
    pageSize: 200,
    lastTimestamp: '2026-07-27T10:30:00.000Z',
  });
  assert.deepEqual(next, { from: '2026-07-27T10:30:00.000Z', to: '2026-07-27T12:00:00.000Z', offset: 0 });
});

test('planNextPage: bloco inteiro no MESMO instante escapa por offset (sem loop infinito)', () => {
  const plan = { from: '2026-07-27T10:30:00.000Z', to: '2026-07-27T12:00:00.000Z', offset: 0 };
  const next = planNextPage({ plan, pageLength: 200, pageSize: 200, lastTimestamp: plan.from });
  assert.deepEqual(next, { from: plan.from, to: plan.to, offset: 200 });
});

test('planNextPage: descendente (feed de eventos) recua o `to`', () => {
  const next = planNextPage({
    plan: { from: '2026-07-27T00:00:00.000Z', to: '2026-07-27T23:59:59.999Z', offset: 0 },
    pageLength: 500,
    pageSize: 500,
    lastTimestamp: '2026-07-27T18:00:00.000Z',
    direction: 'desc',
  });
  assert.deepEqual(next, { from: '2026-07-27T00:00:00.000Z', to: '2026-07-27T18:00:00.000Z', offset: 0 });
});

test('planNextPage: sem último carimbo de tempo, encerra (não chuta cursor)', () => {
  assert.equal(planNextPage({ plan: { offset: 0 }, pageLength: 200, pageSize: 200, lastTimestamp: null }), null);
});

// ── resumo do dia (barato) → esqueleto da régua ───────────────────────────────

const DAY_START_MS = new Date(2026, 6, 27, 0, 0, 0, 0).getTime();
const at = (hour: number, minute = 0) => new Date(DAY_START_MS + (hour * 60 + minute) * 60_000).toISOString();

test('coverageFromGaps transforma buracos do resumo em cobertura da régua', () => {
  const coverage = coverageFromGaps({
    gaps: [
      { startAt: at(0), endAt: at(8) },
      { startAt: at(12), endAt: at(13) },
      { startAt: at(20), endAt: at(24) },
    ],
    dayStartMs: DAY_START_MS,
  });
  assert.deepEqual(coverage.spans, [
    { start: 8 * 60, end: 12 * 60 },
    { start: 13 * 60, end: 20 * 60 },
  ]);
  assert.equal(coverage.lastCoveredMinute, 20 * 60);
});

test('coverageFromGaps: dia sem buraco = dia inteiro gravado', () => {
  const coverage = coverageFromGaps({ gaps: [], dayStartMs: DAY_START_MS });
  assert.deepEqual(coverage.spans, [{ start: 0, end: DAY }]);
  assert.equal(coverage.lastCoveredMinute, DAY);
});

test('coverageFromGaps: resumo TRUNCADO não inventa cobertura no resto do dia', () => {
  // O backend corta em 240 buracos. Além do último buraco conhecido não sabemos
  // nada — desenhar "gravado" ali seria mentira na prova.
  const coverage = coverageFromGaps({
    gaps: [{ startAt: at(0), endAt: at(1) }, { startAt: at(2), endAt: at(3) }],
    dayStartMs: DAY_START_MS,
    truncated: true,
  });
  assert.deepEqual(coverage.spans, [{ start: 60, end: 120 }]);
});

test('coverageFromGaps ignora datas inválidas em vez de explodir', () => {
  const coverage = coverageFromGaps({
    gaps: [{ startAt: 'não-é-data', endAt: at(8) }, { startAt: at(20), endAt: at(24) }],
    dayStartMs: DAY_START_MS,
  });
  assert.deepEqual(coverage.spans, [{ start: 0, end: 20 * 60 }]);
});

// ── merge incremental das janelas ────────────────────────────────────────────

test('mergeByIdSorted junta janelas sem duplicar e mantém a ordem do dia', () => {
  const current = [
    { id: 'r2', startedAt: at(10) },
    { id: 'r3', startedAt: at(11) },
  ];
  const incoming = [
    { id: 'r1', startedAt: at(9) },
    { id: 'r3', startedAt: at(11) }, // repetido pelo cursor inclusivo
    { id: 'r4', startedAt: at(12) },
  ];
  const merged = mergeByIdSorted(current, incoming, (item) => item.id, (item) => item.startedAt);
  assert.deepEqual(merged.map((item) => item.id), ['r1', 'r2', 'r3', 'r4']);
});

test('mergeByIdSorted: item novo substitui o antigo de mesmo id', () => {
  const merged = mergeByIdSorted(
    [{ id: 'r1', startedAt: at(9), fileUsable: false }],
    [{ id: 'r1', startedAt: at(9), fileUsable: true }],
    (item) => item.id,
    (item) => item.startedAt,
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].fileUsable, true);
});

// ── SEGUIR O PLAYHEAD SEM ROUBAR A JANELA ───────────────────────────────────
// Relato de produção (2026-08-07): "no zoom máximo, movo para o lado e quando
// solto o mouse volta para onde o play está — não consigo caminhar pela
// timeline". A reprodução atualiza o playhead a cada ~250ms; se a regra
// recentra sempre que ele está fora da janela, qualquer pan é desfeito no
// instante seguinte.

test('REPRODUÇÃO não rouba a janela de quem navegou para longe', () => {
  // Operador foi ver 08:00 da manhã; o vídeo segue tocando às 16:00.
  const centro = decidirCentroAoMoverPlayhead({
    centro: 480, janelaMinutos: 10, totalMinutos: 1440,
    playheadAnterior: 960, playhead: 960.05, vindoDoVideo: true,
  });
  assert.equal(centro, 480, 'o pan do operador tem de sobreviver ao timeupdate');
});

test('reprodução ARRASTA a janela quando ela já estava acompanhando', () => {
  // Playhead saiu pela borda direita da janela que o acompanhava: segue.
  const centro = decidirCentroAoMoverPlayhead({
    centro: 960, janelaMinutos: 10, totalMinutos: 1440,
    playheadAnterior: 964.9, playhead: 965.1, vindoDoVideo: true,
  });
  assert.equal(centro, 965.1, 'auto-follow durante a reprodução é o esperado');
});

test('NAVEGAÇÃO explícita sempre leva a janela junto', () => {
  // Salto de evento / "Ir para hora" para um ponto distante: a janela vai.
  const centro = decidirCentroAoMoverPlayhead({
    centro: 480, janelaMinutos: 10, totalMinutos: 1440,
    playheadAnterior: 481, playhead: 1200, vindoDoVideo: false,
  });
  assert.equal(centro, 1200);
});

test('playhead visível na janela: nada se move', () => {
  const centro = decidirCentroAoMoverPlayhead({
    centro: 480, janelaMinutos: 60, totalMinutos: 1440,
    playheadAnterior: 470, playhead: 481, vindoDoVideo: true,
  });
  assert.equal(centro, 480);
});
