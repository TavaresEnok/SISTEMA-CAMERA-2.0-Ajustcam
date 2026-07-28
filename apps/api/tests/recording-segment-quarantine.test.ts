import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordingProcessManagerService } from '../src/recordings/recording-process-manager.service';

// ─────────────────────────────────────────────────────────────────────────────
// D2 — QUARENTENA DE SEGMENTO, TETO DE DURAÇÃO e UNIFICAÇÃO RING×GRAVAÇÃO.
//
// Três defeitos com o mesmo pano de fundo (aprendizados da leitura do Frigate):
//  (A) um .ts envenenado era retentado PARA SEMPRE (ffmpeg/ffprobe em loop);
//  (B) duração sem teto → um salto de PTS vira #EXTINF mentiroso e trava o VOD;
//  (C) ring de pré-evento + gravação = DOIS ffmpeg na mesma câmera barata.
//
// Toda a lógica é exercitada com os seams de I/O sobrescritos na INSTÂNCIA
// (padrão de recording-integrity.test.ts / recording-status.test.ts). Onde o
// artefato em disco É o comportamento (marcador de quarentena), usamos um
// diretório temporário real — marcador falso não provaria nada.
// ─────────────────────────────────────────────────────────────────────────────

function makeManager(configOverrides: Record<string, any> = {}) {
  const config = { get: (key: string) => configOverrides[key] } as any;
  const mgr = new RecordingProcessManagerService(config, {} as any, {} as any, {} as any, {} as any, {} as any) as any;
  mgr.logger = { error() {}, warn() {}, log() {}, debug() {} };
  return mgr;
}

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'drac-seg-'));
}

/**
 * Pasta de segmentos como em produção: o .ts alvo MAIS um .ts posterior — o
 * lexicograficamente último é o que o FFmpeg ainda escreve e a varredura pula
 * (`files.slice(0, -1)`). Sem esse segundo arquivo o teste exercitaria só o
 * caminho de finalização, e não a varredura periódica 24/7 onde o loop nasceu.
 */
function seedSegments(dir: string) {
  const target = join(dir, '2026-07-27_10-00-00.ts');
  writeFileSync(target, 'conteudo-de-video-fake');
  writeFileSync(join(dir, '2026-07-27_10-01-00.ts'), 'segmento-em-escrita');
  return target;
}

function scanState(cameraId: string, cameraRootDir: string) {
  return { cameraId, cameraRootDir, segmentSeconds: 60, knownFiles: new Set<string>() } as any;
}

// ── (A) QUARENTENA: teto de tentativas de remux ──────────────────────────────

test('D2 quarentena: .ts que falha 3x entra em QUARENTENA e PARA de ser retentado', async () => {
  const dir = makeTempDir();
  try {
    const target = seedSegments(dir);
    const mgr = makeManager();
    let attempts = 0;
    mgr.remuxAndRegisterTsSegment = async () => {
      attempts += 1;
      throw new Error('remux_ts_falhou: bitstream corrompido');
    };

    const state = scanState('cam-1', dir);
    for (let i = 0; i < 6; i += 1) await mgr.performSegmentScan(state, false);

    assert.equal(attempts, 3, 'o teto de 3 tentativas deve valer: a 4ª varredura não pode gastar ffmpeg de novo');
    assert.equal(existsSync(`${target}.invalid.json`), true, 'estourado o teto, o marcador de quarentena deve existir');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D2 quarentena: o marcador registra MOTIVO, tentativas e horário — e o .ts NUNCA é apagado', async () => {
  const dir = makeTempDir();
  try {
    const target = seedSegments(dir);
    const mgr = makeManager();
    mgr.remuxAndRegisterTsSegment = async () => {
      throw new Error('remux_ts_falhou: moov ausente');
    };

    const state = scanState('cam-9', dir);
    for (let i = 0; i < 3; i += 1) await mgr.performSegmentScan(state, false);

    const marker = JSON.parse(readFileSync(`${target}.invalid.json`, 'utf8'));
    assert.match(String(marker.reason), /moov ausente/, 'o motivo real da falha precisa estar no marcador');
    assert.equal(marker.attempts, 3, 'o marcador registra quantas tentativas foram gastas');
    assert.equal(marker.cameraId, 'cam-9');
    assert.ok(Number.isFinite(Date.parse(String(marker.quarantinedAt))), 'timestamp ISO válido');
    assert.equal(existsSync(target), true, 'VMS probatório: o segmento vai para quarentena, JAMAIS é apagado');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D2 quarentena: o marcador NUNCA vaza credencial da câmera', async () => {
  const dir = makeTempDir();
  try {
    const target = seedSegments(dir);
    const mgr = makeManager();
    mgr.remuxAndRegisterTsSegment = async () => {
      throw new Error('remux_ts_falhou: rtsp://admin:S3nh4Secreta@10.0.0.9:554/cam1 falhou');
    };

    const state = scanState('cam-1', dir);
    for (let i = 0; i < 3; i += 1) await mgr.performSegmentScan(state, false);

    const raw = readFileSync(`${target}.invalid.json`, 'utf8');
    assert.equal(raw.includes('S3nh4Secreta'), false, 'o marcador vai para o disco: senha jamais pode entrar nele');
    assert.match(raw, /redacted/, 'a URL deve aparecer sanitizada');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D2 quarentena: falha transitória (2x) seguida de sucesso NÃO gera quarentena', async () => {
  const dir = makeTempDir();
  try {
    const target = seedSegments(dir);
    const mgr = makeManager();
    let attempts = 0;
    mgr.remuxAndRegisterTsSegment = async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('remux_ts_falhou: disco ocupado');
      return target.replace(/\.ts$/, '.mp4');
    };

    const state = scanState('cam-1', dir);
    for (let i = 0; i < 5; i += 1) await mgr.performSegmentScan(state, false);

    assert.equal(attempts, 3, 'a 3ª tentativa teve sucesso; depois disso o arquivo é conhecido e não é reprocessado');
    assert.equal(existsSync(`${target}.invalid.json`), false, 'sucesso dentro do teto não pode marcar quarentena');
    assert.equal(state.knownFiles.has(target), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D2 quarentena: .ts já marcado por um processo ANTERIOR não é retentado por uma varredura nova', async () => {
  const dir = makeTempDir();
  try {
    const target = seedSegments(dir);
    writeFileSync(`${target}.invalid.json`, JSON.stringify({ reason: 'quarentena_anterior' }));
    const mgr = makeManager();
    let attempts = 0;
    mgr.remuxAndRegisterTsSegment = async () => { attempts += 1; return ''; };

    // knownFiles nasce vazio (processo reiniciado): só o marcador em disco segura o loop.
    await mgr.performSegmentScan(scanState('cam-1', dir), false);

    assert.equal(attempts, 0, 'a quarentena precisa sobreviver ao reinício do processo');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D2 quarentena: a recuperação de órfãos NÃO ressuscita nem apaga um .ts em quarentena', async () => {
  const root = makeTempDir();
  try {
    const cameraDir = join(root, 'camera-cam-1', '2026', '07', '27', '10');
    mkdirSync(cameraDir, { recursive: true });
    const target = join(cameraDir, '2026-07-27_10-00-00.ts');
    writeFileSync(target, 'conteudo');
    writeFileSync(`${target}.invalid.json`, JSON.stringify({ reason: 'remux_ts_falhou' }));
    // 2h de idade: passa da graça (300s) E do prazo de remoção de inválidos (3600s).
    const oldSeconds = Date.now() / 1000 - 7200;
    utimesSync(target, oldSeconds, oldSeconds);

    const mgr = makeManager({ recordingsRoot: root });
    mgr.checkFfmpegAvailable = () => true;
    mgr.prisma = {
      camera: { findMany: async () => [{ id: 'cam-1' }] },
      recording: { findMany: async () => [] },
    };
    let attempts = 0;
    mgr.remuxAndRegisterTsSegment = async () => { attempts += 1; return ''; };

    await mgr.recoverOrphanedSegments();

    assert.equal(attempts, 0, 'órfão em quarentena não pode voltar a gastar ffmpeg');
    assert.equal(existsSync(target), true, 'órfão em quarentena JAMAIS é apagado (divergência deliberada do Frigate)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (B) TETO DE DURAÇÃO DO SEGMENTO ──────────────────────────────────────────

function registerHarness(mgr: any) {
  const captured: { created: any } = { created: null };
  mgr.prisma = {
    camera: { findUnique: async () => ({ recordingMode: 'continuous' }) },
    recording: {
      findUnique: async () => null,
      create: async ({ data }: any) => { captured.created = data; return { id: 'rec-1' }; },
    },
  };
  mgr.thumbnailQueue = { add: async () => undefined };
  return captured;
}

test('D2 duração: MP4 de "2 horas" (salto de PTS) é CLAMPADO para o segmento esperado, não descartado', async () => {
  const mgr = makeManager();
  mgr.probeRecordedFileMetadata = async () => ({ durationSecondsExact: 7200, sizeBytes: 5000, hasVideoStream: true });
  const captured = registerHarness(mgr);
  const clamps: any[] = [];
  mgr.markSegmentDurationClamped = async (...args: any[]) => { clamps.push(args); };

  await mgr.registerSegment('cam-1', '/rec/2026-07-24_10-00-00.mp4', 60);

  assert.ok(captured.created, 'o vídeo pode estar bom: quem mentiu foi o timestamp — NUNCA descartar');
  assert.equal(captured.created.durationSeconds, 60, 'a duração vai para o esperado do segmento');
  assert.equal(
    captured.created.endedAt.getTime() - captured.created.startedAt.getTime(),
    60_000,
    'o fim precisa seguir a duração clampada, senão o #EXTINF continua mentindo e o VOD trava',
  );
  assert.equal(clamps.length, 1, 'o fato precisa ficar registrado (log + marcador)');
});

test('D2 duração: teto padrão (600s) vale para o segmento contínuo de 300s', async () => {
  const mgr = makeManager();
  mgr.probeRecordedFileMetadata = async () => ({ durationSecondsExact: 6000, sizeBytes: 5000, hasVideoStream: true });
  const captured = registerHarness(mgr);
  mgr.markSegmentDurationClamped = async () => undefined;

  await mgr.registerSegment('cam-1', '/rec/2026-07-24_10-00-00.mp4', 300);

  assert.equal(captured.created.durationSeconds, 300);
});

test('D2 duração: segmento um pouco maior que o alvo (keyframe tardio) NÃO é clampado', async () => {
  const mgr = makeManager();
  mgr.probeRecordedFileMetadata = async () => ({ durationSecondsExact: 65.4, sizeBytes: 5000, hasVideoStream: true });
  const captured = registerHarness(mgr);
  let clamped = false;
  mgr.markSegmentDurationClamped = async () => { clamped = true; };

  await mgr.registerSegment('cam-1', '/rec/2026-07-24_10-00-00.mp4', 60);

  assert.equal(clamped, false, 'o teto existe para PTS absurdo, não para a folga normal do keyframe');
  assert.equal(captured.created.durationSeconds, 65, 'a duração real é preservada');
});

test('D2 duração: duração ZERO/ausente continua REJEITADA (clampar não pode virar registrar lixo)', async () => {
  const mgr = makeManager();
  mgr.probeRecordedFileMetadata = async () => ({ durationSecondsExact: null, sizeBytes: 0, hasVideoStream: true });
  const captured = registerHarness(mgr);
  let clamped = false;
  mgr.markSegmentDurationClamped = async () => { clamped = true; };

  await assert.rejects(
    () => mgr.registerSegment('cam-1', '/rec/2026-07-24_10-00-00.mp4', 60),
    /segmento_mp4_invalido_ou_incompleto/,
  );
  assert.equal(captured.created, null, 'segmento sem duração nunca vira linha no banco');
  assert.equal(clamped, false);
});

test('D2 duração: o clamp deixa MARCADOR em disco com a duração medida e a aplicada', async () => {
  const dir = makeTempDir();
  try {
    const filePath = join(dir, '2026-07-24_10-00-00.mp4');
    const mgr = makeManager();
    mgr.probeRecordedFileMetadata = async () => ({ durationSecondsExact: 7200, sizeBytes: 5000, hasVideoStream: true });
    registerHarness(mgr);

    await mgr.registerSegment('cam-1', filePath, 60);

    const marker = JSON.parse(readFileSync(`${filePath}.duration-clamped.json`, 'utf8'));
    assert.equal(marker.probedDurationSeconds, 7200);
    assert.equal(marker.appliedDurationSeconds, 60);
    assert.equal(marker.cameraId, 'cam-1');
    assert.ok(Number.isFinite(Date.parse(String(marker.clampedAt))));
    // O marcador de clamp NÃO pode ser `.invalid.json`: o arquivo é bom e esse
    // nome é consumido por outras áreas como "gravação impossível".
    assert.equal(existsSync(`${filePath}.invalid.json`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── (C) RING DE PRÉ-EVENTO × GRAVAÇÃO: uma sessão RTSP por vez, sem buraco ───

function motionManager(preEventSeconds: number) {
  const previous = process.env.MOTION_PRE_EVENT_SECONDS;
  process.env.MOTION_PRE_EVENT_SECONDS = String(preEventSeconds);
  try {
    return makeManager();
  } finally {
    if (previous === undefined) delete process.env.MOTION_PRE_EVENT_SECONDS;
    else process.env.MOTION_PRE_EVENT_SECONDS = previous;
  }
}

/**
 * Fake FIEL do ring: `startPreBuffer` real é IDEMPOTENTE (sai cedo se já existe
 * processo) e `stopPreBuffer` real remove a entrada do mapa. Um fake que sempre
 * registrasse "ring_start" mentiria sobre a auto-cura.
 */
function armRing(mgr: any, cameraId: string, events: string[], present: boolean) {
  if (present) mgr.preBufferProcs.set(cameraId, { process: {}, dir: '/ring' });
  mgr.startPreBuffer = async (id: string) => {
    if (mgr.preBufferProcs.has(id)) return;
    events.push('ring_start');
    mgr.preBufferProcs.set(id, { process: {}, dir: '/ring' });
  };
  mgr.stopPreBuffer = async (id: string) => {
    if (!mgr.preBufferProcs.has(id)) return;
    events.push('ring_stop');
    mgr.preBufferProcs.delete(id);
  };
  mgr.promotePreRoll = async () => { events.push('promote'); };
}

function motionHarness(mgr: any, events: string[]) {
  mgr.prisma = {
    camera: {
      findUnique: async () => ({ id: 'cam-1', name: 'Portaria', recordingMode: 'motion', recordingEnabled: true, enabled: true }),
    },
  };
  mgr.camerasService = { registerEvent: async () => undefined };
  mgr.scheduleMotionStop = () => { events.push('post_roll_agendado'); };
}

test('D2 pré-evento: ao gravar por movimento o ring é DESLIGADO — mas só DEPOIS da gravação subir', async () => {
  const events: string[] = [];
  const mgr = motionManager(5);
  motionHarness(mgr, events);
  armRing(mgr, 'cam-1', events, true);
  mgr.getStatus = async () => ({ isRecording: false });
  mgr.start = async () => { events.push('rec_start'); return { status: 'recording_started' }; };

  await mgr.handleMotionDetected('cam-1');

  assert.deepEqual(
    events.filter((e) => e !== 'post_roll_agendado'),
    ['promote', 'rec_start', 'ring_stop'],
    'ordem obrigatória: promove o pré-roll → sobe a gravação → só então derruba o ring',
  );
  assert.ok(
    events.indexOf('ring_stop') > events.indexOf('rec_start'),
    'INVARIANTE: nunca pode existir instante em que nem o ring nem a gravação estejam de pé',
  );
  assert.equal(mgr.preBufferProcs.has('cam-1'), false, 'gravando: uma única sessão RTSP de arquivamento');
});

test('D2 pré-evento: se a gravação FALHA ao subir, o ring continua de pé (cobertura preservada)', async () => {
  const events: string[] = [];
  const mgr = motionManager(5);
  motionHarness(mgr, events);
  armRing(mgr, 'cam-1', events, true);
  mgr.getStatus = async () => ({ isRecording: false });
  mgr.start = async () => { throw new Error('camera fora do ar'); };

  await assert.rejects(() => mgr.handleMotionDetected('cam-1'), /camera fora do ar/);

  assert.equal(events.includes('ring_stop'), false, 'sem gravação de pé, o ring é a única cobertura: não pode cair');
  assert.equal(mgr.preBufferProcs.has('cam-1'), true);
});

test('D2 pré-evento: gravação que falha com o ring AUSENTE religa o ring (auto-cura)', async () => {
  const events: string[] = [];
  const mgr = motionManager(5);
  motionHarness(mgr, events);
  armRing(mgr, 'cam-1', events, false);
  mgr.getStatus = async () => ({ isRecording: false });
  mgr.start = async () => { throw new Error('camera fora do ar'); };

  await assert.rejects(() => mgr.handleMotionDetected('cam-1'), /camera fora do ar/);

  assert.deepEqual(events, ['ring_start'], 'sem gravação e sem ring seria cobertura ZERO');
});

test('D2 pré-evento: com a gravação JÁ em curso o ring não é ressuscitado (nada de 2º ffmpeg)', async () => {
  const events: string[] = [];
  const mgr = motionManager(5);
  motionHarness(mgr, events);
  armRing(mgr, 'cam-1', events, false);
  // "JÁ gravando" precisa ser dito pelo canal que o código de fato consulta: no
  // modo local a autoridade é `this.active` (o processo que ESTE nó tem), não o
  // `getStatus`, que é inferência para TELA e mentia depois de um restart.
  // A asserção abaixo é a mesma de antes — só o fixture passou a ser fiel.
  mgr.active.set('cam-1', {});
  mgr.getStatus = async () => ({ isRecording: true });
  mgr.start = async () => { events.push('rec_start'); return { status: 'recording_started' }; };

  const result = await mgr.handleMotionDetected('cam-1');

  assert.equal(result.status, 'already_recording');
  assert.deepEqual(
    events.filter((e) => e !== 'post_roll_agendado'),
    [],
    'a gravação em curso já cobre o "antes": subir o ring seria a 2ª sessão RTSP que trava a câmera',
  );
});

test('D2 pré-evento: ao encerrar a gravação por movimento o ring VOLTA — e sobe ANTES da parada', async () => {
  const events: string[] = [];
  const mgr = motionManager(5);
  mgr.prisma = { camera: { findUnique: async () => ({ recordingMode: 'motion', recordingEnabled: true }) } };
  mgr.camerasService = { registerEvent: async () => undefined };
  armRing(mgr, 'cam-1', events, false);
  mgr.stop = async () => { events.push('rec_stop'); };

  await mgr.stopMotionRecordingAfterQuiet('cam-1', 60);

  assert.deepEqual(events, ['ring_start', 'rec_stop'], 'religar o ring ANTES de parar a gravação fecha a janela sem cobertura');
});

test('D2 pré-evento: com o recurso DESLIGADO (padrão de produção) nada de ring é criado', async () => {
  const events: string[] = [];
  const mgr = motionManager(0);
  mgr.prisma = { camera: { findUnique: async () => ({ recordingMode: 'motion', recordingEnabled: true }) } };
  mgr.camerasService = { registerEvent: async () => undefined };
  armRing(mgr, 'cam-1', events, false);
  mgr.stop = async () => { events.push('rec_stop'); };

  await mgr.stopMotionRecordingAfterQuiet('cam-1', 60);

  assert.deepEqual(events, ['rec_stop'], 'MOTION_PRE_EVENT_SECONDS=0 mantém a produção intocada');
});

// ── (D) UMA ÚNICA POLÍTICA PARA A MESMA FALHA ────────────────────────────────
//
// `performSegmentScan` (câmera ATIVA) e `recoverOrphanedSegments` (câmera
// PARADA) tratavam o MESMO evento — "não consegui recuperar este segmento" —
// com políticas OPOSTAS: a primeira punha em quarentena e preservava o arquivo;
// a segunda dava `unlink` depois de 1h, sem contador e sem marcador.
//
// A assimetria era perversa: a recuperação de órfãos PULA câmera ativa, então a
// única política que apagava era a que só alcança gravação de câmera que parou —
// exatamente o material que ninguém está olhando e que tem mais chance de ser o
// incidente que importava. Um soluço de ffprobe bastava para destruir vídeo bom.
// ─────────────────────────────────────────────────────────────────────────────

function orphanManager(root: string) {
  const mgr = makeManager({ recordingsRoot: root });
  mgr.checkFfmpegAvailable = () => true;
  mgr.prisma = {
    camera: { findMany: async () => [{ id: 'cam-1' }] },
    recording: { findMany: async () => [] },
  };
  return mgr;
}

/** Órfão com idade além do antigo prazo de remoção (3600s) — o caso que apagava. */
function seedOrphan(root: string, fileName: string) {
  const dir = join(root, 'camera-cam-1', '2026', '07', '27', '10');
  mkdirSync(dir, { recursive: true });
  const target = join(dir, fileName);
  writeFileSync(target, 'conteudo-de-video-fake');
  const old = Date.now() / 1000 - 7200;
  utimesSync(target, old, old);
  return target;
}

test('D4 órfão .mp4: ilegível pelo ffprobe vai para QUARENTENA e NÃO é apagado', async () => {
  const root = makeTempDir();
  try {
    const target = seedOrphan(root, '2026-07-27_10-00-00.mp4');
    const mgr = orphanManager(root);
    mgr.probeRecordedFileMetadata = async () => ({ durationSecondsExact: null, sizeBytes: 0, hasVideoStream: false });

    for (let i = 0; i < 5; i += 1) await mgr.recoverOrphanedSegments();

    assert.equal(existsSync(target), true, 'VMS probatório: órfão ilegível NUNCA pode ser apagado');
    assert.equal(existsSync(mgr.segmentQuarantineMarkerPath(target)), true, 'estourado o teto, deve haver marcador de quarentena');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D4 órfão .mp4: o marcador NÃO colide com o `.invalid.json` das miniaturas', async () => {
  const root = makeTempDir();
  try {
    const target = seedOrphan(root, '2026-07-27_10-00-00.mp4');
    const mgr = orphanManager(root);
    mgr.probeRecordedFileMetadata = async () => ({ durationSecondsExact: null, sizeBytes: 0, hasVideoStream: false });

    for (let i = 0; i < 5; i += 1) await mgr.recoverOrphanedSegments();

    // `<arquivo>.mp4.invalid.json` JÁ TEM DONO: thumbnail-generation.processor o
    // escreve para dizer "não deu para gerar miniatura" — o vídeo ali está BOM.
    // Se a quarentena reusasse esse nome, um MP4 perfeitamente reproduzível cuja
    // miniatura falhou seria lido como irrecuperável e sairia do rodízio.
    assert.equal(existsSync(`${target}.invalid.json`), false, 'a quarentena não pode sequestrar o marcador das miniaturas');
    assert.notEqual(mgr.segmentQuarantineMarkerPath(target), `${target}.invalid.json`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D4 órfão .mp4: falha TRANSITÓRIA de probe não quarentena — a tentativa seguinte recupera', async () => {
  const root = makeTempDir();
  try {
    const target = seedOrphan(root, '2026-07-27_10-00-00.mp4');
    const mgr = orphanManager(root);
    let probes = 0;
    mgr.probeRecordedFileMetadata = async () => {
      probes += 1;
      return probes === 1
        ? { durationSecondsExact: null, sizeBytes: 0, hasVideoStream: false }
        : { durationSecondsExact: 60, sizeBytes: 5000, hasVideoStream: true };
    };
    let registered = 0;
    mgr.registerSegment = async () => { registered += 1; };

    await mgr.recoverOrphanedSegments();
    await mgr.recoverOrphanedSegments();

    assert.equal(registered, 1, 'um soluço de ffprobe não pode custar a gravação: a 2ª passada recupera');
    assert.equal(existsSync(mgr.segmentQuarantineMarkerPath(target)), false, 'uma falha isolada não é quarentena');
    assert.equal(existsSync(target), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D4 órfão .ts: remux que falha em câmera PARADA também não apaga (mesma política da ativa)', async () => {
  const root = makeTempDir();
  try {
    const target = seedOrphan(root, '2026-07-27_10-00-00.ts');
    const mgr = orphanManager(root);
    mgr.remuxAndRegisterTsSegment = async () => { throw new Error('remux_ts_falhou: moov ausente'); };

    for (let i = 0; i < 5; i += 1) await mgr.recoverOrphanedSegments();

    assert.equal(existsSync(target), true, 'câmera parada não pode ter política de destruição diferente da ativa');
    assert.equal(existsSync(`${target}.invalid.json`), true, 'o .ts mantém a convenção de marcador já em produção');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D4 órfão: a quarentena tem TETO — o mesmo arquivo não gasta ffprobe para sempre', async () => {
  const root = makeTempDir();
  try {
    seedOrphan(root, '2026-07-27_10-00-00.mp4');
    const mgr = orphanManager(root);
    let probes = 0;
    mgr.probeRecordedFileMetadata = async () => {
      probes += 1;
      return { durationSecondsExact: null, sizeBytes: 0, hasVideoStream: false };
    };

    for (let i = 0; i < 8; i += 1) await mgr.recoverOrphanedSegments();

    assert.equal(probes, 3, 'era este o defeito original do .ts: retentar sem teto, queimando CPU para sempre');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
