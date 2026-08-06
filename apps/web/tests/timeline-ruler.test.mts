import test from 'node:test';
import assert from 'node:assert/strict';
import { escolherGranularidade, gerarTicks, agregarMinimapa } from '../src/lib/timeline-ruler.ts';

// ── A RÉGUA PRECISA SER LEGÍVEL EM QUALQUER ZOOM ────────────────────────────
//
// A timeline antiga tinha 5 rótulos em posições FIXAS (0/25/50/75/100%): com
// zoom eles caíam em horários quebrados ("06:37") e não havia marcação nenhuma
// — sem escala, a barra é só um retângulo colorido.

test('visão de 24h rotula de 2 em 2 horas (não polui)', () => {
  const g = escolherGranularidade(1440, 800);
  assert.equal(g.maior, 120);
  assert.equal(g.formato, 'HH');
});

test('visão de 1h desce para 10 em 10 minutos', () => {
  const g = escolherGranularidade(60, 800);
  assert.equal(g.maior, 10);
  assert.equal(g.formato, 'HH:mm');
});

test('zoom máximo (7,5 min) rotula de minuto em minuto', () => {
  const g = escolherGranularidade(7.5, 800);
  assert.equal(g.maior, 1);
  assert.equal(g.formato, 'HH:mm', 'com passo de 1 min os segundos são sempre :00 — mostrá-los mente precisão');
});

test('segundos aparecem SÓ quando o passo é sub-minuto', () => {
  const g = escolherGranularidade(1, 800);
  assert.ok(g.maior < 1);
  assert.equal(g.formato, 'HH:mm:ss');
});

test('a folga exigida acompanha o tamanho do rótulo', () => {
  // "06h" cabe em menos espaço que "06:35". Exigir a mesma folga para os dois
  // empurrava a visão de 24h para marcações de 3 em 3 horas.
  assert.equal(escolherGranularidade(1440, 800).maior, 120);
  assert.equal(escolherGranularidade(1440, 500).maior, 180, 'régua estreita recua para 3h');
});

test('régua estreita usa passo MAIOR — rótulo não colide', () => {
  const largo = escolherGranularidade(1440, 1600).maior;
  const estreito = escolherGranularidade(1440, 320).maior;
  assert.ok(estreito >= largo, `estreito ${estreito} deveria ser >= largo ${largo}`);
  // 80px de folga por rótulo é o mínimo para "HH:mm" a 11px sem colidir.
  assert.ok(320 / (1440 / estreito) >= 80);
});

test('os três níveis são distintos e decrescentes', () => {
  const g = escolherGranularidade(360, 900);
  assert.ok(g.maior > g.medio && g.medio > g.menor, `${g.maior}/${g.medio}/${g.menor}`);
});

test('ticks caem em horários REDONDOS, não no início da janela', () => {
  // Ancorar na janela produzia marcações em 06:37 que deslizam durante o pan —
  // o operador lê isso como régua quebrada.
  const g = escolherGranularidade(60, 800);
  const ticks = gerarTicks(367, 427, g); // 06:07 → 07:07
  const maiores = ticks.filter((t) => t.nivel === 'maior').map((t) => t.minuto);
  assert.ok(maiores.length > 0);
  for (const m of maiores) {
    assert.equal(m % g.maior, 0, `${m} não é múltiplo de ${g.maior}`);
  }
});

test('um ponto nunca recebe dois níveis (o maior vence)', () => {
  const g = escolherGranularidade(360, 900);
  const ticks = gerarTicks(0, 360, g);
  const minutos = ticks.map((t) => Math.round(t.minuto * 3600));
  assert.equal(new Set(minutos).size, minutos.length, 'tick duplicado empilha traços no mesmo pixel');
});

test('janela enorme com passo fino NÃO gera milhares de nós', () => {
  const g = escolherGranularidade(1440, 800);
  const ticks = gerarTicks(0, 1440, g, 400);
  assert.ok(ticks.length <= 400, `${ticks.length} ticks travariam o pan`);
});

// ── MINIMAPA: o raro não pode sumir sob o comum ─────────────────────────────

test('bucket assume a MAIOR severidade — alarme de 3s sobrevive a 1h de gravação', () => {
  const buckets = agregarMinimapa(
    [
      { start: 0, end: 60, type: 'recorded' },
      { start: 30, end: 30.05, type: 'alarm' }, // 3 segundos
    ],
    1440,
    720,
  );
  const doAlarme = buckets.find((b) => b.indice === Math.floor(30 / 2));
  assert.equal(doAlarme?.tipo, 'alarm', 'no resumo do dia, o raro é justamente o que importa');
});

test('a hierarquia de severidade é alarme > movimento > defeito > gravação', () => {
  const em = (tipos: string[]) => agregarMinimapa(
    tipos.map((type) => ({ start: 10, end: 12, type })), 1440, 720,
  )[0]?.tipo;
  assert.equal(em(['recorded', 'recorded_broken']), 'recorded_broken');
  assert.equal(em(['recorded_broken', 'motion']), 'motion');
  assert.equal(em(['motion', 'alarm']), 'alarm');
});

test('gap não pinta bucket (ausência é ausência)', () => {
  assert.deepEqual(agregarMinimapa([{ start: 0, end: 100, type: 'gap' }], 1440, 720), []);
});

test('o minimapa é barato: 720 buckets no máximo, seja qual for o acervo', () => {
  const spans = Array.from({ length: 5000 }, (_, i) => ({ start: i * 0.2, end: i * 0.2 + 0.1, type: 'recorded' }));
  const buckets = agregarMinimapa(spans, 1440, 720);
  assert.ok(buckets.length <= 720);
});
