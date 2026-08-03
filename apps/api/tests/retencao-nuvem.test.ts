import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ─────────────────────────────────────────────────────────────────────────────
// A RETENÇÃO PRECISA ALCANÇAR A NUVEM
//
// Medido em campo (2026-08-03): a retenção apagava o registro e o arquivo LOCAL,
// e o objeto no bucket ficava órfão PARA SEMPRE. O MinIO encheu, passou a
// recusar todo upload com `XMinioStorageFull (507)`, e o acervo travou — 421
// gravações presas no disco local, sem cópia externa, por 38 horas.
//
// Delegar isso a uma lifecycle rule do S3 não resolve: quem sabe o que pode
// sair é o DRAC, não o bucket. A retenção daqui é POR CÂMERA, respeita gravação
// protegida por incidente e mantém em quarentena o segmento cujo movimento é
// DESCONHECIDO (motionScore = -1). Uma regra de idade no bucket apagaria
// justamente a prova que o operador marcou para guardar.
// ─────────────────────────────────────────────────────────────────────────────

const FONTE = readFileSync('src/recordings/retention.service.ts', 'utf8');

test('a exclusão de gravação também remove o objeto da nuvem', () => {
  assert.ok(
    /deleteCloudObject\(recording\.cloudKey\)/.test(FONTE),
    'sem isto o objeto no bucket fica órfão e o storage enche até travar',
  );
});

test('o objeto da nuvem é removido DEPOIS de a linha sair, nunca antes', () => {
  // Ordem invertida deixaria um registro apontando para um objeto que já não
  // existe: playback quebrado e nenhuma forma de saber que aquilo era prova.
  // A ordem correta, no pior caso, deixa lixo no bucket — recuperável.
  const i = FONTE.indexOf('await this.deleteRowsWithFiles');
  const j = FONTE.indexOf('deleteCloudObject(recording.cloudKey)');
  assert.ok(i > 0 && j > i, 'a remoção na nuvem precisa vir após a exclusão transacional local');
});

test('falha na nuvem NÃO impede a limpeza local', () => {
  // Disco cheio é emergência operacional; objeto órfão é desperdício. Deixar a
  // falha da nuvem abortar a limpeza local inverteria a gravidade dos dois.
  const bloco = FONTE.slice(FONTE.indexOf('private async deleteCloudObject'),
                            FONTE.indexOf('onModuleInit'));
  assert.ok(/try\s*\{/.test(bloco) && /catch/.test(bloco), 'a remoção na nuvem precisa ser tolerante a falha');
  assert.ok(!/throw/.test(bloco), 'ela não pode propagar erro e abortar a retenção local');
});

test('as consultas de expiração carregam o cloudKey', () => {
  // Sem o campo no `select`, `recording.cloudKey` chega undefined e a limpeza da
  // nuvem vira silenciosamente um no-op — o defeito mais fácil de reintroduzir.
  const ocorrencias = (FONTE.match(/cloudKey: true/g) || []).length;
  assert.ok(ocorrencias >= 2, `esperava cloudKey em ambas as consultas de expiração, achei ${ocorrencias}`);
});

test('gravação sem objeto na nuvem não gera chamada inútil', () => {
  assert.ok(/if \(!cloudKey\) return;/.test(FONTE), 'quem nunca subiu não deve custar uma ida ao bucket');
});

test('a nuvem só é tocada quando o storage está habilitado', () => {
  assert.ok(/cfg\?\.enabled/.test(FONTE), 'sem storage provisionado não há objeto a remover');
});

// ── VARREDURA DE ÓRFÃOS: A DECISÃO É SEMPRE DA RETENÇÃO ─────────────────────
//
// A varredura existe porque a limpeza da nuvem foi acrescentada DEPOIS: tudo
// que a retenção apagou antes disso deixou objeto órfão no bucket.
//
// A regra que a torna segura num sistema probatório: ela só remove o que JÁ NÃO
// TEM LINHA em `Recording` — ou seja, o que a retenção do DRAC já autorizou a
// sair, respeitando câmera por câmera, gravação protegida por incidente e a
// quarentena de movimento desconhecido (motionScore = -1).
//
// O objeto de uma gravação que ainda existe NUNCA é tocado, por mais antigo que
// seja. A varredura recolhe lixo; ela não decide retenção. Se essa assimetria
// se perder, o bucket vira uma segunda política de retenção competindo com a do
// DRAC — exatamente o que o dono recusou.

test('a varredura NUNCA remove objeto cuja gravação ainda existe', () => {
  const bloco = FONTE.slice(FONTE.indexOf('private async cleanupOrphanCloudObjects'),
                            FONTE.indexOf('private async deleteCloudObject'));
  assert.ok(
    /cloudKey: \{ in: chaves \}/.test(bloco),
    'a varredura precisa perguntar ao banco quais chaves ainda têm dono',
  );
  assert.ok(
    /if \(protegidas\.has\(chave\)\) continue;/.test(bloco),
    'chave com dono no banco tem de ser PULADA — sem isso a varredura apaga prova viva',
  );
});

test('a varredura não decide por IDADE do objeto', () => {
  const bloco = FONTE.slice(FONTE.indexOf('private async cleanupOrphanCloudObjects'),
                            FONTE.indexOf('private async deleteCloudObject'));
  assert.ok(
    !/lastModified|LastModified|olderThan|idade|maxAge/i.test(bloco),
    'idade do objeto não pode ser critério: quem decide retenção é o DRAC, não o bucket',
  );
});

test('a varredura tem teto por ciclo e pode ser desligada', () => {
  assert.ok(FONTE.includes("envBool('RETENTION_CLOUD_ORPHAN_SWEEP'"), 'precisa poder ser desligada em emergência');
  assert.ok(FONTE.includes("envNumber('RETENTION_CLOUD_ORPHAN_MAX_PER_CYCLE'"), 'precisa de teto por ciclo');
  assert.ok(/if \(TETO === 0\) return 0;/.test(FONTE), 'teto zero precisa desligar a varredura por completo');
});

test('nuvem fora do ar não derruba a retenção local', () => {
  const bloco = FONTE.slice(FONTE.indexOf('private async cleanupOrphanCloudObjects'),
                            FONTE.indexOf('private async deleteCloudObject'));
  assert.ok(/catch \(error\)/.test(bloco) && !/throw/.test(bloco),
    'a varredura precisa tolerar falha: a retenção local é a que libera disco');
});

test('a varredura só roda com storage habilitado', () => {
  const bloco = FONTE.slice(FONTE.indexOf('private async cleanupOrphanCloudObjects'),
                            FONTE.indexOf('private async deleteCloudObject'));
  assert.ok(/cfg\?\.enabled/.test(bloco), 'sem storage provisionado não há bucket a varrer');
});
