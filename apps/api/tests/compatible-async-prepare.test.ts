import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RecordingsService } from '../src/recordings/recordings.service';

// ── O TRANSCODE NÃO SEGURA MAIS A REQUISIÇÃO POR 5 MINUTOS ──────────────────
//
// A primeira reprodução de um HEVC prendia o HTTP pelos até 5 min do FFmpeg;
// estourou o prazo → 500, depois de o operador esperar tudo isso de tela
// travada. Agora: cache pronto serve na hora; sem cache, o preparo dispara em
// SEGUNDO PLANO (dedup de sempre) e a resposta é um 503 imediato com
// `preparing: true` — que o player usa para avisar e tentar de novo sozinho.

function resFake() {
  const estado: any = { status: 0, headers: {} as Record<string, string>, corpo: null, encerrado: false };
  const res: any = {
    req: { headers: {} },
    status(c: number) { estado.status = c; return res; },
    setHeader(k: string, v: string) { estado.headers[k.toLowerCase()] = String(v); return res; },
    json(b: unknown) { estado.corpo = b; estado.encerrado = true; return res; },
    end() { estado.encerrado = true; return res; },
  };
  return { res, estado };
}

function montar(raiz: string) {
  const svc: any = Object.create(RecordingsService.prototype);
  svc.logger = { warn: () => {}, log: () => {}, error: () => {} };
  svc.ensureRecordingExists = async () => ({ id: 'rec-1', cameraId: 'cam-1', filePath: 'cam-1/x.mp4' });
  return svc;
}

test('sem cache pronto: 503 IMEDIATO com preparing e o preparo disparado em fundo', async (t) => {
  const raiz = mkdtempSync(join(tmpdir(), 'drac-compat-'));
  t.after(() => rmSync(raiz, { recursive: true, force: true }));
  process.env.RECORDINGS_ROOT = raiz;
  t.after(() => { delete process.env.RECORDINGS_ROOT; });

  const svc = montar(raiz);
  let preparoDisparado = 0;
  svc.ensureCompatibleFile = async () => { preparoDisparado += 1; return join(raiz, 'nunca'); };

  const { res, estado } = resFake();
  await svc.streamRecordingCompatible('rec-1', res);

  assert.equal(estado.status, 503, 'a resposta tem de ser imediata, nunca os 5 min do FFmpeg');
  assert.equal((estado.corpo as any)?.preparing, true, 'é o campo que faz o player tentar sozinho');
  assert.equal(estado.headers['retry-after'], '5');
  assert.equal(preparoDisparado, 1, 'o transcode TEM de ter sido disparado em segundo plano');
});

test('cache pronto: serve na hora, sem disparar transcode nenhum', async (t) => {
  const raiz = mkdtempSync(join(tmpdir(), 'drac-compat-'));
  t.after(() => rmSync(raiz, { recursive: true, force: true }));
  process.env.RECORDINGS_ROOT = raiz;
  t.after(() => { delete process.env.RECORDINGS_ROOT; });

  mkdirSync(join(raiz, '.playback-compatible', 'cam-1'), { recursive: true });
  writeFileSync(join(raiz, '.playback-compatible', 'cam-1', 'rec-1.mp4'), Buffer.alloc(2048, 1));

  const svc = montar(raiz);
  let preparoDisparado = 0;
  svc.ensureCompatibleFile = async () => { preparoDisparado += 1; return ''; };
  const entregas: string[] = [];
  svc.entregarArquivo = (_res: unknown, filePath: string) => { entregas.push(filePath); };

  const { res, estado } = resFake();
  await svc.streamRecordingCompatible('rec-1', res);

  assert.equal(preparoDisparado, 0, 'com cache pronto não há trabalho a fazer');
  assert.equal(entregas.length, 1, 'o arquivo do cache é o que sai');
  assert.ok(entregas[0].endsWith('rec-1.mp4'));
  assert.notEqual(estado.status, 503);
});
