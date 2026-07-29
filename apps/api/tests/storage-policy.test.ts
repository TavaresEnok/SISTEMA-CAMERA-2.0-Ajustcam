import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_STORAGE_POLICY,
  decideUpload,
  describeStoragePolicy,
  enabledTriggerModes,
  normalizeStoragePolicy,
} from '../src/cloud-storage/storage-policy';

// ─────────────────────────────────────────────────────────────────────────────
// POLÍTICA DE ARMAZENAMENTO — o que impede a nuvem de virar tudo-ou-nada.
//
// Provisionar o bucket na Central é INFRAESTRUTURA (quem contrata é o
// revendedor). Decidir o que mandar para lá é OPERAÇÃO (quem sabe é quem opera
// a câmera). Misturar os dois faria com que habilitar o storage começasse a
// enviar vídeo do cliente sozinho, gerando custo que ninguém pediu.
//
// O que estes testes travam:
//  · default DESLIGADO — provisionar não liga;
//  · contínua NÃO sobe por padrão (é o volume caro de cena vazia);
//  · tipo não classificado NUNCA sobe (não sabemos o que é, não decidimos por
//    conta própria);
//  · `keepLocalCopy` separa "economizar disco" de "ter cópia externa".
// ─────────────────────────────────────────────────────────────────────────────

test('default: nuvem DESLIGADA (provisionar não liga sozinho)', () => {
  const p = normalizeStoragePolicy(undefined);
  assert.equal(p.enabled, false);
  assert.equal(DEFAULT_STORAGE_POLICY.enabled, false);
});

test('default de tipos: movimento e manual SIM, contínua NÃO', () => {
  // Contínua é volume alto de cena vazia; subir por padrão surpreenderia o
  // cliente na fatura.
  const p = normalizeStoragePolicy({ enabled: true });
  assert.equal(p.triggerModes.motion, true);
  assert.equal(p.triggerModes.manual, true);
  assert.equal(p.triggerModes.continuous, false);
});

test('payload corrompido cai no default em vez de ligar por acidente', () => {
  assert.equal(normalizeStoragePolicy('lixo').enabled, false);
  assert.equal(normalizeStoragePolicy({ triggerModes: 'nao-e-objeto' }).triggerModes.motion, true);
  assert.equal(normalizeStoragePolicy(null).enabled, false);
});

test('nuvem desligada: NADA sobe, mesmo com tipos marcados', () => {
  const p = normalizeStoragePolicy({ enabled: false, triggerModes: { continuous: true, motion: true, manual: true } });
  const d = decideUpload(p, { triggerMode: 'motion' });
  assert.equal(d.upload, false);
  assert.match(d.upload === false ? d.reason : '', /desligada/);
});

test('sobe só o tipo marcado', () => {
  const p = normalizeStoragePolicy({ enabled: true, triggerModes: { continuous: false, motion: true, manual: false } });

  const movimento = decideUpload(p, { triggerMode: 'motion' });
  assert.equal(movimento.upload, true);

  const continua = decideUpload(p, { triggerMode: 'continuous' });
  assert.equal(continua.upload, false);
  assert.match(continua.upload === false ? continua.reason : '', /não está marcado/);

  const manual = decideUpload(p, { triggerMode: 'manual' });
  assert.equal(manual.upload, false);
});

test('tipo NÃO classificado nunca sobe', () => {
  // Gravação de backfill/origem indeterminada: subir o que não sabemos
  // classificar contraria a escolha explícita do operador e gera custo.
  const p = normalizeStoragePolicy({ enabled: true, triggerModes: { continuous: true, motion: true, manual: true } });
  for (const modo of ['unknown', '', null, undefined, 'inventado']) {
    const d = decideUpload(p, { triggerMode: modo as string });
    assert.equal(d.upload, false, `modo ${String(modo)} não pode subir`);
  }
});

test('keepLocalCopy separa BACKUP de ECONOMIA de disco', () => {
  const backup = normalizeStoragePolicy({ enabled: true, keepLocalCopy: true });
  const d1 = decideUpload(backup, { triggerMode: 'motion' });
  assert.equal(d1.upload, true);
  assert.equal(d1.upload === true && d1.deleteLocalAfterWindow, false, 'backup MANTÉM o local');

  const tier = normalizeStoragePolicy({ enabled: true, keepLocalCopy: false });
  const d2 = decideUpload(tier, { triggerMode: 'motion' });
  assert.equal(d2.upload === true && d2.deleteLocalAfterWindow, true, 'tier libera o disco');
});

test('enabledTriggerModes devolve só o que sobe (vira filtro de banco)', () => {
  const p = normalizeStoragePolicy({ enabled: true, triggerModes: { continuous: true, motion: false, manual: true } });
  assert.deepEqual(enabledTriggerModes(p).sort(), ['continuous', 'manual']);
});

test('descrição explica o estado em português para a tela e o log', () => {
  assert.match(describeStoragePolicy(normalizeStoragePolicy({ enabled: false })), /desligada/i);

  const nenhum = normalizeStoragePolicy({
    enabled: true, triggerModes: { continuous: false, motion: false, manual: false },
  });
  assert.match(describeStoragePolicy(nenhum), /nenhum tipo/i, 'ligado sem tipo é um estado que confunde — precisa ser dito');

  assert.match(describeStoragePolicy(normalizeStoragePolicy({ enabled: true, keepLocalCopy: true })), /backup/i);
  assert.match(describeStoragePolicy(normalizeStoragePolicy({ enabled: true })), /liberando o disco/i);
});

test('aceita booleano em string (formulário HTML manda "true"/"false")', () => {
  const p = normalizeStoragePolicy({ enabled: 'true', keepLocalCopy: '1', triggerModes: { continuous: 'false' } });
  assert.equal(p.enabled, true);
  assert.equal(p.keepLocalCopy, true);
  assert.equal(p.triggerModes.continuous, false);
});
