import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classificarEventoOnvif,
  deveGravar,
  tipoDeEventoDoSistema,
} from '../src/cameras/helpers/evento-onvif.helper';

// ─────────────────────────────────────────────────────────────────────────────
// O serviço tinha UMA pergunta — "casa com /motion/?" — e descartava o resto em
// silêncio. A sondagem da frota (07/08/2026) mostrou o que ia para o lixo:
// Cam-04/05/06 declaram `ruleEngine/lineDetector/crossed` e
// `ruleEngine/fieldDetector/objectsInside`; outras, `userAlarm/IVA/humanShapeDetect`.
// Os tópicos abaixo são os REAIS, copiados da sondagem.
// ─────────────────────────────────────────────────────────────────────────────

const evento = (topico: string, extra: Record<string, unknown> = {}) => ({
  topic: { _: topico },
  message: { message: { data: { simpleItem: extra } } },
});

test('cruzamento de linha é reconhecido — o evento que era descartado', () => {
  const c = classificarEventoOnvif(evento('tns1:RuleEngine/LineDetector/Crossed'));
  assert.equal(c.tipo, 'linha-cruzada');
  assert.equal(deveGravar(c.tipo), true, 'perímetro tem de armar a gravação');
  assert.equal(tipoDeEventoDoSistema(c.tipo), 'LINE_CROSSED');
});

test('intrusão em área é reconhecida', () => {
  const c = classificarEventoOnvif(evento('tns1:RuleEngine/FieldDetector/ObjectsInside'));
  assert.equal(c.tipo, 'intrusao');
  assert.equal(tipoDeEventoDoSistema(c.tipo), 'INTRUSION_DETECTED');
});

test('forma humana é reconhecida — a câmera já separa pessoa de galho', () => {
  const c = classificarEventoOnvif(evento('tns1:UserAlarm/IVA/HumanShapeDetect'));
  assert.equal(c.tipo, 'forma-humana');
  assert.equal(deveGravar(c.tipo), true);
});

test('movimento continua funcionando exatamente como antes', () => {
  for (const topico of [
    'tns1:VideoSource/MotionAlarm',
    'tns1:RuleEngine/CellMotionDetector/Motion',
    'tns1:VideoAnalytics/MotionDetection',
  ]) {
    assert.equal(classificarEventoOnvif(evento(topico)).tipo, 'movimento', topico);
  }
});

test('O ESPECÍFICO VENCE O GENÉRICO', () => {
  // Armadilha real: o cruzamento de linha vive sob `RuleEngine/`, e vários
  // modelos mandam o nome da regra ou metadados contendo "motion" no mesmo
  // pacote. Testando movimento primeiro, TODO evento de perímetro viraria
  // "movimento" — o achatamento que este classificador existe para desfazer.
  const c = classificarEventoOnvif({
    topic: { _: 'tns1:RuleEngine/LineDetector/Crossed' },
    message: { data: { simpleItem: { Rule: 'MotionRule1', State: 'true' } } },
  });
  assert.equal(c.tipo, 'linha-cruzada', 'a palavra "motion" no payload sequestrou a classificação');
});

test('a direção do cruzamento é extraída quando a câmera informa', () => {
  const c = classificarEventoOnvif({
    topic: { _: 'tns1:RuleEngine/LineDetector/Crossed' },
    message: { data: { simpleItem: { Direction: 'LeftToRight', ObjectId: '7' } } },
  });
  assert.equal(c.tipo, 'linha-cruzada');
  assert.equal(c.direcao, 'LeftToRight', 'sem direção não dá para dizer "não passar POR AQUI"');
});

test('o nome da regra configurada na câmera é preservado', () => {
  const c = classificarEventoOnvif({
    topic: { _: 'tns1:RuleEngine/LineDetector/Crossed' },
    message: { data: { simpleItem: { Rule: 'Portao Frente' } } },
  });
  assert.equal(c.regra, 'Portao Frente', 'o operador precisa saber QUAL linha disparou');
});

test('fim de movimento não arma gravação', () => {
  const c = classificarEventoOnvif({
    topic: { _: 'tns1:VideoSource/MotionAlarm' },
    message: { data: { simpleItem: { State: 'false' } } },
  });
  assert.equal(c.tipo, 'fim-de-movimento');
  assert.equal(deveGravar(c.tipo), false);
});

test('cruzamento de linha NÃO é anulado por um "false" no pacote', () => {
  // Cruzar é instantâneo: a câmera manda o disparo e logo depois o estado
  // voltando ao normal. Tratar esse "false" como fim descartaria a travessia —
  // e o perímetro ficaria cego com aparência de funcionar.
  const c = classificarEventoOnvif({
    topic: { _: 'tns1:RuleEngine/LineDetector/Crossed' },
    message: { data: { simpleItem: { State: 'false', Direction: 'RightToLeft' } } },
  });
  assert.equal(c.tipo, 'linha-cruzada');
  assert.equal(c.direcao, 'RightToLeft');
});

test('sabotagem é reconhecida mas não arma gravação por si', () => {
  const c = classificarEventoOnvif(evento('tns1:RuleEngine/TamperDetector/Tamper'));
  assert.equal(c.tipo, 'sabotagem');
  assert.equal(deveGravar(c.tipo), false, 'sabotagem é alarme, não gatilho de gravação');
  assert.equal(tipoDeEventoDoSistema(c.tipo), 'CAMERA_TAMPER');
});

test('ruído conhecido continua ignorado', () => {
  for (const topico of [
    'tns1:Media/ProfileChanged',
    'tns1:Media/ConfigurationChanged',
    'tns1:AudioAnalytics/Audio/DetectedSound',
    'tns1:UserAlarm/bandwidthChange',
    'tns1:Configuration/Profile',
  ]) {
    const c = classificarEventoOnvif(evento(topico));
    assert.equal(c.tipo, 'ignorado', topico);
    assert.equal(deveGravar(c.tipo), false);
  }
});

test('mensagem malformada não derruba a escuta', () => {
  // A escuta ONVIF roda para 14 câmeras; uma exceção aqui derrubaria o listener
  // e a câmera ficaria surda sem ninguém perceber.
  const circular: any = {};
  circular.self = circular;
  for (const lixo of [null, undefined, 'texto', 42, circular]) {
    const c = classificarEventoOnvif(lixo);
    assert.ok(['ignorado', 'movimento'].includes(c.tipo), String(lixo));
  }
});
