import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UserRole } from '@prisma/client';
import { RecordingsService } from '../src/recordings/recordings.service';
import type { AuthUser } from '../src/common/types/auth-user.type';
import { __resetHwaccelDetectionCache, type HwaccelDecision } from '../src/camera-stream/helpers/hwaccel-presets.helper';
import { buildRangeExportJobId, normalizeRangeExportIdentity } from '../src/jobs/helpers/range-export-job.helper';

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTAÇÃO POR INTERVALO — camada de serviço (I/O real em diretório temporário,
// ffmpeg trocado por seam). O que está em jogo é prova judicial: um evento de 3
// minutos que cruza a borda do segmento (300s, ou 60s no modo movimento) NÃO
// CABE num arquivo só, e o `exportClip` de hoje só sabe recortar UM arquivo.
// ─────────────────────────────────────────────────────────────────────────────

const T0 = Date.parse('2026-07-27T10:00:00.000Z');
const min = (m: number) => new Date(T0 + m * 60_000);

const USER: AuthUser = { id: 'u-op', email: 'op@drac.local', name: 'Operador', role: UserRole.OPERATOR };

type Attempt = { args: string[]; copy: boolean; acelerado: boolean; manifest: string };

const CPU: HwaccelDecision = {
  mode: 'auto',
  preset: null,
  device: null,
  usingCpu: true,
  proven: false,
  degraded: false,
  reason: 'CPU',
  warnings: [],
};

const GPU: HwaccelDecision = {
  ...CPU,
  preset: 'preset-nvidia',
  device: '0',
  usingCpu: false,
  proven: true,
  reason: 'Aceleração preset-nvidia comprovada',
};

function makeService(options: {
  segments?: Array<{ id: string; startMinute: number; durationSeconds?: number; videoCodec?: string | null; audioCodec?: string | null; missingFile?: boolean }>;
  hwaccel?: HwaccelDecision;
  behaviour?: (attempt: Attempt, index: number) => 'ok' | 'erro' | 'vazio';
  canPlayback?: boolean;
  existingClip?: boolean;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'drac-range-export-'));
  const segments = options.segments ?? [
    { id: 's1', startMinute: 0 },
    { id: 's2', startMinute: 5 },
    { id: 's3', startMinute: 10 },
  ];

  const rows = segments.map((s) => {
    const rel = join('cam-1', `${s.id}.mp4`);
    if (!s.missingFile) {
      mkdirSync(join(root, 'cam-1'), { recursive: true });
      writeFileSync(join(root, rel), `segmento-${s.id}`);
    }
    const duration = s.durationSeconds ?? 300;
    return {
      id: s.id,
      cameraId: 'cam-1',
      filePath: rel,
      startedAt: min(s.startMinute),
      endedAt: new Date(min(s.startMinute).getTime() + duration * 1000),
      durationSeconds: duration,
      videoCodec: s.videoCodec === undefined ? 'h264' : s.videoCodec,
      audioCodec: s.audioCodec === undefined ? null : s.audioCodec,
    };
  });

  const attempts: Attempt[] = [];
  const warnings: string[] = [];
  const created: any[] = [];
  const progress: Array<{ step: string; percent: number }> = [];
  const clipsByPath = new Map<string, any>();

  const svc: any = Object.create(RecordingsService.prototype);
  svc.logger = { log: () => {}, warn: (m: string) => warnings.push(String(m)), error: (m: string) => warnings.push(String(m)), debug: () => {} };
  const audits: any[] = [];
  svc.prisma = {
    recording: {
      findMany: async (_args: any) => rows.map((r) => ({ ...r })),
    },
    exportedClip: {
      findUnique: async ({ where }: any) => clipsByPath.get(where.filePath) ?? null,
      create: async ({ data }: any) => {
        const row = { id: `clip-${created.length + 1}`, ...data };
        created.push(row);
        clipsByPath.set(data.filePath, row);
        return row;
      },
    },
    auditLog: { create: async ({ data }: any) => { audits.push(data); return data; } },
  };
  svc.accessControlService = {
    assertCanPlaybackCamera: async () => {
      if (options.canPlayback === false) {
        const error: any = new Error('Sem permissão para reproduzir esta câmera.');
        error.status = 403;
        throw error;
      }
    },
  };
  svc.authService = { me: async () => USER };
  svc.resolveTranscodeHwaccel = async () => options.hwaccel ?? CPU;
  // Codec conhecido vem do diagnóstico já gravado; aqui o seam devolve o que o
  // cenário declarou (o real cai em ffprobe quando o cache não sabe).
  svc.resolveSegmentCodecs = async (recordingId: string) => {
    const row = rows.find((r) => r.id === recordingId);
    return { videoCodec: row?.videoCodec ?? null, audioCodec: row?.audioCodec ?? null };
  };
  svc.inspectClipExternalPlayback = async (filePath: string) => ({
    ok: true,
    container: 'mov,mp4',
    videoCodec: 'h264',
    audioCodec: null,
    durationSeconds: statSync(filePath).size > 0 ? 390 : 0,
    reasons: [],
  });
  svc.runRangeExportAttempt = async (args: string[]) => {
    const manifestPath = args[args.indexOf('-i') + 1];
    const attempt: Attempt = {
      args,
      copy: args.includes('-c') && args[args.indexOf('-c') + 1] === 'copy',
      acelerado: args.some((a) => a === '-hwaccel' || a === '-hwaccel_device'),
      manifest: existsSync(manifestPath) ? readFileSync(manifestPath, 'utf-8') : '',
    };
    attempts.push(attempt);
    const out = args[args.length - 1];
    const verdict = (options.behaviour ?? (() => 'ok'))(attempt, attempts.length - 1);
    if (verdict === 'erro') {
      writeFileSync(out, 'lixo-parcial');
      throw new Error('ffmpeg exited with code 1');
    }
    if (verdict === 'vazio') {
      writeFileSync(out, '');
      return;
    }
    writeFileSync(out, `saida-${attempt.copy ? 'copy' : attempt.acelerado ? 'gpu' : 'cpu'}`);
  };

  const prevRoot = process.env.RECORDINGS_ROOT;
  process.env.RECORDINGS_ROOT = root;
  const restore = () => {
    if (prevRoot === undefined) delete process.env.RECORDINGS_ROOT;
    else process.env.RECORDINGS_ROOT = prevRoot;
    rmSync(root, { recursive: true, force: true });
  };

  return {
    svc: svc as any,
    root,
    attempts,
    warnings,
    created,
    progress,
    clipsByPath,
    audits,
    restore,
    run: (over: Record<string, unknown> = {}) =>
      svc.exportCameraRange(
        USER,
        {
          cameraId: 'cam-1',
          from: min(4.5).toISOString(),
          to: min(11).toISOString(),
          profile: 'auto',
          reason: 'BO 123/2026',
          ...over,
        },
        { onProgress: (p: any) => progress.push(p) },
      ),
  };
}

function clipFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else out.push(join(dir, entry.name));
    }
  };
  const clipsDir = join(root, 'clips');
  if (existsSync(clipsDir)) walk(clipsDir);
  return out;
}

test('intervalo que atravessa 3 segmentos gera UM arquivo contínuo', async () => {
  __resetHwaccelDetectionCache();
  const h = makeService();
  try {
    const result = await h.run();

    const mp4s = clipFiles(h.root).filter((f) => f.endsWith('.mp4'));
    assert.equal(mp4s.length, 1, 'a prova é UM vídeo — não três pedaços para o juiz remontar');
    assert.equal(h.created.length, 1, 'e um único ExportedClip registrado');
    assert.equal(result.segmentCount, 3);
    assert.equal(result.strategy, 'copy');
    assert.equal(result.requestedSeconds, 390);
    assert.equal(result.durationSeconds, 394, 'a duração gravada é a do arquivo REAL (390s pedidos + 2s de margem em cada ponta)');
    assert.deepEqual(result.sourceRecordingIds, ['s1', 's2', 's3']);
    assert.equal(result.continuous, true);
    assert.deepEqual(result.gaps, []);

    // O manifesto entregue ao ffmpeg tem de listar os TRÊS arquivos, na ordem.
    const manifest = h.attempts[0].manifest;
    assert.equal((manifest.match(/^file /gm) ?? []).length, 3, manifest);
    assert.ok(manifest.includes('s1.mp4') && manifest.includes('s2.mp4') && manifest.includes('s3.mp4'));
    assert.ok(manifest.indexOf('s1.mp4') < manifest.indexOf('s2.mp4'), 'fora de ordem a prova vira outra coisa');
    assert.ok(/inpoint 268\.000/.test(manifest), `recorte com margem de keyframe: ${manifest}`);
    assert.ok(/outpoint 62\.000/.test(manifest), manifest);

    // A janela gravada no banco é a que o arquivo REALMENTE cobre.
    assert.equal(h.created[0].startedAt.toISOString(), new Date(min(4.5).getTime() - 2000).toISOString());
    assert.equal(h.created[0].endedAt.toISOString(), new Date(min(11).getTime() + 2000).toISOString());
    assert.equal(h.created[0].sourceRecordingId, 's1');
    assert.ok(h.created[0].fileSha256 && h.created[0].fileSha256.length === 64, 'a evidência continua com hash');
    assert.equal(h.created[0].createdByUserId, USER.id);

    // Auditoria: o job roda FORA do request, então quem registra é o serviço.
    assert.equal(h.audits.length, 1, 'exportação sem trilha de auditoria não é prova');
    assert.equal(h.audits[0].action, 'recording.range.export');
    assert.equal(h.audits[0].userId, USER.id);
    assert.equal((h.audits[0].metadata as any).reason, 'BO 123/2026');
  } finally {
    h.restore();
  }
});

test('auditoria quebrada NÃO faz a exportação pronta se perder', async () => {
  const h = makeService();
  h.svc.prisma.auditLog.create = async () => {
    throw new Error('banco fora do ar');
  };
  try {
    const result = await h.run();
    assert.ok(existsSync(result.filePath), 'o arquivo já existe em disco: falhar aqui jogaria o trabalho fora');
    assert.equal(h.created.length, 1);
    assert.ok(h.warnings.some((w) => /auditoria/i.test(w)), `a falha de auditoria tem de gritar no log — ${JSON.stringify(h.warnings)}`);
  } finally {
    h.restore();
  }
});

test('a exportação escreve o manifesto de PROVENIÊNCIA junto do vídeo', async () => {
  const h = makeService();
  try {
    const result = await h.run();
    const sidecar = clipFiles(h.root).find((f) => f.endsWith('.json'));
    assert.ok(sidecar, 'sem a lista de origem o arquivo emendado não se defende em perícia');
    const parsed = JSON.parse(readFileSync(sidecar!, 'utf-8'));
    assert.deepEqual(parsed.parts.map((p: any) => p.recordingId), ['s1', 's2', 's3']);
    assert.equal(parsed.strategy, 'copy');
    assert.equal(parsed.fileSha256, result.fileSha256);
    assert.equal(parsed.requestedBy.userId, USER.id);
    assert.equal(parsed.reason, 'BO 123/2026');
  } finally {
    h.restore();
  }
});

test('GATE: sem permissão de playback nada é exportado (nem um ffmpeg roda)', async () => {
  const h = makeService({ canPlayback: false });
  try {
    await assert.rejects(() => h.run(), /permiss/i);
    assert.equal(h.attempts.length, 0, 'o gate tem de barrar ANTES de tocar em arquivo de câmera');
    assert.equal(h.created.length, 0);
    assert.deepEqual(clipFiles(h.root), []);
  } finally {
    h.restore();
  }
});

test('stream-copy quando dá: UMA tentativa, sem reencodar (rápido e sem perda)', async () => {
  const h = makeService();
  try {
    await h.run();
    assert.equal(h.attempts.length, 1);
    assert.equal(h.attempts[0].copy, true);
    assert.ok(!h.attempts[0].args.includes('libx264'));
  } finally {
    h.restore();
  }
});

test('codec misto no intervalo: NENHUMA tentativa de copy — vai direto ao transcode', async () => {
  const h = makeService({
    segments: [
      { id: 's1', startMinute: 0, videoCodec: 'h264' },
      { id: 's2', startMinute: 5, videoCodec: 'hevc' },
    ],
  });
  try {
    const result = await h.run({ to: min(6).toISOString() });
    assert.equal(result.strategy, 'transcode');
    assert.equal(h.attempts.filter((a) => a.copy).length, 0, 'copy de codecs misturados abre e toca lixo');
    assert.equal(h.attempts.length, 1);
    assert.ok(h.attempts[0].args.includes('libx264'));
  } finally {
    h.restore();
  }
});

test('copy que falha cai para transcode sozinho — o arquivo TEM de sair', async () => {
  const h = makeService({ behaviour: (a) => (a.copy ? 'erro' : 'ok') });
  try {
    const result = await h.run();
    assert.equal(h.attempts.length, 2);
    assert.equal(h.attempts[0].copy, true);
    assert.equal(h.attempts[1].copy, false);
    assert.equal(result.strategyUsed, 'transcode');
    assert.ok(existsSync(result.filePath));
  } finally {
    h.restore();
  }
});

test('hwaccel falha ⇒ refaz em CPU e entrega (a GPU é bônus, nunca requisito)', async () => {
  __resetHwaccelDetectionCache();
  const h = makeService({
    hwaccel: GPU,
    segments: [
      { id: 's1', startMinute: 0, videoCodec: 'h264' },
      { id: 's2', startMinute: 5, videoCodec: 'hevc' }, // força transcode
    ],
    behaviour: (a) => (a.acelerado ? 'erro' : 'ok'),
  });
  try {
    const result = await h.run({ to: min(6).toISOString() });
    assert.equal(h.attempts.length, 2);
    assert.equal(h.attempts[0].acelerado, true);
    assert.equal(h.attempts[1].acelerado, false);
    assert.ok(existsSync(result.filePath));
    assert.ok(
      h.warnings.some((w) => /acelera/i.test(w) && /CPU/i.test(w)),
      `a queda para CPU precisa AVISAR — ${JSON.stringify(h.warnings)}`,
    );
  } finally {
    h.restore();
  }
});

test('hwaccel que sai 0 mas não escreve nada também cai para CPU', async () => {
  __resetHwaccelDetectionCache();
  const h = makeService({
    hwaccel: GPU,
    segments: [
      { id: 's1', startMinute: 0, videoCodec: 'h264' },
      { id: 's2', startMinute: 5, videoCodec: 'hevc' },
    ],
    behaviour: (a) => (a.acelerado ? 'vazio' : 'ok'),
  });
  try {
    const result = await h.run({ to: min(6).toISOString() });
    assert.equal(h.attempts.length, 2, 'código de saída 0 não é prova de arquivo bom');
    assert.ok(existsSync(result.filePath));
  } finally {
    h.restore();
  }
});

test('todas as tentativas falham: erro claro, ZERO lixo em disco e nada no banco', async () => {
  const h = makeService({ behaviour: () => 'erro' });
  try {
    await assert.rejects(() => h.run(), /export/i);
    assert.equal(h.created.length, 0, 'clip que não existe não pode virar registro de prova');
    assert.deepEqual(clipFiles(h.root), [], 'arquivo pela metade não pode sobrar se passando por prova');
    assert.deepEqual(
      readdirSync(join(h.root, '.range-export')).filter((f) => !f.startsWith('.')),
      [],
      'o manifesto temporário tem de ser limpo mesmo no caminho de erro',
    );
  } finally {
    h.restore();
  }
});

test('idempotência: repetir o MESMO pedido não roda ffmpeg de novo', async () => {
  const h = makeService();
  try {
    const primeiro = await h.run();
    const segundo = await h.run();
    assert.equal(h.attempts.length, 1, 'o segundo clique não pode disparar outro FFmpeg contra a gravação');
    assert.equal(h.created.length, 1);
    assert.equal(segundo.id, primeiro.id);
    assert.equal(segundo.reused, true);
  } finally {
    h.restore();
  }
});

test('idempotência: perfil diferente é OUTRA exportação (não reusa o arquivo errado)', async () => {
  const h = makeService();
  try {
    await h.run();
    const compat = await h.run({ profile: 'compatible' });
    assert.equal(h.created.length, 2);
    assert.equal(compat.reused, undefined);
    assert.equal(compat.strategy, 'transcode', 'perfil compatível reencoda para H.264 mesmo quando o copy seria possível');
  } finally {
    h.restore();
  }
});

test('progresso é publicado etapa a etapa até 100%', async () => {
  const h = makeService();
  try {
    await h.run();
    const passos = h.progress.map((p) => p.step);
    assert.ok(passos.includes('planning'), passos.join(','));
    assert.ok(passos.includes('copying'), passos.join(','));
    assert.ok(passos.includes('hashing'), passos.join(','));
    assert.equal(passos[passos.length - 1], 'done');
    assert.equal(h.progress[h.progress.length - 1].percent, 100);
  } finally {
    h.restore();
  }
});

test('intervalo sem gravação nenhuma: 404 honesto, sem arquivo e sem ffmpeg', async () => {
  const h = makeService();
  try {
    await assert.rejects(() => h.run({ from: min(60).toISOString(), to: min(70).toISOString() }), /grava/i);
    assert.equal(h.attempts.length, 0);
    assert.deepEqual(clipFiles(h.root), []);
  } finally {
    h.restore();
  }
});

test('segmento que sumiu do disco não entra no plano (404 na emenda trava o player)', async () => {
  const h = makeService({
    segments: [
      { id: 's1', startMinute: 0 },
      { id: 's2', startMinute: 5, missingFile: true },
      { id: 's3', startMinute: 10 },
    ],
  });
  try {
    const result = await h.run();
    assert.deepEqual(result.sourceRecordingIds, ['s1', 's3']);
    assert.equal(result.continuous, false);
    assert.equal(result.gaps.length, 1, 'o buraco tem de aparecer no laudo, não sumir na emenda');
  } finally {
    h.restore();
  }
});

test('intervalo longo demais é recusado antes de virar trabalho', async () => {
  const h = makeService();
  try {
    await assert.rejects(
      () => h.run({ from: min(0).toISOString(), to: new Date(T0 + 48 * 3600_000).toISOString() }),
      /interval|máxim|maxim/i,
    );
    assert.equal(h.attempts.length, 0);
  } finally {
    h.restore();
  }
});

test('o exportClip por recordingId continua existindo (outros consumidores dependem dele)', () => {
  assert.equal(typeof RecordingsService.prototype.exportClip, 'function');
});

test('o job resolve o usuário do pedido na HORA de executar', async () => {
  const h = makeService();
  const pedidos: string[] = [];
  h.svc.authService = {
    me: async (userId: string) => {
      pedidos.push(userId);
      return USER;
    },
  };
  try {
    const result = await h.svc.runRangeExportJob(
      {
        cameraId: 'cam-1',
        from: min(4.5).toISOString(),
        to: min(11).toISOString(),
        profile: 'auto',
        reason: 'BO 123/2026',
        requestedByUserId: USER.id,
      },
      { onProgress: (p: any) => h.progress.push(p) },
    );
    assert.deepEqual(pedidos, [USER.id]);
    assert.equal(result.segmentCount, 3);
  } finally {
    h.restore();
  }
});

test('usuário desativado entre o clique e a execução NÃO exporta', async () => {
  const h = makeService();
  h.svc.authService = {
    me: async () => {
      throw new Error('Usuário inativo ou inexistente.');
    },
  };
  try {
    await assert.rejects(
      () =>
        h.svc.runRangeExportJob({
          cameraId: 'cam-1',
          from: min(4.5).toISOString(),
          to: min(11).toISOString(),
          reason: 'BO 123/2026',
          requestedByUserId: 'u-demitido',
        }),
      /inativo|inexistente/i,
    );
    assert.equal(h.attempts.length, 0, 'a fila não pode ser a porta dos fundos de quem perdeu o acesso');
    assert.equal(h.created.length, 0);
  } finally {
    h.restore();
  }
});

// ── Fila ─────────────────────────────────────────────────────────────────────

// Os cenários de fila mexem em RECORDINGS_ROOT; o node:test roda os testes de um
// arquivo em sequência, então desfazemos tudo no fim (ordem inversa).
const limpezasDaFila: Array<() => void> = [];
after(() => {
  for (const limpar of [...limpezasDaFila].reverse()) limpar();
});

function makeQueueService(options: { jobs?: any[]; clipReady?: boolean } = {}) {
  const added: any[] = [];
  const removed: string[] = [];
  const jobs = options.jobs ?? [];
  const svc: any = Object.create(RecordingsService.prototype);
  svc.logger = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  svc.accessControlService = { assertCanPlaybackCamera: async () => {} };

  // "Já pronto" é pronto NO DISCO: uma linha no banco apontando para arquivo que
  // a retenção apagou não pode ser vendida ao operador como exportação concluída.
  const root = mkdtempSync(join(tmpdir(), 'drac-range-queue-'));
  const prevRoot = process.env.RECORDINGS_ROOT;
  process.env.RECORDINGS_ROOT = root;
  const identity = normalizeRangeExportIdentity({ cameraId: 'cam-1', from: min(4.5), to: min(11), profile: 'auto' });
  const readyPath = svc.buildRangeExportOutputPath?.(identity) ?? join(root, 'clips', 'inexistente.mp4');
  if (options.clipReady) {
    mkdirSync(join(readyPath, '..'), { recursive: true });
    writeFileSync(readyPath, 'prova-pronta');
  }
  const restoreQueue = () => {
    if (prevRoot === undefined) delete process.env.RECORDINGS_ROOT;
    else process.env.RECORDINGS_ROOT = prevRoot;
    rmSync(root, { recursive: true, force: true });
  };
  limpezasDaFila.push(restoreQueue);

  svc.prisma = {
    exportedClip: {
      findUnique: async ({ where }: any) =>
        options.clipReady && where.filePath === readyPath
          ? { id: 'clip-pronto', cameraId: 'cam-1', filePath: readyPath, durationSeconds: 394, sizeBytes: BigInt(12) }
          : null,
    },
  };
  svc.rangeExportQueue = {
    add: async (name: string, data: any, opts: any) => {
      added.push({ name, data, opts });
      return { id: opts.jobId, name, data };
    },
    getJob: async (id: string) => jobs.find((j) => j.id === id) ?? null,
    getJobs: async (_states: string[]) => jobs,
  };
  return { svc, added, removed, jobs, readyPath, restore: restoreQueue };
}

test('enfileirar usa o jobId idempotente (BullMQ recusa o duplicado sozinho)', async () => {
  const h = makeQueueService();
  const identity = normalizeRangeExportIdentity({ cameraId: 'cam-1', from: min(4.5), to: min(11), profile: 'auto' });
  const primeiro = await h.svc.enqueueCameraRangeExport(USER, {
    cameraId: 'cam-1',
    from: min(4.5).toISOString(),
    to: min(11).toISOString(),
    reason: 'BO 1',
  });
  const segundo = await h.svc.enqueueCameraRangeExport(USER, {
    cameraId: 'cam-1',
    from: min(4.5).toISOString(),
    to: min(11).toISOString(),
    reason: 'BO 1',
  });
  assert.equal(primeiro.jobId, buildRangeExportJobId(identity));
  assert.equal(segundo.jobId, primeiro.jobId, 'mesmo pedido, mesmo job — não existe fila com a mesma prova duas vezes');
  assert.equal(h.added[0].opts.jobId, primeiro.jobId);
});

test('enfileirar NÃO roda o ffmpeg no request (a gravação não disputa CPU com o clique)', async () => {
  const h = makeQueueService();
  const resposta = await h.svc.enqueueCameraRangeExport(USER, {
    cameraId: 'cam-1',
    from: min(4.5).toISOString(),
    to: min(11).toISOString(),
    reason: 'BO 1',
  });
  assert.equal(resposta.status, 'queued');
  assert.equal(resposta.progress.percent, 0);
  assert.equal(h.added.length, 1);
});

test('exportação já pronta é devolvida na hora, sem entrar na fila', async () => {
  const h = makeQueueService({ clipReady: true });
  const resposta = await h.svc.enqueueCameraRangeExport(USER, {
    cameraId: 'cam-1',
    from: min(4.5).toISOString(),
    to: min(11).toISOString(),
    reason: 'BO 1',
  });
  assert.equal(resposta.status, 'completed');
  assert.equal(resposta.clip.id, 'clip-pronto');
  assert.equal(h.added.length, 0);
});

test('consulta de progresso passa pelo MESMO gate de acesso da câmera', async () => {
  const h = makeQueueService({
    jobs: [
      {
        id: 'rex-1',
        data: { cameraId: 'cam-privada' },
        progress: { step: 'encoding', percent: 40 },
        getState: async () => 'active',
      },
    ],
  });
  const negados: string[] = [];
  h.svc.accessControlService = {
    assertCanPlaybackCamera: async (_u: AuthUser, cameraId: string) => {
      negados.push(cameraId);
      throw new Error('Sem permissão para reproduzir esta câmera.');
    },
  };
  await assert.rejects(() => h.svc.getCameraRangeExportStatus(USER, 'rex-1'), /permiss/i);
  assert.deepEqual(negados, ['cam-privada'], 'o gate é conferido com a câmera DO JOB, não com a do pedido');
});

test('consulta de progresso devolve estado e percentual', async () => {
  const h = makeQueueService({
    jobs: [
      {
        id: 'rex-1',
        data: { cameraId: 'cam-1', from: min(4.5).toISOString(), to: min(11).toISOString() },
        progress: { step: 'encoding', percent: 40 },
        attemptsMade: 0,
        getState: async () => 'active',
      },
    ],
  });
  const status = await h.svc.getCameraRangeExportStatus(USER, 'rex-1');
  assert.equal(status.status, 'active');
  assert.equal(status.progress.percent, 40);
  assert.equal(status.progress.step, 'encoding');
  assert.equal(status.cameraId, 'cam-1');
});

test('órfão do restart volta para a fila; job vivo é deixado em paz', async () => {
  const agora = Date.now();
  const removidos: string[] = [];
  const readicionados: string[] = [];
  const h = makeQueueService({
    jobs: [
      {
        id: 'rex-vivo',
        name: 'export-range',
        data: { cameraId: 'cam-1' },
        attemptsMade: 0,
        processedOn: agora - 1_000,
        progress: { step: 'encoding', percent: 40, at: agora - 1_000 },
        remove: async () => removidos.push('rex-vivo'),
      },
      {
        id: 'rex-orfao',
        name: 'export-range',
        data: { cameraId: 'cam-1' },
        attemptsMade: 0,
        processedOn: agora - 3_600_000,
        progress: { step: 'encoding', percent: 40, at: agora - 3_600_000 },
        remove: async () => removidos.push('rex-orfao'),
      },
    ],
  });
  h.svc.rangeExportQueue.add = async (name: string, _data: any, opts: any) => {
    readicionados.push(opts.jobId);
    return { id: opts.jobId, name };
  };

  const resultado = await h.svc.recoverOrphanRangeExports();
  assert.deepEqual(removidos, ['rex-orfao']);
  assert.deepEqual(readicionados, ['rex-orfao'], 'o trabalho perdido no restart tem de voltar sozinho');
  assert.equal(resultado.requeued, 1);
  assert.equal(resultado.kept, 1);
});

test('órfão que na verdade está TRAVADO por um worker vivo não é duplicado', async () => {
  const agora = Date.now();
  const readicionados: string[] = [];
  const h = makeQueueService({
    jobs: [
      {
        id: 'rex-lock',
        name: 'export-range',
        data: { cameraId: 'cam-1' },
        attemptsMade: 0,
        processedOn: agora - 3_600_000,
        // O BullMQ recusa remover job com lock ativo — é assim que sabemos que
        // ainda existe alguém trabalhando nele apesar do batimento velho.
        remove: async () => {
          throw new Error('Job is locked');
        },
      },
    ],
  });
  h.svc.rangeExportQueue.add = async (_n: string, _d: any, opts: any) => {
    readicionados.push(opts.jobId);
    return { id: opts.jobId };
  };
  const resultado = await h.svc.recoverOrphanRangeExports();
  assert.deepEqual(readicionados, [], 'reenfileirar job travado geraria DOIS ffmpeg sobre o mesmo arquivo');
  assert.equal(resultado.requeued, 0);
  assert.equal(resultado.skipped, 1);
});
