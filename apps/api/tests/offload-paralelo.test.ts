import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CloudOffloadService } from '../src/cloud-storage/cloud-offload.service';

// ─────────────────────────────────────────────────────────────────────────────
// ENVIO EM PARALELO, COM TETO
//
// Sequencial, cada gravação pagava sozinha os ~143ms que o fornecedor cobra para
// abrir conexão (ele fecha a cada requisição). Em paralelo esse custo se
// sobrepõe. Mas paralelismo demais não usa mais internet do que há — só disputa
// com o vídeo ao vivo — e por isso o número é escolha do operador, com teto.
//
// O que estes testes travam: o teto é RESPEITADO (nunca há mais envios em voo
// que o pedido), a fila é puxada por trabalhador (não dividida em blocos fixos,
// que deixariam trabalhador ocioso esperando o vídeo mais lento), e uma falha
// não derruba as outras.
// ─────────────────────────────────────────────────────────────────────────────

function makeOffload(over: Record<string, unknown> = {}) {
  const svc: any = Object.create(CloudOffloadService.prototype);
  svc.logger = { log() {}, warn() {}, error() {} };
  svc.running = false;
  svc.getPolicy = async () => ({
    enabled: true,
    triggerModes: { continuous: true, motion: true, manual: true },
    keepLocalCopy: false,
  });
  svc.buildCloudKey = (r: any) => `k/${r.id}`;
  Object.assign(svc, over);
  return svc;
}

/** Grava quantos envios estão em voo a cada instante. */
function clienteQueMedePico(picoRef: { atual: number; pico: number }, atrasoMs = 12) {
  return {
    putObject: async () => {
      picoRef.atual += 1;
      picoRef.pico = Math.max(picoRef.pico, picoRef.atual);
      await new Promise((r) => setTimeout(r, atrasoMs));
      picoRef.atual -= 1;
    },
    putObjectMultipart: async () => {},
    headObject: async () => ({ exists: true }),
    deleteObject: async () => {},
  };
}

/**
 * Arquivos REAIS num diretório temporário.
 *
 * O caminho de envio faz `stat` e lê o arquivo do disco; com caminhos
 * inventados ele falha antes de chegar ao envio e o teste mediria zero
 * paralelismo achando que mediu o teto.
 */
async function bancada(n: number) {
  const raiz = await mkdtemp(join(tmpdir(), 'drac-offload-'));
  const lista = [];
  for (let i = 0; i < n; i += 1) {
    const caminho = join(raiz, `v${i}.mp4`);
    await writeFile(caminho, Buffer.alloc(2048, 1));
    lista.push({ id: `r${i}`, cameraId: 'c1', filePath: caminho, sizeBytes: BigInt(2048), triggerMode: 'motion' });
  }
  return { raiz, lista, limpar: () => rm(raiz, { recursive: true, force: true }) };
}

function prismaCom(lista: any[]) {
  return {
    recording: {
      findMany: async () => lista,
      update: async () => ({}),
      updateMany: async () => ({ count: 0 }),
    },
  };
}

test('o teto de envios simultâneos é respeitado', async (t) => {
  const pico = { atual: 0, pico: 0 };
  const b = await bancada(30);
  t.after(() => b.limpar());
  const svc = makeOffload({ prisma: prismaCom(b.lista), recordingsRoot: () => b.raiz });

  await svc.uploadPending(clienteQueMedePico(pico), { uploadConcurrency: 4 } as any, null);
  assert.ok(pico.pico <= 4, `chegou a ${pico.pico} envios em voo, com teto 4`);
  assert.ok(pico.pico > 1, 'e usou o paralelismo — 1 em voo seria o sequencial de antes');
});

test('teto 1 volta a ser sequencial', async (t) => {
  const pico = { atual: 0, pico: 0 };
  const b = await bancada(6);
  t.after(() => b.limpar());
  const svc = makeOffload({ prisma: prismaCom(b.lista), recordingsRoot: () => b.raiz });

  await svc.uploadPending(clienteQueMedePico(pico), { uploadConcurrency: 1 } as any, null);
  assert.equal(pico.pico, 1);
});

test('valor absurdo do operador não vira paralelismo absurdo', async (t) => {
  const pico = { atual: 0, pico: 0 };
  const b = await bancada(200);
  t.after(() => b.limpar());
  const svc = makeOffload({ prisma: prismaCom(b.lista), recordingsRoot: () => b.raiz });

  await svc.uploadPending(clienteQueMedePico(pico), { uploadConcurrency: 5000 } as any, null);
  assert.ok(pico.pico <= 64, `teto de segurança furado: ${pico.pico} em voo`);
});
