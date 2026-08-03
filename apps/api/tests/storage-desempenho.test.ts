import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  camerasSuportadas,
  classificarLatencia,
  instavel,
  mediana,
  percentil,
  throughputMbps,
} from '../src/cloud-storage/helpers/benchmark-stats.helper';
import { StorageBenchmarkService } from '../src/cloud-storage/storage-benchmark.service';

// ─────────────────────────────────────────────────────────────────────────────
// MEDIÇÃO DE DESEMPENHO DO STORAGE
//
// O risco desta funcionalidade não é falhar — é MENTIR de forma convincente. Um
// número bonito faz o operador dimensionar a operação errado e descobrir só
// quando o disco enche. Estes testes travam as armadilhas:
//
//   · média escondendo a cauda (é a cauda que forma fila);
//   · bits confundidos com bytes (fator 8 na conta de banda contratada);
//   · lixo pago deixado no bucket do cliente quando a medição falha no meio;
//   · duas medições simultâneas dividindo a banda e relatando metade.
// ─────────────────────────────────────────────────────────────────────────────

// ── Estatística ─────────────────────────────────────────────────────────────

test('mediana ignora o outlier que a média engoliria', () => {
  // Bucket que responde bem quase sempre e trava de vez em quando: a média diz
  // 460ms (ruim), a mediana diz 40ms (a experiência real) e o p95 revela a
  // trava. Os três juntos contam a história; qualquer um sozinho mente.
  const amostras = [40, 38, 42, 41, 39, 40, 3000];
  const media = amostras.reduce((a, b) => a + b, 0) / amostras.length;
  assert.ok(media > 400);
  assert.equal(mediana(amostras), 40);
  assert.ok(percentil(amostras, 0.95) > 1000, 'o p95 tem de continuar mostrando a trava');
});

test('mediana de amostra par é a média dos dois centrais', () => {
  assert.equal(mediana([10, 20, 30, 40]), 25);
});

test('percentil interpola em vez de saltar entre valores brutos', () => {
  assert.equal(percentil([0, 10], 0.5), 5);
  assert.equal(percentil([0, 100], 0.95), 95);
  assert.equal(percentil([42], 0.95), 42, 'uma amostra só não tem percentil — devolve o que há');
  assert.equal(percentil([], 0.95), 0);
});

test('throughput é em MEGABITS por segundo, como a banda é contratada', () => {
  // 1 MB em 1s = 8 Mb/s. Devolver 1 (MB/s) faria o cliente comparar com o "100
  // mega" do provedor e concluir que está 8x pior do que está.
  assert.equal(throughputMbps(1_000_000, 1000), 8);
  assert.equal(throughputMbps(8_000_000, 1000), 64);
  assert.equal(throughputMbps(1000, 0), 0, 'tempo zero não vira divisão por zero');
});

test('câmeras suportadas usa o bitrate MEDIDO e guarda margem', () => {
  // 100 Mb/s × 70% ÷ 2,06 = 33. Prometer os 100% da medição seria prometer uma
  // rede que só existe no instante ocioso do teste.
  assert.equal(camerasSuportadas(100), 33);
  assert.equal(camerasSuportadas(0), 0);
  assert.equal(camerasSuportadas(1), 0, 'banda que não comporta nem uma câmera devolve zero, não fração');
});

test('classificação de latência acompanha o que a operação sente', () => {
  assert.equal(classificarLatencia(35), 'boa');
  assert.equal(classificarLatencia(200), 'aceitável');
  assert.equal(classificarLatencia(900), 'ruim');
});

test('instabilidade é a cauda LONGE da mediana, não a cauda alta', () => {
  assert.equal(instavel(40, 80), false, 'dobro é folga normal de rede');
  assert.equal(instavel(40, 200), true);
  assert.equal(instavel(500, 900), false, 'lento e consistente é lento, não instável');
});

// ── Serviço ─────────────────────────────────────────────────────────────────

function makeBenchmark(over: Record<string, unknown> = {}) {
  const svc: any = Object.create(StorageBenchmarkService.prototype);
  svc.logger = { log() {}, warn() {} };
  svc.rodando = false;
  svc.prisma = {
    cloudStorage: {
      findUnique: async () => ({
        id: 'st-1', name: 'Eveo 1T', bucket: 'acervo-1t', endpoint: 'http://eveo:9000',
        prefix: '', provider: 's3', region: 'us-east-1', accessKeyId: 'AK',
        secretAccessKeyEncrypted: 'cifrado:S', forcePathStyle: true, updatedAt: new Date(),
      }),
    },
  };
  svc.resolver = {
    materializar: (r: any) => ({ ...r, secretAccessKey: 'S' }),
    clienteDe: () => ({
      putObject: async () => {},
      getObject: async () => Buffer.alloc(1024 * 1024),
      headObject: async () => ({ exists: true }),
      deleteObject: async () => {},
    }),
  };
  Object.assign(svc, over);
  return svc;
}

test('APAGA tudo que criou, inclusive quando a medição falha no meio', async () => {
  const apagadas: string[] = [];
  const svc = makeBenchmark({
    resolver: {
      materializar: (r: any) => r,
      clienteDe: () => ({
        putObject: async () => {},
        getObject: async () => { throw new Error('conexão caiu'); },
        headObject: async () => ({ exists: true }),
        deleteObject: async (k: string) => { apagadas.push(k); },
      }),
    },
  });
  await assert.rejects(() => svc.medir('st-1', 1));
  assert.equal(apagadas.length, 1, 'o objeto grande já subido tem de sair mesmo com a falha');
  assert.ok(apagadas[0].startsWith('__drac_perf__/'),
    'objeto de teste vive sob prefixo próprio — nunca pode colidir com gravação');
});

test('a trava libera depois da falha, senão o botão morre para sempre', async () => {
  const svc = makeBenchmark({
    resolver: {
      materializar: (r: any) => r,
      clienteDe: () => ({
        putObject: async () => { throw new Error('sem acesso'); },
        getObject: async () => Buffer.alloc(0),
        headObject: async () => ({ exists: true }),
        deleteObject: async () => {},
      }),
    },
  });
  await assert.rejects(() => svc.medir('st-1', 1));
  assert.equal(svc.rodando, false);
});

test('recusa duas medições ao mesmo tempo', async () => {
  const svc = makeBenchmark();
  svc.rodando = true;
  await assert.rejects(() => svc.medir('st-1', 1), /medição em andamento/);
});

test('recusa storage com credencial ilegível', async () => {
  const svc = makeBenchmark({ resolver: { materializar: () => null, clienteDe: () => { throw new Error('não devia'); } } });
  await assert.rejects(() => svc.medir('st-1', 1), /não pôde ser decifrada/);
});

test('o tamanho da amostra é limitado nos dois extremos', async () => {
  let maiorCarga = 0;
  const cliente = {
    putObject: async (_k: string, p: Buffer) => { maiorCarga = Math.max(maiorCarga, p.length); },
    getObject: async () => Buffer.alloc(1024),
    headObject: async () => ({ exists: true }),
    deleteObject: async () => {},
  };
  const svc = makeBenchmark({ resolver: { materializar: (r: any) => r, clienteDe: () => cliente } });

  const pequeno = await svc.medir('st-1', 0);
  assert.equal(pequeno.amostraMb, 8, 'zero cai no padrão, não vira medição de nada');

  maiorCarga = 0;
  const grande = await svc.medir('st-1', 999);
  assert.equal(grande.amostraMb, 32, 'teto: acima disso o teste competiria com o envio das gravações');
  assert.equal(maiorCarga, 32 * 1024 * 1024);
});

test('a medição conta as falhas e AVISA que os números ficaram otimistas', async () => {
  const svc = makeBenchmark({
    resolver: {
      materializar: (r: any) => r,
      clienteDe: () => ({
        putObject: async () => {},
        getObject: async () => Buffer.alloc(1024 * 1024),
        headObject: async () => { throw new Error('timeout'); },
        deleteObject: async () => {},
      }),
    },
  });
  const r = await svc.medir('st-1', 1);
  assert.equal(r.falhas, 7, 'as sete amostras de latência falharam');
  assert.ok(r.observacoes.some((o: string) => o.includes('otimistas')),
    'medição parcial sem aviso é pior que medição nenhuma');
  assert.equal(r.latencia.amostras, 0);
});

test('objeto que volta truncado invalida a descida em vez de virar banda alta', async () => {
  const svc = makeBenchmark({
    resolver: {
      materializar: (r: any) => r,
      clienteDe: () => ({
        putObject: async () => {},
        // 1 KB de volta para 1 MB enviado: sem esta checagem, a "descida"
        // pareceria mil vezes mais rápida que a subida.
        getObject: async () => Buffer.alloc(1024),
        headObject: async () => ({ exists: true }),
        deleteObject: async () => {},
      }),
    },
  });
  const r = await svc.medir('st-1', 1);
  assert.ok(r.observacoes.some((o: string) => o.includes('não é confiável')));
  assert.ok(r.falhas > 0);
});
