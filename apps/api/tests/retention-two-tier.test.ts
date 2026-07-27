import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RetentionService } from '../src/recordings/retention.service';

// ─────────────────────────────────────────────────────────────────────────────
// Retenção em DOIS NÍVEIS (ideia derivada do Frigate, MIT):
//   corte curto  = "N dias de TUDO"
//   corte longo  = "M dias do que teve MOVIMENTO"  (M >= N)
//
// O que estes testes travam — e que vale mais que a feature:
//  · motionScore === -1 (DESCONHECIDO) NUNCA expira no corte curto. Gravação
//    cuja atividade não sabemos é tratada como se tivesse movimento. Apagar de
//    menos custa disco; apagar de mais é irreversível e pode destruir prova.
//  · dry-run não apaga NADA (contamos as chamadas de delete, não só os arquivos).
//  · flag desligada = comportamento atual byte a byte (inclusive o formato do
//    resultado que vai para o log e a fronteira exata do corte).
//  · investigação/legal hold vence os DOIS cortes.
// ─────────────────────────────────────────────────────────────────────────────

const DAY = 86_400_000;

// O guardião de disco é ortogonal a este teste e depende do disco REAL da
// máquina; empurramos o gatilho para o teto para que ele nunca dispare aqui.
process.env.RETENTION_DISK_TRIGGER_PERCENT = '99';

type SeedRecording = {
  id: string;
  ageDays: number;
  /** `undefined` = coluna ausente (banco/cliente Prisma anterior à migração). */
  motionScore?: number;
  cameraRetentionDays?: number;
  sizeBytes?: number;
};

type SeedClip = { id: string; sourceRecordingId: string; ageDays: number };

type HarnessOptions = {
  globalDays?: number;
  clips?: SeedClip[];
  /** IDs em legal_hold ativo. */
  holdRecordingIds?: string[];
  /** IDs anexados a uma investigação (evidência sem hold explícito). */
  evidenceRecordingIds?: string[];
};

type Harness = {
  svc: any;
  root: string;
  recordingFile: (id: string) => string;
  clipFile: (id: string) => string;
  deleteCalls: { recordings: string[]; clips: string[] };
  logs: string[];
  dispose: () => void;
};

/**
 * Fake do Prisma modelado no schema REAL:
 *  · `recording.findMany({ include: { camera } })` devolve os escalares + a
 *    relação, ordenado por `startedAt asc` (como a query real);
 *  · `recording.delete` explode quando o id não existe (P2025) e faz o CASCADE
 *    de `ExportedClip.sourceRecording` (onDelete: Cascade no schema);
 *  · toda forma de query NÃO modelada explode — um fake que responde a
 *    qualquer coisa é um fake que mente.
 */
function buildHarness(seed: SeedRecording[], options: HarnessOptions = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'drac-ret2-'));
  const now = Date.now();
  const cameras = new Map<string, { retentionDays: number }>();
  const store = new Map<string, any>();
  const recordingFiles = new Map<string, string>();
  const clipFiles = new Map<string, string>();
  const clips: any[] = [];
  const deleteCalls = { recordings: [] as string[], clips: [] as string[] };
  const logs: string[] = [];

  for (const item of seed) {
    const cameraId = `cam-${item.id}`;
    cameras.set(cameraId, { retentionDays: item.cameraRetentionDays ?? 7 });
    mkdirSync(join(root, cameraId), { recursive: true });
    const relative = join(cameraId, `${item.id}.mp4`);
    const full = join(root, relative);
    writeFileSync(full, 'video');
    recordingFiles.set(item.id, full);
    const row: any = {
      id: item.id,
      cameraId,
      filePath: relative,
      startedAt: new Date(now - item.ageDays * DAY),
      endedAt: new Date(now - item.ageDays * DAY + 60_000),
      durationSeconds: 60,
      sizeBytes: BigInt(item.sizeBytes ?? 0),
      source: 'UNKNOWN',
      triggerMode: 'continuous',
      createdAt: new Date(now - item.ageDays * DAY),
    };
    // Só existe a coluna quando o seed a define: assim conseguimos exercitar o
    // banco PRÉ-migração (campo ausente ⇒ DESCONHECIDO).
    if (item.motionScore !== undefined) row.motionScore = item.motionScore;
    store.set(item.id, row);
  }

  for (const clip of options.clips ?? []) {
    const source = store.get(clip.sourceRecordingId);
    if (!source) throw new Error(`seed inválido: clip ${clip.id} sem gravação de origem`);
    const relative = join(source.cameraId, `${clip.id}.clip.mp4`);
    const full = join(root, relative);
    writeFileSync(full, 'clip');
    clipFiles.set(clip.id, full);
    clips.push({
      id: clip.id,
      cameraId: source.cameraId,
      sourceRecordingId: clip.sourceRecordingId,
      filePath: relative,
      startedAt: new Date(now - clip.ageDays * DAY),
    });
  }

  const holdRows = (options.holdRecordingIds ?? []).length
    ? [{ investigationId: 'inv-1', metadata: { enabled: true, recordingIds: options.holdRecordingIds } }]
    : [];
  const evidenceRows = (options.evidenceRecordingIds ?? []).map((id, index) => ({
    recordingId: id,
    eventId: null,
    metadata: null,
    __index: index,
  }));

  const sorted = () => [...store.values()].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const project = (row: any, select: Record<string, boolean>) => {
    const out: any = {};
    for (const key of Object.keys(select)) out[key] = row[key];
    return out;
  };

  const prisma = {
    investigationItem: {
      findMany: async (args: any) => {
        if (args?.where?.type === 'legal_hold') return holdRows.map((r) => ({ ...r }));
        if (args?.where?.NOT?.type === 'legal_hold') return evidenceRows.map((r) => ({ ...r }));
        throw new Error(`fake investigationItem.findMany não modelado: ${JSON.stringify(args)}`);
      },
    },
    exportedClip: {
      findMany: async (args: any) => {
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
        if (!args?.where && args?.include?.sourceRecording) {
          return clips
            .map((c) => {
              const source = store.get(c.sourceRecordingId);
              return {
                ...c,
                sourceRecording: source
                  ? { ...source, camera: cameras.get(source.cameraId) }
                  : null,
              };
            })
            .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
        }
        throw new Error(`fake exportedClip.findMany não modelado: ${JSON.stringify(args)}`);
      },
      delete: async (args: any) => {
        const id = args?.where?.id;
        const index = clips.findIndex((c) => c.id === id);
        if (index < 0) throw new Error(`P2025 (fake): clip ${id} não existe`);
        clips.splice(index, 1);
        deleteCalls.clips.push(id);
        return {};
      },
    },
    recording: {
      findMany: async (args: any) => {
        let rows = sorted();
        const notIn = args?.where?.id?.notIn;
        if (notIn) rows = rows.filter((r) => !notIn.includes(r.id));
        else if (args?.where && Object.keys(args.where).length) {
          throw new Error(`fake recording.findMany where não modelado: ${JSON.stringify(args.where)}`);
        }
        if (typeof args?.take === 'number') rows = rows.slice(0, args.take);
        if (args?.select) return rows.map((r) => project(r, args.select));
        if (args?.include?.camera) {
          return rows.map((r) => ({ ...r, camera: { ...cameras.get(r.cameraId) } }));
        }
        throw new Error(`fake recording.findMany não modelado: ${JSON.stringify(args)}`);
      },
      delete: async (args: any) => {
        const id = args?.where?.id;
        if (!store.has(id)) throw new Error(`P2025 (fake): gravação ${id} não existe`);
        store.delete(id);
        // CASCADE real do schema: ExportedClip.sourceRecording onDelete: Cascade.
        for (let i = clips.length - 1; i >= 0; i -= 1) {
          if (clips[i].sourceRecordingId === id) clips.splice(i, 1);
        }
        deleteCalls.recordings.push(id);
        return {};
      },
    },
    cameraEvent: {
      deleteMany: async () => ({ count: 0 }),
    },
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
  svc.settings = {
    isAutoCleanupEnabled: async () => true,
    getDefaultRetentionDays: async () => 0,
  };

  return {
    svc,
    root,
    recordingFile: (id: string) => recordingFiles.get(id)!,
    clipFile: (id: string) => clipFiles.get(id)!,
    deleteCalls,
    logs,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

const POLICY_KEYS = [
  'RETENTION_TWO_TIER_ENABLED',
  'RETENTION_TWO_TIER_DRY_RUN',
  'RETENTION_ALL_DAYS',
  'RETENTION_MOTION_DAYS',
] as const;

function setPolicyEnv(env: Partial<Record<(typeof POLICY_KEYS)[number], string>>) {
  for (const key of POLICY_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
}

function clearPolicyEnv() {
  for (const key of POLICY_KEYS) delete process.env[key];
}

// ── 1. QUARENTENA: o desconhecido não morre no corte curto ───────────────────

test('dois níveis: motionScore = -1 (DESCONHECIDO) NUNCA expira no corte curto', async () => {
  setPolicyEnv({
    RETENTION_TWO_TIER_ENABLED: 'true',
    RETENTION_TWO_TIER_DRY_RUN: 'false',
    RETENTION_ALL_DAYS: '2',
    RETENTION_MOTION_DAYS: '30',
  });
  const h = buildHarness([
    { id: 'desconhecido', ageDays: 10, motionScore: -1 },
    { id: 'sem-coluna', ageDays: 10 }, // banco pré-migração: campo ausente
    { id: 'sem-movimento', ageDays: 10, motionScore: 0 },
  ]);
  try {
    const result = await h.svc.handleRetention('teste');
    assert.deepEqual(h.deleteCalls.recordings, ['sem-movimento'], 'só o que SABEMOS ser vazio pode morrer cedo');
    assert.equal(existsSync(h.recordingFile('desconhecido')), true, 'motionScore=-1 entra em QUARENTENA, não é apagado');
    assert.equal(existsSync(h.recordingFile('sem-coluna')), true, 'coluna ausente = DESCONHECIDO = quarentena');
    assert.equal(existsSync(h.recordingFile('sem-movimento')), false);
    assert.equal(result.recordingsDeleted, 1);
    assert.equal(result.motionRetained, 2, 'as duas gravações em quarentena devem ser contabilizadas');
  } finally {
    clearPolicyEnv();
    h.dispose();
  }
});

test('dois níveis: o DESCONHECIDO também não é imortal — morre no corte longo', async () => {
  setPolicyEnv({
    RETENTION_TWO_TIER_ENABLED: 'true',
    RETENTION_TWO_TIER_DRY_RUN: 'false',
    RETENTION_ALL_DAYS: '2',
    RETENTION_MOTION_DAYS: '30',
  });
  const h = buildHarness([
    { id: 'antigo', ageDays: 45, motionScore: -1 },
    { id: 'recente', ageDays: 10, motionScore: -1 },
  ]);
  try {
    await h.svc.handleRetention('teste');
    assert.deepEqual(h.deleteCalls.recordings, ['antigo']);
    assert.equal(existsSync(h.recordingFile('recente')), true);
  } finally {
    clearPolicyEnv();
    h.dispose();
  }
});

// ── 2. Os dois cortes ────────────────────────────────────────────────────────

test('dois níveis: motionScore > 0 sobrevive ao corte curto e morre no corte longo', async () => {
  setPolicyEnv({
    RETENTION_TWO_TIER_ENABLED: 'true',
    RETENTION_TWO_TIER_DRY_RUN: 'false',
    RETENTION_ALL_DAYS: '3',
    RETENTION_MOTION_DAYS: '30',
  });
  const h = buildHarness([
    { id: 'movimento-antigo', ageDays: 40, motionScore: 7 },
    { id: 'movimento-recente', ageDays: 10, motionScore: 7 },
    { id: 'vazio-recente', ageDays: 10, motionScore: 0 },
    { id: 'vazio-dentro-do-curto', ageDays: 1, motionScore: 0 },
  ]);
  try {
    const result = await h.svc.handleRetention('teste');
    assert.deepEqual(
      [...h.deleteCalls.recordings].sort(),
      ['movimento-antigo', 'vazio-recente'],
      'corte longo mata tudo; corte curto mata só o que teve 0 movimento',
    );
    assert.equal(existsSync(h.recordingFile('movimento-recente')), true);
    assert.equal(existsSync(h.recordingFile('vazio-dentro-do-curto')), true);
    assert.equal(result.recordingsDeleted, 2);
  } finally {
    clearPolicyEnv();
    h.dispose();
  }
});

test('dois níveis: corte de movimento NUNCA pode ser menor que o corte de tudo', async () => {
  // Configuração invertida (movimento=1 < tudo=10): se o serviço obedecesse ao
  // literal, uma gravação COM movimento morreria ANTES de uma sem movimento.
  setPolicyEnv({
    RETENTION_TWO_TIER_ENABLED: 'true',
    RETENTION_TWO_TIER_DRY_RUN: 'false',
    RETENTION_ALL_DAYS: '10',
    RETENTION_MOTION_DAYS: '1',
  });
  const h = buildHarness([
    { id: 'com-movimento', ageDays: 5, motionScore: 4 },
    { id: 'sem-movimento', ageDays: 5, motionScore: 0 },
  ]);
  try {
    await h.svc.handleRetention('teste');
    assert.deepEqual(h.deleteCalls.recordings, [], 'ambas estão dentro do corte de 10 dias: nada morre');
    assert.equal(existsSync(h.recordingFile('com-movimento')), true);
    assert.equal(existsSync(h.recordingFile('sem-movimento')), true);
  } finally {
    clearPolicyEnv();
    h.dispose();
  }
});

test('dois níveis: sem override, cada câmera mantém o próprio corte como base', async () => {
  setPolicyEnv({
    RETENTION_TWO_TIER_ENABLED: 'true',
    RETENTION_TWO_TIER_DRY_RUN: 'false',
    RETENTION_MOTION_DAYS: '60',
  });
  const h = buildHarness([
    { id: 'curta-vazia', ageDays: 5, motionScore: 0, cameraRetentionDays: 3 },
    { id: 'longa-vazia', ageDays: 5, motionScore: 0, cameraRetentionDays: 30 },
  ]);
  try {
    await h.svc.handleRetention('teste');
    assert.deepEqual(h.deleteCalls.recordings, ['curta-vazia'], 'o corte de TUDO herda retentionDays da câmera');
  } finally {
    clearPolicyEnv();
    h.dispose();
  }
});

// ── 3. DRY-RUN ───────────────────────────────────────────────────────────────

test('dois níveis: DRY-RUN conta e loga, mas não chama delete nem toca no disco', async () => {
  setPolicyEnv({
    RETENTION_TWO_TIER_ENABLED: 'true',
    RETENTION_TWO_TIER_DRY_RUN: 'true',
    RETENTION_ALL_DAYS: '2',
    RETENTION_MOTION_DAYS: '30',
  });
  const h = buildHarness([
    { id: 'vazio', ageDays: 10, motionScore: 0, sizeBytes: 1_000 },
    { id: 'muito-antigo', ageDays: 90, motionScore: 5, sizeBytes: 2_000 },
    { id: 'quarentena', ageDays: 10, motionScore: -1, sizeBytes: 4_000 },
  ]);
  try {
    const result = await h.svc.handleRetention('teste');
    assert.deepEqual(h.deleteCalls.recordings, [], 'DRY-RUN não pode chamar prisma.recording.delete NENHUMA vez');
    for (const id of ['vazio', 'muito-antigo', 'quarentena']) {
      assert.equal(existsSync(h.recordingFile(id)), true, `${id} deveria continuar no disco`);
    }
    assert.equal(result.recordingsDeleted, 0);
    assert.equal(result.recordingsWouldDelete, 2, 'contaria vazio + muito-antigo');
    assert.equal(result.wouldFreeBytes, 3_000);
    assert.ok(
      h.logs.some((l) => l.startsWith('warn:') && l.includes('DRY-RUN')),
      'o operador precisa ver no log que a retenção por idade está apenas simulada',
    );
  } finally {
    clearPolicyEnv();
    h.dispose();
  }
});

test('dois níveis: DRY-RUN é o padrão quando a flag é ligada sem opt-in explícito', async () => {
  setPolicyEnv({
    RETENTION_TWO_TIER_ENABLED: 'true',
    RETENTION_ALL_DAYS: '2',
    RETENTION_MOTION_DAYS: '30',
  });
  const h = buildHarness([{ id: 'vazio', ageDays: 10, motionScore: 0 }]);
  try {
    const result = await h.svc.handleRetention('teste');
    assert.deepEqual(h.deleteCalls.recordings, [], 'ninguém liga isso no escuro: sem RETENTION_TWO_TIER_DRY_RUN=false, não apaga');
    assert.equal(result.recordingsWouldDelete, 1);
  } finally {
    clearPolicyEnv();
    h.dispose();
  }
});

// ── 4. Flag desligada = comportamento atual ──────────────────────────────────

test('flag OFF: comportamento atual byte a byte (mesmos deletes, mesmo resultado)', async () => {
  clearPolicyEnv();
  const seed: SeedRecording[] = [
    { id: 'velha-com-movimento', ageDays: 10, motionScore: 9, cameraRetentionDays: 7 },
    { id: 'velha-sem-movimento', ageDays: 10, motionScore: 0, cameraRetentionDays: 7 },
    { id: 'velha-desconhecida', ageDays: 10, motionScore: -1, cameraRetentionDays: 7 },
    { id: 'nova-sem-movimento', ageDays: 1, motionScore: 0, cameraRetentionDays: 7 },
  ];
  const h = buildHarness(seed);
  try {
    const result = await h.svc.handleRetention('teste');
    assert.deepEqual(
      [...h.deleteCalls.recordings].sort(),
      ['velha-com-movimento', 'velha-desconhecida', 'velha-sem-movimento'],
      'com a flag off o motionScore é IRRELEVANTE: vale só retentionDays',
    );
    assert.deepEqual(
      Object.keys(result),
      ['skipped', 'recordingsDeleted', 'clipsDeleted', 'eventsDeleted', 'orphanThumbnailsDeleted', 'orphanCompatibleFilesDeleted'],
      'o resultado logado não pode ganhar campos novos enquanto a feature está desligada',
    );
    assert.equal(result.recordingsDeleted, 3);
  } finally {
    h.dispose();
  }
});

test('flag OFF: dias configurados no ambiente NÃO valem sem a flag', async () => {
  // Cenário real de rollout: o operador já escreveu os dias no .env e ainda não
  // ligou a feature. Nada pode mudar — nem apagar mais cedo, nem reter mais.
  setPolicyEnv({ RETENTION_ALL_DAYS: '1', RETENTION_MOTION_DAYS: '365' });
  const h = buildHarness([
    { id: 'velha-com-movimento', ageDays: 10, motionScore: 9, cameraRetentionDays: 7 },
    { id: 'nova-sem-movimento', ageDays: 3, motionScore: 0, cameraRetentionDays: 7 },
  ]);
  try {
    const result = await h.svc.handleRetention('teste');
    assert.deepEqual(h.deleteCalls.recordings, ['velha-com-movimento'], 'vale só retentionDays da câmera');
    assert.equal(existsSync(h.recordingFile('nova-sem-movimento')), true, 'RETENTION_ALL_DAYS=1 não pode agir com a flag off');
    assert.equal(result.recordingsWouldDelete, undefined);
    assert.equal(result.motionRetained, undefined);
  } finally {
    clearPolicyEnv();
    h.dispose();
  }
});

test('flag OFF: a fronteira do corte continua sendo estritamente MAIOR que N dias', async () => {
  clearPolicyEnv();
  // A regra histórica só apaga quando `startedAt < now - N dias`. Nada de idade
  // "exatamente N" aqui: o `now` do serviço é lido depois do seed e a diferença
  // de milissegundos deixaria o teste instável — a fronteira exata é travada na
  // regra PURA (ver 'regra pura: a janela e o veredito por gravação').
  const h = buildHarness([{ id: 'passou', ageDays: 7.001, cameraRetentionDays: 7, motionScore: 0 }]);
  try {
    const result = await h.svc.handleRetention('teste');
    assert.equal(result.recordingsDeleted, 1, 'idade maior que o corte expira');

    const h2 = buildHarness([{ id: 'dentro', ageDays: 6.999, cameraRetentionDays: 7, motionScore: 0 }]);
    try {
      const r2 = await h2.svc.handleRetention('teste');
      assert.equal(r2.recordingsDeleted, 0, 'idade menor que o corte NÃO expira');
      assert.deepEqual(h2.deleteCalls.recordings, []);
    } finally {
      h2.dispose();
    }
  } finally {
    h.dispose();
  }
});

// ── 5. Proteções acima de tudo ───────────────────────────────────────────────

test('proteção: legal hold e evidência vencem os DOIS cortes', async () => {
  setPolicyEnv({
    RETENTION_TWO_TIER_ENABLED: 'true',
    RETENTION_TWO_TIER_DRY_RUN: 'false',
    RETENTION_ALL_DAYS: '1',
    RETENTION_MOTION_DAYS: '2',
  });
  const h = buildHarness(
    [
      { id: 'hold-vazia', ageDays: 400, motionScore: 0 },
      { id: 'evidencia-vazia', ageDays: 400, motionScore: 0 },
      { id: 'livre-vazia', ageDays: 400, motionScore: 0 },
    ],
    { holdRecordingIds: ['hold-vazia'], evidenceRecordingIds: ['evidencia-vazia'] },
  );
  try {
    const result = await h.svc.handleRetention('teste');
    assert.deepEqual(h.deleteCalls.recordings, ['livre-vazia'], 'só a gravação sem proteção pode ser apagada');
    assert.equal(existsSync(h.recordingFile('hold-vazia')), true, 'legal hold vence a retenção');
    assert.equal(existsSync(h.recordingFile('evidencia-vazia')), true, 'item de investigação vence a retenção');
    assert.equal(result.recordingsDeleted, 1);
  } finally {
    clearPolicyEnv();
    h.dispose();
  }
});

test('proteção: clip em investigação segura a gravação de origem nos dois cortes', async () => {
  setPolicyEnv({
    RETENTION_TWO_TIER_ENABLED: 'true',
    RETENTION_TWO_TIER_DRY_RUN: 'false',
    RETENTION_ALL_DAYS: '1',
    RETENTION_MOTION_DAYS: '2',
  });
  const h = buildHarness(
    [{ id: 'origem', ageDays: 400, motionScore: 0 }],
    { clips: [{ id: 'clip-1', sourceRecordingId: 'origem', ageDays: 400 }] },
  );
  // O hold aponta para o CLIP; a origem só é protegida por transitividade.
  h.svc.prisma.investigationItem.findMany = async (args: any) => {
    if (args?.where?.type === 'legal_hold') {
      return [{ investigationId: 'inv-1', metadata: { enabled: true, clipIds: ['clip-1'] } }];
    }
    return [];
  };
  try {
    await h.svc.handleRetention('teste');
    assert.deepEqual(h.deleteCalls.recordings, [], 'a origem do clip protegido não pode morrer');
    assert.deepEqual(h.deleteCalls.clips, [], 'o clip protegido não pode morrer');
    assert.equal(existsSync(h.recordingFile('origem')), true);
    assert.equal(existsSync(h.clipFile('clip-1')), true);
  } finally {
    clearPolicyEnv();
    h.dispose();
  }
});

// ── 6. Unidade da regra pura ─────────────────────────────────────────────────

test('regra pura: a janela e o veredito por gravação', () => {
  const svc: any = Object.create(RetentionService.prototype);
  const off = { enabled: false, dryRun: true, allDays: 2, motionDays: 30 };
  assert.deepEqual(svc.resolveRetentionWindow(7, off), { allDays: 7, motionDays: 7 }, 'flag off ignora a política');

  const on = { enabled: true, dryRun: false, allDays: 2, motionDays: 30 };
  assert.deepEqual(svc.resolveRetentionWindow(7, on), { allDays: 2, motionDays: 30 });
  assert.deepEqual(
    svc.resolveRetentionWindow(7, { enabled: true, dryRun: false, allDays: 0, motionDays: 0 }),
    { allDays: 7, motionDays: 7 },
    '0 = herda o corte da câmera',
  );
  assert.deepEqual(
    svc.resolveRetentionWindow(7, { enabled: true, dryRun: false, allDays: 10, motionDays: 1 }),
    { allDays: 10, motionDays: 10 },
    'movimento é elevado até o corte de tudo',
  );

  const now = Date.now();
  const janela = { allDays: 2, motionDays: 30 };
  const at = (days: number) => new Date(now - days * DAY);
  assert.equal(svc.isExpiredByAge(at(1), 0, now, janela), false, 'dentro do corte curto nada expira');
  assert.equal(svc.isExpiredByAge(at(10), 0, now, janela), true, 'sem movimento expira no corte curto');
  assert.equal(svc.isExpiredByAge(at(10), -1, now, janela), false, 'DESCONHECIDO nunca expira no corte curto');
  assert.equal(svc.isExpiredByAge(at(10), 1, now, janela), false, 'com movimento não expira no corte curto');
  assert.equal(svc.isExpiredByAge(at(40), -1, now, janela), true, 'corte longo expira até o desconhecido');
  assert.equal(svc.isExpiredByAge(at(40), 3, now, janela), true, 'corte longo expira o com movimento');

  // Fronteira EXATA, byte a byte com a regra histórica (`startedAt < now - N`):
  // idade igual ao corte permanece; um milissegundo além expira.
  const legado = { allDays: 7, motionDays: 7 };
  assert.equal(svc.isExpiredByAge(new Date(now - 7 * DAY), 0, now, legado), false, 'idade == corte NÃO expira');
  assert.equal(svc.isExpiredByAge(new Date(now - 7 * DAY - 1), 0, now, legado), true, 'idade == corte + 1ms expira');
  assert.equal(svc.isExpiredByAge(new Date(now - 2 * DAY), 0, now, janela), false, 'idade == corte curto NÃO expira');
  assert.equal(svc.isExpiredByAge(new Date(now - 2 * DAY - 1), 0, now, janela), true, 'idade == corte curto + 1ms expira');

  assert.equal(svc.readMotionScore({}), -1, 'campo ausente = DESCONHECIDO');
  assert.equal(svc.readMotionScore({ motionScore: null }), -1);
  assert.equal(svc.readMotionScore({ motionScore: -5 }), -1, 'valor fora do domínio = DESCONHECIDO');
  assert.equal(svc.readMotionScore({ motionScore: 1.5 }), -1, 'não-inteiro = DESCONHECIDO');
  assert.equal(svc.readMotionScore({ motionScore: 0 }), 0);
  assert.equal(svc.readMotionScore({ motionScore: 12 }), 12);
});

test('política: lida do ambiente, desligada e em dry-run por padrão', () => {
  const svc: any = Object.create(RetentionService.prototype);
  clearPolicyEnv();
  assert.deepEqual(svc.readTwoTierPolicy(), { enabled: false, dryRun: true, allDays: 0, motionDays: 0 });

  setPolicyEnv({
    RETENTION_TWO_TIER_ENABLED: 'true',
    RETENTION_TWO_TIER_DRY_RUN: 'false',
    RETENTION_ALL_DAYS: '3',
    RETENTION_MOTION_DAYS: '45',
  });
  assert.deepEqual(svc.readTwoTierPolicy(), { enabled: true, dryRun: false, allDays: 3, motionDays: 45 });

  setPolicyEnv({ RETENTION_TWO_TIER_ENABLED: 'sim', RETENTION_ALL_DAYS: 'abc', RETENTION_MOTION_DAYS: '-9' });
  assert.deepEqual(
    svc.readTwoTierPolicy(),
    { enabled: false, dryRun: true, allDays: 0, motionDays: 0 },
    'lixo no ambiente cai no lado seguro: desligado',
  );
  clearPolicyEnv();
});
