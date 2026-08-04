import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retencaoEfetiva, diasQuePerde } from '../src/recordings/helpers/retencao-efetiva.helper';

// ─────────────────────────────────────────────────────────────────────────────
// RETENÇÃO: GRUPO OU CÂMERA
//
// Antes existia UM número por câmera, e aplicar em lote pelo grupo SOBRESCREVIA
// o valor de cada uma — as exceções ajustadas à mão se perdiam a cada mexida no
// grupo, sem volta.
//
// Agora o grupo guarda a política e a câmera escolhe se a segue. O que estes
// testes travam é a conta que decide o que sobrevive no disco. Errar aqui não é
// um número errado numa tela: é gravação apagada com o prazo errado, e a
// varredura roda de hora em hora apagando até 20.000 por ciclo.
// ─────────────────────────────────────────────────────────────────────────────

test('seguindo o grupo, vale o número do GRUPO — não o da câmera', () => {
  const dias = retencaoEfetiva(
    { retentionDays: 90, retentionFollowsGroup: true, grupoRetentionDays: 3 },
    7,
  );
  assert.equal(dias, 3, 'o 90 da câmera fica guardado, mas quem manda é o grupo');
});

test('não seguindo, vale o número DELA — o grupo não interfere', () => {
  const dias = retencaoEfetiva(
    { retentionDays: 90, retentionFollowsGroup: false, grupoRetentionDays: 3 },
    7,
  );
  assert.equal(dias, 90, 'é exatamente isto que a sobrescrita destruía antes');
});

test('segue o grupo mas NÃO tem grupo: cai no global', () => {
  const dias = retencaoEfetiva(
    { retentionDays: 90, retentionFollowsGroup: true, grupoRetentionDays: null },
    3,
  );
  assert.equal(dias, 3);
});

test('ZERO nunca vira retenção — apagaria o acervo inteiro no ciclo seguinte', () => {
  assert.equal(retencaoEfetiva({ retentionDays: 0, retentionFollowsGroup: false, grupoRetentionDays: 5 }, 3), 3);
  assert.equal(retencaoEfetiva({ retentionDays: 10, retentionFollowsGroup: true, grupoRetentionDays: 0 }, 3), 3);
  assert.equal(retencaoEfetiva({ retentionDays: -5, retentionFollowsGroup: false, grupoRetentionDays: 5 }, 3), 3);
});

test('global inválido também tem piso — o último recurso não pode ser o pior', () => {
  assert.equal(retencaoEfetiva({ retentionDays: null, retentionFollowsGroup: true, grupoRetentionDays: null }, 0), 1);
  assert.equal(retencaoEfetiva({ retentionDays: null, retentionFollowsGroup: true, grupoRetentionDays: null }, NaN), 1);
});

test('valores ausentes caem no global, não em zero', () => {
  assert.equal(retencaoEfetiva({ retentionDays: undefined, retentionFollowsGroup: false, grupoRetentionDays: 5 }, 3), 3);
  assert.equal(retencaoEfetiva({ retentionDays: 10, retentionFollowsGroup: undefined, grupoRetentionDays: 5 }, 3), 10,
    'toggle ausente é tratado como "não segue": mantém o número que a câmera já tinha');
});

// ── O AVISO ANTES DE APAGAR ─────────────────────────────────────────────────

test('encurtar a retenção diz quantos dias somem', () => {
  // Câmera de 10 dias passando a seguir um grupo de 3: o 4º ao 10º dia somem na
  // varredura seguinte. O operador precisa ver o "7" ANTES de confirmar.
  assert.equal(diasQuePerde(10, 3), 7);
});

test('aumentar a retenção não perde nada', () => {
  assert.equal(diasQuePerde(3, 10), 0);
  assert.equal(diasQuePerde(7, 7), 0);
});

test('valores inválidos não viram aviso falso de perda', () => {
  assert.equal(diasQuePerde(NaN, 3), 0);
  assert.equal(diasQuePerde(10, NaN), 0);
});
