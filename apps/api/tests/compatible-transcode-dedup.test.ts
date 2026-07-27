import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RecordingsService } from '../src/recordings/recordings.service';

// ── Achado da análise competitiva (verificado): o transcode de playback compatível
// (até 5 min de FFmpeg) não tinha dedup nem fila — N requisições simultâneas da
// MESMA gravação disparavam N transcodes do mesmo arquivo (tempestade de CPU no
// host que também grava e serve live). E escrevia direto no nome FINAL, então um
// transcode interrompido deixava um MP4 truncado que o cache seguinte aceitaria.

test('transcode compatível: chamadas concorrentes da mesma gravação fazem UM só trabalho', async () => {
  const svc: any = Object.create(RecordingsService.prototype);
  let runs = 0;
  let release: (v: string) => void = () => {};
  const gate = new Promise<string>((resolve) => { release = resolve; });
  svc.generateCompatibleFile = async () => { runs += 1; return gate; };
  (svc as any).compatibleFileInFlight = new Map();

  const a = svc.ensureCompatibleFile('rec-1');
  const b = svc.ensureCompatibleFile('rec-1');
  const c = svc.ensureCompatibleFile('rec-1');
  release('/out/rec-1.mp4');
  const results = await Promise.all([a, b, c]);

  assert.equal(runs, 1, 'três pedidos simultâneos não podem disparar três transcodes');
  assert.deepEqual(results, ['/out/rec-1.mp4', '/out/rec-1.mp4', '/out/rec-1.mp4']);
});

test('transcode compatível: gravações DIFERENTES não são deduplicadas entre si', async () => {
  const svc: any = Object.create(RecordingsService.prototype);
  let runs = 0;
  svc.generateCompatibleFile = async (id: string) => { runs += 1; return `/out/${id}.mp4`; };
  (svc as any).compatibleFileInFlight = new Map();
  await Promise.all([svc.ensureCompatibleFile('a'), svc.ensureCompatibleFile('b')]);
  assert.equal(runs, 2);
});

test('transcode compatível: a entrada em voo é liberada após terminar (não fica presa)', async () => {
  const svc: any = Object.create(RecordingsService.prototype);
  let runs = 0;
  svc.generateCompatibleFile = async (id: string) => { runs += 1; return `/out/${id}.mp4`; };
  (svc as any).compatibleFileInFlight = new Map();
  await svc.ensureCompatibleFile('rec-1');
  await svc.ensureCompatibleFile('rec-1'); // depois de concluído, roda de novo
  assert.equal(runs, 2, 'o mapa em voo precisa ser limpo no finally');
  assert.equal((svc as any).compatibleFileInFlight.size, 0);
});

test('transcode compatível: falha também libera a entrada em voo', async () => {
  const svc: any = Object.create(RecordingsService.prototype);
  svc.generateCompatibleFile = async () => { throw new Error('ffmpeg falhou'); };
  (svc as any).compatibleFileInFlight = new Map();
  await assert.rejects(() => svc.ensureCompatibleFile('rec-1'), /ffmpeg falhou/);
  assert.equal((svc as any).compatibleFileInFlight.size, 0, 'falha não pode deixar a gravação travada em voo');
});

test('transcode compatível: escreve em .tmp e renomeia (nome final nunca é parcial)', () => {
  const src = readFileSync('src/recordings/recordings.service.ts', 'utf8');
  const start = src.indexOf('private async generateCompatibleFile');
  assert.notEqual(start, -1, 'esperava o gerador do arquivo compatível');
  const body = src.slice(start, src.indexOf('async streamRecordingCompatible'));
  assert.match(body, /tmpPath/, 'o transcode deve escrever num temporário');
  assert.match(body, /renameSync\(tmpPath, outputPath\)/, 'e publicar por rename atômico');
  assert.doesNotMatch(body.slice(0, body.indexOf('renameSync')), /'\+faststart',\s*\n\s*outputPath/, 'o ffmpeg não pode escrever direto no nome final');
});
