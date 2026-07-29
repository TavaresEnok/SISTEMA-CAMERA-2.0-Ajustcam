import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RetentionService } from '../src/recordings/retention.service';

// O sprite de scrubbing (2.9) mora AO LADO do MP4 e o helper promete que ele
// "herda a retenção da origem". A retenção só conhecia `.thumb.jpg`, então cada
// gravação com scrubbing deixava um `.preview.jpg` PERMANENTE no disco após a
// origem ser apagada — vazamento de armazenamento e de derivado de conteúdo.
// Estes testes travam as duas pontas: exclusão da gravação e varredura de órfãos.

function makeService(root: string, recordings: Array<{ id: string; cameraId: string; filePath: string }>) {
  const svc: any = Object.create(RetentionService.prototype);
  svc.logger = { warn() {}, log() {} };
  svc.config = { get: (k: string) => (k === 'recordingsRoot' ? root : undefined) };
  svc.prisma = {
    exportedClip: { findMany: async () => [], delete: async () => ({}) },
    recording: {
      findMany: async () => recordings.map((r) => ({ ...r })),
      delete: async () => ({}),
    },
    $transaction: async (callback: (tx: any) => unknown) => callback({
      // Ver retention-advisory-lock.e2e.ts: o lock usa $executeRawUnsafe
      // porque pg_advisory_xact_lock devolve `void`.
      $executeRawUnsafe: async () => 1,
      $queryRawUnsafe: async () => [{ pg_advisory_xact_lock: null }],
      exportedClip: {
        delete: async () => ({}),
        deleteMany: async () => ({ count: 0 }),
      },
      recording: { delete: async () => ({}) },
    }),
  };
  return svc;
}

// A pasta é `camera-<id>/` — o que `buildRecordingOutputDir` de fato cria em
// produção. O fixture antigo usava `cam-1`, um nome que nunca existiu no disco;
// só a ASSERÇÃO importa aqui e ela segue idêntica. A varredura de órfãos passou
// a ser dirigida pelos diretórios de câmera, então um fixture fora da convenção
// deixaria de ser varrido — e o teste "passaria" sem exercitar nada.
function seedRecording(root: string, name: string) {
  const cam = join(root, 'camera-cam-1');
  mkdirSync(cam, { recursive: true });
  const mp4 = join(cam, `${name}.mp4`);
  const thumb = join(cam, `${name}.thumb.jpg`);
  const preview = join(cam, `${name}.preview.jpg`);
  for (const f of [mp4, thumb, preview]) writeFileSync(f, 'x');
  return { mp4, thumb, preview, relative: join('camera-cam-1', `${name}.mp4`) };
}

test('retenção: apagar a gravação apaga TAMBÉM o sprite .preview.jpg', async () => {
  const root = mkdtempSync(join(tmpdir(), 'drac-ret-'));
  try {
    const f = seedRecording(root, '2026-07-24_10-00-00');
    const svc = makeService(root, []);
    const removed = await svc.deleteRecording(
      { id: 'r1', cameraId: 'cam-1', filePath: f.relative },
      { recordingIds: new Set(), clipIds: new Set(), eventIds: new Set() },
    );
    assert.equal(removed, true);
    assert.equal(existsSync(f.mp4), false, 'o MP4 deveria sumir');
    assert.equal(existsSync(f.thumb), false, 'a thumbnail deveria sumir');
    assert.equal(existsSync(f.preview), false, 'o SPRITE deveria sumir junto com a origem');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('retenção: varredura remove sprite ÓRFÃO e preserva o de gravação viva', async () => {
  const root = mkdtempSync(join(tmpdir(), 'drac-ret-'));
  try {
    const viva = seedRecording(root, 'viva');
    const orfa = seedRecording(root, 'orfa');
    // Só "viva" existe no banco; o sprite de "orfa" não tem dono.
    const svc = makeService(root, [{ id: 'r-viva', cameraId: 'cam-1', filePath: viva.relative }]);
    const res = await svc.cleanupOrphanDerivedArtifacts();
    assert.equal(existsSync(viva.preview), true, 'sprite de gravação VIVA não pode ser removido');
    assert.equal(existsSync(orfa.preview), false, 'sprite ÓRFÃO deveria ser removido');
    assert.ok(res.orphanThumbnailsDeleted >= 1, 'a contagem deve refletir os derivados órfãos removidos');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Escopo por câmera: a varredura de órfãos não pode hidratar o acervo INTEIRO ──
//
// `cleanupOrphanDerivedArtifacts` montava três Sets com TODAS as linhas de
// Recording para depois varrer o disco. Hoje são centenas de linhas e não custa
// nada; com 100 câmeras × 30 dias de retenção são ~800 mil, e o job é periódico.
// A varredura passa a ser POR CÂMERA: mesmo resultado, pico de memória de uma
// câmera em vez do acervo. A varredura é dirigida pelos DIRETÓRIOS do disco (e
// não pela tabela Camera), senão a pasta de uma câmera EXCLUÍDA deixaria de ser
// limpa — o caso em que há mais órfão para limpar.

function makeScopedService(root: string, recordings: Array<{ id: string; cameraId: string; filePath: string }>) {
  const queries: any[] = [];
  const svc: any = Object.create(RetentionService.prototype);
  svc.logger = { warn() {}, log() {} };
  svc.config = { get: (k: string) => (k === 'recordingsRoot' ? root : undefined) };
  svc.prisma = {
    exportedClip: { findMany: async () => [], delete: async () => ({}) },
    recording: {
      findMany: async (args: any) => {
        queries.push(args);
        const where = args?.where?.cameraId;
        return recordings.filter((r) => (where ? r.cameraId === where : true)).map((r) => ({ ...r }));
      },
      delete: async () => ({}),
    },
  };
  return { svc, queries };
}

function seedCameraDir(root: string, cameraId: string, name: string) {
  const dir = join(root, `camera-${cameraId}`);
  mkdirSync(dir, { recursive: true });
  const mp4 = join(dir, `${name}.mp4`);
  const thumb = join(dir, `${name}.thumb.jpg`);
  const preview = join(dir, `${name}.preview.jpg`);
  for (const f of [mp4, thumb, preview]) writeFileSync(f, 'x');
  return { mp4, thumb, preview, relative: join(`camera-${cameraId}`, `${name}.mp4`) };
}

test('órfãos: a varredura consulta o banco POR CÂMERA, nunca o acervo inteiro de uma vez', async () => {
  const root = mkdtempSync(join(tmpdir(), 'drac-ret-'));
  try {
    const a = seedCameraDir(root, 'aaa', 'viva-a');
    const b = seedCameraDir(root, 'bbb', 'viva-b');
    const { svc, queries } = makeScopedService(root, [
      { id: 'r1', cameraId: 'aaa', filePath: a.relative },
      { id: 'r2', cameraId: 'bbb', filePath: b.relative },
    ]);

    await svc.cleanupOrphanDerivedArtifacts();

    assert.ok(queries.length >= 2, 'uma consulta por câmera, não uma consulta única gigante');
    assert.equal(
      queries.some((q: any) => !q?.where?.cameraId),
      false,
      'nenhuma consulta pode vir SEM filtro de câmera — é ela que limita o pico de memória',
    );
    assert.equal(existsSync(a.thumb), true, 'derivado de gravação viva não pode ser apagado');
    assert.equal(existsSync(b.preview), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('órfãos: pasta de câmera EXCLUÍDA continua sendo limpa (varre o disco, não a tabela Camera)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'drac-ret-'));
  try {
    const viva = seedCameraDir(root, 'aaa', 'viva');
    // Câmera removida do sistema: a pasta ficou, o banco não tem mais nada dela.
    const fantasma = seedCameraDir(root, 'zzz', 'sobra');
    const { svc } = makeScopedService(root, [{ id: 'r1', cameraId: 'aaa', filePath: viva.relative }]);

    await svc.cleanupOrphanDerivedArtifacts();

    assert.equal(existsSync(fantasma.thumb), false, 'é justamente aqui que mais sobra derivado órfão');
    assert.equal(existsSync(fantasma.preview), false);
    assert.equal(existsSync(viva.thumb), true, 'e a câmera viva não pode ser atingida');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('órfãos: derivado de câmera A jamais é julgado pelas linhas da câmera B', async () => {
  const root = mkdtempSync(join(tmpdir(), 'drac-ret-'));
  try {
    const a = seedCameraDir(root, 'aaa', 'mesma-hora');
    const b = seedCameraDir(root, 'bbb', 'mesma-hora');
    // Só a câmera A tem linha viva; B tem arquivo de mesmo NOME e nenhuma linha.
    const { svc } = makeScopedService(root, [{ id: 'r1', cameraId: 'aaa', filePath: a.relative }]);

    await svc.cleanupOrphanDerivedArtifacts();

    assert.equal(existsSync(a.thumb), true, 'o dono vivo preserva o seu derivado');
    assert.equal(existsSync(b.thumb), false, 'nome igual em outra câmera não pode "adotar" o órfão');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
