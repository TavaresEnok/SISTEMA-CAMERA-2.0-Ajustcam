import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { CloudOffloadService } from '../src/cloud-storage/cloud-offload.service';
import { S3Client } from '../src/cloud-storage/s3-client';

// ─────────────────────────────────────────────────────────────────────────────
// OFFLOAD PONTA A PONTA: Postgres real + bucket real + arquivo real em disco.
//
// A invariante que este arquivo existe para provar:
//   NENHUM arquivo local é apagado sem upload CONFIRMADO.
//
// Um teste com S3 falso provaria só que a lógica chama as funções na ordem
// certa. Aqui a gravação sobe de verdade, é relida do bucket de verdade, e o
// arquivo some do disco de verdade — que é o único jeito de confiar em código
// que APAGA prova.
//
// Precisa de Postgres (scripts/e2e-postgres-fixture.sh) e de um bucket
// S3-compatível (DRAC_E2E_S3_*). Anti-teatro: pula visível sem infra; sob
// DRAC_E2E_REQUIRED=1 falha em vez de passar verde.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.DRAC_E2E_DATABASE_URL ?? '';
const S3 = {
  endpoint: process.env.DRAC_E2E_S3_ENDPOINT ?? '',
  region: process.env.DRAC_E2E_S3_REGION ?? 'us-east-1',
  bucket: process.env.DRAC_E2E_S3_BUCKET ?? '',
  accessKeyId: process.env.DRAC_E2E_S3_ACCESS_KEY ?? '',
  secretAccessKey: process.env.DRAC_E2E_S3_SECRET_KEY ?? '',
};
const REQUIRED = process.env.DRAC_E2E_REQUIRED === '1';
const configurado = Boolean(DB_URL && S3.endpoint && S3.bucket && S3.accessKeyId && S3.secretAccessKey);

if (!configurado) {
  const motivo = 'exige DRAC_E2E_DATABASE_URL + DRAC_E2E_S3_* (Postgres e bucket reais)';
  if (REQUIRED) test('offload ponta a ponta', () => assert.fail(`DRAC_E2E_REQUIRED=1 mas ${motivo}`));
  else test('offload ponta a ponta', { skip: motivo }, () => {});
} else {
  const TAG = `off${process.pid}`;
  const prefix = `drac-e2e-offload/${process.pid}`;
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const raiz = mkdtempSync(join(tmpdir(), 'drac-offload-'));
  const s3 = new S3Client({ ...S3, prefix, forcePathStyle: true });

  /** Monta o serviço com config injetada — sem Nest, como o resto da casa faz. */
  function buildService(localWindowHours: number) {
    const svc: any = Object.create(CloudOffloadService.prototype);
    svc.logger = { log: () => {}, warn: () => {}, error: () => {} };
    svc.running = false;
    svc.prisma = prisma;
    svc.config = { get: (k: string) => (k === 'recordingsRoot' ? raiz : undefined) };
    svc.cloudConnector = {
      getCloudStorageConfig: async () => ({
        enabled: true, mode: 'tier', provider: 'minio',
        endpoint: S3.endpoint, region: S3.region, bucket: S3.bucket,
        prefix, accessKeyId: S3.accessKeyId, secretAccessKey: S3.secretAccessKey,
        localWindowHours, forcePathStyle: true, updatedAt: null,
      }),
    };
    return svc;
  }

  async function limpar() {
    await prisma.recording.deleteMany({ where: { id: { startsWith: TAG } } });
    await prisma.camera.deleteMany({ where: { id: { startsWith: TAG } } });
    // Cada teste começa de uma política CONHECIDA. O default do produto é
    // "nuvem desligada"; deixar isso implícito faria os testes de offload
    // passarem ou falharem conforme a ordem de execução.
    await prisma.systemSetting.upsert({
      where: { key: 'storage.policy' },
      create: { key: 'storage.policy', value: JSON.stringify({ enabled: true, triggerModes: { continuous: true, motion: true, manual: true } }) },
      update: { value: JSON.stringify({ enabled: true, triggerModes: { continuous: true, motion: true, manual: true } }) },
    });
  }

  /** Cria câmera + gravação com arquivo real no disco. */
  async function semear(id: string, opts: { idadeHoras: number; conteudo: Buffer; triggerMode?: string }) {
    const cameraId = `${TAG}-cam`;
    await prisma.camera.upsert({
      where: { id: cameraId },
      create: { id: cameraId, name: cameraId, ip: '10.0.0.1', username: 'u', passwordEncrypted: 'e' },
      update: {},
    });
    const rel = join(`camera-${cameraId}`, `${id}.mp4`);
    const abs = join(raiz, rel);
    mkdirSync(join(raiz, `camera-${cameraId}`), { recursive: true });
    writeFileSync(abs, opts.conteudo);
    const quando = new Date(Date.now() - opts.idadeHoras * 3600_000);
    await prisma.recording.create({
      data: {
        id, cameraId, filePath: rel, startedAt: quando, endedAt: quando,
        sizeBytes: BigInt(opts.conteudo.length), durationSeconds: 60,
        // Sem um tipo VÁLIDO nada sobe: a política ignora 'unknown' de
        // propósito (não classificamos, não decidimos por conta própria).
        triggerMode: opts.triggerMode ?? 'motion',
      },
    });
    return abs;
  }

  test.after(async () => {
    for (const o of await s3.listObjects('').catch(() => [])) {
      await s3.deleteObject(o.key.replace(`${prefix}/`, '')).catch(() => undefined);
    }
    await limpar();
    await prisma.$disconnect();
  });

  test('sobe a gravação para o bucket e MARCA no banco', async () => {
    await limpar();
    const conteudo = Buffer.from('conteudo-de-video-simulado-'.repeat(100));
    await semear(`${TAG}-a`, { idadeHoras: 48, conteudo });

    const svc = buildService(24);
    const r = await svc.runOnce();
    assert.equal(r.skipped, false);
    assert.equal(r.uploaded, 1, 'a gravação pendente tem que subir');
    assert.equal(r.failed, 0);

    const row = await prisma.recording.findUnique({ where: { id: `${TAG}-a` } });
    assert.ok(row?.cloudKey, 'cloudKey precisa ser gravado');
    assert.ok(row?.cloudUploadedAt, 'cloudUploadedAt marca o upload CONFIRMADO');

    // O objeto existe MESMO no bucket, com o conteúdo íntegro.
    const doBucket = await s3.getObject(row!.cloudKey!.replace(`${prefix}/`, ''));
    assert.ok(doBucket.equals(conteudo), 'o que está no bucket tem que ser byte a byte o que estava em disco');
  });

  test('apaga o local só DEPOIS da janela, e só do que já subiu', async () => {
    await limpar();
    const antigo = await semear(`${TAG}-old`, { idadeHoras: 48, conteudo: Buffer.from('antigo') });
    const recente = await semear(`${TAG}-new`, { idadeHoras: 1, conteudo: Buffer.from('recente') });

    const svc = buildService(24);
    await svc.runOnce(); // sobe os dois
    // Envelhece o upload do antigo: a poda olha `cloudUploadedAt`, não startedAt.
    await prisma.recording.update({
      where: { id: `${TAG}-old` },
      data: { cloudUploadedAt: new Date(Date.now() - 48 * 3600_000) },
    });
    await svc.runOnce();

    assert.equal(existsSync(antigo), false, 'passada a janela, o arquivo local sai do disco');
    assert.equal(existsSync(recente), true, 'dentro da janela, o local PERMANECE (playback recente é do disco)');

    const rowAntigo = await prisma.recording.findUnique({ where: { id: `${TAG}-old` } });
    assert.ok(rowAntigo?.localDeletedAt, 'a remoção local precisa ficar registrada');
    assert.ok(rowAntigo?.cloudKey, 'e a gravação continua existindo — na nuvem');
  });

  test('INVARIANTE: upload que falha NÃO apaga o arquivo local', async () => {
    await limpar();
    const arquivo = await semear(`${TAG}-fail`, { idadeHoras: 72, conteudo: Buffer.from('nao-pode-sumir') });

    // Credencial errada: todo upload falha.
    const svc = buildService(1);
    svc.cloudConnector = {
      getCloudStorageConfig: async () => ({
        enabled: true, mode: 'tier', provider: 'minio',
        endpoint: S3.endpoint, region: S3.region, bucket: S3.bucket,
        prefix, accessKeyId: S3.accessKeyId, secretAccessKey: 'CHAVE-ERRADA',
        localWindowHours: 1, forcePathStyle: true, updatedAt: null,
      }),
    };

    const r = await svc.runOnce();
    assert.equal(r.uploaded, 0);
    assert.ok(r.failed >= 1, 'a falha precisa ser contabilizada');
    assert.equal(existsSync(arquivo), true, 'O ARQUIVO LOCAL NÃO PODE SUMIR — é a prova do cliente');

    const row = await prisma.recording.findUnique({ where: { id: `${TAG}-fail` } });
    assert.equal(row?.cloudKey, null, 'sem upload confirmado, nada é marcado');
    assert.equal(row?.localDeletedAt, null);
  });

  test('reprocessar é idempotente (não duplica objeto nem reconta)', async () => {
    await limpar();
    await semear(`${TAG}-idem`, { idadeHoras: 48, conteudo: Buffer.from('idempotente') });
    const svc = buildService(24);

    const primeira = await svc.runOnce();
    assert.equal(primeira.uploaded, 1);

    const segunda = await svc.runOnce();
    assert.equal(segunda.uploaded, 0, 'o que já subiu não sobe de novo');
  });

  test('modo mount não faz offload (lá o ffmpeg já escreve no bucket)', async () => {
    const svc = buildService(24);
    svc.cloudConnector = {
      getCloudStorageConfig: async () => ({
        enabled: true, mode: 'mount', provider: 'minio',
        endpoint: S3.endpoint, region: S3.region, bucket: S3.bucket, prefix,
        accessKeyId: S3.accessKeyId, secretAccessKey: S3.secretAccessKey,
        localWindowHours: 24, forcePathStyle: true, updatedAt: null,
      }),
    };
    const r = await svc.runOnce();
    assert.equal(r.skipped, true);
    assert.match(String(r.reason), /mount/);
  });

  test('sem storage provisionado o offload não faz nada', async () => {
    const svc = buildService(24);
    svc.cloudConnector = { getCloudStorageConfig: async () => null };
    const r = await svc.runOnce();
    assert.equal(r.skipped, true);
    assert.equal(r.uploaded, 0);
  });

  test('resumo reflete o estado real do acervo', async () => {
    await limpar();
    await semear(`${TAG}-s1`, { idadeHoras: 48, conteudo: Buffer.from('a') });
    await semear(`${TAG}-s2`, { idadeHoras: 48, conteudo: Buffer.from('b') });
    const svc = buildService(24);
    await svc.runOnce();

    const resumo = await svc.summary();
    assert.equal(resumo.enabled, true);
    assert.equal(resumo.bucket, S3.bucket);
    assert.ok(resumo.recordingsInCloud >= 2, 'as duas subiram');
  });

  // ── FASE 3: assistir o que já está SÓ na nuvem ─────────────────────────────
  // Sem isto, o offload seria uma armadilha: a gravação está salva no bucket,
  // mas some da interface. O byte passa PELA API (proxy) porque o bucket pode
  // ser MinIO em rede local, inalcançável do navegador do operador remoto.

  /** Response falso do Express: coleta status, headers e corpo. */
  function fakeRes(range?: string) {
    const chunks: Buffer[] = [];
    const headers: Record<string, string> = {};
    const res: any = {
      req: { headers: range ? { range } : {} },
      statusCode: 200,
      writableEnded: false,
      status(code: number) { this.statusCode = code; return this; },
      setHeader(k: string, v: string) { headers[k.toLowerCase()] = String(v); return this; },
      write(buf: Buffer) { chunks.push(Buffer.from(buf)); return true; },
      end() { this.writableEnded = true; },
      once() { /* sem backpressure no teste */ },
    };
    return { res, headers, body: () => Buffer.concat(chunks) };
  }

  /** RecordingsService mínimo: só o caminho de nuvem, sem Nest. */
  function buildRecordingsService() {
    const { RecordingsService } = require('../src/recordings/recordings.service');
    const svc: any = Object.create(RecordingsService.prototype);
    // Object.create não roda inicializadores de campo: o logger real é criado
    // na construção da classe, então precisa ser fornecido aqui.
    svc.logger = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    svc.cloudConnector = {
      getCloudStorageConfig: async () => ({
        enabled: true, mode: 'tier', provider: 'minio',
        endpoint: S3.endpoint, region: S3.region, bucket: S3.bucket, prefix,
        accessKeyId: S3.accessKeyId, secretAccessKey: S3.secretAccessKey,
        localWindowHours: 24, forcePathStyle: true, updatedAt: null,
      }),
    };
    return svc;
  }

  test('gravação SÓ na nuvem ainda é reproduzível (o buraco que a Fase 3 fecha)', async () => {
    await limpar();
    const conteudo = Buffer.from('VIDEO-'.repeat(5000));
    const arquivo = await semear(`${TAG}-cloudplay`, { idadeHoras: 72, conteudo });

    const off = buildService(1);
    await off.runOnce();
    await prisma.recording.update({
      where: { id: `${TAG}-cloudplay` },
      data: { cloudUploadedAt: new Date(Date.now() - 48 * 3600_000) },
    });
    await off.runOnce();
    assert.equal(existsSync(arquivo), false, 'pré-condição: o local saiu do disco');

    const row = await prisma.recording.findUnique({ where: { id: `${TAG}-cloudplay` } });
    const svc = buildRecordingsService();
    const { res, headers, body } = fakeRes();
    const serviu = await svc.streamFromCloudIfAvailable(row, res);

    assert.equal(serviu, true, 'a API tem que servir da nuvem em vez de 404');
    assert.equal(res.statusCode, 200);
    assert.equal(headers['accept-ranges'], 'bytes', 'sem isto o navegador não faz seek');
    assert.ok(body().equals(conteudo), 'o vídeo servido é byte a byte o que foi gravado');
  });

  test('Range é repassado ao bucket — seek funciona no vídeo da nuvem', async () => {
    const row = await prisma.recording.findUnique({ where: { id: `${TAG}-cloudplay` } });
    assert.ok(row?.cloudKey, 'pré-condição: veio do teste anterior');

    const svc = buildRecordingsService();
    const { res, headers, body } = fakeRes('bytes=10-19');
    await svc.streamFromCloudIfAvailable(row, res);

    assert.equal(res.statusCode, 206, 'resposta parcial, como o navegador espera');
    assert.ok(headers['content-range'], 'Content-Range vem do bucket, não recalculado aqui');
    assert.equal(body().length, 10, 'exatamente os 10 bytes pedidos');
    assert.equal(body().toString(), Buffer.from('VIDEO-'.repeat(5000)).subarray(10, 20).toString());
  });

  test('download de gravação na nuvem anexa nome de arquivo', async () => {
    const row = await prisma.recording.findUnique({ where: { id: `${TAG}-cloudplay` } });
    const svc = buildRecordingsService();
    const { res, headers } = fakeRes();
    await svc.streamFromCloudIfAvailable(row, res, { download: true });
    assert.match(headers['content-disposition'] ?? '', /attachment; filename=/);
  });

  test('gravação sem cópia na nuvem devolve false (mantém o 404 de sempre)', async () => {
    const svc = buildRecordingsService();
    const { res } = fakeRes();
    const serviu = await svc.streamFromCloudIfAvailable({ id: 'x', filePath: 'a.mp4', cloudKey: null }, res);
    assert.equal(serviu, false);
  });

  test('storage removido do painel: erro EXPLICA que está na nuvem', async () => {
    // "Não encontrado" mandaria o operador procurar no disco um arquivo que
    // está no bucket.
    const svc = buildRecordingsService();
    svc.cloudConnector = { getCloudStorageConfig: async () => null };
    const { res } = fakeRes();
    await assert.rejects(
      () => svc.streamFromCloudIfAvailable({ id: 'x', filePath: 'a.mp4', cloudKey: 'k' }, res),
      /nuvem/i,
    );
  });

  // ── Política + multipart, contra infra real ──────────────────────────────

  async function setPolicy(svc: any, policy: any) {
    await prisma.systemSetting.upsert({
      where: { key: 'storage.policy' },
      create: { key: 'storage.policy', value: JSON.stringify(policy) },
      update: { value: JSON.stringify(policy) },
    });
  }

  test('POLÍTICA: só sobe o tipo de gravação marcado', async () => {
    await limpar();
    // Duas gravações, tipos diferentes.
    await semear(`${TAG}-mot`, { idadeHoras: 48, conteudo: Buffer.from('movimento') });
    await semear(`${TAG}-con`, { idadeHoras: 48, conteudo: Buffer.from('continua') });
    await prisma.recording.update({ where: { id: `${TAG}-mot` }, data: { triggerMode: 'motion' } });
    await prisma.recording.update({ where: { id: `${TAG}-con` }, data: { triggerMode: 'continuous' } });

    const svc = buildService(24);
    await setPolicy(svc, { enabled: true, triggerModes: { continuous: false, motion: true, manual: false } });
    const r = await svc.runOnce();

    assert.equal(r.uploaded, 1, 'só a de movimento sobe');
    const mot = await prisma.recording.findUnique({ where: { id: `${TAG}-mot` } });
    const con = await prisma.recording.findUnique({ where: { id: `${TAG}-con` } });
    assert.ok(mot?.cloudKey, 'movimento foi marcado');
    assert.equal(con?.cloudKey, null, 'contínua NÃO subiu — é o que o operador escolheu');
  });

  test('POLÍTICA desligada: nada sobe mesmo com bucket provisionado', async () => {
    await limpar();
    await semear(`${TAG}-off`, { idadeHoras: 48, conteudo: Buffer.from('x') });
    await prisma.recording.update({ where: { id: `${TAG}-off` }, data: { triggerMode: 'motion' } });

    const svc = buildService(24);
    await setPolicy(svc, { enabled: false, triggerModes: { motion: true } });
    const r = await svc.runOnce();
    assert.equal(r.uploaded, 0, 'ter bucket não significa enviar');
  });

  test('POLÍTICA keepLocalCopy: sobe mas NÃO apaga o local (modo backup)', async () => {
    await limpar();
    const arquivo = await semear(`${TAG}-bkp`, { idadeHoras: 72, conteudo: Buffer.from('backup') });
    await prisma.recording.update({ where: { id: `${TAG}-bkp` }, data: { triggerMode: 'motion' } });

    const svc = buildService(1);
    await setPolicy(svc, { enabled: true, keepLocalCopy: true, triggerModes: { motion: true } });
    await svc.runOnce();
    await prisma.recording.update({
      where: { id: `${TAG}-bkp` },
      data: { cloudUploadedAt: new Date(Date.now() - 48 * 3600_000) },
    });
    await svc.runOnce();

    const row = await prisma.recording.findUnique({ where: { id: `${TAG}-bkp` } });
    assert.ok(row?.cloudKey, 'subiu para a nuvem');
    assert.equal(existsSync(arquivo), true, 'quem pediu BACKUP não quer perder o arquivo local');
    assert.equal(row?.localDeletedAt, null);
  });

  test('MULTIPART: arquivo grande sobe em partes e volta íntegro', async () => {
    // 12 MiB força o caminho multipart (parte mínima do protocolo é 5 MiB).
    const grande = Buffer.alloc(12 * 1024 * 1024);
    for (let i = 0; i < grande.length; i += 1) grande[i] = (i * 31) % 256;

    const key = 'multipart/grande.bin';
    let offsetLido = 0;
    await s3.putObjectMultipart(
      key,
      async (offset, length) => { offsetLido = Math.max(offsetLido, offset + length); return grande.subarray(offset, offset + length); },
      grande.length,
      { partSizeBytes: 5 * 1024 * 1024, contentType: 'video/mp4' },
    );
    assert.equal(offsetLido, grande.length, 'leu o arquivo inteiro, em partes');

    const baixado = await s3.getObject(key);
    assert.equal(baixado.length, grande.length, 'tamanho confere');
    assert.ok(baixado.equals(grande), 'byte a byte idêntico — partes remontadas na ordem certa');
    await s3.deleteObject(key);
  });

  test('MULTIPART: falha no meio ABORTA o upload (não deixa parte órfã cobrando)', async () => {
    const key = 'multipart/falha.bin';
    await assert.rejects(
      () => s3.putObjectMultipart(
        key,
        async (offset) => { if (offset > 0) throw new Error('falha simulada na leitura'); return Buffer.alloc(5 * 1024 * 1024); },
        12 * 1024 * 1024,
        { partSizeBytes: 5 * 1024 * 1024 },
      ),
      /falha simulada/,
    );
    // O objeto NÃO pode existir: upload incompleto não vira arquivo.
    assert.equal((await s3.headObject(key)).exists, false, 'upload abortado não deixa objeto pela metade');
  });

  // ── Materialização: trazer da nuvem para transcode/snapshot ───────────────
  // ffmpeg precisa de um CAMINHO real. Sem isto, gravação offloadada ficava
  // assistível (o streaming faz pass-through) mas não transcodável — câmera
  // H.265 em navegador sem HEVC simplesmente não abria.

  test('materializa a gravação da nuvem em cache local, íntegra', async () => {
    await limpar();
    const conteudo = Buffer.from('CONTEUDO-PARA-TRANSCODE-'.repeat(200));
    const arquivo = await semear(`${TAG}-mat`, { idadeHoras: 72, conteudo });

    const off = buildService(1);
    await off.runOnce();
    await prisma.recording.update({
      where: { id: `${TAG}-mat` },
      data: { cloudUploadedAt: new Date(Date.now() - 48 * 3600_000) },
    });
    await off.runOnce();
    assert.equal(existsSync(arquivo), false, 'pré-condição: saiu do disco');

    const row = await prisma.recording.findUnique({ where: { id: `${TAG}-mat` } });
    const svc = buildRecordingsService();
    // materializeFromCloud usa RECORDINGS_ROOT do ambiente.
    const anterior = process.env.RECORDINGS_ROOT;
    process.env.RECORDINGS_ROOT = raiz;
    try {
      const local = await svc.materializeFromCloud(row);
      assert.ok(local, 'precisa devolver um caminho local');
      assert.equal(existsSync(local), true, 'o arquivo tem que existir de fato');
      assert.ok(readFileSync(local).equals(conteudo), 'byte a byte igual ao original — senão o ffmpeg lê vídeo corrompido');

      // Segunda chamada REUSA o cache em vez de baixar de novo.
      const denovo = await svc.materializeFromCloud(row);
      assert.equal(denovo, local, 'mesma chave, mesmo arquivo em cache');
    } finally {
      if (anterior === undefined) delete process.env.RECORDINGS_ROOT;
      else process.env.RECORDINGS_ROOT = anterior;
    }
  });

  test('materializar gravação SEM cópia na nuvem devolve null', async () => {
    const svc = buildRecordingsService();
    const local = await svc.materializeFromCloud({ id: 'x', filePath: 'a.mp4', cloudKey: null });
    assert.equal(local, null, 'sem cloudKey não há o que materializar');
  });

  test('não deixa arquivo .partial para trás quando o download falha', async () => {
    // Um .partial tratado como cache válido faria o ffmpeg ler vídeo truncado.
    const svc = buildRecordingsService();
    svc.cloudConnector = {
      getCloudStorageConfig: async () => ({
        enabled: true, mode: 'tier', provider: 'minio',
        endpoint: S3.endpoint, region: S3.region, bucket: S3.bucket, prefix,
        accessKeyId: S3.accessKeyId, secretAccessKey: 'CHAVE-ERRADA',
        localWindowHours: 24, forcePathStyle: true, updatedAt: null,
      }),
    };
    const anterior = process.env.RECORDINGS_ROOT;
    process.env.RECORDINGS_ROOT = raiz;
    try {
      const local = await svc.materializeFromCloud({ id: 'falha-mat', filePath: 'x.mp4', cloudKey: 'inexistente.mp4' });
      assert.equal(local, null, 'falha de download não pode virar caminho válido');
      const cache = join(raiz, '.cloud-cache');
      const sobras = existsSync(cache) ? readdirSync(cache).filter((f) => f.includes('falha-mat')) : [];
      assert.deepEqual(sobras, [], 'nenhum resíduo .partial no cache');
    } finally {
      if (anterior === undefined) delete process.env.RECORDINGS_ROOT;
      else process.env.RECORDINGS_ROOT = anterior;
    }
  });
}
