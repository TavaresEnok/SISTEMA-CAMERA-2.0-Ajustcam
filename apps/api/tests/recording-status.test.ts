import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecordingProcessManagerService } from '../src/recordings/recording-process-manager.service';

// ─────────────────────────────────────────────────────────────────────────────
// D2 (status por-FATO): em modo local, "está gravando" é o PROCESSO FFmpeg vivo —
// não a idade do último segmento. getStatus não pode reportar OK com o FFmpeg
// morto. "existe gravação recente" (hasRecentSegment) é um campo à parte.
// ─────────────────────────────────────────────────────────────────────────────

function makeManager() {
  const config = { get: () => undefined } as any;
  const mgr = new RecordingProcessManagerService(config, {} as any, {} as any, {} as any, {} as any, {} as any) as any;
  mgr.logger = { error() {}, warn() {}, log() {}, debug() {} };
  const recentStart = new Date(Date.now() - 30_000); // segmento recente (<15min)
  mgr.prisma = {
    recording: { findFirst: async () => ({ startedAt: recentStart, endedAt: null, filePath: '/rec/x.mp4' }) },
    camera: { findUnique: async () => ({ recordingEnabled: true }) },
    cameraEvent: { findFirst: async () => null },
  };
  return mgr;
}

test('D2 status: processo local VIVO reporta gravando', async () => {
  const mgr = makeManager();
  mgr.active.set('cam-1', { pid: 4242, startedAt: new Date(), outputPattern: '/rec/%Y.ts' });
  mgr.isPidAlive = () => true;
  const s = await mgr.getStatus('cam-1');
  assert.equal(s.isRecording, true);
  assert.equal(s.statusDetail, 'recording_ok_local_process');
});

test('D2 status: processo local MORTO NÃO reporta gravando (não mente OK com FFmpeg morto)', async () => {
  const mgr = makeManager();
  mgr.active.set('cam-1', { pid: 4242, startedAt: new Date(), outputPattern: '/rec/%Y.ts' });
  mgr.isPidAlive = () => false;
  const s = await mgr.getStatus('cam-1');
  assert.equal(s.isRecording, false, 'PID morto não pode reportar gravando');
  assert.equal(s.stale, true);
  assert.equal(s.statusDetail, 'local_process_dead');
});

test('D2 status: hasRecentSegment é um campo separado de isRecording', async () => {
  const mgr = makeManager();
  mgr.active.set('cam-1', { pid: 4242, startedAt: new Date(), outputPattern: '/rec/%Y.ts' });
  mgr.isPidAlive = () => true;
  const s = await mgr.getStatus('cam-1');
  assert.equal(s.hasRecentSegment, true);
});

// ── AUTORIDADE ≠ INFERÊNCIA: a janela cega de 15 minutos ────────────────────
//
// Defeito observado em produção em 2026-07-28 (anterior a este trabalho, veio
// de 3414f70). `getStatus` responde para TELA: no modo local sem estado em
// memória ele INFERE "gravando" a partir de um segmento recente (<15 min).
// Isso é bom para o painel e péssimo como decisão.
//
// Depois de um restart da API, `this.active` está VAZIO — nenhum ffmpeg
// sobreviveu — mas o último segmento continua recente. Então:
//
//   1. chega movimento;
//   2. `getStatus` infere isRecording=true;
//   3. `handleMotionDetected` devolve `already_recording` e não faz nada;
//   4. a câmera fica SEM GRAVAR até a janela vencer.
//
// Medido: último segmento 01:16:42, restart às 01:28, movimento contínuo de
// 01:25 em diante, e a gravação só voltou às 01:32:04 — exatamente quando os
// 15 minutos expiraram. 15 minutos de imagem perdidos por reinício.
//
// Quem manda aqui é o processo que ESTE nó tem (`this.active`). No modo worker
// o processo é de outro nó e a inferência é a única informação disponível.

function motionStartManager(opts: { controlMode?: 'local' | 'worker'; activeHas?: boolean; inferred?: boolean }) {
  const events: string[] = [];
  const mgr: any = Object.create(RecordingProcessManagerService.prototype);
  mgr.logger = { warn() {}, log() {}, debug() {}, error() {} };
  mgr.controlMode = opts.controlMode ?? 'local';
  mgr.active = new Map(opts.activeHas ? [['cam-1', {}]] : []);
  mgr.preBufferProcs = new Map();
  mgr.preEventSeconds = 0;
  mgr.prisma = {
    camera: {
      findUnique: async () => ({ id: 'cam-1', name: 'Portaria', recordingMode: 'motion', recordingEnabled: true, enabled: true }),
    },
  };
  // A inferência de tela: é ela que mentia para o decisor.
  mgr.getStatus = async () => ({ isRecording: opts.inferred ?? false });
  mgr.start = async () => { events.push('rec_start'); return { status: 'recording_started' }; };
  mgr.stopPreBuffer = async () => undefined;
  mgr.startPreBuffer = async () => undefined;
  mgr.scheduleMotionStop = () => undefined;
  mgr.camerasService = { registerEvent: async (_c: string, type: string) => { events.push(type); } };
  return { mgr, events };
}

test('movimento: após restart da API (active vazio) a gravação SOBE, mesmo com segmento recente', async () => {
  // Exatamente o estado de produção: nada rodando, mas a inferência diz "gravando".
  const { mgr, events } = motionStartManager({ controlMode: 'local', activeHas: false, inferred: true });

  const result = await mgr.handleMotionDetected('cam-1');

  assert.ok(events.includes('rec_start'), 'a inferência de tela não pode decidir: 15 min de imagem se perdem');
  assert.ok(events.includes('MOTION_RECORDING_STARTED'));
  assert.notEqual(result.status, 'already_recording');
});

test('movimento: com gravação REALMENTE de pé não sobe um segundo ffmpeg', async () => {
  const { mgr, events } = motionStartManager({ controlMode: 'local', activeHas: true, inferred: true });

  const result = await mgr.handleMotionDetected('cam-1');

  assert.equal(events.includes('rec_start'), false, 'duas sessões RTSP travam a câmera barata');
  assert.equal(result.status, 'already_recording');
});

test('movimento: modo WORKER continua confiando na inferência (o processo é de outro nó)', async () => {
  // Aqui `active` está vazio por definição — o ffmpeg vive no worker, não aqui.
  const { mgr, events } = motionStartManager({ controlMode: 'worker', activeHas: false, inferred: true });

  const result = await mgr.handleMotionDetected('cam-1');

  assert.equal(events.includes('rec_start'), false, 'no worker, active vazio é normal e não significa "não grava"');
  assert.equal(result.status, 'already_recording');
});

test('movimento: modo WORKER sem gravação recente sobe normalmente', async () => {
  const { mgr, events } = motionStartManager({ controlMode: 'worker', activeHas: false, inferred: false });

  await mgr.handleMotionDetected('cam-1');

  assert.ok(events.includes('rec_start'));
});

// ── -segment_time NÃO PODE RECEBER LIXO DO CHAMADOR ─────────────────────────
//
// `buildArgs` monta o comando do ffmpeg e escreve `String(segmentSeconds)`
// direto em `-segment_time`. O valor vem do CHAMADOR, e os chamadores leem
// RECORDING_SEGMENT_SECONDS com pisos INCONSISTENTES:
//
//   env.config.ts .................. { min: 5, max: 3600, integer: true }
//   recording-process-manager ...... { min: 1 }
//   camera-health-check (2 pontos) . SEM PISO
//   recordings.controller (2) ...... SEM PISO
//   cameras.controller (1) ......... SEM PISO
//
// Ou seja, RECORDING_SEGMENT_SECONDS=0 chega cru ao ffmpeg vindo de 5 lugares —
// inclusive do health-check, que REINICIA a câmera. `-segment_time 0` faz o
// ffmpeg rotacionar a cada pacote: milhares de arquivos por segundo, disco
// cheio e gravação destruída. Negativo mata o processo em laço de reinício.
//
// A correção certa é no ESTREITAMENTO, não em cada chamador: quem transforma o
// número em argumento do ffmpeg é que precisa recusar valor destrutivo. Assim
// qualquer chamador futuro nasce protegido.

function argsDoFfmpeg(segmentSeconds: number) {
  const mgr: any = Object.create(RecordingProcessManagerService.prototype);
  mgr.logger = { warn() {}, log() {}, debug() {}, error() {} };
  mgr.recordingFormat = 'ts';
  mgr.configService = { get: () => undefined };
  const camera: any = { id: 'cam-1', name: 'Portaria' };
  return mgr.buildArgs(camera, 'rtsp://x/y', '/rec/%Y.ts', segmentSeconds, 'h264');
}

function segmentTimeDe(args: string[]) {
  const i = args.indexOf('-segment_time');
  return i >= 0 ? Number(args[i + 1]) : null;
}

test('segment_time: ZERO nunca chega ao ffmpeg (rotação por pacote destrói a gravação)', () => {
  const valor = segmentTimeDe(argsDoFfmpeg(0));
  assert.ok(valor !== null, 'o argumento tem de existir');
  assert.ok(valor >= 5, `-segment_time ${valor} rotacionaria sem parar`);
});

test('segment_time: NEGATIVO nunca chega ao ffmpeg (processo morre em laço)', () => {
  for (const ruim of [-1, -300]) {
    const valor = segmentTimeDe(argsDoFfmpeg(ruim));
    assert.ok(valor !== null && valor >= 5, `-segment_time ${valor} para entrada ${ruim}`);
  }
});

test('segment_time: fracionário é normalizado para inteiro', () => {
  const valor = segmentTimeDe(argsDoFfmpeg(300.7));
  assert.ok(Number.isInteger(valor), `-segment_time ${valor} não é inteiro`);
});

test('segment_time: valor ABSURDO é limitado (segmento de 1 dia trava o VOD e a retenção)', () => {
  const valor = segmentTimeDe(argsDoFfmpeg(86_400));
  assert.ok(valor <= 3600, `-segment_time ${valor} passa do teto canônico de env.config.ts`);
});

test('segment_time: valores LEGÍTIMOS passam intactos (a correção não pode mexer na produção)', () => {
  for (const bom of [5, 60, 120, 300, 600, 3600]) {
    assert.equal(segmentTimeDe(argsDoFfmpeg(bom)), bom, `valor válido ${bom} foi alterado`);
  }
});

// ── GUARDA DE DISCO: SUSPENDER ≠ DESARMAR ───────────────────────────────────
//
// `enforceDiskGuard` reagia a disco cheio chamando `stop(cameraId)`. Mas `stop()`
// grava `recordingEnabled: false` — que neste projeto é o estado DESEJADO pelo
// cliente, não o estado de runtime. Consequência em cadeia:
//
//   · o health-check varre `where: { recordingEnabled: true }` → não vê mais a câmera;
//   · `restartRecordingAfterCrash` exige `recordingEnabled === true` → não religa;
//   · `startEnabledContinuousRecordings` só roda no boot e por padrão está OFF.
//
// Ou seja: um pico de disco às 03h derruba as 24 câmeras; às 04h a retenção
// libera espaço; e NENHUMA volta a gravar até alguém reabilitar na tela, uma a
// uma. E sem `registerEvent` nenhum — a linha do tempo da câmera não mostra
// nada, o watchdog de infra não alerta, existe só um logger.error no stdout.
//
// A guarda tem de suspender o RUNTIME e deixar o desejado intacto.

function diskGuardManager(opts: { cameras: string[] }) {
  const eventos: Array<{ tipo: string; cameraId: string }> = [];
  const desiredWrites: Array<{ cameraId: string; recordingEnabled: unknown }> = [];
  const mgr: any = Object.create(RecordingProcessManagerService.prototype);
  mgr.logger = { warn() {}, log() {}, debug() {}, error() {} };
  mgr.controlMode = 'local';
  mgr.minFreeBytes = 2 * 1024 ** 3;
  mgr.minFreePercent = 5;
  mgr.active = new Map(opts.cameras.map((id) => [id, { stopRequested: false, watcher: setInterval(() => {}, 1e9), process: { exitCode: null } }]));
  for (const [, s] of mgr.active) (s.watcher as NodeJS.Timeout).unref?.();
  mgr.getStorageUsage = async () => ({ freeBytes: 1024 ** 3, freePercent: 1, usedPercent: 99 });
  mgr.stopProcessAndWait = async () => undefined;
  // Fake FIEL: na produção é `finalizeRecordingState` que remove do mapa
  // `active` (recording-process-manager.service.ts:1582). Um fake que não
  // removesse deixaria a asserção "o processo parou" sem sentido.
  mgr.finalizeRecordingState = (cameraId: string) => { mgr.active.delete(cameraId); };
  mgr.cancelPendingRestart = () => undefined;
  mgr.camerasService = {
    getCameraOrThrow: async (id: string) => ({ id }),
    registerEvent: async (cameraId: string, tipo: string) => { eventos.push({ tipo, cameraId }); },
  };
  mgr.prisma = {
    camera: {
      update: async ({ where, data }: any) => {
        desiredWrites.push({ cameraId: where.id, recordingEnabled: data.recordingEnabled });
        return {};
      },
    },
  };
  mgr.resolveRecordingModeUpdate = async () => ({});
  return { mgr, eventos, desiredWrites };
}

test('guarda de disco: suspende a gravação SEM desarmar o desejado do cliente', async () => {
  const { mgr, desiredWrites } = diskGuardManager({ cameras: ['cam-1', 'cam-2'] });

  await mgr.enforceDiskGuard();

  const desarmadas = desiredWrites.filter((w) => w.recordingEnabled === false);
  assert.deepEqual(
    desarmadas, [],
    'gravar `recordingEnabled: false` some com a câmera do health-check: ela nunca mais volta sozinha',
  );
  assert.equal(mgr.active.size, 0, 'o PROCESSO precisa parar — é disso que o disco cheio depende');
});

test('guarda de disco: a parada é VISÍVEL — um evento por câmera, não só um log', async () => {
  const { mgr, eventos } = diskGuardManager({ cameras: ['cam-1', 'cam-2'] });

  await mgr.enforceDiskGuard();

  const porDisco = eventos.filter((e) => /DISK|DISCO/i.test(e.tipo));
  assert.equal(porDisco.length, 2, 'sem evento, a parada é invisível na linha do tempo e para o watchdog de infra');
  assert.deepEqual(porDisco.map((e) => e.cameraId).sort(), ['cam-1', 'cam-2']);
});

test('guarda de disco: disco saudável não para nada nem emite evento', async () => {
  const { mgr, eventos, desiredWrites } = diskGuardManager({ cameras: ['cam-1'] });
  mgr.getStorageUsage = async () => ({ freeBytes: 50 * 1024 ** 3, freePercent: 60, usedPercent: 40 });

  await mgr.enforceDiskGuard();

  assert.equal(mgr.active.size, 1, 'a guarda não pode agir com disco folgado');
  assert.deepEqual(eventos, []);
  assert.deepEqual(desiredWrites, []);
});

// ── ROTINA DE FUNDO NÃO PODE DERRUBAR A API ─────────────────────────────────
//
// `recoverOrphanedSegments` e `startEnabledContinuousRecordings` são disparadas
// com `void this.X()` dentro de setInterval/setTimeout e NÃO tinham try/catch de
// topo. As queries Prisma, os statSync e a recursão readdirSync estavam
// descobertos. Sem `process.on('unhandledRejection')` em lugar nenhum e com
// Node 22 (default `--unhandled-rejections=throw`), qualquer rejeição MATA o
// processo. O irmão `enforceDiskGuard` tem o try/catch — a proteção era a
// intenção, faltou aplicá-la aqui.
//
// Por que isso é grave e não "o container reinicia": a política é
// `unless-stopped`, então a API volta — mas RECORDING_AUTO_START_ENABLED é
// `false` por padrão (o log de produção diz "Auto-start de gravacao continua
// desativado"). Um Postgres reiniciando no instante errado derruba a API e a
// gravação CONTÍNUA não volta sozinha. Um blip de banco vira acervo perdido.

test('rotina de fundo: falha do Prisma na recuperação de órfãos NÃO rejeita', async () => {
  const mgr: any = Object.create(RecordingProcessManagerService.prototype);
  mgr.logger = { warn() {}, log() {}, debug() {}, error() {} };
  mgr.recordingsRoot = '/tmp/inexistente-de-proposito';
  mgr.recordingFormat = 'mp4';
  mgr.active = new Map();
  mgr.segmentRemuxFailures = new Map();
  mgr.checkFfmpegAvailable = () => true;
  mgr.prisma = {
    camera: { findMany: async () => { throw new Error('Connection terminated unexpectedly'); } },
    recording: { findMany: async () => [] },
  };

  await assert.doesNotReject(
    () => mgr.recoverOrphanedSegments(),
    'sob `void` numa rejeição isto seria unhandled rejection — e a API inteira morre',
  );
});

test('rotina de fundo: falha do Prisma no auto-start de contínuas NÃO rejeita', async () => {
  const mgr: any = Object.create(RecordingProcessManagerService.prototype);
  mgr.logger = { warn() {}, log() {}, debug() {}, error() {} };
  mgr.prisma = { camera: { findMany: async () => { throw new Error('too many connections'); } } };
  mgr.start = async () => ({ status: 'recording_started' });

  await assert.doesNotReject(() => mgr.startEnabledContinuousRecordings());
});

test('rotina de fundo: erro de I/O no meio da varredura NÃO rejeita', async () => {
  const mgr: any = Object.create(RecordingProcessManagerService.prototype);
  mgr.logger = { warn() {}, log() {}, debug() {}, error() {} };
  mgr.recordingsRoot = '/tmp';
  mgr.recordingFormat = 'mp4';
  mgr.active = new Map();
  mgr.segmentRemuxFailures = new Map();
  mgr.checkFfmpegAvailable = () => true;
  mgr.prisma = {
    // Câmera cuja pasta não existe/sem permissão: o walk explode lá dentro.
    camera: { findMany: async () => [{ id: '../../etc' }] },
    recording: { findMany: async () => [] },
  };

  await assert.doesNotReject(() => mgr.recoverOrphanedSegments());
});
