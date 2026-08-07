import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudOffloadService } from '../src/cloud-storage/cloud-offload.service';
import { S3Error } from '../src/cloud-storage/s3-client';

// ─────────────────────────────────────────────────────────────────────────────
// DISJUNTOR do envio à nuvem (incidente de 07/08/2026).
//
// Com a credencial do fornecedor revogada, cada ciclo tentava o lote inteiro e
// o corpo de cada PUT (~27 MB) era transmitido ANTES do 403. A regra de
// drenagem via a fila crescer e ESCALAVA o lote — ~174 uploads × 27 MB a cada
// 5 min contra um bucket morto. A subida saturou: vídeo ao vivo a 0 fps,
// câmeras pretas e a API inalcançável de fora, com o sistema "parado" aos
// olhos do operador enquanto gravava normalmente por dentro.
//
// A regra destes testes: storage que reprova num LIST de 1 chave não recebe
// NENHUM byte de vídeo — e, tão importante, não dispara NENHUMA poda local.
// ─────────────────────────────────────────────────────────────────────────────

function montar(opcoes: { preflightFalha?: S3Error | Error | null } = {}) {
  const eventos: string[] = [];
  const avisos: string[] = [];

  const cliente = {
    listObjectsPage: async () => {
      eventos.push('preflight');
      if (opcoes.preflightFalha) throw opcoes.preflightFalha;
      return { objects: [], nextToken: null };
    },
  };

  // Object.create: inicializador de campo NÃO roda (armadilha conhecida do
  // repositório) — `running` começa undefined, que é falso, como precisamos.
  const svc: any = Object.create(CloudOffloadService.prototype);
  svc.logger = { warn: (m: string) => avisos.push(m), log: () => {}, error: () => {}, debug: () => {} };
  svc.resolver = {
    storageParaEscrita: async () => ({ id: 'st-1', name: 'Bucket Teste', uploadConcurrency: 4 }),
    clienteDe: () => cliente,
  };
  svc.prisma = { recording: { count: async () => 697 } };
  svc.uploadPending = async () => { eventos.push('upload'); return { uploaded: 0, failed: 0, bytesUploaded: 0 }; };
  svc.pruneUploaded = async () => { eventos.push('poda'); return 0; };
  svc.verificarAcervoNaNuvem = async () => { eventos.push('vigilancia'); return null; };

  return { svc, eventos, avisos };
}

test('credencial recusada: o ciclo é pulado por inteiro — sem upload e SEM poda', async () => {
  const { svc, eventos, avisos } = montar({ preflightFalha: new S3Error(403, 'InvalidAccessKeyId', 'chave inválida') });

  const resultado = await svc.runOnce();

  assert.deepEqual(eventos, ['preflight'], 'nada além do preflight pode ter rodado');
  assert.equal(resultado.skipped, true);
  assert.match(String(resultado.reason), /InvalidAccessKeyId/);
  // A poda é o ponto mais grave: com o bucket morto, a cópia local do que
  // consta "já enviado" é a ÚNICA real. Apagar com base num acervo ilegível
  // seria repetir o incidente Eveo por dentro do sistema.
  assert.ok(!eventos.includes('poda'));
  assert.equal(avisos.length, 1, 'um aviso por ciclo — não um por gravação (eram ~2.000/hora)');
  assert.match(avisos[0], /697/, 'o aviso diz quantas aguardam');
  assert.match(avisos[0], /nada podado/i);
});

test('bucket inexistente e falha de rede também barram o ciclo', async () => {
  for (const falha of [new S3Error(404, 'NoSuchBucket', 'sem bucket'), new Error('ETIMEDOUT')]) {
    const { svc, eventos } = montar({ preflightFalha: falha });
    const resultado = await svc.runOnce();
    assert.equal(resultado.skipped, true, String(falha));
    assert.deepEqual(eventos, ['preflight']);
  }
});

test('storage saudável: o ciclo segue normal, na ordem envio → poda → vigilância', async () => {
  const { svc, eventos, avisos } = montar();

  const resultado = await svc.runOnce();

  assert.equal(resultado.skipped, false);
  assert.deepEqual(eventos, ['preflight', 'upload', 'poda', 'vigilancia']);
  assert.deepEqual(avisos, [], 'preflight que passa não polui o log');
});

test('a falha do preflight fica registrada para o heartbeat da Central', async () => {
  // Foi a ausência deste registro que deixou horas de NoSuchBucket invisíveis
  // à Central no incidente original.
  const { svc } = montar({ preflightFalha: new S3Error(403, 'InvalidAccessKeyId', 'x') });
  await svc.runOnce();
  assert.equal(svc.ultimaFalhaCodigo, 'InvalidAccessKeyId');
  assert.ok(svc.ultimaFalhaEm instanceof Date);
});
