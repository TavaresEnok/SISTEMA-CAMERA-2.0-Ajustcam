import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { planVodPlaylist, renderVodPlaylist } from '../src/recordings/helpers/vod-playlist.helper';
import { RecordingsService } from '../src/recordings/recordings.service';
import { RecordingsController } from '../src/recordings/recordings.controller';
import type { AuthUser } from '../src/common/types/auth-user.type';

// ─────────────────────────────────────────────────────────────────────────────
// VOD CONTÍNUO — playlist HLS por INTERVALO.
//
// Hoje o playback web troca de ARQUIVO a cada gravação (nova URL, novo token,
// player recarrega) — a "engasgada" ao rever. Aqui provamos a lógica que monta
// UMA playlist VOD listando os vários segmentos do intervalo, com DISCONTINUITY
// só onde a linha do tempo realmente quebra.
//
// O helper é PURO (sem I/O). O serviço adiciona: gate de conteúdo (via
// controller), recorte de janela, existência do arquivo e o token de playback
// JÁ EXISTENTE (nada de autenticação nova).
// ─────────────────────────────────────────────────────────────────────────────

const T = (iso: string) => new Date(iso);
const MIN = 60_000;

function seg(id: string, startIso: string, endIso: string | null, extra: Record<string, unknown> = {}) {
  return { id, startedAt: T(startIso), endedAt: endIso ? T(endIso) : null, ...extra };
}

function url(entry: { recordingId: string }) {
  return `/recordings/${entry.recordingId}/play?token=tok-${entry.recordingId}`;
}

// ── HELPER PURO ──────────────────────────────────────────────────────────────

test('vod helper: 1 segmento gera playlist VOD completa (sem DISCONTINUITY)', () => {
  const plan = planVodPlaylist({
    segments: [seg('r1', '2026-07-27T10:00:00.000Z', '2026-07-27T10:05:00.000Z')],
    from: T('2026-07-27T10:00:00.000Z'),
    to: T('2026-07-27T11:00:00.000Z'),
  });

  assert.equal(plan.segments.length, 1);
  assert.equal(plan.segments[0].durationSeconds, 300);
  assert.equal(plan.segments[0].offsetSeconds, 0);
  assert.equal(plan.segments[0].discontinuity, false);
  assert.equal(plan.totalDurationSeconds, 300);
  assert.equal(plan.targetDurationSeconds, 300);

  const lines = renderVodPlaylist(plan, url).split('\n');
  assert.equal(lines[0], '#EXTM3U');
  assert.ok(lines.includes('#EXT-X-PLAYLIST-TYPE:VOD'), 'playlist precisa se declarar VOD');
  assert.ok(lines.includes('#EXT-X-VERSION:3'));
  assert.ok(lines.includes('#EXT-X-TARGETDURATION:300'));
  assert.ok(lines.includes('#EXTINF:300.000,'));
  assert.ok(lines.includes('/recordings/r1/play?token=tok-r1'));
  assert.equal(lines[lines.length - 1], '#EXT-X-ENDLIST', 'VOD precisa terminar com ENDLIST');
  assert.equal(lines.filter((l) => l === '#EXT-X-DISCONTINUITY').length, 0);
});

test('vod helper: segmentos contíguos NÃO geram DISCONTINUITY e acumulam offset', () => {
  const plan = planVodPlaylist({
    segments: [
      seg('r1', '2026-07-27T10:00:00.000Z', '2026-07-27T10:05:00.000Z'),
      seg('r2', '2026-07-27T10:05:00.000Z', '2026-07-27T10:10:00.000Z'),
      seg('r3', '2026-07-27T10:10:00.000Z', '2026-07-27T10:15:00.000Z'),
    ],
    from: T('2026-07-27T10:00:00.000Z'),
    to: T('2026-07-27T11:00:00.000Z'),
  });

  assert.deepEqual(plan.segments.map((s) => s.offsetSeconds), [0, 300, 600]);
  assert.deepEqual(plan.segments.map((s) => s.discontinuity), [false, false, false]);
  assert.equal(plan.discontinuities, 0);
  assert.equal(plan.totalDurationSeconds, 900);

  const playlist = renderVodPlaylist(plan, url);
  assert.equal(playlist.includes('#EXT-X-DISCONTINUITY'), false, 'linha do tempo contínua não pode ter DISCONTINUITY');
  assert.equal(playlist.match(/#EXTINF:/g)?.length, 3);
});

test('vod helper: GAP gera EXATAMENTE uma DISCONTINUITY, imediatamente antes do segmento pós-gap', () => {
  const plan = planVodPlaylist({
    segments: [
      seg('r1', '2026-07-27T10:00:00.000Z', '2026-07-27T10:05:00.000Z'),
      // 60s de buraco (câmera caiu) antes de r2
      seg('r2', '2026-07-27T10:06:00.000Z', '2026-07-27T10:11:00.000Z'),
      seg('r3', '2026-07-27T10:11:00.000Z', '2026-07-27T10:16:00.000Z'),
    ],
    from: T('2026-07-27T10:00:00.000Z'),
    to: T('2026-07-27T11:00:00.000Z'),
  });

  assert.deepEqual(plan.segments.map((s) => s.discontinuity), [false, true, false]);
  assert.equal(plan.segments[1].discontinuityReason, 'gap');
  assert.equal(plan.discontinuities, 1);

  const lines = renderVodPlaylist(plan, url).split('\n');
  assert.equal(lines.filter((l) => l === '#EXT-X-DISCONTINUITY').length, 1);
  const r2Line = lines.indexOf('/recordings/r2/play?token=tok-r2');
  const r1Line = lines.indexOf('/recordings/r1/play?token=tok-r1');
  const discLine = lines.indexOf('#EXT-X-DISCONTINUITY');
  assert.ok(discLine > r1Line, 'DISCONTINUITY vem DEPOIS do segmento anterior ao buraco');
  assert.ok(discLine < r2Line, 'DISCONTINUITY vem ANTES do segmento que sucede o buraco');
  // e antes do EXTINF do r2 (a tag pertence ao segmento seguinte)
  assert.equal(lines[r2Line - 1].startsWith('#EXTINF:'), true);
});

test('vod helper: sobreposição entre segmentos também quebra a continuidade', () => {
  const plan = planVodPlaylist({
    segments: [
      seg('r1', '2026-07-27T10:00:00.000Z', '2026-07-27T10:05:00.000Z'),
      seg('r2', '2026-07-27T10:04:00.000Z', '2026-07-27T10:09:00.000Z'),
    ],
    from: T('2026-07-27T10:00:00.000Z'),
    to: T('2026-07-27T11:00:00.000Z'),
  });
  assert.deepEqual(plan.segments.map((s) => s.discontinuity), [false, true]);
  assert.equal(plan.segments[1].discontinuityReason, 'overlap');
});

test('vod helper: TARGETDURATION é o TETO arredondado da MAIOR duração', () => {
  const plan = planVodPlaylist({
    segments: [
      seg('r1', '2026-07-27T10:00:00.000Z', '2026-07-27T10:02:00.000Z'), // 120s
      seg('r2', '2026-07-27T10:02:00.000Z', '2026-07-27T10:07:01.400Z'), // 301.4s
      seg('r3', '2026-07-27T10:07:01.400Z', '2026-07-27T10:09:01.400Z'), // 120s
    ],
    from: T('2026-07-27T10:00:00.000Z'),
    to: T('2026-07-27T11:00:00.000Z'),
  });
  assert.equal(plan.targetDurationSeconds, 302, 'teto de 301.4 é 302');
  assert.ok(renderVodPlaylist(plan, url).includes('#EXT-X-TARGETDURATION:302'));
  assert.ok(renderVodPlaylist(plan, url).includes('#EXTINF:301.400,'));
});

test('vod helper: informa o offset do início pedido DENTRO do primeiro segmento', () => {
  const plan = planVodPlaylist({
    segments: [
      seg('r1', '2026-07-27T10:00:00.000Z', '2026-07-27T10:05:00.000Z'),
      seg('r2', '2026-07-27T10:05:00.000Z', '2026-07-27T10:10:00.000Z'),
    ],
    // pedido começa 2min30 DENTRO do primeiro segmento
    from: T('2026-07-27T10:02:30.000Z'),
    to: T('2026-07-27T10:09:00.000Z'),
  });
  assert.equal(plan.segments.length, 2, 'o segmento que cruza a borda entra inteiro');
  assert.equal(plan.startOffsetSeconds, 150, 'o player deve buscar 150s dentro da playlist');
});

test('vod helper: offset é 0 quando o intervalo começa antes do primeiro segmento', () => {
  const plan = planVodPlaylist({
    segments: [seg('r1', '2026-07-27T10:00:00.000Z', '2026-07-27T10:05:00.000Z')],
    from: T('2026-07-27T09:00:00.000Z'),
    to: T('2026-07-27T11:00:00.000Z'),
  });
  assert.equal(plan.startOffsetSeconds, 0);
});

test('vod helper: recorte inclui quem CRUZA a borda e exclui quem só encosta', () => {
  const plan = planVodPlaylist({
    segments: [
      seg('fora-antes', '2026-07-27T09:50:00.000Z', '2026-07-27T09:55:00.000Z'),
      seg('encosta-inicio', '2026-07-27T09:57:00.000Z', '2026-07-27T10:02:00.000Z'), // termina EM from
      seg('cruza-inicio', '2026-07-27T09:58:00.000Z', '2026-07-27T10:03:00.000Z'),
      seg('dentro', '2026-07-27T10:03:00.000Z', '2026-07-27T10:06:00.000Z'),
      seg('cruza-fim', '2026-07-27T10:06:00.000Z', '2026-07-27T10:11:00.000Z'),
      seg('encosta-fim', '2026-07-27T10:07:00.000Z', '2026-07-27T10:12:00.000Z'), // começa EM to
      seg('fora-depois', '2026-07-27T10:20:00.000Z', '2026-07-27T10:25:00.000Z'),
    ],
    from: T('2026-07-27T10:02:00.000Z'),
    to: T('2026-07-27T10:07:00.000Z'),
  });
  assert.deepEqual(plan.segments.map((s) => s.recordingId), ['cruza-inicio', 'dentro', 'cruza-fim']);
});

test('vod helper: intervalo sem gravação vira plano vazio e playlist ainda estruturalmente válida', () => {
  const plan = planVodPlaylist({
    segments: [seg('r1', '2026-07-27T10:00:00.000Z', '2026-07-27T10:05:00.000Z')],
    from: T('2026-07-27T20:00:00.000Z'),
    to: T('2026-07-27T21:00:00.000Z'),
  });
  assert.equal(plan.segments.length, 0);
  assert.equal(plan.totalDurationSeconds, 0);
  assert.equal(plan.startOffsetSeconds, 0);

  const lines = renderVodPlaylist(plan, url).split('\n');
  assert.equal(lines[0], '#EXTM3U');
  assert.ok(lines.includes('#EXT-X-TARGETDURATION:1'), 'TARGETDURATION precisa ser >= 1 mesmo vazio');
  assert.equal(lines[lines.length - 1], '#EXT-X-ENDLIST');
  assert.equal(lines.some((l) => l.startsWith('#EXTINF:')), false);
});

test('vod helper: troca de codec entre segmentos contíguos gera DISCONTINUITY', () => {
  const plan = planVodPlaylist({
    segments: [
      seg('r1', '2026-07-27T10:00:00.000Z', '2026-07-27T10:05:00.000Z', { codec: 'h264' }),
      seg('r2', '2026-07-27T10:05:00.000Z', '2026-07-27T10:10:00.000Z', { codec: 'hevc' }),
      seg('r3', '2026-07-27T10:10:00.000Z', '2026-07-27T10:15:00.000Z', { codec: 'hevc' }),
    ],
    from: T('2026-07-27T10:00:00.000Z'),
    to: T('2026-07-27T11:00:00.000Z'),
  });
  assert.deepEqual(plan.segments.map((s) => s.discontinuity), [false, true, false]);
  assert.equal(plan.segments[1].discontinuityReason, 'codec');
});

test('vod helper: codec desconhecido (null) NÃO inventa DISCONTINUITY', () => {
  const plan = planVodPlaylist({
    segments: [
      seg('r1', '2026-07-27T10:00:00.000Z', '2026-07-27T10:05:00.000Z', { codec: 'h264' }),
      seg('r2', '2026-07-27T10:05:00.000Z', '2026-07-27T10:10:00.000Z', { codec: null }),
    ],
    from: T('2026-07-27T10:00:00.000Z'),
    to: T('2026-07-27T11:00:00.000Z'),
  });
  assert.deepEqual(plan.segments.map((s) => s.discontinuity), [false, false]);
});

test('vod helper: duração cai para durationSeconds quando endedAt falta; sem nenhuma, descarta', () => {
  const plan = planVodPlaylist({
    segments: [
      seg('sem-fim', '2026-07-27T10:00:00.000Z', null, { durationSeconds: 300 }),
      seg('sem-nada', '2026-07-27T10:05:00.000Z', null),
      seg('normal', '2026-07-27T10:05:00.000Z', '2026-07-27T10:10:00.000Z'),
    ],
    from: T('2026-07-27T10:00:00.000Z'),
    to: T('2026-07-27T11:00:00.000Z'),
  });
  assert.deepEqual(plan.segments.map((s) => s.recordingId), ['sem-fim', 'normal']);
  assert.equal(plan.segments[0].durationSeconds, 300);
  assert.equal(plan.skipped, 1);
  assert.deepEqual(plan.segments.map((s) => s.discontinuity), [false, false]);
});

test('vod helper: maxSegments trunca a playlist e sinaliza truncated', () => {
  const segments = Array.from({ length: 10 }, (_, i) =>
    seg(`r${i}`, new Date(Date.UTC(2026, 6, 27, 10, i * 5)).toISOString(), new Date(Date.UTC(2026, 6, 27, 10, (i + 1) * 5)).toISOString()),
  );
  const plan = planVodPlaylist({
    segments,
    from: T('2026-07-27T10:00:00.000Z'),
    to: T('2026-07-27T12:00:00.000Z'),
    maxSegments: 4,
  });
  assert.equal(plan.segments.length, 4);
  assert.equal(plan.truncated, true);
  assert.deepEqual(plan.segments.map((s) => s.recordingId), ['r0', 'r1', 'r2', 'r3']);
});

test('vod helper: cada segmento carrega PROGRAM-DATE-TIME do instante real', () => {
  const plan = planVodPlaylist({
    segments: [seg('r1', '2026-07-27T10:00:00.000Z', '2026-07-27T10:05:00.000Z')],
    from: T('2026-07-27T10:00:00.000Z'),
    to: T('2026-07-27T11:00:00.000Z'),
  });
  assert.ok(renderVodPlaylist(plan, url).includes('#EXT-X-PROGRAM-DATE-TIME:2026-07-27T10:00:00.000Z'));
});

test('vod helper: entrada fora de ordem é ordenada por tempo antes de montar', () => {
  const plan = planVodPlaylist({
    segments: [
      seg('r2', '2026-07-27T10:05:00.000Z', '2026-07-27T10:10:00.000Z'),
      seg('r1', '2026-07-27T10:00:00.000Z', '2026-07-27T10:05:00.000Z'),
    ],
    from: T('2026-07-27T10:00:00.000Z'),
    to: T('2026-07-27T11:00:00.000Z'),
  });
  assert.deepEqual(plan.segments.map((s) => s.recordingId), ['r1', 'r2']);
  assert.equal(plan.discontinuities, 0);
});

// ── SERVIÇO ──────────────────────────────────────────────────────────────────

type FakeRec = { id: string; cameraId: string; startedAt: Date; endedAt: Date | null; durationSeconds: number | null; filePath: string };

function makeServiceFixture(records: FakeRec[], filesOnDisk: string[], canView = true) {
  const root = mkdtempSync(join(tmpdir(), 'drac-vod-'));
  for (const rel of filesOnDisk) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, Buffer.alloc(4096, 1));
  }
  const previousRoot = process.env.RECORDINGS_ROOT;
  process.env.RECORDINGS_ROOT = root;

  const queries: any[] = [];
  const svc: any = Object.create(RecordingsService.prototype);
  svc.prisma = {
    recording: {
      findMany: async (args: any) => {
        queries.push(args);
        const where = args.where ?? {};
        return records
          .filter((r) => r.cameraId === where.cameraId)
          .filter((r) => {
            const gte = where.startedAt?.gte ? r.startedAt >= where.startedAt.gte : true;
            const lte = where.startedAt?.lte ? r.startedAt <= where.startedAt.lte : true;
            return gte && lte;
          })
          .filter((r) => {
            // espelha o OR do Prisma: fechada que termina depois de `from` OU aberta
            const or = where.OR as Array<any> | undefined;
            if (!or) return true;
            return or.some((cond) => {
              if (cond.endedAt === null) return r.endedAt === null;
              if (cond.endedAt?.gte) return r.endedAt !== null && r.endedAt >= cond.endedAt.gte;
              return false;
            });
          })
          .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
          .map((r) => ({ ...r }));
      },
    },
  };
  // Gate único de conteúdo, espelhando a inversão da câmera privada: quem não
  // pode VER leva ForbiddenException (mesmo contrato do AccessControlService).
  svc.accessControlService = {
    assertCanPlaybackCamera: async () => {
      if (!canView) throw new ForbiddenException('Sem acesso ao conteúdo desta câmera.');
    },
  };
  const tokenCalls: Array<{ userId: string; recordingId: string }> = [];
  svc.authService = {
    createPlaybackToken: async (userId: string, recordingId: string) => {
      tokenCalls.push({ userId, recordingId });
      return { playToken: `jwt-${recordingId}`, expiresAt: new Date(Date.now() + 300_000).toISOString() };
    },
  };
  const cleanup = () => {
    if (previousRoot === undefined) delete process.env.RECORDINGS_ROOT;
    else process.env.RECORDINGS_ROOT = previousRoot;
    rmSync(root, { recursive: true, force: true });
  };
  return { svc: svc as RecordingsService, tokenCalls, queries, root, cleanup };
}

const viewer: AuthUser = { id: 'u-viewer', email: 'v@test.local', name: 'Viewer', role: UserRole.VIEWER };

const BASE_RECORDS: FakeRec[] = [
  {
    id: 'rec-1',
    cameraId: 'cam-1',
    startedAt: T('2026-07-27T10:00:00.000Z'),
    endedAt: T('2026-07-27T10:05:00.000Z'),
    durationSeconds: 300,
    filePath: 'cam-1/10-00-00.mp4',
  },
  {
    id: 'rec-2',
    cameraId: 'cam-1',
    startedAt: T('2026-07-27T10:05:00.000Z'),
    endedAt: T('2026-07-27T10:10:00.000Z'),
    durationSeconds: 300,
    filePath: 'cam-1/10-05-00.mp4',
  },
  {
    id: 'rec-sumido',
    cameraId: 'cam-1',
    startedAt: T('2026-07-27T10:10:00.000Z'),
    endedAt: T('2026-07-27T10:15:00.000Z'),
    durationSeconds: 300,
    filePath: 'cam-1/10-10-00.mp4',
  },
];

test('vod service: playlist aponta para o endpoint de arquivo EXISTENTE com token de playback', async (t) => {
  const fx = makeServiceFixture(BASE_RECORDS, ['cam-1/10-00-00.mp4', 'cam-1/10-05-00.mp4']);
  t.after(fx.cleanup);

  const result: any = await (fx.svc as any).buildVodPlaylist(viewer, {
    cameraId: 'cam-1',
    from: '2026-07-27T10:00:00.000Z',
    to: '2026-07-27T10:20:00.000Z',
  });

  assert.equal(result.segmentCount, 2);
  // URL RELATIVA: a playlist é servida sob um prefixo que a API não enxerga
  // (`/api/` reescrito pelo nginx). Absoluta (`/recordings/...`) mandava VLC e
  // ffmpeg para a raiz do domínio — ou seja, para a SPA em vez da API.
  assert.ok(result.playlist.includes('rec-1/play.mp4?token=jwt-rec-1'));
  assert.ok(result.playlist.includes('rec-2/play.mp4?token=jwt-rec-2'));
  assert.ok(!/^\/recordings\//m.test(result.playlist), 'nenhuma URL de segmento pode ser absoluta');
  assert.deepEqual(fx.tokenCalls, [
    { userId: 'u-viewer', recordingId: 'rec-1' },
    { userId: 'u-viewer', recordingId: 'rec-2' },
  ], 'usa createPlaybackToken (mecanismo atual), um token por segmento do dono da sessão');
  assert.equal(result.segments[0].playUrl, 'rec-1/play.mp4?token=jwt-rec-1');
});

test('vod service: URL do segmento termina em .mp4 ANTES da query', async (t) => {
  // MEDIDO com ffprobe 8.0.1: player baseado em ffmpeg >= 7 RECUSA segmento HLS
  // cuja URL não termina em extensão de mídia conhecida ("is not in
  // allowed_segment_extensions"). Sem o sufixo, a playlist só tocaria no hls.js.
  const fx = makeServiceFixture(BASE_RECORDS, ['cam-1/10-00-00.mp4']);
  t.after(fx.cleanup);
  const result: any = await (fx.svc as any).buildVodPlaylist(viewer, {
    cameraId: 'cam-1',
    from: '2026-07-27T10:00:00.000Z',
    to: '2026-07-27T10:20:00.000Z',
  });
  const [path] = result.segments[0].playUrl.split('?');
  assert.ok(path.endsWith('.mp4'), `caminho do segmento precisa terminar em .mp4: ${result.segments[0].playUrl}`);
  assert.ok(result.segments[0].playUrl.includes('?token='), 'token continua na query (mecanismo atual)');
});

test('vod service: segmento sem arquivo no disco NÃO entra na playlist', async (t) => {
  const fx = makeServiceFixture(BASE_RECORDS, ['cam-1/10-00-00.mp4', 'cam-1/10-05-00.mp4']);
  t.after(fx.cleanup);

  const result: any = await (fx.svc as any).buildVodPlaylist(viewer, {
    cameraId: 'cam-1',
    from: '2026-07-27T10:00:00.000Z',
    to: '2026-07-27T10:20:00.000Z',
  });
  assert.equal(result.playlist.includes('rec-sumido'), false, 'arquivo ausente viraria 404 no meio do vídeo');
  assert.equal(result.segments.length, 2);
});

test('vod service: o PRODUTOR de tokens também respeita o gate (defesa em profundidade)', async (t) => {
  // Mesmo princípio do createThumbnailTokens (thumbnail-token-gate.test.ts): quem
  // EMITE token de conteúdo confere o gate, sem depender de o chamador ter feito.
  const fx = makeServiceFixture(BASE_RECORDS, ['cam-1/10-00-00.mp4', 'cam-1/10-05-00.mp4'], false);
  t.after(fx.cleanup);
  await assert.rejects(
    () => (fx.svc as any).buildVodPlaylist(viewer, {
      cameraId: 'cam-1',
      from: '2026-07-27T10:00:00.000Z',
      to: '2026-07-27T10:20:00.000Z',
    }),
    ForbiddenException,
  );
  assert.deepEqual(fx.tokenCalls, [], 'nenhum token de conteúdo pode ser emitido para quem não vê a câmera');
  assert.deepEqual(fx.queries, [], 'nem sequer consulta as gravações da câmera negada');
});

test('vod service: janela maior que o teto (24h) é rejeitada', async (t) => {
  const fx = makeServiceFixture(BASE_RECORDS, ['cam-1/10-00-00.mp4']);
  t.after(fx.cleanup);
  await assert.rejects(
    () => (fx.svc as any).buildVodPlaylist(viewer, {
      cameraId: 'cam-1',
      from: '2026-07-26T09:00:00.000Z',
      to: '2026-07-27T10:00:00.000Z',
    }),
    BadRequestException,
  );
});

test('vod service: intervalo invertido ou data inválida é rejeitado', async (t) => {
  const fx = makeServiceFixture(BASE_RECORDS, ['cam-1/10-00-00.mp4']);
  t.after(fx.cleanup);
  await assert.rejects(
    () => (fx.svc as any).buildVodPlaylist(viewer, { cameraId: 'cam-1', from: '2026-07-27T11:00:00.000Z', to: '2026-07-27T10:00:00.000Z' }),
    BadRequestException,
  );
  await assert.rejects(
    () => (fx.svc as any).buildVodPlaylist(viewer, { cameraId: 'cam-1', from: 'nao-e-data', to: '2026-07-27T10:00:00.000Z' }),
    BadRequestException,
  );
});

test('vod service: intervalo sem gravação utilizável responde 404 (e não emite token)', async (t) => {
  const fx = makeServiceFixture(BASE_RECORDS, ['cam-1/10-00-00.mp4']);
  t.after(fx.cleanup);
  await assert.rejects(
    () => (fx.svc as any).buildVodPlaylist(viewer, {
      cameraId: 'cam-1',
      from: '2026-07-27T20:00:00.000Z',
      to: '2026-07-27T21:00:00.000Z',
    }),
    NotFoundException,
  );
  assert.deepEqual(fx.tokenCalls, [], 'sem segmento não há token de conteúdo emitido');
});

test('vod service: consulta o banco só da câmera pedida e com janela limitada', async (t) => {
  const fx = makeServiceFixture(BASE_RECORDS, ['cam-1/10-00-00.mp4', 'cam-1/10-05-00.mp4']);
  t.after(fx.cleanup);
  await (fx.svc as any).buildVodPlaylist(viewer, {
    cameraId: 'cam-1',
    from: '2026-07-27T10:00:00.000Z',
    to: '2026-07-27T10:20:00.000Z',
  });
  const where = fx.queries[0].where;
  assert.equal(where.cameraId, 'cam-1', 'jamais varrer outras câmeras');
  assert.ok(where.startedAt.lte instanceof Date);
  assert.ok(where.startedAt.gte instanceof Date);
  assert.ok(where.startedAt.gte.getTime() < T('2026-07-27T10:00:00.000Z').getTime(), 'precisa de lookback p/ pegar o segmento que cruza a borda');
  assert.ok(fx.queries[0].take > 0, 'consulta precisa ser limitada');
});

test('vod service: usa o codec do cache de diagnóstico quando existe (DISCONTINUITY real)', async (t) => {
  const fx = makeServiceFixture(BASE_RECORDS, ['cam-1/10-00-00.mp4', 'cam-1/10-05-00.mp4']);
  t.after(fx.cleanup);
  const cacheDir = join(fx.root, '.diagnostics-cache');
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    join(cacheDir, 'recording-health.json'),
    JSON.stringify({
      'rec-1': { checkedAt: new Date().toISOString(), diagnostics: { video: { codec: 'h264' } } },
      'rec-2': { checkedAt: new Date().toISOString(), diagnostics: { video: { codec: 'hevc' } } },
    }),
  );

  const result: any = await (fx.svc as any).buildVodPlaylist(viewer, {
    cameraId: 'cam-1',
    from: '2026-07-27T10:00:00.000Z',
    to: '2026-07-27T10:20:00.000Z',
  });
  assert.equal(result.playlist.includes('#EXT-X-DISCONTINUITY'), true);
  assert.equal(result.segments[1].discontinuityReason, 'codec');
});

// ── CONTROLLER (gate de conteúdo — invariante da câmera privada) ─────────────

function makeRes() {
  const headers: Record<string, string> = {};
  const sent: any[] = [];
  return {
    headers,
    sent,
    res: {
      setHeader: (k: string, v: string) => {
        headers[k] = v;
      },
      send: (body: any) => {
        sent.push({ kind: 'send', body });
        return body;
      },
      json: (body: any) => {
        sent.push({ kind: 'json', body });
        return body;
      },
    } as any,
  };
}

function makeController(opts: { canView: boolean; order: string[] }) {
  const access = {
    // Gate de HISTÓRICO: nestes testes espelha o de view (o que importa
    // é que o gate seja chamado antes de servir conteúdo).
    assertCanPlaybackCamera: async (...args: any[]) => (access as any).assertCanViewCamera(...args),
    assertCanViewCamera: async (_u: AuthUser, cameraId: string) => {
      opts.order.push(`access:${cameraId}`);
      if (!opts.canView) throw new ForbiddenException('Sem acesso à câmera.');
    },
  };
  const recordings = {
    buildVodPlaylist: async (_u: AuthUser, params: any) => {
      opts.order.push(`vod:${params.cameraId}`);
      return {
        cameraId: params.cameraId,
        from: params.from,
        to: params.to,
        playlist: '#EXTM3U\n#EXT-X-ENDLIST',
        segmentCount: 1,
        startOffsetSeconds: 12.5,
        totalDurationSeconds: 300,
        targetDurationSeconds: 300,
        discontinuities: 0,
        truncated: false,
        segments: [{ recordingId: 'rec-1', playUrl: '/recordings/rec-1/play?token=jwt' }],
      };
    },
  };
  const audit = { log: async () => opts.order.push('audit') };
  return new RecordingsController({} as any, recordings as any, {} as any, {} as any, access as any, audit as any);
}

test('vod controller: aplica assertCanPlaybackCamera ANTES de montar a playlist', async () => {
  const order: string[] = [];
  const controller: any = makeController({ canView: true, order });
  const { res, headers, sent } = makeRes();

  await controller.getVodPlaylist(viewer, 'cam-1', '2026-07-27T10:00:00.000Z', '2026-07-27T10:20:00.000Z', undefined, { headers: {} } as any, res);

  assert.deepEqual(order, ['access:cam-1', 'vod:cam-1', 'audit']);
  assert.equal(headers['Content-Type'], 'application/vnd.apple.mpegurl');
  assert.equal(headers['X-Drac-Vod-Start-Offset-Seconds'], '12.5');
  assert.equal(sent[0].kind, 'send');
  assert.ok(String(sent[0].body).startsWith('#EXTM3U'));
});

test('vod controller: câmera PRIVADA alheia — gate nega e a playlist NUNCA é montada', async () => {
  const order: string[] = [];
  const controller: any = makeController({ canView: false, order });
  const { res } = makeRes();

  await assert.rejects(
    () => controller.getVodPlaylist(viewer, 'cam-private', '2026-07-27T10:00:00.000Z', '2026-07-27T10:20:00.000Z', undefined, { headers: {} } as any, res),
    ForbiddenException,
  );
  assert.deepEqual(order, ['access:cam-private'], 'o serviço de VOD não pode ser chamado sem passar pelo gate');
});

test('vod controller: cameraId ausente é BadRequest (não vaza playlist de outra câmera)', async () => {
  const order: string[] = [];
  const controller: any = makeController({ canView: true, order });
  const { res } = makeRes();
  await assert.rejects(
    () => controller.getVodPlaylist(viewer, undefined, '2026-07-27T10:00:00.000Z', '2026-07-27T10:20:00.000Z', undefined, { headers: {} } as any, res),
    BadRequestException,
  );
  assert.deepEqual(order, []);
});

test('vod controller: alias /play.mp4 delega ao MESMO playback (mesmo token, mesmo gate)', async () => {
  const order: string[] = [];
  const auth = {
    verifyPlaybackToken: async (token: string) => {
      order.push(`verify:${token}`);
      return { sub: 'u-viewer', recordingId: 'rec-1', type: 'play' };
    },
    me: async (id: string) => {
      order.push(`me:${id}`);
      return viewer;
    },
  };
  const recordings = {
    ensureRecordingExists: async (id: string) => {
      order.push(`recording:${id}`);
      return { id, cameraId: 'cam-1' };
    },
    shouldPreferCompatiblePlayback: async () => false,
    streamRecording: async (id: string) => {
      order.push(`stream:${id}`);
      return 'streamed';
    },
  };
  const access = {
    // Gate de HISTÓRICO: nestes testes espelha o de view (o que importa
    // é que o gate seja chamado antes de servir conteúdo).
    assertCanPlaybackCamera: async (...args: any[]) => (access as any).assertCanViewCamera(...args),
    assertCanViewCamera: async (_u: AuthUser, cameraId: string) => order.push(`access:${cameraId}`),
  };
  const audit = { log: async () => order.push('audit') };
  const controller: any = new RecordingsController({} as any, recordings as any, {} as any, auth as any, access as any, audit as any);

  const result = await controller.playRecordingAsMp4('rec-1', 'tok', undefined, undefined, { headers: {} } as any, {} as any);

  assert.equal(result, 'streamed');
  assert.deepEqual(order, ['verify:tok', 'me:u-viewer', 'recording:rec-1', 'access:cam-1', 'audit', 'stream:rec-1']);
});

test('vod controller: alias /play.mp4 rejeita token de OUTRA gravação (gate intacto)', async () => {
  const auth = { verifyPlaybackToken: async () => ({ sub: 'u-viewer', recordingId: 'rec-outra', type: 'play' }) };
  const controller: any = new RecordingsController({} as any, {} as any, {} as any, auth as any, {} as any, {} as any);
  await assert.rejects(
    () => controller.playRecordingAsMp4('rec-1', 'tok', undefined, undefined, { headers: {} } as any, {} as any),
    /Token inválido/,
  );
});

test('vod controller: format=json devolve o plano (offsets) em JSON', async () => {
  const order: string[] = [];
  const controller: any = makeController({ canView: true, order });
  const { res, headers, sent } = makeRes();

  await controller.getVodPlaylist(viewer, 'cam-1', '2026-07-27T10:00:00.000Z', '2026-07-27T10:20:00.000Z', 'json', { headers: {} } as any, res);

  assert.equal(sent[0].kind, 'json');
  assert.equal(sent[0].body.startOffsetSeconds, 12.5);
  assert.equal(sent[0].body.segments[0].recordingId, 'rec-1');
  assert.ok(headers['Content-Type'].startsWith('application/json'));
});
