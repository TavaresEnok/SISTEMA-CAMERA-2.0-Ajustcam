import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiEnabledEfetivo, detectorObrigatorio } from '../src/cameras/helpers/motion-detector.helper';

// ─────────────────────────────────────────────────────────────────────────────
// GRAVAR POR MOVIMENTO DO SISTEMA EXIGE O DETECTOR LIGADO
//
// `motionTrigger=SYSTEM` significa "quem detecta é o MOG2". Combinado com
// `aiEnabled=false`, o resultado não é um erro visível — é a câmera NUNCA
// gravar. O gerenciador tenta subir a análise, recebe "câmera desabilitada",
// não lança exceção, e desiste. A cada 5 minutos, indefinidamente.
//
// MEDIDO em produção: 7 câmeras nesse estado, 5 delas ONLINE e mudas por 10
// horas, com o log repetindo "religando análise" e nada na tela indicando
// problema.
// ─────────────────────────────────────────────────────────────────────────────

test('movimento do SISTEMA obriga o detector', () => {
  assert.equal(detectorObrigatorio({ recordingMode: 'motion', motionTrigger: 'SYSTEM', aiEnabled: false }), true);
  assert.equal(
    aiEnabledEfetivo({ recordingMode: 'motion', motionTrigger: 'SYSTEM', aiEnabled: false }),
    true,
    'o valor do formulário é ignorado: armar por um detector desligado é a combinação que não grava nada',
  );
});

test('movimento da CÂMERA respeita o detector desligado', () => {
  // Aqui `false` é a configuração CORRETA e economiza CPU: o movimento vem por
  // evento da própria câmera, e o MOG2 não teria função nenhuma.
  assert.equal(detectorObrigatorio({ recordingMode: 'motion', motionTrigger: 'CAMERA', aiEnabled: false }), false);
  assert.equal(aiEnabledEfetivo({ recordingMode: 'motion', motionTrigger: 'CAMERA', aiEnabled: false }), false);
});

test('gravação contínua não é afetada', () => {
  // A regra é sobre movimento do sistema, não sobre toda gravação. Forçar o
  // detector na contínua ligaria análise em toda a frota sem ninguém pedir.
  assert.equal(detectorObrigatorio({ recordingMode: 'continuous', motionTrigger: 'SYSTEM', aiEnabled: false }), false);
  assert.equal(aiEnabledEfetivo({ recordingMode: 'continuous', motionTrigger: 'SYSTEM', aiEnabled: false }), false);
});

test('gravação manual com trigger SYSTEM também não obriga', () => {
  assert.equal(detectorObrigatorio({ recordingMode: 'manual', motionTrigger: 'SYSTEM', aiEnabled: false }), false);
});

test('campo ausente continua significando "não mexer"', () => {
  // O Prisma trata `undefined` como "não alterar". Devolver `false` aqui
  // DESLIGARIA o detector em toda edição que não tocasse no campo.
  assert.equal(aiEnabledEfetivo({ recordingMode: 'continuous', motionTrigger: 'CAMERA', aiEnabled: undefined }), undefined);
  assert.equal(aiEnabledEfetivo({ recordingMode: 'manual', motionTrigger: 'CAMERA', aiEnabled: null }), undefined);
});

test('valores nulos ou desconhecidos não disparam a obrigação', () => {
  assert.equal(detectorObrigatorio({ recordingMode: null, motionTrigger: null, aiEnabled: false }), false);
  assert.equal(detectorObrigatorio({ recordingMode: 'motion', motionTrigger: 'ONVIF', aiEnabled: false }), false);
});
