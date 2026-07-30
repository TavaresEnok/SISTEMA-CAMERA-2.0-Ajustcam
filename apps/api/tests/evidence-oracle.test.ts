import test from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceService } from '../src/evidence/evidence.service';

// ─────────────────────────────────────────────────────────────────────────────
// O VERIFICADOR NÃO PODE SER UM ORÁCULO DE ASSINATURA.
//
// `verifyPackage` devolvia `expected.signature` = o HMAC calculado para o
// conteúdo ENVIADO. Com isso, qualquer usuário que alcance a verificação forja
// prova em dois passos: manda o pacote adulterado, lê a assinatura que o
// servidor diz esperar, cola e reenvia — passa. Um módulo de evidência que
// entrega a própria assinatura não prova nada.
// ─────────────────────────────────────────────────────────────────────────────

function service() {
  const svc: any = Object.create(EvidenceService.prototype);
  svc.hmacSecret = 'segredo-de-teste-com-tamanho-suficiente-123456';
  svc.hmacKeyId = 'test-v1';
  svc.assertSecretConfigured = () => {};
  return svc;
}

test('verify NÃO devolve o hash nem a assinatura calculados', () => {
  const svc = service();
  const adulterado = {
    conteudo: 'gravação trocada',
    packageHash: { algorithm: 'SHA-256', value: 'valor-errado' },
    signature: { algorithm: 'HMAC-SHA-256', value: 'assinatura-errada', keyId: 'test-v1' },
  };

  const r = svc.verifyPackage(adulterado);

  assert.equal(r.ok, false, 'pacote adulterado tem que reprovar');
  const serializado = JSON.stringify(r);
  // O ataque: pegar daqui a assinatura correta. Nenhum valor derivado da chave
  // HMAC pode aparecer na resposta.
  const esperado = svc.hmacSha256Hex(svc.sha256Hex(svc.stableStringify(svc.omitInternalFields(adulterado))));
  assert.ok(!serializado.includes(esperado), 'a assinatura calculada NÃO pode vazar na resposta');
  assert.equal(r.expected?.signature?.value, undefined, 'sem valor em expected.signature');
  assert.equal(r.expected?.packageHash?.value, undefined, 'sem valor em expected.packageHash');
});

test('verify continua dizendo ao usuário legítimo o que ele precisa', () => {
  const svc = service();
  // Um pacote assinado de verdade tem que passar — senão a correção teria
  // quebrado a função do módulo em vez de protegê-la.
  //
  // NOTA DE FORMATO: `signPackage` devolve só o selo
  // ({packageHash, signature, signedAt}); o pacote verificável é o PAYLOAD
  // com o selo no nível superior. Guardar `{payload, signature}` aninhado
  // (como o worker de exportação faz) produz algo que o próprio verificador
  // não reconhece — bug real, corrigido em separado.
  const payload = { conteudo: 'gravação íntegra' };
  const assinado = { ...payload, ...svc.signPackage(payload) };
  const r = svc.verifyPackage(assinado);

  assert.equal(r.ok, true);
  assert.equal(r.hashValid, true);
  assert.equal(r.signatureValid, true);
  assert.ok(Array.isArray(r.details) && r.details.length > 0, 'o laudo legível permanece');
  assert.equal(r.expected?.signature?.keyId, 'test-v1', 'saber QUAL chave era esperada não é vazamento');
});
