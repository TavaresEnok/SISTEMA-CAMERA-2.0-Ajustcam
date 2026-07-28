import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileRecordingPaths } from '../src/recordings/helpers/recording-reconcile.helper';

// ─────────────────────────────────────────────────────────────────────────────
// 2.4 — reconciliação DB↔disco de gravações (moonfire check.rs / zmaudit.pl).
// Helper PURO: as duas classes de órfão são detectadas nas DUAS direções.
// ─────────────────────────────────────────────────────────────────────────────

test('2.4: detecta órfãos nas duas direções', () => {
  const db = ['/rec/a.mp4', '/rec/b.mp4', '/rec/c.mp4'];
  const disk = ['/rec/b.mp4', '/rec/c.mp4', '/rec/d.mp4'];
  const { orfaosNoDisco, orfaosNoDb } = reconcileRecordingPaths(db, disk);
  // No disco mas fora do banco → d.mp4.
  assert.deepEqual(orfaosNoDisco, ['/rec/d.mp4']);
  // No banco mas fora do disco → a.mp4.
  assert.deepEqual(orfaosNoDb, ['/rec/a.mp4']);
});

test('2.4: tudo casando → nenhum órfão', () => {
  const paths = ['/rec/a.mp4', '/rec/b.mp4'];
  const { orfaosNoDisco, orfaosNoDb } = reconcileRecordingPaths(paths, [...paths]);
  assert.deepEqual(orfaosNoDisco, []);
  assert.deepEqual(orfaosNoDb, []);
});

test('2.4: banco vazio → todo arquivo do disco é órfão-no-disco', () => {
  const { orfaosNoDisco, orfaosNoDb } = reconcileRecordingPaths([], ['/rec/x.mp4', '/rec/y.mp4']);
  assert.deepEqual(orfaosNoDisco, ['/rec/x.mp4', '/rec/y.mp4']);
  assert.deepEqual(orfaosNoDb, []);
});

test('2.4: disco vazio → todo registro do banco é órfão-no-db', () => {
  const { orfaosNoDisco, orfaosNoDb } = reconcileRecordingPaths(['/rec/x.mp4', '/rec/y.mp4'], []);
  assert.deepEqual(orfaosNoDisco, []);
  assert.deepEqual(orfaosNoDb, ['/rec/x.mp4', '/rec/y.mp4']);
});

test('2.4: resultado é determinístico (ordenado) apesar da ordem de entrada', () => {
  const db = ['/rec/z.mp4', '/rec/m.mp4', '/rec/a.mp4'];
  const disk: string[] = [];
  const { orfaosNoDb } = reconcileRecordingPaths(db, disk);
  assert.deepEqual(orfaosNoDb, ['/rec/a.mp4', '/rec/m.mp4', '/rec/z.mp4'], 'ordenação estável');
});

test('2.4: duplicatas na mesma lista não geram falso órfão', () => {
  const { orfaosNoDisco, orfaosNoDb } = reconcileRecordingPaths(
    ['/rec/a.mp4', '/rec/a.mp4'],
    ['/rec/a.mp4', '/rec/a.mp4'],
  );
  assert.deepEqual(orfaosNoDisco, []);
  assert.deepEqual(orfaosNoDb, []);
});

// ── O JOB NOTURNO NÃO PODE DESFAZER O CLAMP DE PTS ──────────────────────────
//
// `registerSegment` detecta salto de PTS (a câmera reinicia o relógio RTSP no
// meio do segmento), CLAMPA a duração para a esperada, deixa o marcador
// `<arquivo>.duration-clamped.json` ao lado e grava endedAt coerente.
//
// `reconcileRecordingMetadata` — que roda no cron da meia-noite sobre as 2.000
// gravações mais recentes — re-executava o MESMO `ffprobe format=duration`,
// obtinha de novo o valor absurdo e sobrescrevia `durationSeconds` e `endedAt`
// SEM teto e SEM olhar o marcador. A correção do clamp tinha vida útil de 24h.
//
// O estrago não é cosmético: com durationSeconds=25200 (7h) num segmento de
// 300s, o VOD emite `#EXTINF:25200.000` e passa a marcar os ~84 segmentos
// seguintes como sobreposição (start − prevEnd fortemente negativo). O player
// trava ou pula em cima de gravação ÍNTEGRA — exatamente o desfecho que o clamp
// existe para evitar. O mesmo valor contamina os `outpoint` do manifesto concat
// da exportação para perícia.
//
// O marcador é a fonte da verdade: ele existe justamente para dizer "aqui o
// ffprobe mente". Quem o encontra não pode acreditar no probe.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordingsService } from '../src/recordings/recordings.service';

function reconcileHarness(opts: { comMarcador: boolean; probeSeconds: number; probeSize: number }) {
  const root = mkdtempSync(join(tmpdir(), 'drac-rec-'));
  const nome = '2026-07-28_10-00-00.mp4';
  const filePath = join(root, nome);
  writeFileSync(filePath, 'video');
  if (opts.comMarcador) {
    writeFileSync(`${filePath}.duration-clamped.json`, JSON.stringify({
      probedDurationSeconds: opts.probeSeconds, appliedDurationSeconds: 300, cameraId: 'cam-1',
    }));
  }

  const updates: any[] = [];
  const svc: any = Object.create(RecordingsService.prototype);
  svc.logger = { warn() {}, log() {} };
  svc.probeFileMetadata = async () => ({ durationSecondsExact: opts.probeSeconds, sizeBytes: opts.probeSize });
  const startedAt = new Date('2026-07-28T10:00:00Z');
  svc.prisma = {
    recording: {
      findMany: async () => [{
        id: 'rec-1', filePath: nome, startedAt,
        endedAt: new Date(startedAt.getTime() + 300_000),
        durationSeconds: 300, sizeBytes: 1_000n,
      }],
      update: async (args: any) => { updates.push(args.data); return {}; },
    },
  };
  return { svc, updates, root, startedAt };
}

test('reconciliação: gravação com marcador de CLAMP não tem a duração sobrescrita', async () => {
  const anterior = process.env.RECORDINGS_ROOT;
  const { svc, updates, root, startedAt } = reconcileHarness({ comMarcador: true, probeSeconds: 25_200, probeSize: 5_000 });
  process.env.RECORDINGS_ROOT = root;
  try {
    await svc.reconcileRecordingMetadata(10);

    const mexeuNaDuracao = updates.some((u) => u.durationSeconds !== undefined);
    assert.equal(mexeuNaDuracao, false, 'o marcador diz que o ffprobe mente aqui: acreditar nele desfaz o clamp');
    const mexeuNoFim = updates.some((u) => u.endedAt !== undefined);
    assert.equal(mexeuNoFim, false, 'endedAt errado marca 84 segmentos seguintes como sobreposição no VOD');
    assert.equal(startedAt.getTime(), new Date('2026-07-28T10:00:00Z').getTime());
  } finally {
    if (anterior === undefined) delete process.env.RECORDINGS_ROOT; else process.env.RECORDINGS_ROOT = anterior;
    rmSync(root, { recursive: true, force: true });
  }
});

test('reconciliação: com marcador, o TAMANHO ainda é corrigido (o byte não mente)', async () => {
  const anterior = process.env.RECORDINGS_ROOT;
  const { svc, updates, root } = reconcileHarness({ comMarcador: true, probeSeconds: 25_200, probeSize: 5_000 });
  process.env.RECORDINGS_ROOT = root;
  try {
    await svc.reconcileRecordingMetadata(10);
    assert.equal(updates.length, 1, 'o tamanho divergia (1000 → 5000) e precisa ser reconciliado');
    assert.equal(updates[0].sizeBytes, 5_000n);
  } finally {
    if (anterior === undefined) delete process.env.RECORDINGS_ROOT; else process.env.RECORDINGS_ROOT = anterior;
    rmSync(root, { recursive: true, force: true });
  }
});

test('reconciliação: SEM marcador a reconciliação normal continua igual', async () => {
  const anterior = process.env.RECORDINGS_ROOT;
  const { svc, updates, root } = reconcileHarness({ comMarcador: false, probeSeconds: 600, probeSize: 5_000 });
  process.env.RECORDINGS_ROOT = root;
  try {
    await svc.reconcileRecordingMetadata(10);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].durationSeconds, 600, 'sem marcador o probe é a verdade — não pode mudar');
    assert.ok(updates[0].endedAt instanceof Date);
  } finally {
    if (anterior === undefined) delete process.env.RECORDINGS_ROOT; else process.env.RECORDINGS_ROOT = anterior;
    rmSync(root, { recursive: true, force: true });
  }
});
