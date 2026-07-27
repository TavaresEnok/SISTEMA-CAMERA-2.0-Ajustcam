import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RetentionService } from '../src/recordings/retention.service';

// ─────────────────────────────────────────────────────────────────────────────
// EXPIRAÇÃO O(acervo) → O(o que expira).
//
// A versão anterior hidratava o ACERVO INTEIRO no heap do Node a cada hora,
// DENTRO do mesmo processo que segura os ffmpeg de gravação:
//   100 câmeras × 30 dias × 288 segmentos ≈ 864 mil linhas por passagem.
// O custo crescia com o que EXISTE, não com o que EXPIRA — numa instalação
// grande isso é uma pausa de GC em cima do processo que grava prova.
//
// A regra de negócio NÃO muda: o filtro de data (e o de atividade, quando a
// retenção em dois níveis está ligada) desce para o BANCO, em LOTES, com teto
// por ciclo. Este arquivo prova as duas coisas que importam:
//   1. EQUIVALÊNCIA — apaga exatamente o mesmo conjunto que a varredura completa
//      apagaria, incluindo proteções (investigação/legal hold) e os dois níveis;
//   2. CUSTO — o número de linhas hidratadas acompanha o que expira, não o acervo.
// ─────────────────────────────────────────────────────────────────────────────

const DAY = 86_400_000;

// O guardião de disco depende do disco REAL da máquina; empurramos o gatilho
// para o teto para que ele nunca interfira nestes testes.
process.env.RETENTION_DISK_TRIGGER_PERCENT = '99';

type SeedRecording = {
  id: string;
  cameraId: string;
  ageDays: number;
  /** `undefined` = coluna ausente (banco anterior à migração) ⇒ DESCONHECIDO. */
  motionScore?: number;
  sizeBytes?: number;
};

type SeedCamera = { id: string; retentionDays?: number };
type SeedClip = { id: string; sourceRecordingId: string; ageDays: number };

type HarnessOptions = {
  globalDays?: number;
  cameras: SeedCamera[];
  recordings: SeedRecording[];
  clips?: SeedClip[];
  holdRecordingIds?: string[];
  holdClipIds?: string[];
  evidenceRecordingIds?: string[];
  /** Cliente Prisma ANTERIOR à migração de `Recording.motionScore`. */
  clienteSemMotionScore?: boolean;
};

/** Contadores de custo: é o que transforma "ficou mais barato" em número. */
type Stats = { recordingRowsRead: number; clipRowsRead: number; recordingQueries: number; clipQueries: number };

/**
 * Fake do Prisma modelado no schema REAL e nas formas de query que o serviço
 * realmente emite. Qualquer forma NÃO modelada explode: um fake que responde a
 * qualquer coisa é um fake que mente — e aqui ele é a única prova de que o
 * filtro desceu para o banco.
 *
 * Semântica implementada (a mesma do Prisma/Postgres):
 *   · where.cameraId.in / .notIn
 *   · where.startedAt.lt / .gte           (fronteiras ESTRITAS como no SQL)
 *   · where.OR: [...]                     (AND com o resto do where)
 *   · where.NOT: { motionScore: 0 }       (nega a igualdade)
 *   · orderBy [startedAt asc, id asc]     (ordem TOTAL — sem desempate, uma
 *                                          paginação com skip/take pode pular
 *                                          ou repetir linha no Postgres)
 *   · skip/take                           (janela sobre o resultado ordenado)
 *   · delete                              (P2025 quando não existe + CASCADE)
 */
function buildHarness(options: HarnessOptions) {
  const root = mkdtempSync(join(tmpdir(), 'drac-ret-lote-'));
  const now = Date.now();
  const cameras = options.cameras.map((c) => ({ id: c.id, retentionDays: c.retentionDays }));
  const store = new Map<string, any>();
  const clips: any[] = [];
  const files = new Map<string, string>();
  const deleteCalls = { recordings: [] as string[], clips: [] as string[] };
  const logs: string[] = [];
  const stats: Stats = { recordingRowsRead: 0, clipRowsRead: 0, recordingQueries: 0, clipQueries: 0 };

  for (const item of options.recordings) {
    mkdirSync(join(root, item.cameraId), { recursive: true });
    const relative = join(item.cameraId, `${item.id}.mp4`);
    const full = join(root, relative);
    writeFileSync(full, 'video');
    files.set(item.id, full);
    const row: any = {
      id: item.id,
      cameraId: item.cameraId,
      filePath: relative,
      startedAt: new Date(now - item.ageDays * DAY),
      sizeBytes: BigInt(item.sizeBytes ?? 0),
    };
    if (item.motionScore !== undefined) row.motionScore = item.motionScore;
    store.set(item.id, row);
  }

  for (const clip of options.clips ?? []) {
    const source = store.get(clip.sourceRecordingId);
    if (!source) throw new Error(`seed inválido: clip ${clip.id} sem gravação de origem`);
    const relative = join(source.cameraId, `${clip.id}.clip.mp4`);
    writeFileSync(join(root, relative), 'clip');
    files.set(clip.id, join(root, relative));
    clips.push({
      id: clip.id,
      cameraId: source.cameraId,
      sourceRecordingId: clip.sourceRecordingId,
      filePath: relative,
      startedAt: new Date(now - clip.ageDays * DAY),
    });
  }

  const matchesDate = (value: Date, filter: any) => {
    if (filter === undefined) return true;
    if (filter.lt !== undefined && !(value.getTime() < filter.lt.getTime())) return false;
    if (filter.gte !== undefined && !(value.getTime() >= filter.gte.getTime())) return false;
    for (const key of Object.keys(filter)) {
      if (key !== 'lt' && key !== 'gte') throw new Error(`fake: filtro de data não modelado: ${key}`);
    }
    return true;
  };

  const matchesCameraId = (cameraId: string, filter: any) => {
    if (filter === undefined) return true;
    if (filter.in) return filter.in.includes(cameraId);
    if (filter.notIn) return !filter.notIn.includes(cameraId);
    throw new Error(`fake: filtro de cameraId não modelado: ${JSON.stringify(filter)}`);
  };

  const matchesRecording = (row: any, where: any = {}): boolean => {
    for (const key of Object.keys(where)) {
      if (!['cameraId', 'startedAt', 'motionScore', 'OR', 'NOT', 'id'].includes(key)) {
        throw new Error(`fake: campo de where não modelado em recording: ${key}`);
      }
    }
    if (!matchesCameraId(row.cameraId, where.cameraId)) return false;
    if (!matchesDate(row.startedAt, where.startedAt)) return false;
    if (where.motionScore !== undefined && row.motionScore !== where.motionScore) return false;
    if (where.id?.notIn && where.id.notIn.includes(row.id)) return false;
    if (where.NOT !== undefined) {
      if (where.NOT.motionScore === undefined) throw new Error('fake: NOT não modelado');
      if (row.motionScore === where.NOT.motionScore) return false;
    }
    if (where.OR !== undefined) {
      if (!where.OR.some((clause: any) => matchesRecording(row, clause))) return false;
    }
    return true;
  };

  const orderedRecordings = (where: any, orderBy: any) => {
    const expected = JSON.stringify([{ startedAt: 'asc' }, { id: 'asc' }]);
    if (JSON.stringify(orderBy) !== expected) {
      throw new Error(
        `fake: paginação sem ordem TOTAL (${JSON.stringify(orderBy)}). Sem desempate por id, `
        + 'skip/take pode pular ou repetir linha quando dois segmentos têm o mesmo startedAt.',
      );
    }
    return [...store.values()]
      .filter((row) => matchesRecording(row, where))
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime() || a.id.localeCompare(b.id));
  };

  const project = (row: any, select: Record<string, boolean>) => {
    const out: any = {};
    for (const key of Object.keys(select)) out[key] = row[key];
    return out;
  };

  let queryCount = 0;
  const guard = () => {
    queryCount += 1;
    // Rede contra laço infinito: se a paginação não avançar (por exemplo, sem
    // `skip` quando a linha é protegida e não some), o teste morre aqui em vez
    // de travar a suíte inteira.
    if (queryCount > 2_000) throw new Error('fake: laço infinito de paginação (mais de 2000 queries)');
  };

  const prisma = {
    camera: {
      findMany: async (args: any) => {
        guard();
        if (!args?.select?.id || !args?.select?.retentionDays) {
          throw new Error(`fake camera.findMany não modelado: ${JSON.stringify(args)}`);
        }
        return cameras.map((c) => ({ id: c.id, retentionDays: c.retentionDays }));
      },
    },
    investigationItem: {
      findMany: async (args: any) => {
        guard();
        if (args?.where?.type === 'legal_hold') {
          const metadata: any = { enabled: true };
          if (options.holdRecordingIds?.length) metadata.recordingIds = options.holdRecordingIds;
          if (options.holdClipIds?.length) metadata.clipIds = options.holdClipIds;
          return options.holdRecordingIds?.length || options.holdClipIds?.length
            ? [{ investigationId: 'inv-1', metadata }]
            : [];
        }
        if (args?.where?.NOT?.type === 'legal_hold') {
          return (options.evidenceRecordingIds ?? []).map((id) => ({ recordingId: id, eventId: null, metadata: null }));
        }
        throw new Error(`fake investigationItem.findMany não modelado: ${JSON.stringify(args)}`);
      },
    },
    exportedClip: {
      findMany: async (args: any) => {
        guard();
        if (args?.where?.sourceRecordingId) {
          return clips
            .filter((c) => c.sourceRecordingId === args.where.sourceRecordingId)
            .map((c) => ({ id: c.id, filePath: c.filePath }));
        }
        if (args?.where?.id?.in) {
          return clips
            .filter((c) => args.where.id.in.includes(c.id))
            .map((c) => ({ sourceRecordingId: c.sourceRecordingId }));
        }
        if (args?.where?.startedAt && args?.orderBy) {
          stats.clipQueries += 1;
          const rows = clips
            .filter((c) => {
              if (!matchesDate(c.startedAt, args.where.startedAt)) return false;
              const source = store.get(c.sourceRecordingId);
              // Relação obrigatória no schema: sem origem, a linha não existiria.
              if (!source) return false;
              return matchesCameraId(source.cameraId, args.where.sourceRecording?.cameraId);
            })
            .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime() || a.id.localeCompare(b.id));
          const skip = args.skip ?? 0;
          const page = rows.slice(skip, skip + (args.take ?? rows.length));
          stats.clipRowsRead += page.length;
          return page.map((c) => (args.select ? project(c, args.select) : { ...c }));
        }
        throw new Error(`fake exportedClip.findMany não modelado: ${JSON.stringify(args)}`);
      },
      delete: async (args: any) => {
        const index = clips.findIndex((c) => c.id === args?.where?.id);
        if (index < 0) throw new Error(`P2025 (fake): clip ${args?.where?.id} não existe`);
        clips.splice(index, 1);
        deleteCalls.clips.push(args.where.id);
        return {};
      },
    },
    recording: {
      // `prisma.recording.fields` existe no cliente gerado (field refs) e é como
      // o serviço descobre se a coluna `motionScore` já foi migrada. Um cliente
      // ANTERIOR à migração não traz a chave — cenário exercitado adiante.
      fields: options.clienteSemMotionScore
        ? { id: {}, cameraId: {}, filePath: {}, startedAt: {}, sizeBytes: {} }
        : { id: {}, cameraId: {}, filePath: {}, startedAt: {}, sizeBytes: {}, motionScore: {} },
      findMany: async (args: any) => {
        guard();
        if (options.clienteSemMotionScore) {
          // O Prisma RECUSA a query inteira quando o argumento cita uma coluna
          // desconhecida — não devolve lista vazia, explode.
          const cita = JSON.stringify(args ?? {}).includes('motionScore');
          if (cita) throw new Error('Unknown arg `motionScore` (fake: cliente pré-migração)');
        }
        // Varredura de órfãos (derivados no disco) — outra passagem, não a
        // expiração; continua lendo id/cameraId/filePath de todas as linhas.
        if (args?.select && !args?.where && !args?.orderBy) {
          return [...store.values()].map((r) => project(r, args.select));
        }
        // Guardião de disco: pega as mais antigas sem hold.
        if (args?.orderBy && JSON.stringify(args.orderBy) === JSON.stringify({ startedAt: 'asc' })) {
          const rows = [...store.values()]
            .filter((r) => matchesRecording(r, args.where ?? {}))
            .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
            .slice(0, args.take ?? undefined);
          return rows.map((r) => (args.select ? project(r, args.select) : { ...r }));
        }
        stats.recordingQueries += 1;
        const rows = orderedRecordings(args?.where ?? {}, args?.orderBy);
        const skip = args?.skip ?? 0;
        const page = rows.slice(skip, skip + (args?.take ?? rows.length));
        stats.recordingRowsRead += page.length;
        if (!args?.select) throw new Error('fake: a expiração não pode hidratar a linha inteira (use select)');
        return page.map((r) => project(r, args.select));
      },
      count: async (args: any) => {
        guard();
        if (options.clienteSemMotionScore && JSON.stringify(args ?? {}).includes('motionScore')) {
          throw new Error('Unknown arg `motionScore` (fake: cliente pré-migração)');
        }
        return [...store.values()].filter((r) => matchesRecording(r, args?.where ?? {})).length;
      },
      delete: async (args: any) => {
        const id = args?.where?.id;
        if (!store.has(id)) throw new Error(`P2025 (fake): gravação ${id} não existe`);
        store.delete(id);
        // CASCADE real do schema (ExportedClip.sourceRecording onDelete: Cascade).
        for (let i = clips.length - 1; i >= 0; i -= 1) {
          if (clips[i].sourceRecordingId === id) clips.splice(i, 1);
        }
        deleteCalls.recordings.push(id);
        return {};
      },
    },
    cameraEvent: { deleteMany: async () => ({ count: 0 }) },
  };

  const svc: any = Object.create(RetentionService.prototype);
  svc.logger = {
    log: (m: string) => logs.push(`log:${m}`),
    warn: (m: string) => logs.push(`warn:${m}`),
    error: (m: string) => logs.push(`error:${m}`),
  };
  svc.config = {
    get: (key: string) => {
      if (key === 'recordingsRoot') return root;
      if (key === 'retentionDays') return options.globalDays ?? 7;
      return undefined;
    },
  };
  svc.prisma = prisma;
  svc.settings = { isAutoCleanupEnabled: async () => true, getDefaultRetentionDays: async () => 0 };

  return {
    svc,
    root,
    now,
    stats,
    logs,
    deleteCalls,
    file: (id: string) => files.get(id)!,
    remaining: () => [...store.keys()].sort(),
    remainingClips: () => clips.map((c) => c.id).sort(),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * REFERÊNCIA: a varredura completa como era antes — hidrata tudo e decide em
 * memória. É contra ela que a versão em lotes é comparada; se as duas
 * discordarem em UMA gravação, a otimização mudou a política de retenção.
 */
function esperadoPelaVarreduraCompleta(options: HarnessOptions, now: number) {
  const globalDays = options.globalDays ?? 7;
  const camerasById = new Map(options.cameras.map((c) => [c.id, c]));
  const protectedRecordings = new Set([...(options.holdRecordingIds ?? []), ...(options.evidenceRecordingIds ?? [])]);
  const protectedClips = new Set(options.holdClipIds ?? []);
  // Hold sobre clip protege a gravação de origem por transitividade.
  for (const clip of options.clips ?? []) {
    if (protectedClips.has(clip.id)) protectedRecordings.add(clip.sourceRecordingId);
  }

  const clipsApagados: string[] = [];
  const clipsPorGravacao = new Map<string, string[]>();
  for (const clip of options.clips ?? []) {
    const list = clipsPorGravacao.get(clip.sourceRecordingId) ?? [];
    list.push(clip.id);
    clipsPorGravacao.set(clip.sourceRecordingId, list);
  }
  const gravacaoPorId = new Map(options.recordings.map((r) => [r.id, r]));

  for (const clip of options.clips ?? []) {
    const source = gravacaoPorId.get(clip.sourceRecordingId);
    const days = (source ? camerasById.get(source.cameraId)?.retentionDays : undefined) ?? globalDays;
    if (!(now - clip.ageDays * DAY < now - days * DAY)) continue;
    if (protectedClips.has(clip.id)) continue;
    clipsApagados.push(clip.id);
  }

  const gravacoesApagadas: string[] = [];
  for (const rec of options.recordings) {
    const base = camerasById.get(rec.cameraId)?.retentionDays ?? globalDays;
    let allDays = base;
    let motionDays = base;
    if (process.env.RETENTION_TWO_TIER_ENABLED === 'true') {
      const all = Number(process.env.RETENTION_ALL_DAYS ?? 0);
      const motion = Number(process.env.RETENTION_MOTION_DAYS ?? 0);
      allDays = all > 0 ? all : base;
      motionDays = Math.max(allDays, motion > 0 ? motion : base);
    }
    const ageMs = rec.ageDays * DAY;
    const score = typeof rec.motionScore === 'number' && Number.isInteger(rec.motionScore) && rec.motionScore >= 0
      ? rec.motionScore
      : -1;
    let expirou: boolean;
    if (ageMs > motionDays * DAY) expirou = true;
    else if (ageMs <= allDays * DAY) expirou = false;
    else expirou = score === 0;
    if (!expirou) continue;
    if (protectedRecordings.has(rec.id)) continue;
    // Clip protegido segura a gravação inteira (o arquivo exportado é evidência).
    if ((clipsPorGravacao.get(rec.id) ?? []).some((id) => protectedClips.has(id))) continue;
    gravacoesApagadas.push(rec.id);
  }
  return { gravacoes: gravacoesApagadas.sort(), clips: clipsApagados.sort() };
}

const POLICY_KEYS = [
  'RETENTION_TWO_TIER_ENABLED',
  'RETENTION_TWO_TIER_DRY_RUN',
  'RETENTION_ALL_DAYS',
  'RETENTION_MOTION_DAYS',
  'RETENTION_EXPIRY_BATCH_SIZE',
  'RETENTION_MAX_DELETIONS_PER_CYCLE',
] as const;

function setEnv(env: Partial<Record<(typeof POLICY_KEYS)[number], string>>) {
  for (const key of POLICY_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
}
function clearEnv() {
  for (const key of POLICY_KEYS) delete process.env[key];
}

/** Acervo variado e determinístico: câmeras com cortes diferentes, idades em
 *  volta da fronteira, atividade conhecida/desconhecida/ausente e órfã. */
function acervoVariado(): HarnessOptions {
  const cameras: SeedCamera[] = [
    { id: 'cam-curta', retentionDays: 3 },
    { id: 'cam-padrao', retentionDays: 7 },
    { id: 'cam-longa', retentionDays: 30 },
    { id: 'cam-herda', retentionDays: undefined },
  ];
  const recordings: SeedRecording[] = [];
  let seed = 42;
  const proximo = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const idades = [0.5, 1, 2.5, 3.5, 6.9, 7.1, 8, 12, 29.5, 31, 45, 120];
  for (const camera of cameras) {
    for (let i = 0; i < idades.length; i += 1) {
      const sorteio = proximo();
      const motionScore = sorteio < 0.3 ? 0 : sorteio < 0.6 ? -1 : sorteio < 0.8 ? undefined : Math.ceil(sorteio * 9);
      recordings.push({
        id: `${camera.id}-${i}`,
        cameraId: camera.id,
        ageDays: idades[i],
        motionScore,
        sizeBytes: 1_000 + i,
      });
    }
  }
  // Gravação cuja câmera sumiu do cadastro: cai no corte GLOBAL.
  // Nenhuma idade do cenário cai EXATAMENTE sobre um corte (2, 3, 7 ou 30 dias):
  // o `now` do serviço é lido milissegundos depois do seed, e a fronteira exata
  // é travada no teste próprio de fronteira, não aqui.
  recordings.push({ id: 'orfa-nova', cameraId: 'cam-fantasma', ageDays: 1.5, motionScore: 0 });
  recordings.push({ id: 'orfa-velha', cameraId: 'cam-fantasma', ageDays: 40, motionScore: 0 });
  return {
    globalDays: 7,
    cameras,
    recordings,
    clips: [
      { id: 'clip-velho', sourceRecordingId: 'cam-padrao-11', ageDays: 100 },
      { id: 'clip-novo', sourceRecordingId: 'cam-padrao-0', ageDays: 0.5 },
      { id: 'clip-curto-velho', sourceRecordingId: 'cam-curta-5', ageDays: 5 },
      { id: 'clip-longo-vivo', sourceRecordingId: 'cam-longa-8', ageDays: 20 },
    ],
    holdRecordingIds: ['cam-longa-11'],
    evidenceRecordingIds: ['cam-padrao-7'],
    holdClipIds: ['clip-velho'],
  };
}

// ── 1. EQUIVALÊNCIA com a varredura completa ─────────────────────────────────

test('lotes apagam EXATAMENTE o mesmo conjunto que a varredura completa (flag off)', async () => {
  clearEnv();
  const seed = acervoVariado();
  const h = buildHarness(seed);
  try {
    const esperado = esperadoPelaVarreduraCompleta(seed, h.now);
    const result = await h.svc.handleRetention('teste');
    assert.deepEqual([...h.deleteCalls.recordings].sort(), esperado.gravacoes, 'conjunto de gravações apagadas divergiu');
    assert.deepEqual([...h.deleteCalls.clips].sort(), esperado.clips, 'conjunto de clips apagados divergiu');
    assert.equal(result.recordingsDeleted, esperado.gravacoes.length);
    assert.equal(result.clipsDeleted, esperado.clips.length);
    assert.ok(esperado.gravacoes.length > 5, 'o cenário precisa ter substância');
  } finally {
    h.dispose();
  }
});

test('lotes apagam o mesmo conjunto com a retenção em DOIS NÍVEIS ligada', async () => {
  setEnv({
    RETENTION_TWO_TIER_ENABLED: 'true',
    RETENTION_TWO_TIER_DRY_RUN: 'false',
    RETENTION_ALL_DAYS: '2',
    RETENTION_MOTION_DAYS: '30',
  });
  const seed = acervoVariado();
  const h = buildHarness(seed);
  try {
    const esperado = esperadoPelaVarreduraCompleta(seed, h.now);
    await h.svc.handleRetention('teste');
    assert.deepEqual([...h.deleteCalls.recordings].sort(), esperado.gravacoes);
    assert.deepEqual([...h.deleteCalls.clips].sort(), esperado.clips);
  } finally {
    clearEnv();
    h.dispose();
  }
});

test('o tamanho do lote NÃO muda o resultado (1, 3 ou 500 por vez)', async () => {
  const seed = acervoVariado();
  const conjuntos: string[][] = [];
  for (const tamanho of ['1', '3', '500']) {
    setEnv({ RETENTION_EXPIRY_BATCH_SIZE: tamanho });
    const h = buildHarness(seed);
    try {
      await h.svc.handleRetention('teste');
      conjuntos.push([...h.deleteCalls.recordings].sort());
    } finally {
      h.dispose();
    }
  }
  clearEnv();
  assert.deepEqual(conjuntos[0], conjuntos[1], 'lote de 1 divergiu do lote de 3');
  assert.deepEqual(conjuntos[1], conjuntos[2], 'lote de 3 divergiu do lote de 500');
  assert.ok(conjuntos[0].length > 5);
});

// ── 2. Proteções continuam acima de tudo ─────────────────────────────────────

test('gravação protegida no meio do lote não é apagada NEM trava a paginação', async () => {
  // As 4 mais antigas estão protegidas: sem `skip`, a página seguinte devolveria
  // eternamente as mesmas linhas e a expiração nunca alcançaria a quinta.
  setEnv({ RETENTION_EXPIRY_BATCH_SIZE: '2' });
  const seed: HarnessOptions = {
    globalDays: 7,
    cameras: [{ id: 'cam-1', retentionDays: 7 }],
    recordings: [
      { id: 'p1', cameraId: 'cam-1', ageDays: 100, motionScore: 0 },
      { id: 'p2', cameraId: 'cam-1', ageDays: 90, motionScore: 0 },
      { id: 'p3', cameraId: 'cam-1', ageDays: 80, motionScore: 0 },
      { id: 'p4', cameraId: 'cam-1', ageDays: 70, motionScore: 0 },
      { id: 'livre', cameraId: 'cam-1', ageDays: 60, motionScore: 0 },
      { id: 'nova', cameraId: 'cam-1', ageDays: 1, motionScore: 0 },
    ],
    holdRecordingIds: ['p1', 'p2'],
    evidenceRecordingIds: ['p3', 'p4'],
  };
  const h = buildHarness(seed);
  try {
    const result = await h.svc.handleRetention('teste');
    assert.deepEqual(h.deleteCalls.recordings, ['livre'], 'só a gravação sem proteção pode morrer');
    assert.equal(result.recordingsDeleted, 1);
    assert.deepEqual(h.remaining(), ['nova', 'p1', 'p2', 'p3', 'p4']);
    for (const id of ['p1', 'p2', 'p3', 'p4']) assert.equal(existsSync(h.file(id)), true, `${id} sumiu do disco`);
  } finally {
    clearEnv();
    h.dispose();
  }
});

test('clip em investigação segura o clip E a gravação de origem, mesmo em lotes', async () => {
  setEnv({ RETENTION_EXPIRY_BATCH_SIZE: '1' });
  const seed: HarnessOptions = {
    globalDays: 7,
    cameras: [{ id: 'cam-1', retentionDays: 7 }],
    recordings: [
      { id: 'origem', cameraId: 'cam-1', ageDays: 400, motionScore: 0 },
      { id: 'outra', cameraId: 'cam-1', ageDays: 400, motionScore: 0 },
    ],
    clips: [{ id: 'clip-1', sourceRecordingId: 'origem', ageDays: 400 }],
    holdClipIds: ['clip-1'],
  };
  const h = buildHarness(seed);
  try {
    await h.svc.handleRetention('teste');
    assert.deepEqual(h.deleteCalls.recordings, ['outra']);
    assert.deepEqual(h.deleteCalls.clips, [], 'o clip protegido não pode morrer');
    assert.equal(existsSync(h.file('origem')), true);
    assert.equal(existsSync(h.file('clip-1')), true);
  } finally {
    clearEnv();
    h.dispose();
  }
});

// ── 3. Teto por ciclo ────────────────────────────────────────────────────────

test('teto por ciclo limita o estrago e o ciclo seguinte continua de onde parou', async () => {
  setEnv({ RETENTION_MAX_DELETIONS_PER_CYCLE: '3', RETENTION_EXPIRY_BATCH_SIZE: '2' });
  const seed: HarnessOptions = {
    globalDays: 7,
    cameras: [{ id: 'cam-1', retentionDays: 7 }],
    recordings: Array.from({ length: 8 }, (_, i) => ({
      id: `r${i}`,
      cameraId: 'cam-1',
      ageDays: 100 - i,
      motionScore: 0,
    })),
  };
  const h = buildHarness(seed);
  try {
    const primeiro = await h.svc.handleRetention('teste');
    assert.equal(primeiro.recordingsDeleted, 3, 'o teto por ciclo tem que valer');
    assert.deepEqual(h.deleteCalls.recordings, ['r0', 'r1', 'r2'], 'as MAIS ANTIGAS primeiro');
    assert.ok(
      h.logs.some((l) => l.startsWith('warn:') && /teto/i.test(l)),
      'atingir o teto sem avisar é a mesma falha silenciosa de sempre',
    );

    const segundo = await h.svc.handleRetention('teste');
    assert.equal(segundo.recordingsDeleted, 3, 'o ciclo seguinte continua');
    assert.deepEqual(h.deleteCalls.recordings.slice(3), ['r3', 'r4', 'r5']);

    await h.svc.handleRetention('teste');
    assert.deepEqual(h.remaining(), [], 'em três ciclos o acervo expirado acaba');
  } finally {
    clearEnv();
    h.dispose();
  }
});

// ── 4. CUSTO: o que a mudança existe para provar ─────────────────────────────

test('custo: hidrata o que EXPIRA, não o acervo', async () => {
  clearEnv();
  const cameras: SeedCamera[] = Array.from({ length: 12 }, (_, i) => ({ id: `cam-${i}`, retentionDays: 7 }));
  const recordings: SeedRecording[] = [];
  for (const camera of cameras) {
    // 200 segmentos por câmera: 198 dentro da retenção, 2 expirados.
    for (let i = 0; i < 198; i += 1) {
      recordings.push({ id: `${camera.id}-viva-${i}`, cameraId: camera.id, ageDays: 1 + i / 400, motionScore: 0 });
    }
    for (let i = 0; i < 2; i += 1) {
      recordings.push({ id: `${camera.id}-velha-${i}`, cameraId: camera.id, ageDays: 30 + i, motionScore: 0 });
    }
  }
  const h = buildHarness({ globalDays: 7, cameras, recordings });
  try {
    const acervo = recordings.length;
    const expiram = 12 * 2;
    const result = await h.svc.handleRetention('teste');
    assert.equal(result.recordingsDeleted, expiram, 'apagou o que tinha que apagar');
    assert.ok(
      h.stats.recordingRowsRead <= expiram * 2,
      `hidratou ${h.stats.recordingRowsRead} linhas para expirar ${expiram} de um acervo de ${acervo} — `
      + 'o custo voltou a acompanhar o ACERVO',
    );
    // Registro do ganho, para quem for ler o log do teste:
    console.log(
      `[custo] acervo=${acervo} expiradas=${expiram} linhas hidratadas=${h.stats.recordingRowsRead} `
      + `(varredura completa hidrataria ${acervo}) queries=${h.stats.recordingQueries}`,
    );
  } finally {
    h.dispose();
  }
});

test('custo: acervo 10× maior com o MESMO tanto expirando não cobra 10× mais', async () => {
  clearEnv();
  const medir = async (segmentosPorCamera: number) => {
    const cameras: SeedCamera[] = [{ id: 'cam-1', retentionDays: 7 }];
    const recordings: SeedRecording[] = [];
    for (let i = 0; i < segmentosPorCamera; i += 1) {
      recordings.push({ id: `viva-${i}`, cameraId: 'cam-1', ageDays: 1 + i / 1000, motionScore: 0 });
    }
    for (let i = 0; i < 5; i += 1) {
      recordings.push({ id: `velha-${i}`, cameraId: 'cam-1', ageDays: 50 + i, motionScore: 0 });
    }
    const h = buildHarness({ globalDays: 7, cameras, recordings });
    try {
      await h.svc.handleRetention('teste');
      return h.stats.recordingRowsRead;
    } finally {
      h.dispose();
    }
  };
  const pequeno = await medir(50);
  const grande = await medir(500);
  assert.equal(pequeno, grande, `custo cresceu com o acervo: ${pequeno} → ${grande}`);
});

// ── 5. Dois níveis: contagem do que foi RETIDO continua saindo ───────────────

test('dois níveis: motionRetained continua sendo contado sem varrer o acervo', async () => {
  setEnv({
    RETENTION_TWO_TIER_ENABLED: 'true',
    RETENTION_TWO_TIER_DRY_RUN: 'false',
    RETENTION_ALL_DAYS: '2',
    RETENTION_MOTION_DAYS: '30',
  });
  const seed: HarnessOptions = {
    globalDays: 7,
    cameras: [{ id: 'cam-1', retentionDays: 7 }],
    recordings: [
      { id: 'com-movimento', cameraId: 'cam-1', ageDays: 10, motionScore: 4 },
      { id: 'desconhecida', cameraId: 'cam-1', ageDays: 10, motionScore: -1 },
      { id: 'sem-coluna', cameraId: 'cam-1', ageDays: 10 },
      { id: 'vazia', cameraId: 'cam-1', ageDays: 10, motionScore: 0 },
      { id: 'nova', cameraId: 'cam-1', ageDays: 1, motionScore: 5 },
    ],
  };
  const h = buildHarness(seed);
  try {
    const result = await h.svc.handleRetention('teste');
    assert.deepEqual(h.deleteCalls.recordings, ['vazia'], 'só o que SABEMOS ser vazio morre no corte curto');
    assert.equal(result.motionRetained, 3, 'com movimento + desconhecida + sem coluna');
    assert.equal(result.recordingsDeleted, 1);
  } finally {
    clearEnv();
    h.dispose();
  }
});

test('dois níveis em DRY-RUN não apaga nada e continua contando o que apagaria', async () => {
  setEnv({
    RETENTION_TWO_TIER_ENABLED: 'true',
    RETENTION_TWO_TIER_DRY_RUN: 'true',
    RETENTION_ALL_DAYS: '2',
    RETENTION_MOTION_DAYS: '30',
    RETENTION_EXPIRY_BATCH_SIZE: '2',
  });
  const seed: HarnessOptions = {
    globalDays: 7,
    cameras: [{ id: 'cam-1', retentionDays: 7 }],
    recordings: [
      { id: 'vazia-1', cameraId: 'cam-1', ageDays: 10, motionScore: 0, sizeBytes: 1_000 },
      { id: 'vazia-2', cameraId: 'cam-1', ageDays: 11, motionScore: 0, sizeBytes: 2_000 },
      { id: 'antiga', cameraId: 'cam-1', ageDays: 90, motionScore: 9, sizeBytes: 4_000 },
      { id: 'protegida', cameraId: 'cam-1', ageDays: 90, motionScore: 0, sizeBytes: 8_000 },
    ],
    holdRecordingIds: ['protegida'],
  };
  const h = buildHarness(seed);
  try {
    const result = await h.svc.handleRetention('teste');
    assert.deepEqual(h.deleteCalls.recordings, [], 'DRY-RUN não pode chamar delete');
    assert.equal(result.recordingsWouldDelete, 3);
    assert.equal(result.wouldFreeBytes, 7_000, 'a protegida não entra na conta');
    assert.equal(result.recordingsDeleted, 0);
  } finally {
    clearEnv();
    h.dispose();
  }
});

// ── 6. Casos de borda do agrupamento por câmera ──────────────────────────────

test('gravação de câmera EXCLUÍDA do cadastro cai no corte global (não fica imortal)', async () => {
  clearEnv();
  const seed: HarnessOptions = {
    globalDays: 7,
    cameras: [{ id: 'cam-viva', retentionDays: 30 }],
    recordings: [
      { id: 'orfa-velha', cameraId: 'cam-sumida', ageDays: 40, motionScore: 0 },
      { id: 'orfa-nova', cameraId: 'cam-sumida', ageDays: 2, motionScore: 0 },
      { id: 'viva-velha', cameraId: 'cam-viva', ageDays: 40, motionScore: 0 },
      { id: 'viva-meio', cameraId: 'cam-viva', ageDays: 20, motionScore: 0 },
    ],
  };
  const h = buildHarness(seed);
  try {
    await h.svc.handleRetention('teste');
    assert.deepEqual(
      [...h.deleteCalls.recordings].sort(),
      ['orfa-velha', 'viva-velha'],
      'órfã usa o corte global (7d); a câmera viva mantém o dela (30d)',
    );
  } finally {
    h.dispose();
  }
});

test('cadastro de câmeras VAZIO: tudo cai no corte global', async () => {
  clearEnv();
  const h = buildHarness({
    globalDays: 7,
    cameras: [],
    recordings: [
      { id: 'velha', cameraId: 'cam-x', ageDays: 40, motionScore: 0 },
      { id: 'nova', cameraId: 'cam-x', ageDays: 2, motionScore: 0 },
    ],
  });
  try {
    await h.svc.handleRetention('teste');
    assert.deepEqual(h.deleteCalls.recordings, ['velha']);
  } finally {
    h.dispose();
  }
});

test('a fronteira do corte continua ESTRITA (idade == corte não expira)', async () => {
  clearEnv();
  const h = buildHarness({
    globalDays: 7,
    cameras: [{ id: 'cam-1', retentionDays: 7 }],
    recordings: [
      { id: 'passou', cameraId: 'cam-1', ageDays: 7.001, motionScore: 0 },
      { id: 'dentro', cameraId: 'cam-1', ageDays: 6.999, motionScore: 0 },
    ],
  });
  try {
    await h.svc.handleRetention('teste');
    assert.deepEqual(h.deleteCalls.recordings, ['passou']);
  } finally {
    h.dispose();
  }
});

test('cliente Prisma PRÉ-migração: sem a coluna, tudo vira quarentena (e a retenção não quebra)', async () => {
  // Filtrar por uma coluna que o cliente gerado não conhece faz o Prisma RECUSAR
  // a query inteira — a retenção pararia de rodar e o disco encheria em silêncio.
  // O caminho seguro é o mesmo da varredura antiga: sem sinal de atividade, todo
  // segmento é DESCONHECIDO e só morre no corte LONGO.
  setEnv({
    RETENTION_TWO_TIER_ENABLED: 'true',
    RETENTION_TWO_TIER_DRY_RUN: 'false',
    RETENTION_ALL_DAYS: '2',
    RETENTION_MOTION_DAYS: '30',
  });
  const h = buildHarness({
    globalDays: 7,
    cameras: [{ id: 'cam-1', retentionDays: 7 }],
    recordings: [
      { id: 'vazia-no-meio', cameraId: 'cam-1', ageDays: 10, motionScore: 0 },
      { id: 'antiga', cameraId: 'cam-1', ageDays: 40, motionScore: 0 },
      { id: 'nova', cameraId: 'cam-1', ageDays: 1, motionScore: 0 },
    ],
    clienteSemMotionScore: true,
  });
  try {
    const result = await h.svc.handleRetention('teste');
    assert.deepEqual(h.deleteCalls.recordings, ['antiga'], 'só o corte LONGO expira sem a coluna');
    assert.equal(existsSync(h.file('vazia-no-meio')), true, 'sem sinal de atividade, quarentena');
    assert.equal(result.motionRetained, 1, 'a faixa inteira conta como retida por movimento');
    assert.ok(
      h.logs.some((l) => l.startsWith('warn:') && /motionScore/.test(l)),
      'o operador precisa saber que o cliente está desatualizado',
    );
  } finally {
    clearEnv();
    h.dispose();
  }
});

test('limpeza automática desligada continua abortando a passagem inteira', async () => {
  clearEnv();
  const h = buildHarness({
    globalDays: 7,
    cameras: [{ id: 'cam-1', retentionDays: 7 }],
    recordings: [{ id: 'velha', cameraId: 'cam-1', ageDays: 400, motionScore: 0 }],
  });
  h.svc.settings.isAutoCleanupEnabled = async () => false;
  try {
    const result = await h.svc.handleRetention('teste');
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'auto_cleanup_disabled');
    assert.deepEqual(h.deleteCalls.recordings, []);
    assert.equal(h.stats.recordingQueries, 0, 'nem consultar o banco deveria');
  } finally {
    h.dispose();
  }
});
