// e2e de MÍDIA REAL da playlist VOD contínua.
//
// Os testes unitários (tests/vod-playlist.test.ts) provam a LÓGICA da playlist.
// Aqui provamos que o M3U8 gerado é de fato CONSUMÍVEL por um player: MP4s reais
// gerados por ffmpeg, servidos por um HTTP local com a MESMA forma de URL do
// produto (`/recordings/:id/play?token=…`, com token conferido), e um
// ffprobe/ffmpeg de verdade lendo a playlist de ponta a ponta — inclusive
// atravessando um `#EXT-X-DISCONTINUITY` no meio.
//
// TUDO via docker (a imagem bluenviron/mediamtx:1-ffmpeg traz ffmpeg+ffprobe),
// então roda headless sem depender de ffmpeg instalado no host. Sem docker, o
// teste PULA visível — a menos que DRAC_E2E_REQUIRED=1, quando FALHA em vez de
// passar calado.
//
// Rodar:  node --import tsx --test tests/vod-playlist-media.e2e.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planVodPlaylist, renderVodPlaylist } from '../src/recordings/helpers/vod-playlist.helper';

const IMAGE = process.env.DRAC_E2E_MEDIAMTX_IMAGE ?? 'bluenviron/mediamtx:1-ffmpeg';
const REQUIRED = process.env.DRAC_E2E_REQUIRED === '1';
const SEGMENT_SECONDS = 4;
const TOKEN = 'token-de-playback-fake';

function docker(args: string[]) {
  return spawnSync('docker', args, { encoding: 'utf8', timeout: 180_000 });
}

/**
 * ATENÇÃO: os passos que falam com o HTTP local (ffprobe/ffmpeg lendo a
 * playlist) PRECISAM ser assíncronos. `spawnSync` bloqueia o event loop do
 * mesmo processo que serve os arquivos — o player ficaria esperando para sempre
 * uma resposta que só sai quando o próprio player terminar.
 */
function dockerAsync(args: string[], timeoutMs = 180_000) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

function dockerAvailable() {
  const r = docker(['version', '--format', '{{.Server.Version}}']);
  return r.status === 0;
}

if (!dockerAvailable()) {
  if (REQUIRED) {
    test('vod e2e de mídia OBRIGATÓRIO porém docker indisponível', () => {
      assert.fail('DRAC_E2E_REQUIRED=1 mas docker não respondeu — e2e obrigatório não pode passar sem rodar de verdade.');
    });
  } else {
    test('vod e2e de mídia', { skip: 'docker indisponível' }, () => {});
  }
} else {
  test('playlist VOD com MP4s REAIS é consumível por ffprobe/ffmpeg (inclusive no DISCONTINUITY)', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'drac-vod-media-'));
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    const gid = typeof process.getgid === 'function' ? process.getgid() : null;

    const files: Record<string, string> = {
      'rec-a': join(dir, 'rec-a.mp4'),
      'rec-b': join(dir, 'rec-b.mp4'),
      'rec-c': join(dir, 'rec-c.mp4'),
    };

    const server = createServer((req, res) => {
      const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (parsed.pathname === '/recordings/vod.m3u8') {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end(playlist);
        return;
      }
      // Aceita as DUAS formas do produto: `/play` e o alias `/play.mp4`.
      const match = parsed.pathname.match(/^\/recordings\/([^/]+)\/play(?:\.mp4)?$/);
      // Mesma forma do produto: sem token válido, o arquivo NÃO sai.
      if (!match || parsed.searchParams.get('token') !== TOKEN) {
        res.writeHead(401).end('token invalido');
        return;
      }
      const file = files[match[1]];
      if (!file) {
        res.writeHead(404).end('nao encontrado');
        return;
      }
      const size = statSync(file).size;
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        const start = m && m[1] ? Number(m[1]) : 0;
        const end = m && m[2] ? Number(m[2]) : size - 1;
        res.writeHead(206, {
          'Content-Type': 'video/mp4',
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Content-Length': String(end - start + 1),
          'Accept-Ranges': 'bytes',
        });
        createReadStream(file, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(size), 'Accept-Ranges': 'bytes' });
      createReadStream(file).pipe(res);
    });

    let playlist = '';
    t.after(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        docker(['run', '--rm', '-v', `${dir}:/out`, '--entrypoint', 'sh', IMAGE, '-c', 'rm -rf /out/* || true']);
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    });

    // ── 1. três segmentos MP4 REAIS (H.264), como os que a gravação produz ────
    for (const name of Object.keys(files)) {
      const args = ['run', '--rm', '-v', `${dir}:/out`];
      if (uid !== null && gid !== null) args.push('--user', `${uid}:${gid}`);
      args.push(
        '--entrypoint', 'ffmpeg', IMAGE,
        '-v', 'error',
        '-f', 'lavfi', '-i', `testsrc=size=320x180:rate=15:duration=${SEGMENT_SECONDS}`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '15',
        '-t', String(SEGMENT_SECONDS), '-movflags', '+faststart',
        `/out/${name}.mp4`,
      );
      const gen = docker(args);
      assert.equal(gen.status, 0, `geração do segmento ${name} falhou: ${gen.stderr}`);
      assert.ok(statSync(files[name]).size > 1024, `segmento ${name} vazio`);
    }

    // ── 2. playlist pelo HELPER REAL: a e b contíguos, c depois de um GAP ─────
    const base = Date.UTC(2026, 6, 27, 10, 0, 0);
    const plan = planVodPlaylist({
      segments: [
        { id: 'rec-a', startedAt: new Date(base), endedAt: new Date(base + SEGMENT_SECONDS * 1000) },
        { id: 'rec-b', startedAt: new Date(base + SEGMENT_SECONDS * 1000), endedAt: new Date(base + 2 * SEGMENT_SECONDS * 1000) },
        // buraco de 60s (câmera caiu) → DISCONTINUITY
        { id: 'rec-c', startedAt: new Date(base + 2 * SEGMENT_SECONDS * 1000 + 60_000), endedAt: new Date(base + 3 * SEGMENT_SECONDS * 1000 + 60_000) },
      ],
      from: new Date(base),
      to: new Date(base + 10 * 60_000),
    });
    assert.equal(plan.segments.length, 3);
    assert.equal(plan.discontinuities, 1);

    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port));
    });
    playlist = renderVodPlaylist(plan, (s) => `/recordings/${s.recordingId}/play.mp4?token=${TOKEN}`);
    const playlistUrl = `http://127.0.0.1:${port}/recordings/vod.m3u8`;

    // ── 3. ffprobe LÊ a playlist como um único vídeo contínuo ────────────────
    const probe = await dockerAsync([
      'run', '--rm', '--network', 'host', '--entrypoint', 'ffprobe', IMAGE,
      '-v', 'error',
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
      '-show_entries', 'format=duration,format_name:stream=codec_name,codec_type',
      '-of', 'default=noprint_wrappers=1', playlistUrl,
    ]);
    assert.equal(probe.status, 0, `ffprobe não consumiu a playlist: ${probe.stderr}`);
    assert.match(probe.stdout, /format_name=hls/, `não foi reconhecida como HLS: ${probe.stdout}`);
    assert.match(probe.stdout, /codec_name=h264/, `sem vídeo H.264: ${probe.stdout}`);
    const durationMatch = probe.stdout.match(/duration=([\d.]+)/);
    assert.ok(durationMatch, `duração ausente: ${probe.stdout}`);
    const duration = parseFloat(durationMatch[1]);
    assert.ok(
      Math.abs(duration - 3 * SEGMENT_SECONDS) <= 1.5,
      `duração da playlist ${duration}s deveria somar os 3 segmentos (~${3 * SEGMENT_SECONDS}s) — o buraco NÃO vira tempo morto`,
    );

    // ── 4. decodifica a playlist INTEIRA (atravessa o DISCONTINUITY) ─────────
    const decode = await dockerAsync([
      'run', '--rm', '--network', 'host', '--entrypoint', 'ffmpeg', IMAGE,
      '-v', 'error',
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
      '-i', playlistUrl, '-f', 'null', '-',
    ]);
    assert.equal(decode.status, 0, `decodificação completa da playlist falhou: ${decode.stderr}`);
  });
}
