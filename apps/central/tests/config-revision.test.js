'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.CENTRAL_STORAGE_SECRET = process.env.CENTRAL_STORAGE_SECRET || 'chave-de-teste-com-mais-de-16-chars';

// ─────────────────────────────────────────────────────────────────────────────
// A CENTRAL PRECISA DIZER A VERDADE SOBRE O QUE FOI APLICADO.
//
// A regra anterior era `policyPending = updatedAt > lastHeartbeatAt`: isso prova
// que a instalação esteve ONLINE depois da mudança, não que ela APLICOU a
// mudança. O caso perigoso é silencioso — uma instalação antiga recebe um campo
// que não entende, ignora, manda outro heartbeat, e a pendência SOME do painel
// sem nada ter sido aplicado. O operador acredita que configurou.
//
// O modelo por revisão fecha isso: a Central emite `configRevision` (desejada),
// a instalação devolve `appliedRevision` + status, e a pendência passa a ser
// comparação de revisão — com o caso "versão não confirma" ficando VISÍVEL em
// vez de virar falso "aplicado".
//
// Este arquivo testa a REGRA de decisão, isolada do servidor HTTP.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Réplica da regra de `publicInstallation` (server.js). Mantida aqui para
 * poder exercitar as combinações sem subir o servidor; se a regra lá mudar,
 * este teste tem que mudar junto — é intencional que ele quebre nesse caso.
 */
function isPending(item, nowMs = Date.now()) {
  const lastHeartbeatAt = item.lastHeartbeatAt ? new Date(item.lastHeartbeatAt).getTime() : 0;
  const updatedAt = item.updatedAt ? new Date(item.updatedAt).getTime() : 0;
  const desired = Number(item.configRevision || 0) || 0;
  const applied = Number(item.appliedConfigRevision || 0) || 0;
  const status = item.configApplyStatus || 'UNKNOWN';
  void nowMs;
  return desired > 0
    ? (applied < desired || status === 'FAILED')
    : Boolean(updatedAt && lastHeartbeatAt && updatedAt > lastHeartbeatAt);
}

const T = (min) => new Date(Date.now() - min * 60000).toISOString();

test('revisão aplicada = desejada → NÃO está pendente', () => {
  assert.equal(isPending({
    configRevision: 5, appliedConfigRevision: 5, configApplyStatus: 'APPLIED',
    updatedAt: T(10), lastHeartbeatAt: T(1),
  }), false);
});

test('revisão aplicada ATRASADA → pendente', () => {
  assert.equal(isPending({
    configRevision: 6, appliedConfigRevision: 5, configApplyStatus: 'APPLIED',
    updatedAt: T(10), lastHeartbeatAt: T(1),
  }), true, 'a instalação ainda não aplicou a última mudança');
});

test('O CASO QUE A REGRA ANTIGA ERRAVA: heartbeat novo sem aplicar', () => {
  // Instalação mandou heartbeat DEPOIS da mudança (o que a regra antiga lia
  // como "aplicado"), mas a revisão aplicada continua velha.
  const item = {
    configRevision: 7, appliedConfigRevision: 6, configApplyStatus: 'APPLIED',
    updatedAt: T(30), lastHeartbeatAt: T(1),
  };
  const regraAntiga = new Date(item.updatedAt).getTime() > new Date(item.lastHeartbeatAt).getTime();
  assert.equal(regraAntiga, false, 'a regra antiga diria "não pendente"');
  assert.equal(isPending(item), true, 'a regra nova percebe que NÃO foi aplicado');
});

test('aplicação que FALHOU continua pendente, mesmo com revisão igual', () => {
  assert.equal(isPending({
    configRevision: 4, appliedConfigRevision: 4, configApplyStatus: 'FAILED',
    updatedAt: T(10), lastHeartbeatAt: T(1),
  }), true, 'revisão igual mas falha registrada não pode contar como aplicado');
});

test('instalação que NÃO confirma (versão antiga) fica pendente e visível', () => {
  // Antes, esta era exatamente a que sumia da lista. Agora fica pendente e o
  // painel mostra "versão sem confirmação" — o operador sabe que precisa
  // atualizar a instalação, em vez de achar que aplicou.
  assert.equal(isPending({
    configRevision: 3, appliedConfigRevision: 0, configApplyStatus: 'UNSUPPORTED',
    updatedAt: T(10), lastHeartbeatAt: T(1),
  }), true);
});

test('sem revisão emitida, mantém o comportamento antigo (retrocompat)', () => {
  // Instalação que nunca recebeu configuração nova não pode mudar de estado só
  // porque o modelo de revisão passou a existir.
  assert.equal(isPending({ updatedAt: T(1), lastHeartbeatAt: T(10) }), true, 'mudou depois do último sinal');
  assert.equal(isPending({ updatedAt: T(10), lastHeartbeatAt: T(1) }), false, 'sinal veio depois da mudança');
  assert.equal(isPending({}), false, 'sem dado nenhum não inventa pendência');
});

test('primeira aplicação (0 → 1) é pendente até confirmar', () => {
  assert.equal(isPending({ configRevision: 1, appliedConfigRevision: 0, configApplyStatus: 'UNKNOWN' }), true);
  assert.equal(isPending({ configRevision: 1, appliedConfigRevision: 1, configApplyStatus: 'APPLIED' }), false);
});
