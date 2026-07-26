// e2e do PIPELINE de vídeo contra uma fonte RTSP SINTÉTICA (item 0.3 do
// docs/PLANO-EVOLUCAO-DRAC.md). Diferente do operational-e2e (que cobre CRUD via
// HTTP), este exercita o caminho REAL de streaming→gravação: prova que uma fonte
// RTSP viva é probável e que a técnica canônica do DRAC (remux `-c copy` para MP4
// segmentado, SEM reencode) produz um arquivo válido e com duração correta.
//
// TUDO via docker (a imagem bluenviron/mediamtx:1-ffmpeg traz ffmpeg+ffprobe), então
// roda headless no host e no CI sem depender de ffmpeg instalado localmente.
//
// Configuração vem da fixture `scripts/e2e-rtsp-fixture.sh` (exporta DRAC_E2E_RTSP_URL).
// Gate anti-teatro: sem DRAC_E2E_RTSP_URL o teste PULA — a MENOS que
// DRAC_E2E_REQUIRED=1 (contexto obrigatório, ex.: CI), quando então FALHA em vez de
// passar calado. Rode localmente com: `scripts/e2e-rtsp-fixture.sh run`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RTSP_URL = process.env.DRAC_E2E_RTSP_URL ?? '';
const REQUIRED = process.env.DRAC_E2E_REQUIRED === '1';
const IMAGE = process.env.DRAC_E2E_MEDIAMTX_IMAGE ?? 'bluenviron/mediamtx:1-ffmpeg';
const NETWORK = process.env.DRAC_E2E_DOCKER_NETWORK ?? 'host';
const RECORD_SECONDS = Number(process.env.DRAC_E2E_RECORD_SECONDS ?? '4');

function docker(args: string[]) {
  return spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000 });
}

if (!RTSP_URL) {
  // Sem fonte configurada: em contexto obrigatório é ERRO (não deixa CI passar
  // calado sem rodar o pipeline); fora dele, pula visível.
  if (REQUIRED) {
    test('pipeline RTSP e2e OBRIGATÓRIO porém não configurado', () => {
      assert.fail(
        'DRAC_E2E_REQUIRED=1 mas DRAC_E2E_RTSP_URL ausente. Suba a fixture antes ' +
          '(scripts/e2e-rtsp-fixture.sh) — um e2e obrigatório não pode passar sem rodar de verdade.',
      );
    });
  } else {
    test('pipeline RTSP e2e', { skip: 'sem DRAC_E2E_RTSP_URL — rode: scripts/e2e-rtsp-fixture.sh run' }, () => {});
  }
} else {
  test('docker disponível para o e2e', () => {
    const r = docker(['version', '--format', '{{.Server.Version}}']);
    assert.equal(r.status, 0, `docker indisponível: ${r.stderr || r.error}`);
  });

  test('fonte RTSP sintética é probável: tem vídeo H.264 e áudio AAC', () => {
    const r = docker([
      'run', '--rm', '--network', NETWORK, '--entrypoint', 'ffprobe', IMAGE,
      '-v', 'error', '-rtsp_transport', 'tcp',
      '-show_entries', 'stream=codec_name,codec_type,width,height',
      '-of', 'default=noprint_wrappers=1', RTSP_URL,
    ]);
    assert.equal(r.status, 0, `ffprobe da fonte falhou: ${r.stderr}`);
    assert.match(r.stdout, /codec_type=video/, `sem stream de vídeo: ${r.stdout}`);
    assert.match(r.stdout, /codec_name=h264/, `vídeo não é H.264: ${r.stdout}`);
    assert.match(r.stdout, /codec_type=audio/, `sem stream de áudio: ${r.stdout}`);
    assert.match(r.stdout, /codec_name=aac/, `áudio não é AAC: ${r.stdout}`);
  });

  test(`grava ${RECORD_SECONDS}s via -c copy → MP4 válido (H.264) com duração ≈ ${RECORD_SECONDS}s`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'drac-e2e-rec-'));
    // Roda o ffmpeg como o usuário atual (quando possível) para o arquivo de saída
    // ser removível fora de /tmp sticky; fora do Linux, limpa via container.
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    const gid = typeof process.getgid === 'function' ? process.getgid() : null;
    try {
      const recArgs = ['run', '--rm', '--network', NETWORK, '-v', `${dir}:/out`];
      if (uid !== null && gid !== null) recArgs.push('--user', `${uid}:${gid}`);
      recArgs.push(
        '--entrypoint', 'ffmpeg', IMAGE,
        '-v', 'error', '-rtsp_transport', 'tcp', '-i', RTSP_URL,
        '-t', String(RECORD_SECONDS), '-c', 'copy', '-f', 'mp4', '-movflags', '+faststart',
        '/out/seg.mp4',
      );
      const rec = docker(recArgs);
      assert.equal(rec.status, 0, `gravação (-c copy) falhou: ${rec.stderr}`);

      const st = statSync(join(dir, 'seg.mp4'));
      assert.ok(st.size > 1000, `segmento vazio/curto demais: ${st.size} bytes`);

      const probe = docker([
        'run', '--rm', '-v', `${dir}:/out`, '--entrypoint', 'ffprobe', IMAGE,
        '-v', 'error',
        '-show_entries', 'format=duration:stream=codec_name,codec_type',
        '-of', 'default=noprint_wrappers=1', '/out/seg.mp4',
      ]);
      assert.equal(probe.status, 0, `ffprobe do segmento falhou: ${probe.stderr}`);
      assert.match(probe.stdout, /codec_name=h264/, `segmento não preservou H.264 (reencode?): ${probe.stdout}`);
      const m = probe.stdout.match(/duration=([\d.]+)/);
      assert.ok(m, `duração ausente no probe: ${probe.stdout}`);
      const dur = parseFloat(m[1]);
      assert.ok(
        Math.abs(dur - RECORD_SECONDS) <= 1.5,
        `duração gravada ${dur}s fora do esperado (~${RECORD_SECONDS}s)`,
      );
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        docker(['run', '--rm', '-v', `${dir}:/out`, '--entrypoint', 'sh', IMAGE, '-c', 'rm -rf /out/* || true']);
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  });
}
