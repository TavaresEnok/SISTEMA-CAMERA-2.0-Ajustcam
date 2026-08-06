import test from 'node:test';
import assert from 'node:assert/strict';
import { janelaDaGravacao, selecionarGravacaoNoInstante } from '../src/lib/playback-selection.ts';

// ── "A TIMELINE NÃO SELECIONA O VÍDEO CORRETO" ──────────────────────────────
//
// A lógica minuto→gravação era a mais crítica da página e a única sem teste.
// Cada caso abaixo é um defeito REAL relatado ou medido nesta frota:
// fallback na primeira gravação do dia, sobreposições de ~5s do pré-roll
// (848 em 48h), emendas escolhendo o segmento velho, gravação sem endedAt
// sumindo, meia-noite quebrando a aritmética de relógio.

const T0 = Date.parse('2026-08-06T12:00:00.000Z');
const min = (n: number) => T0 + n * 60_000;

function rec(id: string, startMin: number, durSec: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    startedAt: new Date(min(startMin)).toISOString(),
    endedAt: new Date(min(startMin) + durSec * 1000).toISOString(),
    durationSeconds: durSec,
    ...extra,
  };
}

test('clique dentro de um segmento seleciona ELE, com offset em segundos', () => {
  const sel = selecionarGravacaoNoInstante([rec('a', 0, 300), rec('b', 5, 300)], min(6) + 30_000);
  assert.equal(sel.tipo, 'exata');
  assert.equal((sel as any).id, 'b');
  assert.ok(Math.abs((sel as any).offsetSeconds - 90) < 0.001, 'offset = 1min30s dentro do segmento b');
});

test('SOBREPOSIÇÃO (pré-roll de movimento): o instante pertence ao segmento MAIS NOVO', () => {
  // O ring promove ~5s anteriores ao gatilho que invadem o fim do segmento
  // anterior — 848 casos em 48h medidos. O find() ascendente escolhia o VELHO,
  // fazia seek na cauda e disparava `ended` na hora: "selecionou o vídeo errado".
  const sel = selecionarGravacaoNoInstante(
    [rec('velha', 0, 305), rec('nova', 5, 300)],
    min(5) + 2_000,
  );
  assert.equal((sel as any).id, 'nova', 'o pré-roll existe para cobrir o gatilho; o segmento novo é o dono do instante');
});

test('EMENDA exata entre dois segmentos: fim é EXCLUSIVO, começa o seguinte', () => {
  const sel = selecionarGravacaoNoInstante([rec('a', 0, 300), rec('b', 5, 300)], min(5));
  assert.equal((sel as any).id, 'b');
  assert.equal((sel as any).offsetSeconds, 0, 'seek no último frame do anterior disparava ended imediato');
});

test('clique DEPOIS da última gravação NUNCA volta para a primeira do dia', () => {
  // O defeito assinatura: câmera parou 18:00, clique às 19:30 tocava 00:05.
  const sel = selecionarGravacaoNoInstante(
    [rec('primeira-do-dia', 0, 300), rec('ultima', 60, 300)],
    min(150),
  );
  assert.equal(sel.tipo, 'proxima');
  assert.equal((sel as any).id, 'ultima', 'a resposta certa é a mais PRÓXIMA no tempo');
  assert.ok((sel as any).offsetSeconds >= 298, 'aterrissa perto do fim, não no começo');
});

test('clique ANTES da primeira gravação seleciona a primeira, do começo', () => {
  const sel = selecionarGravacaoNoInstante([rec('a', 60, 300)], min(10));
  assert.equal((sel as any).id, 'a');
  assert.equal((sel as any).offsetSeconds, 0);
});

test('gravação SEM endedAt usa durationSeconds — não some da seleção', () => {
  const semFim = { id: 'aberta', startedAt: new Date(min(0)).toISOString(), endedAt: null, durationSeconds: 300 };
  const sel = selecionarGravacaoNoInstante([semFim], min(2));
  assert.equal(sel.tipo, 'exata');
  assert.equal((sel as any).id, 'aberta');
});

test('gravação sem fim NENHUM (ainda gravando) contém o instante presente', () => {
  const gravando = { id: 'ao-vivo', startedAt: new Date(min(0)).toISOString(), endedAt: null, durationSeconds: null };
  const sel = selecionarGravacaoNoInstante([gravando], min(3), { agoraMs: min(4) });
  assert.equal(sel.tipo, 'exata');
  assert.equal((sel as any).id, 'ao-vivo');
});

test('cobertura diz que HÁ vídeo ali mas o detalhe não chegou: AGUARDAR, não chutar', () => {
  // Timeline por janela: o clique numa faixa ainda não carregada selecionava a
  // primeira gravação do dia, o vídeo errado COMEÇAVA a tocar e sobrescrevia a
  // intenção do operador antes de a faixa certa carregar.
  const sel = selecionarGravacaoNoInstante(
    [rec('longe', 0, 300)],
    min(600),
    { coberturaMinutos: [{ start: 0, end: 1440 }], dayStartMs: min(0) },
  );
  assert.equal(sel.tipo, 'aguardar', 'selecionar qualquer outra coisa descarta a intenção do operador');
});

test('cobertura diz que NÃO há vídeo ali: vai de mais-próxima mesmo', () => {
  const sel = selecionarGravacaoNoInstante(
    [rec('unica', 0, 300)],
    min(600),
    { coberturaMinutos: [{ start: 0, end: 10 }], dayStartMs: min(0) },
  );
  assert.equal(sel.tipo, 'proxima');
  assert.equal((sel as any).id, 'unica');
});

test('meia-noite: janela absoluta atravessa o dia sem quebrar', () => {
  // minuteOfDay fazia 23:58→00:03 virar end < start e a gravação sumia.
  const cruzando = rec('virada', -2, 300); // começa 2 min antes do T0, termina 3 depois
  const janela = janelaDaGravacao(cruzando, min(10));
  assert.ok(janela.endMs > janela.startMs);
  const sel = selecionarGravacaoNoInstante([cruzando], min(1));
  assert.equal(sel.tipo, 'exata');
  assert.equal((sel as any).id, 'virada');
});

test('lista vazia: nada — e nada de exceção', () => {
  assert.equal(selecionarGravacaoNoInstante([], min(0)).tipo, 'nada');
});
