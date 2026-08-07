import { test } from 'node:test';
import assert from 'node:assert/strict';
import { devePularPorDeteccaoNativa, modoDaCamera } from '../src/ai/helpers/modo-por-camera.helper';

// ─────────────────────────────────────────────────────────────────────────────
// O modo de IA deixou de ser um só para a frota. Duas armadilhas travadas aqui,
// ambas capazes de deixar a linha de perímetro desenhada sem detectar nada
// enquanto a tela diz que está tudo ativo:
//   1. mandar o modo GLOBAL anularia a decisão por câmera;
//   2. o atalho da detecção nativa pularia justamente as 17 câmeras da frota
//      que usam evento ONVIF.
// ─────────────────────────────────────────────────────────────────────────────

test('câmera que roda objeto sobe para general; o resto fica em motion', () => {
  assert.equal(modoDaCamera('motion', true), 'general');
  assert.equal(modoDaCamera('motion', false), 'motion');
});

test('A REGRA É SÓ DE SUBIDA — nunca rebaixa escolha explícita do operador', () => {
  // Se a instalação está em `general` global, uma câmera sem linha não pode
  // voltar para `motion` por conta própria: seria desfazer o que foi pedido.
  assert.equal(modoDaCamera('general', false), 'general');
  // E `face` é mais específico que `general`: promover dali seria rebaixar.
  assert.equal(modoDaCamera('face', true), 'face');
  assert.equal(modoDaCamera('face', false), 'face');
});

test('modo global inválido cai em motion, nunca no pesado', () => {
  for (const v of [null, undefined, '', 'geral', 'GENERAL', 42 as any]) {
    assert.equal(modoDaCamera(v, false), 'motion', String(v));
  }
});

test('O ATALHO DA DETECÇÃO NATIVA NÃO PODE PULAR QUEM TEM OBJETO A FAZER', () => {
  // Este é o caso real da frota: 17 câmeras com motionTrigger=CAMERA. Aplicar
  // o atalho cegamente faria a linha desenhada nelas não detectar NADA, com a
  // tela afirmando que estava ativo.
  const comObjeto = devePularPorDeteccaoNativa({
    modoGlobal: 'motion', motionTrigger: 'CAMERA', rodaObjeto: true,
  });
  assert.equal(comObjeto, false, 'pulou uma câmera que precisa rodar objeto');
});

test('sem objeto, o atalho continua valendo — é o que evita replicar a MOG2', () => {
  const semObjeto = devePularPorDeteccaoNativa({
    modoGlobal: 'motion', motionTrigger: 'CAMERA', rodaObjeto: false,
  });
  assert.equal(semObjeto, true, 'perdeu a economia de CPU da detecção nativa');
});

test('câmera com detecção do SISTEMA nunca é pulada', () => {
  assert.equal(
    devePularPorDeteccaoNativa({ modoGlobal: 'motion', motionTrigger: 'SYSTEM', rodaObjeto: false }),
    false,
  );
});

test('o fallback do watchdog vence o atalho', () => {
  // `permitirGatilhoDaCamera` é o fallback que liga a MOG2 quando a detecção
  // nativa está sem prova de vida. Pular aí deixaria a câmera cega dos dois
  // lados.
  assert.equal(
    devePularPorDeteccaoNativa({
      modoGlobal: 'motion', motionTrigger: 'CAMERA', rodaObjeto: false, permitirGatilhoDaCamera: true,
    }),
    false,
  );
});

test('em modo global pesado o atalho não se aplica', () => {
  // `general`/`face` significam que a instalação quer análise pesada em tudo;
  // pular por detecção nativa contrariaria isso.
  for (const global of ['general', 'face']) {
    assert.equal(
      devePularPorDeteccaoNativa({ modoGlobal: global, motionTrigger: 'CAMERA', rodaObjeto: false }),
      false,
      global,
    );
  }
});
