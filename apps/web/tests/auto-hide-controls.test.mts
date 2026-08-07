import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decidirControles,
  EVENTOS_DE_PRESENCA,
  ATRASO_PADRAO_MS,
  type EntradaControles,
} from '../src/lib/auto-hide-controls.ts';

// ─────────────────────────────────────────────────────────────────────────────
// CONTROLES DO MURAL QUE SOMEM SOZINHOS
//
// O mural fica horas numa TV de sala de operação. Dois elementos ficavam
// permanentemente por cima do vídeo (o selo "Ao Vivo / Modo Mural" e o botão
// "Sair"). Agora somem após 3s sem interação e voltam ao primeiro movimento.
//
// O que estes testes travam não é o visual — é a máquina de estados. Um
// controle que some na hora errada, ou que some e não volta, transforma uma
// tela cheia em armadilha: o operador não acha como sair e não há mais nada
// visível para clicar.
// ─────────────────────────────────────────────────────────────────────────────

const base: EntradaControles = {
  interagiuAgora: false,
  ponteiroSobreControle: false,
  focoNosControles: false,
  msDesdeInteracao: 0,
  atrasoMs: 3000,
};
const com = (p: Partial<EntradaControles>) => decidirControles({ ...base, ...p });

test('some depois do prazo sem interação', () => {
  const r = com({ msDesdeInteracao: 3000 });
  assert.equal(r.visivel, false);
  assert.equal(r.proximoPrazoMs, null, 'já sumiu: não há o que reavaliar até alguém mexer');
});

test('ANTES do prazo continua visível e marca o tempo que falta', () => {
  const r = com({ msDesdeInteracao: 1200 });
  assert.equal(r.visivel, true);
  // Reagendar pelo restante, e não pelo prazo cheio, é o que faz o controle
  // sumir 3s após a ÚLTIMA interação — e não 3s depois de cada verificação.
  assert.equal(r.proximoPrazoMs, 1800);
});

test('qualquer interação traz de volta e reinicia a contagem', () => {
  const r = com({ interagiuAgora: true, msDesdeInteracao: 9999 });
  assert.equal(r.visivel, true);
  assert.equal(r.proximoPrazoMs, 3000);
});

test('com o ponteiro EM CIMA, não some — nem depois do prazo', () => {
  // Sumir com o ponteiro em cima tira o botão debaixo do clique em curso: a
  // pessoa mira, o alvo desaparece, o clique cai no vídeo.
  const r = com({ ponteiroSobreControle: true, msDesdeInteracao: 60_000 });
  assert.equal(r.visivel, true);
  assert.equal(r.proximoPrazoMs, null, 'não adianta reagendar enquanto o ponteiro estiver ali');
});

test('com FOCO de teclado dentro, não some — nem depois do prazo', () => {
  // Quem chega por Tab precisa enxergar o que focou. Esconder deixa o foco
  // invisível e a tela vira armadilha para quem não usa mouse.
  const r = com({ focoNosControles: true, msDesdeInteracao: 60_000 });
  assert.equal(r.visivel, true);
  assert.equal(r.proximoPrazoMs, null);
});

test('foco vence até quando o ponteiro já saiu', () => {
  const r = com({ focoNosControles: true, ponteiroSobreControle: false, msDesdeInteracao: 5000 });
  assert.equal(r.visivel, true);
});

test('prazo zero não faz o controle piscar fora de existência', () => {
  // atrasoMs=0 é configuração inválida, mas não pode virar um controle que
  // some antes de aparecer.
  const r = com({ interagiuAgora: true, atrasoMs: 0 });
  assert.equal(r.visivel, true);
});

test('o prazo padrão é o que foi pedido: 3 segundos', () => {
  assert.equal(ATRASO_PADRAO_MS, 3000);
});

// ── OS GATILHOS ────────────────────────────────────────────────────────────

test('tela de toque tem gatilho — senão some e não volta nunca', () => {
  // Em tablet não existe "mover o mouse". Se o único gatilho fosse movimento,
  // os controles sumiriam aos 3s e a pessoa ficaria sem saída visível.
  assert.ok(EVENTOS_DE_PRESENCA.includes('pointerdown'));
  assert.ok(EVENTOS_DE_PRESENCA.includes('touchstart'));
});

test('teclado também conta como presença', () => {
  assert.ok(EVENTOS_DE_PRESENCA.includes('keydown'));
});

test('movimento de ponteiro é o gatilho principal', () => {
  assert.ok(EVENTOS_DE_PRESENCA.includes('pointermove'));
});

test('scroll NÃO é gatilho', () => {
  // O mural não rola. Um scroll fantasma de trackpad traria os controles de
  // volta sozinho, sem ninguém ter mexido.
  assert.ok(!(EVENTOS_DE_PRESENCA as readonly string[]).includes('scroll'));
});
