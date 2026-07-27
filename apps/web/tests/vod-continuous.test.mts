import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_PLAY_TOKEN_TTL_SECONDS,
  absoluteToVodPosition,
  decodeJwtExpiryMs,
  isPlaybackTokenUsable,
  locateVodSegment,
  nextVodSegment,
  normalizeVodPlaylist,
  refreshSegmentUrl,
  resolveInitialSeekSeconds,
  segmentTokens,
  shouldAbortStalledSwap,
  shouldPrefetchNextSegment,
  shouldRenewPlaylist,
  vodPositionToAbsoluteMs,
  type VodPlaylist,
} from '../src/lib/vod-continuous.ts';

// A playlist VOD é a linha do tempo CONTÍNUA do dia: o backend
// (apps/api/src/recordings/helpers/vod-playlist.helper.ts) devolve os segmentos
// já ordenados, com duração real e offset acumulado. Estes testes cobrem o que o
// front faz com ela: converter instante absoluto <-> posição contínua, decidir
// quando renovar os tokens ANTES de expirarem e cair no caminho antigo quando a
// playlist não serve.

const T0 = Date.parse('2026-07-27T08:00:00.000Z');

function rawSegment(index: number, options: Partial<Record<string, unknown>> = {}) {
  const startMs = T0 + index * 300_000;
  return {
    recordingId: `rec-${index}`,
    startedAt: new Date(startMs).toISOString(),
    endedAt: new Date(startMs + 300_000).toISOString(),
    durationSeconds: 300,
    offsetSeconds: index * 300,
    discontinuity: false,
    discontinuityReason: null,
    codec: 'h264',
    playUrl: `/recordings/rec-${index}/play.mp4?token=tok-${index}`,
    ...options,
  };
}

function rawPlaylist(segments: unknown[], extra: Record<string, unknown> = {}) {
  return {
    cameraId: 'cam-1',
    from: new Date(T0).toISOString(),
    to: new Date(T0 + 86_400_000).toISOString(),
    startOffsetSeconds: 0,
    totalDurationSeconds: 0,
    truncated: false,
    segments,
    ...extra,
  };
}

function playlistOf(segments: unknown[], extra: Record<string, unknown> = {}): VodPlaylist {
  const playlist = normalizeVodPlaylist(rawPlaylist(segments, extra), T0);
  assert.ok(playlist, 'playlist deveria ser utilizável neste cenário');
  return playlist;
}

test('normalizeVodPlaylist aceita a resposta do backend e recalcula a linha do tempo', () => {
  const playlist = playlistOf([rawSegment(0), rawSegment(1), rawSegment(2)]);
  assert.equal(playlist.segments.length, 3);
  assert.equal(playlist.totalDurationSeconds, 900);
  // Offsets acumulados: cada segmento começa onde o anterior terminou.
  assert.deepEqual(playlist.segments.map((segment) => segment.offsetSeconds), [0, 300, 600]);
  assert.equal(playlist.segments[1].startedAtMs, T0 + 300_000);
  assert.equal(playlist.segments[1].token, 'tok-1');
});

test('normalizeVodPlaylist ordena por instante real mesmo com offsets bagunçados', () => {
  const playlist = playlistOf([
    rawSegment(2, { offsetSeconds: 0 }),
    rawSegment(0, { offsetSeconds: 999 }),
    rawSegment(1, { offsetSeconds: 7 }),
  ]);
  assert.deepEqual(playlist.segments.map((segment) => segment.recordingId), ['rec-0', 'rec-1', 'rec-2']);
  assert.deepEqual(playlist.segments.map((segment) => segment.offsetSeconds), [0, 300, 600]);
});

test('normalizeVodPlaylist devolve null quando a playlist não serve (fallback)', () => {
  // Sem gravação nenhuma / resposta inesperada / erro do endpoint: o front tem de
  // voltar ao caminho antigo (arquivo por arquivo), nunca tocar uma playlist vazia.
  assert.equal(normalizeVodPlaylist(null, T0), null);
  assert.equal(normalizeVodPlaylist({ segments: [] }, T0), null);
  assert.equal(normalizeVodPlaylist({ segments: 'nope' }, T0), null);
  assert.equal(normalizeVodPlaylist(rawPlaylist([{ recordingId: 'x' }]), T0), null);
  // Duração inválida/zerada não dá linha do tempo: descarta o segmento.
  assert.equal(normalizeVodPlaylist(rawPlaylist([rawSegment(0, { durationSeconds: 0, endedAt: null })]), T0), null);
  // Sem playUrl não há como pedir o vídeo.
  assert.equal(normalizeVodPlaylist(rawPlaylist([rawSegment(0, { playUrl: '' })]), T0), null);
});

test('normalizeVodPlaylist descarta o segmento podre e mantém o resto', () => {
  const playlist = playlistOf([rawSegment(0), rawSegment(1, { startedAt: 'não-é-data' }), rawSegment(2)]);
  assert.deepEqual(playlist.segments.map((segment) => segment.recordingId), ['rec-0', 'rec-2']);
  assert.equal(playlist.totalDurationSeconds, 600);
});

test('absoluteToVodPosition mapeia o relógio para a posição contínua', () => {
  const playlist = playlistOf([rawSegment(0), rawSegment(1), rawSegment(2)]);
  const inside = absoluteToVodPosition(playlist, new Date(T0 + 300_000 + 42_000));
  assert.equal(inside?.placement, 'inside');
  // 2º segmento (offset 300) + 42s dentro dele.
  assert.equal(inside?.seconds, 342);
  assert.equal(inside?.segment?.recordingId, 'rec-1');
  assert.equal(inside?.offsetInSegmentSeconds, 42);
  assert.equal(inside?.segmentIndex, 1);
});

test('absoluteToVodPosition trata antes/depois/buraco sem sair da playlist', () => {
  // Buraco de 10 min entre o 1º e o 2º segmento.
  const playlist = playlistOf([rawSegment(0), rawSegment(3, { discontinuity: true })]);
  const before = absoluteToVodPosition(playlist, new Date(T0 - 60_000));
  assert.deepEqual([before?.placement, before?.seconds], ['before', 0]);

  const gap = absoluteToVodPosition(playlist, new Date(T0 + 600_000));
  // Cai no buraco: continua no COMEÇO do próximo segmento (nada para tocar antes).
  assert.equal(gap?.placement, 'gap');
  assert.equal(gap?.seconds, 300);
  assert.equal(gap?.segment?.recordingId, 'rec-3');

  const after = absoluteToVodPosition(playlist, new Date(T0 + 86_400_000));
  assert.equal(after?.placement, 'after');
  assert.equal(after?.seconds, 600);
  assert.equal(absoluteToVodPosition(playlist, 'data inválida'), null);
});

test('posição <-> instante fecham a ida e a volta', () => {
  const playlist = playlistOf([rawSegment(0), rawSegment(1), rawSegment(3)]);
  for (const seconds of [0, 1, 299.5, 300, 601, 899.9]) {
    const absolute = vodPositionToAbsoluteMs(playlist, seconds);
    assert.ok(absolute !== null);
    const back = absoluteToVodPosition(playlist, absolute);
    assert.ok(Math.abs((back?.seconds ?? -1) - seconds) < 0.002, `ida e volta falhou em ${seconds}s`);
  }
  // Fora dos limites: nunca escapa da linha do tempo.
  assert.equal(vodPositionToAbsoluteMs(playlist, -50), playlist.segments[0].startedAtMs);
  assert.equal(vodPositionToAbsoluteMs(playlist, 99_999), playlist.segments[2].endedAtMs);
});

test('locateVodSegment e nextVodSegment apontam o arquivo e o seguinte', () => {
  const playlist = playlistOf([rawSegment(0), rawSegment(1), rawSegment(2)]);
  const located = locateVodSegment(playlist, 610);
  assert.equal(located?.segment.recordingId, 'rec-2');
  assert.equal(located?.index, 2);
  assert.equal(located?.offsetInSegmentSeconds, 10);
  assert.equal(nextVodSegment(playlist, 1)?.recordingId, 'rec-2');
  assert.equal(nextVodSegment(playlist, 2), null);
});

test('resolveInitialSeekSeconds honra o ?at= e cai no startOffsetSeconds do backend', () => {
  const playlist = playlistOf([rawSegment(0), rawSegment(1)], { startOffsetSeconds: 120 });
  // Link ?at= manda: seek no instante pedido.
  assert.equal(resolveInitialSeekSeconds({ playlist, at: new Date(T0 + 300_000 + 30_000).toISOString() }), 330);
  // Sem ?at= (ou com valor inválido) vale o offset que o backend calculou.
  assert.equal(resolveInitialSeekSeconds({ playlist }), 120);
  assert.equal(resolveInitialSeekSeconds({ playlist, at: 'xx' }), 120);
});

test('shouldRenewPlaylist renova ANTES de o token expirar e respeita voo/desistência', () => {
  const expiresAtMs = T0 + 300_000; // token de 5 min
  const base = {
    fetchedAtMs: T0,
    tokenExpiresAtMs: expiresAtMs,
    renewLeadSeconds: 60,
    documentVisible: true,
  };
  // 3 min depois: ainda falta mais que a folga de 60s → não renova.
  assert.equal(shouldRenewPlaylist(base, T0 + 180_000), false);
  // 4m01 depois: entrou na folga (faltam <60s p/ expirar) → renova.
  assert.equal(shouldRenewPlaylist(base, T0 + 241_000), true);
  // Já expirado continua pedindo renovação.
  assert.equal(shouldRenewPlaylist(base, T0 + 400_000), true);
  // Requisição em voo não duplica.
  assert.equal(shouldRenewPlaylist({ ...base, inFlight: true }, T0 + 241_000), false);
  // Falhas seguidas: desiste (o chamador cai no caminho antigo) em vez de martelar.
  assert.equal(shouldRenewPlaylist({ ...base, consecutiveFailures: 3, maxFailures: 3 }, T0 + 400_000), false);
  // Backoff entre tentativas depois de uma falha.
  const failed = { ...base, consecutiveFailures: 1, lastAttemptAtMs: T0 + 241_000, retryDelaySeconds: 20 };
  assert.equal(shouldRenewPlaylist(failed, T0 + 250_000), false);
  assert.equal(shouldRenewPlaylist(failed, T0 + 262_000), true);
});

test('shouldRenewPlaylist não gasta rede em aba escondida, salvo se estiver tocando', () => {
  const base = { fetchedAtMs: T0, tokenExpiresAtMs: T0 + 300_000, renewLeadSeconds: 60 };
  assert.equal(shouldRenewPlaylist({ ...base, documentVisible: false, playing: false }, T0 + 241_000), false);
  assert.equal(shouldRenewPlaylist({ ...base, documentVisible: false, playing: true }, T0 + 241_000), true);
});

test('shouldRenewPlaylist usa o TTL padrão quando não dá para ler o exp do token', () => {
  const base = { fetchedAtMs: T0, tokenExpiresAtMs: null, renewLeadSeconds: 60, documentVisible: true };
  const ttlMs = DEFAULT_PLAY_TOKEN_TTL_SECONDS * 1000;
  assert.equal(shouldRenewPlaylist(base, T0 + ttlMs - 61_000), false);
  assert.equal(shouldRenewPlaylist(base, T0 + ttlMs - 59_000), true);
});

test('decodeJwtExpiryMs lê o exp sem validar assinatura e engole lixo', () => {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor((T0 + 300_000) / 1000) })).toString('base64url');
  assert.equal(decodeJwtExpiryMs(`aaa.${payload}.bbb`), T0 + 300_000);
  assert.equal(decodeJwtExpiryMs('não-é-jwt'), null);
  assert.equal(decodeJwtExpiryMs(''), null);
  assert.equal(decodeJwtExpiryMs(`aaa.${Buffer.from('{}').toString('base64url')}.bbb`), null);
});

test('isPlaybackTokenUsable só aprova token que aguenta o carregamento', () => {
  const jwt = (expMs: number) => `aaa.${Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000) })).toString('base64url')}.bbb`;
  assert.equal(isPlaybackTokenUsable(jwt(T0 + 120_000), T0), true);
  // Faltando menos que a folga: não arrisca 401 no meio do playback.
  assert.equal(isPlaybackTokenUsable(jwt(T0 + 10_000), T0), false);
  assert.equal(isPlaybackTokenUsable(jwt(T0 - 1_000), T0), false);
  // Sem token / token ilegível: caminho de sempre (emitir token novo).
  assert.equal(isPlaybackTokenUsable(null, T0), false);
  assert.equal(isPlaybackTokenUsable('tok-opaco', T0), false);
});

test('refreshSegmentUrl troca o token vencido pelo novo sem mexer no resto', () => {
  const tokens = { 'rec-1': 'novo-token' };
  assert.equal(
    refreshSegmentUrl('/recordings/rec-1/play.mp4?token=velho&forceDirect=1', tokens),
    '/recordings/rec-1/play.mp4?token=novo-token&forceDirect=1',
  );
  assert.equal(
    refreshSegmentUrl('https://cam.example/api/recordings/rec-1/play?compatible=1', tokens),
    'https://cam.example/api/recordings/rec-1/play?compatible=1&token=novo-token',
  );
  // Sem token novo para a gravação: devolve a URL intacta (nunca quebra o pedido).
  assert.equal(refreshSegmentUrl('/recordings/rec-9/play.mp4?token=velho', tokens), '/recordings/rec-9/play.mp4?token=velho');
  assert.equal(refreshSegmentUrl('/qualquer/coisa', tokens), '/qualquer/coisa');
});

test('segmentTokens indexa os tokens por gravação', () => {
  const playlist = playlistOf([rawSegment(0), rawSegment(1)]);
  assert.deepEqual(segmentTokens(playlist), { 'rec-0': 'tok-0', 'rec-1': 'tok-1' });
});

test('shouldPrefetchNextSegment só aquece o próximo arquivo perto da virada', () => {
  const playlist = playlistOf([rawSegment(0), rawSegment(1)]);
  // Começo do 1º segmento: faltam 300s, não desperdiça banda.
  assert.equal(shouldPrefetchNextSegment(playlist, 10, 25), null);
  // A 20s do fim: aquece o próximo.
  assert.equal(shouldPrefetchNextSegment(playlist, 280, 25)?.recordingId, 'rec-1');
  // Último segmento: não há o que aquecer.
  assert.equal(shouldPrefetchNextSegment(playlist, 590, 25), null);
});

test('shouldAbortStalledSwap desiste da troca travada e devolve o playback ao caminho antigo', () => {
  const state = { swapStartedAtMs: T0, lastProgressAtMs: null, timeoutMs: 4000 };
  assert.equal(shouldAbortStalledSwap(state, T0 + 3_000), false);
  assert.equal(shouldAbortStalledSwap(state, T0 + 4_100), true);
  // Houve progresso depois da troca: está tocando, não aborta.
  assert.equal(shouldAbortStalledSwap({ ...state, lastProgressAtMs: T0 + 500 }, T0 + 4_100), false);
  // Troca não iniciada: nada a abortar.
  assert.equal(shouldAbortStalledSwap({ ...state, swapStartedAtMs: null }, T0 + 99_000), false);
});
