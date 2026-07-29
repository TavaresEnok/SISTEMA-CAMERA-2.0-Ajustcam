import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SYNC_DEAD_BAND_SECONDS,
  SYNC_HARD_SEEK_SECONDS,
  SYNC_MAX_RATE_FACTOR,
  SYNC_MIN_RATE_FACTOR,
  SYNC_SEEK_COOLDOWN_MS,
  decideSyncAction,
  followerStatusLabel,
  needsSourceChange,
  resolveFollowerTarget,
  shouldApplyRate,
  type SyncFollowerState,
} from '../src/lib/playback-sync.ts';

// Sincronia entre câmeras no playback: seguir alguém entre ambientes exige ver N
// câmeras no MESMO instante. A regra de correção é o que erra em silêncio — um
// seguidor mostrando outro momento com cara de sincronizado leva o operador a
// concluir errado sobre a cena. Estes testes travam justamente isso.
//
// A forma (deriva pequena = acelera suave; deriva grande = salto seco) é a mesma
// já usada no ao vivo em components/LiveStreamPlayer.tsx, creditada ao Frigate.
// Os limiares aqui são bem mais apertados: lá o alvo é a borda do live, aqui é
// casar dois acervos no mesmo instante de parede.

const T0 = Date.parse('2026-07-27T08:00:00.000Z');

function seguidor(overrides: Partial<SyncFollowerState> = {}): SyncFollowerState {
  return {
    absoluteMs: T0,
    readyState: 4,
    paused: false,
    placement: 'inside',
    offsetInSegmentSeconds: 10,
    segmentLoaded: true,
    lastSeekAtMs: null,
    ...overrides,
  };
}

const base = {
  masterAbsoluteMs: T0,
  masterPaused: false,
  userSpeed: 1,
  nowMs: T0,
};

test('sincronizado: dentro da banda morta não corrige (e limpa aceleração antiga)', () => {
  const acao = decideSyncAction({
    ...base,
    follower: seguidor({ absoluteMs: T0 - SYNC_DEAD_BAND_SECONDS * 1000 * 0.5 }),
  });
  assert.equal(acao.kind, 'rate');
  assert.equal(acao.kind === 'rate' && acao.playbackRate, 1, 'volta à taxa do operador, sem oscilar');
});

test('atrasado moderado: ACELERA (sem salto) e respeita o teto', () => {
  const acao = decideSyncAction({ ...base, follower: seguidor({ absoluteMs: T0 - 800 }) });
  assert.equal(acao.kind, 'rate');
  if (acao.kind !== 'rate') return;
  assert.ok(acao.playbackRate > 1, 'atrasado precisa acelerar');
  assert.ok(acao.playbackRate <= SYNC_MAX_RATE_FACTOR, 'nunca acima do teto');
  assert.ok(acao.driftSeconds > 0, 'sinal: positivo = atrasado');
});

test('adiantado moderado: DESACELERA e respeita o piso', () => {
  const acao = decideSyncAction({ ...base, follower: seguidor({ absoluteMs: T0 + 800 }) });
  assert.equal(acao.kind, 'rate');
  if (acao.kind !== 'rate') return;
  assert.ok(acao.playbackRate < 1, 'adiantado precisa frear');
  assert.ok(acao.playbackRate >= SYNC_MIN_RATE_FACTOR, 'nunca abaixo do piso');
  assert.ok(acao.driftSeconds < 0, 'sinal: negativo = adiantado');
});

test('a velocidade do OPERADOR é preservada — a correção multiplica, não substitui', () => {
  // Este é o bug que a régua do repo pega: PlaybackPage já dirige playbackRate
  // pelo seletor de velocidade. Devolver um fator absoluto zeraria o 4× dele.
  const acao = decideSyncAction({ ...base, userSpeed: 4, follower: seguidor({ absoluteMs: T0 - 800 }) });
  assert.equal(acao.kind, 'rate');
  if (acao.kind !== 'rate') return;
  assert.ok(acao.playbackRate > 4, 'tem que ficar ACIMA de 4×, não virar ~1×');
  assert.ok(acao.playbackRate <= 4 * SYNC_MAX_RATE_FACTOR);
});

test('deriva grande: salto seco no offset do segmento', () => {
  const acao = decideSyncAction({
    ...base,
    follower: seguidor({ absoluteMs: T0 - (SYNC_HARD_SEEK_SECONDS + 1) * 1000, offsetInSegmentSeconds: 42 }),
  });
  assert.equal(acao.kind, 'seek');
  assert.equal(acao.kind === 'seek' && acao.toSeconds, 42);
});

test('salto tem carência: não repete a cada tick (senão a imagem trava)', () => {
  const atrasado = { absoluteMs: T0 - (SYNC_HARD_SEEK_SECONDS + 1) * 1000 };
  const recemSaltado = decideSyncAction({
    ...base,
    nowMs: T0 + 100,
    follower: seguidor({ ...atrasado, lastSeekAtMs: T0 }),
  });
  assert.equal(recemSaltado.kind, 'none', 'dentro da carência não salta de novo');

  const passouCarencia = decideSyncAction({
    ...base,
    nowMs: T0 + SYNC_SEEK_COOLDOWN_MS + 1,
    follower: seguidor({ ...atrasado, lastSeekAtMs: T0 }),
  });
  assert.equal(passouCarencia.kind, 'seek', 'passada a carência, corrige');
});

test('seguidor sem gravação no instante: PAUSA — nunca finge sincronia', () => {
  // O pior resultado possível seria pular para o segmento vizinho e parecer
  // sincronizado exibindo outro momento.
  for (const placement of ['gap', 'before', 'after'] as const) {
    const acao = decideSyncAction({ ...base, follower: seguidor({ placement }) });
    assert.equal(acao.kind, 'pause', `placement ${placement} tem que congelar`);
  }
});

test('segmento errado carregado: manda trocar, não tenta ajustar tempo', () => {
  const acao = decideSyncAction({ ...base, follower: seguidor({ segmentLoaded: false }) });
  assert.equal(acao.kind, 'reselect-segment');
});

test('sem metadados confiáveis: não corrige no escuro', () => {
  assert.equal(decideSyncAction({ ...base, follower: seguidor({ readyState: 0 }) }).kind, 'none');
  assert.equal(decideSyncAction({ ...base, follower: seguidor({ absoluteMs: null }) }).kind, 'none');
});

test('mestre pausado ou sem posição: não mexe no seguidor', () => {
  assert.equal(decideSyncAction({ ...base, masterPaused: true, follower: seguidor() }).kind, 'none');
  assert.equal(decideSyncAction({ ...base, masterAbsoluteMs: null, follower: seguidor() }).kind, 'none');
});

test('quanto maior a deriva, mais forte a correção (monotônica)', () => {
  const taxa = (driftMs: number) => {
    const acao = decideSyncAction({ ...base, follower: seguidor({ absoluteMs: T0 - driftMs }) });
    return acao.kind === 'rate' ? acao.playbackRate : Number.NaN;
  };
  const r300 = taxa(300);
  const r700 = taxa(700);
  const r1500 = taxa(1500);
  assert.ok(r300 < r700, 'correção cresce com a deriva');
  assert.ok(r700 < r1500 || r1500 === SYNC_MAX_RATE_FACTOR, 'cresce até saturar no teto');
});

test('shouldApplyRate evita escrever a cada tick (microengasgo no decode)', () => {
  assert.equal(shouldApplyRate(1, 1.005), false, 'diferença irrelevante não vale um write');
  assert.equal(shouldApplyRate(1, 1.2), true);
});

// ── Resolução do alvo por câmera ─────────────────────────────────────────────
// Cada câmera tem o SEU acervo: "instante X" vira arquivo+offset diferente em
// cada uma, e pode simplesmente não existir. Decidir errado aqui mostra a cena
// ERRADA com cara de sincronizada — o pior resultado possível da feature.

const playlistFake = { segments: [{ recordingId: 'r1' }, { recordingId: 'r2' }] };

test('alvo pronto: devolve gravação, índice e offset', () => {
  const alvo = resolveFollowerTarget(playlistFake, {
    placement: 'inside', seconds: 130, segmentIndex: 1, offsetInSegmentSeconds: 10,
  });
  assert.equal(alvo.status, 'ready');
  if (alvo.status !== 'ready') return;
  assert.equal(alvo.recordingId, 'r2');
  assert.equal(alvo.offsetInSegmentSeconds, 10);
});

test('buraco no acervo do seguidor NÃO vira "pronto"', () => {
  const alvo = resolveFollowerTarget(playlistFake, {
    placement: 'gap', seconds: 50, segmentIndex: 0, offsetInSegmentSeconds: 0,
  });
  assert.equal(alvo.status, 'gap');
  assert.match(followerStatusLabel(alvo) ?? '', /sem gravação/i);
});

test('fora das pontas informa QUAL ponta (o operador precisa saber)', () => {
  const antes = resolveFollowerTarget(playlistFake, {
    placement: 'before', seconds: 0, segmentIndex: 0, offsetInSegmentSeconds: 0,
  });
  assert.equal(antes.status, 'outside');
  assert.match(followerStatusLabel(antes) ?? '', /antes/i);

  const depois = resolveFollowerTarget(playlistFake, {
    placement: 'after', seconds: 999, segmentIndex: 1, offsetInSegmentSeconds: 0,
  });
  assert.match(followerStatusLabel(depois) ?? '', /depois/i);
});

test('playlist ausente/vazia é indisponível, não "pronto"', () => {
  assert.equal(resolveFollowerTarget(null, null).status, 'unavailable');
  assert.equal(resolveFollowerTarget({ segments: [] }, null).status, 'unavailable');
});

test('índice inconsistente com a playlist não indexa undefined', () => {
  const alvo = resolveFollowerTarget(playlistFake, {
    placement: 'inside', seconds: 10, segmentIndex: 99, offsetInSegmentSeconds: 0,
  });
  assert.equal(alvo.status, 'unavailable', 'melhor indisponível que reproduzir lixo');
});

test('offset negativo é saneado (nunca vira currentTime inválido)', () => {
  const alvo = resolveFollowerTarget(playlistFake, {
    placement: 'inside', seconds: 5, segmentIndex: 0, offsetInSegmentSeconds: -3,
  });
  assert.equal(alvo.status === 'ready' && alvo.offsetInSegmentSeconds, 0);
});

test('troca de fonte compara por recordingId, não por URL', () => {
  const alvo = resolveFollowerTarget(playlistFake, {
    placement: 'inside', seconds: 130, segmentIndex: 1, offsetInSegmentSeconds: 10,
  });
  assert.equal(needsSourceChange('r1', alvo), true, 'gravação diferente exige troca');
  assert.equal(needsSourceChange('r2', alvo), false, 'mesma gravação NÃO remonta o vídeo');
  // Renovação de token muda a URL mas não a gravação: não pode piscar a imagem.
  assert.equal(needsSourceChange('r2', alvo), false);
});

test('sem alvo pronto não se troca fonte', () => {
  const gap = resolveFollowerTarget(playlistFake, {
    placement: 'gap', seconds: 50, segmentIndex: 0, offsetInSegmentSeconds: 0,
  });
  assert.equal(needsSourceChange('r1', gap), false);
});
