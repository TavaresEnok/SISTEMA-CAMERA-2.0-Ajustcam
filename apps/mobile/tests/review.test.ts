/// <reference types="node" />
import { test } from 'node:test';
import {
  confidencePercent,
  formatConfidence,
  formatReviewTime,
  labelDisplay,
  matchesReviewFilter,
  reviewFeedPath,
  reviewPlayUrl,
  reviewPlaybackTarget,
  reviewThumbnailUrl,
  unseenBadge,
  type ReviewFilters,
  type ReviewItem,
} from '../src/utils/review';

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

function makeItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: 'evt-1',
    cameraId: 'cam-1',
    cameraName: 'Portaria',
    type: 'OBJECT_DETECTED',
    label: 'pessoa',
    confirmed: true,
    confidence: 0.87,
    source: 'ai',
    occurredAt: '2026-07-14T06:07:08',
    reviewed: false,
    recordingId: 'rec-9',
    offsetSeconds: 42,
    ...overrides,
  };
}

test('review feed path: só envia filtros ativos e trata "all" como sem rótulo', () => {
  assert(reviewFeedPath() === '/review/feed?limit=48', `padrão deve ser limit=48 (got ${reviewFeedPath()})`);
  const full: ReviewFilters = { cameraId: 'cam 1', label: 'pessoa', onlyConfirmed: true, unseenOnly: true, limit: 20 };
  const path = reviewFeedPath(full);
  assert(path.startsWith('/review/feed?limit=20'), 'limit customizado deve aparecer');
  assert(path.includes('cameraId=cam%201'), 'cameraId deve ser URL-encoded');
  assert(path.includes('label=pessoa'), 'rótulo deve ser enviado');
  assert(path.includes('onlyConfirmed=true'), 'onlyConfirmed deve ser enviado');
  assert(path.includes('unseenOnly=true'), 'unseenOnly deve ser enviado');
  assert(!reviewFeedPath({ label: 'all' }).includes('label='), '"all" NÃO deve virar parâmetro label');
});

test('review filter: predicado local esconde item que deixa de casar', () => {
  const seen = makeItem({ reviewed: true });
  assert(matchesReviewFilter(seen, {}), 'sem filtro tudo passa');
  assert(!matchesReviewFilter(seen, { unseenOnly: true }), 'item visto some com "só não vistos"');
  assert(!matchesReviewFilter(makeItem({ label: 'carro' }), { label: 'pessoa' }), 'rótulo diferente é filtrado');
  assert(matchesReviewFilter(makeItem({ label: 'carro' }), { label: 'all' }), '"all" não filtra por rótulo');
  assert(!matchesReviewFilter(makeItem({ confirmed: false }), { onlyConfirmed: true }), 'não-confirmado some com "só com objeto"');
  assert(!matchesReviewFilter(makeItem({ cameraId: 'cam-2' }), { cameraId: 'cam-1' }), 'câmera diferente é filtrada');
});

test('review label: objeto reconhecido, fallback por tipo e capitalização', () => {
  assert(labelDisplay(makeItem({ label: 'pessoa' })) === 'Pessoa', 'pessoa → Pessoa');
  assert(labelDisplay(makeItem({ label: 'onibus' })) === 'Ônibus', 'onibus → Ônibus');
  assert(labelDisplay(makeItem({ label: 'gato' })) === 'Gato', 'rótulo desconhecido é capitalizado');
  assert(labelDisplay(makeItem({ label: null, type: 'MOTION_DETECTED' })) === 'Movimento', 'sem objeto usa o tipo');
  assert(labelDisplay(makeItem({ label: null, type: 'FACE_UNKNOWN' })) === 'Rosto desconhecido', 'tipo de rosto');
  assert(labelDisplay(makeItem({ label: null, type: 'ALGO_NOVO' })) === 'Evento', 'tipo desconhecido → Evento');
});

test('review confiança: clampa em [0,1] e formata em %', () => {
  assert(confidencePercent(makeItem({ confidence: 0.87 })) === 87, '0.87 → 87');
  assert(confidencePercent(makeItem({ confidence: null })) === null, 'null → null');
  assert(confidencePercent(makeItem({ confidence: 1.4 })) === 100, 'acima de 1 clampa em 100');
  assert(confidencePercent(makeItem({ confidence: -0.2 })) === 0, 'abaixo de 0 clampa em 0');
  assert(formatConfidence(makeItem({ confidence: 0.5 })) === '50%', 'formata com %');
  assert(formatConfidence(makeItem({ confidence: null })) === '', 'sem confiança vira string vazia');
});

test('review hora: dd/MM HH:mm:ss no fuso local e vazio para inválido', () => {
  // Data local (sem Z) → componentes locais preservados em qualquer fuso.
  assert(formatReviewTime('2026-07-14T06:07:08') === '14/07 06:07:08', 'formato dd/MM HH:mm:ss');
  assert(formatReviewTime('2026-03-05T00:00:00') === '05/03 00:00:00', 'zero-pad de dia/mês/hora');
  assert(formatReviewTime(null) === '', 'null → vazio');
  assert(formatReviewTime('não-é-data') === '', 'data inválida → vazio');
});

test('review playback: monta o alvo no instante e saneia o offset', () => {
  const target = reviewPlaybackTarget(makeItem({ recordingId: 'rec-9', cameraId: 'cam-1', offsetSeconds: 42.9 }));
  assert(target !== null, 'com gravação deve haver alvo');
  assert(target!.recordingId === 'rec-9' && target!.cameraId === 'cam-1', 'preserva recordingId e cameraId');
  assert(target!.offsetSeconds === 42, 'offset vira inteiro (floor)');
  assert(reviewPlaybackTarget(makeItem({ offsetSeconds: -5 }))!.offsetSeconds === 0, 'offset negativo → 0');
  assert(reviewPlaybackTarget(makeItem({ offsetSeconds: null }))!.offsetSeconds === 0, 'offset ausente → 0');
  assert(reviewPlaybackTarget(makeItem({ recordingId: null })) === null, 'sem gravação → sem alvo');
});

test('review play URL: espelha o formato do openPlayback e escapa o token', () => {
  const url = reviewPlayUrl('https://api.local', 'rec 9', 'tok/en+1');
  assert(url === 'https://api.local/recordings/rec%209/play?token=tok%2Fen%2B1&compatible=1', `URL inesperada: ${url}`);
});

test('review thumbnail URL: aponta para o endpoint autenticado do evento', () => {
  assert(reviewThumbnailUrl('https://api.local', 'evt 1') === 'https://api.local/review/evt%201/thumbnail', 'thumbnail encode');
});

test('review badge: cap em 9+ e sem badge quando zerado', () => {
  assert(unseenBadge(0) === null, 'zero não mostra badge');
  assert(unseenBadge(-3) === null, 'negativo não mostra badge');
  assert(unseenBadge(null) === null, 'null não mostra badge');
  assert(unseenBadge(5) === '5', '5 → "5"');
  assert(unseenBadge(12) === '9+', '12 → "9+"');
});
