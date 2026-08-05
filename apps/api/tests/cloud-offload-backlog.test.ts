import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudOffloadService } from '../src/cloud-storage/cloud-offload.service';

// ── "QUANDO O S3 VOLTAR, SOBE TUDO" PRECISA SER VERDADE ─────────────────────
//
// O lote era fixo: 25 gravações a cada 15 minutos ≈ 100 por hora. Esta frota
// PRODUZ cerca de 300 por hora. Em regime normal não aparece (o envio também é
// disparado quando cada segmento fecha), mas depois de qualquer interrupção do
// fornecedor — as horas de `NoSuchBucket (404)` desta instalação — a fila
// acumulada NUNCA drena: entra mais por hora do que sai, e o atraso vira
// permanente sem ninguém perceber.
//
// Com fila grande, o lote cresce (até um teto) e o tamanho da fila vai para o
// log. Atraso de arquivamento silencioso é como se descobre, tarde demais, que
// um mês inteiro não subiu.

function montar(pendentes: number, env: Record<string, string> = {}) {
  const anterior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) { anterior[k] = process.env[k]; process.env[k] = v; }

  const avisos: string[] = [];
  let takePedido = 0;
  const svc: any = Object.create(CloudOffloadService.prototype);
  svc.logger = { warn: (m: string) => avisos.push(m), log: () => {}, error: () => {} };
  svc.getPolicy = async () => ({ enabled: true, triggerModes: { continuous: true, motion: true, manual: true } });
  svc.prisma = {
    recording: {
      count: async () => pendentes,
      findMany: async ({ take }: { take: number }) => { takePedido = take; return []; },
    },
  };

  const restaurar = () => {
    for (const [k, v] of Object.entries(anterior)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
  return { svc, avisos, take: () => takePedido, restaurar };
}

async function rodar(pendentes: number, env: Record<string, string> = {}) {
  const b = montar(pendentes, env);
  try {
    await b.svc.uploadPending({}, { uploadConcurrency: 4 }, null);
    return { take: b.take(), avisos: b.avisos };
  } finally {
    b.restaurar();
  }
}

test('fila pequena mantém o lote normal', async () => {
  const { take, avisos } = await rodar(10, { CLOUD_OFFLOAD_BATCH: '25' });
  assert.equal(take, 25);
  assert.deepEqual(avisos, [], 'sem atraso não há o que avisar');
});

test('fila ATRASADA aumenta o lote para drenar em vez de crescer', async () => {
  // 2.000 pendentes com lote de 25 levaria 20 horas só para tocar em cada uma
  // uma vez — enquanto entram mais 300 por hora. A fila nunca fecharia.
  const { take, avisos } = await rodar(2000, { CLOUD_OFFLOAD_BATCH: '25', CLOUD_OFFLOAD_BATCH_MAX: '200' });
  assert.equal(take, 200, 'o lote precisa crescer, senão o atraso é permanente');
  assert.ok(avisos.some((m) => m.includes('2000')), 'o tamanho da fila tem de aparecer no log');
});

test('o lote cresce proporcional à fila, não direto no teto', async () => {
  // 200 pendentes → um quarto por ciclo: drena em ~4 ciclos sem despejar tudo
  // de uma vez na internet que também carrega o vídeo ao vivo.
  const { take } = await rodar(200, { CLOUD_OFFLOAD_BATCH: '25', CLOUD_OFFLOAD_BATCH_MAX: '200' });
  assert.equal(take, 50);
});

test('o teto do lote é respeitado', async () => {
  const { take } = await rodar(100000, { CLOUD_OFFLOAD_BATCH: '25', CLOUD_OFFLOAD_BATCH_MAX: '80' });
  assert.equal(take, 80, 'sem teto, uma fila enorme viraria uma rajada que disputa banda com o ao vivo');
});

test('o lote ampliado nunca fica MENOR que o normal', async () => {
  const { take } = await rodar(60, { CLOUD_OFFLOAD_BATCH: '25', CLOUD_OFFLOAD_BATCH_MAX: '200' });
  assert.ok(take >= 25, `lote ${take} menor que o normal atrasaria ainda mais a fila`);
});

test('contagem indisponível não derruba o envio', async () => {
  // A contagem é diagnóstico; falhar nela não pode impedir o upload.
  const b = montar(0, { CLOUD_OFFLOAD_BATCH: '25' });
  b.svc.prisma.recording.count = async () => { throw new Error('banco ocupado'); };
  try {
    await b.svc.uploadPending({}, { uploadConcurrency: 4 }, null);
    assert.equal(b.take(), 25, 'sem a contagem, segue com o lote normal');
  } finally {
    b.restaurar();
  }
});
