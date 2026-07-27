import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RecordingProcessManagerService } from '../src/recordings/recording-process-manager.service';

// ── Achado da análise competitiva (verificado): uma falha de RUNTIME do FFmpeg
// gravava `recordingEnabled: false` no banco. Esse campo é o ESTADO DESEJADO do
// cliente (lido como `intendedRecording` no getStatus) — então uma câmera fora do
// ar por um instante ficava com a gravação DESARMADA para sempre, sem voltar nem
// após reinício. Estado desejado só muda por ação explícita.
test('gravação: NENHUM handler de erro do FFmpeg desarma o estado desejado', () => {
  const src = readFileSync('src/recordings/recording-process-manager.service.ts', 'utf8');
  // O arquivo tem VÁRIOS handlers de erro de processo (gravação, pré-buffer…).
  // Verificar só o primeiro deixaria os outros livres para reintroduzir o bug.
  const handlers: string[] = [];
  let idx = src.indexOf("proc.on('error'");
  while (idx !== -1) {
    handlers.push(src.slice(idx, idx + 900));
    idx = src.indexOf("proc.on('error'", idx + 1);
  }
  assert.ok(handlers.length > 0, 'esperava ao menos um handler de erro de processo');
  for (const [i, handler] of handlers.entries()) {
    assert.doesNotMatch(
      handler,
      /recordingEnabled:\s*false/,
      `handler de erro #${i + 1} não pode escrever recordingEnabled=false (desarma o estado desejado)`,
    );
  }
});

// ── Achado: a validação do segmento só consultava `format=duration,size`. Um
// arquivo só-áudio, ou com a trilha de vídeo quebrada, tem duração e virava uma
// linha READY que não reproduz.
function makeService(probeResult: any) {
  const svc: any = Object.create(RecordingProcessManagerService.prototype);
  svc.logger = { warn() {}, log() {}, debug() {}, error() {} };
  svc.probeRecordedFileMetadata = async () => probeResult;
  svc.prisma = {
    camera: { findUnique: async () => ({ recordingMode: 'continuous' }) },
    recording: {
      findUnique: async () => null,
      create: async () => ({ id: 'r1' }),
    },
  };
  return svc;
}

const NAME = '/rec/cam-1/2026-07-24_10-00-00.mp4';

test('segmento: arquivo SEM stream de vídeo é rejeitado (não vira linha READY)', async () => {
  const svc = makeService({ durationSecondsExact: 300, sizeBytes: 5_000_000, hasVideoStream: false });
  await assert.rejects(
    () => svc.registerSegment('cam-1', NAME, 300),
    /sem_stream_de_video/,
    'duração sozinha não pode aprovar um arquivo sem vídeo',
  );
});

test('segmento: arquivo COM vídeo e duração é aceito (sem regressão)', async () => {
  const svc = makeService({ durationSecondsExact: 300, sizeBytes: 5_000_000, hasVideoStream: true });
  await assert.doesNotReject(() => svc.registerSegment('cam-1', NAME, 300));
});

test('segmento: sem duração continua rejeitado (comportamento anterior preservado)', async () => {
  const svc = makeService({ durationSecondsExact: null, sizeBytes: 10, hasVideoStream: true });
  await assert.rejects(() => svc.registerSegment('cam-1', NAME, 300), /invalido_ou_incompleto/);
});

// ── Achado: o probe precisa PEDIR os streams, senão nunca saberá se há vídeo.
test('probe: consulta os streams além do format (senão não há como validar vídeo)', () => {
  const src = readFileSync('src/recordings/recording-process-manager.service.ts', 'utf8');
  const start = src.indexOf('private async probeRecordedFileMetadata');
  const body = src.slice(start, start + 1200);
  assert.match(body, /stream=codec_type/, 'o ffprobe precisa pedir codec_type dos streams');
});
