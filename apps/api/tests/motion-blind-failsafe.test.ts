import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordingProcessManagerService } from '../src/recordings/recording-process-manager.service';

// ── DETECTOR CEGO NÃO PODE VIRAR CÂMERA SEM GRAVAÇÃO ────────────────────────
//
// Em modo movimento, "não detectei nada" e "não estou enxergando nada" dão o
// MESMO resultado na tela: zero gravação. O primeiro é correto; o segundo é o
// pior defeito possível num sistema de segurança — tudo parece armado e não
// existe imagem do fato.
//
// Medido em produção (2026-08-05): 9 de 9 câmeras armadas com o detector em
// `no_frame_received`, 10+ falhas consecutivas de captura e backoff no teto de
// 60s — cegas por mais de meia hora, gravando NADA. O health-check já emitia
// HEALTH_MOTION_DETECTOR_STALE; ninguém ligava esse aviso à gravação.
//
// Regra nova: NA DÚVIDA, GRAVA.

type Chamadas = {
  starts: string[];
  stops: string[];
  eventos: Array<{ camera: string; tipo: string }>;
  timersLimpos: string[];
  stopsAgendados: Array<{ camera: string; postRoll: number }>;
};

function montar(camera: Partial<{ id: string; name: string; recordingMode: string; enabled: boolean }> | null, opcoes: {
  jaGravando?: boolean;
  falharStart?: boolean;
} = {}) {
  const chamadas: Chamadas = { starts: [], stops: [], eventos: [], timersLimpos: [], stopsAgendados: [] };
  const svc: any = Object.create(RecordingProcessManagerService.prototype);

  svc.logger = { warn: () => {}, log: () => {}, error: () => {} };
  (svc as any).blindFailsafe = new Set<string>();
  svc.controlMode = 'local';
  svc.active = new Map<string, unknown>();
  if (opcoes.jaGravando && camera?.id) svc.active.set(camera.id, {});
  svc.prisma = {
    camera: {
      findUnique: async () => (camera ? { id: 'cam-1', name: 'Cam 1', recordingMode: 'motion', enabled: true, ...camera } : null),
    },
  };
  svc.start = async (cameraId: string) => {
    if (opcoes.falharStart) throw new Error('disco cheio');
    chamadas.starts.push(cameraId);
    svc.active.set(cameraId, {});
    return { status: 'started' };
  };
  svc.stop = async (cameraId: string) => { chamadas.stops.push(cameraId); svc.active.delete(cameraId); };
  svc.getStatus = async () => ({ isRecording: Boolean(opcoes.jaGravando) });
  svc.camerasService = {
    registerEvent: async (cameraId: string, tipo: string) => { chamadas.eventos.push({ camera: cameraId, tipo }); },
  };
  svc.clearMotionStopTimer = (cameraId: string) => { chamadas.timersLimpos.push(cameraId); };
  svc.scheduleMotionStop = (cameraId: string, postRoll: number) => { chamadas.stopsAgendados.push({ camera: cameraId, postRoll }); };
  svc.getMotionSegmentSeconds = () => 60;
  svc.getMotionPostRollSeconds = () => 20;

  return { svc, chamadas };
}

test('detector cego LIGA a gravação contínua de emergência', () => {
  // Este é o buraco inteiro: sem isto, a câmera fica armada e não grava nada.
  const { svc, chamadas } = montar({ id: 'cam-1' });
  return svc.definirFailsafeDetectorCego('cam-1', true).then((r: string) => {
    assert.equal(r, 'ligado');
    assert.deepEqual(chamadas.starts, ['cam-1'], 'detector cego sem gravação é câmera sem registro nenhum');
    assert.deepEqual(chamadas.eventos.map((e) => e.tipo), ['MOTION_FAILSAFE_RECORDING_STARTED']);
    assert.deepEqual(chamadas.timersLimpos, ['cam-1'], 'um post-roll pendente mataria a gravação de emergência');
    assert.deepEqual(svc.camerasEmFailsafeCego(), ['cam-1']);
  });
});

test('já gravando: o fail-safe NÃO abre uma segunda gravação', async () => {
  // Dois ffmpeg na mesma câmera brigam por sessão RTSP — as câmeras baratas
  // travam com 2-4 sessões, e ainda faltam live e IA.
  const { svc, chamadas } = montar({ id: 'cam-1' }, { jaGravando: true });
  await svc.definirFailsafeDetectorCego('cam-1', true);
  assert.deepEqual(chamadas.starts, []);
  assert.deepEqual(chamadas.eventos.map((e) => e.tipo), ['MOTION_FAILSAFE_RECORDING_STARTED']);
});

test('detector voltou: encerra o fail-safe pelo post-roll, não na hora', async () => {
  // Cortar no instante da recuperação deixaria sem imagem justamente o momento
  // em que o detector volta a enxergar.
  const { svc, chamadas } = montar({ id: 'cam-1' });
  await svc.definirFailsafeDetectorCego('cam-1', true);
  const r = await svc.definirFailsafeDetectorCego('cam-1', false);

  assert.equal(r, 'desligado');
  assert.deepEqual(chamadas.stops, [], 'parar na hora é que abriria o buraco');
  assert.deepEqual(chamadas.stopsAgendados, [{ camera: 'cam-1', postRoll: 20 }]);
  assert.deepEqual(svc.camerasEmFailsafeCego(), []);
});

test('o health-check chama a cada ciclo: só a TRANSIÇÃO faz trabalho', async () => {
  const { svc, chamadas } = montar({ id: 'cam-1' });
  assert.equal(await svc.definirFailsafeDetectorCego('cam-1', true), 'ligado');
  assert.equal(await svc.definirFailsafeDetectorCego('cam-1', true), 'inalterado');
  assert.equal(await svc.definirFailsafeDetectorCego('cam-1', true), 'inalterado');
  // Repetir o evento a cada ciclo do health-check encheria o histórico e o
  // Telegram do dono com o mesmo aviso.
  assert.equal(chamadas.starts.length, 1);
  assert.equal(chamadas.eventos.length, 1);
});

test('enquanto o detector está cego, o post-roll NÃO derruba a gravação', async () => {
  // Um post-roll agendado ANTES da cegueira (ou de um movimento que ainda
  // pingou) cairia aqui e desligaria a própria cobertura de emergência.
  const { svc, chamadas } = montar({ id: 'cam-1' });
  await svc.definirFailsafeDetectorCego('cam-1', true);
  svc.motionStopTimers = new Map();
  await svc.stopMotionRecordingAfterQuiet('cam-1', 20);
  assert.deepEqual(chamadas.stops, [], 'a gravação de emergência tem de sobreviver ao post-roll');
});

test('câmera em modo contínuo não ganha fail-safe (já grava sempre)', async () => {
  const { svc, chamadas } = montar({ id: 'cam-1', recordingMode: 'continuous' });
  assert.equal(await svc.definirFailsafeDetectorCego('cam-1', true), 'inalterado');
  assert.deepEqual(chamadas.starts, []);
});

test('câmera DESABILITADA não ganha gravação por detector cego', async () => {
  // Desabilitar é uma decisão do operador; um detector cego não pode revertê-la.
  const { svc, chamadas } = montar({ id: 'cam-1', enabled: false });
  assert.equal(await svc.definirFailsafeDetectorCego('cam-1', true), 'inalterado');
  assert.deepEqual(chamadas.starts, []);
});

test('câmera inexistente não quebra o ciclo do health-check', async () => {
  const { svc } = montar(null);
  assert.equal(await svc.definirFailsafeDetectorCego('sumiu', true), 'inalterado');
});

test('gravação de emergência que NÃO sobe continua marcada para nova tentativa', async () => {
  // Câmera fora do ar ou disco cheio: o próximo ciclo do health-check tem de
  // tentar de novo, senão a câmera fica cega e sem gravação para sempre.
  const { svc, chamadas } = montar({ id: 'cam-1' }, { falharStart: true });
  assert.equal(await svc.definirFailsafeDetectorCego('cam-1', true), 'ligado');
  assert.deepEqual(svc.camerasEmFailsafeCego(), ['cam-1'], 'desistir aqui deixaria a câmera sem nenhuma cobertura');
  assert.deepEqual(chamadas.eventos, [], 'não anuncia gravação que não existe');
});
