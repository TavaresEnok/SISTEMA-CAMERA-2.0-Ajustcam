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
