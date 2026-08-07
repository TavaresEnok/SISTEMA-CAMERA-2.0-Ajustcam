// Lógica PURA da fila de Revisão (item 2.7). Sem imports de React Native para
// rodar sob `node --test`: formatação do item, filtros e montagem do link de
// reprodução no instante exato (recordingId + offsetSeconds).
//
// Privacidade: estes tipos espelham EXATAMENTE o que o backend `/review/feed`
// devolve (o backend já exclui câmera privada via getAccessibleCameraIds). Nada
// aqui infere/expõe campo além do feed.

export type ReviewItem = {
  id: string;
  cameraId: string;
  cameraName: string | null;
  type: string;
  label: string | null;
  confirmed: boolean;
  confidence: number | null;
  source: string | null;
  occurredAt: string;
  reviewed: boolean;
  recordingId: string | null;
  offsetSeconds: number | null;
};

export type ReviewFeedResponse = {
  items: ReviewItem[];
  /** COMPATIBILIDADE com builds antigos: "pelo menos isto", não o total real.
   *  O backend deixou de contar (custava até 15 s). Use `temMais`. */
  total: number;
  temMais?: boolean;
  /** Há detecção neste filtro cuja gravação já não existe — a fila as omite. */
  haEventoSemVideo?: boolean;
  limit: number;
  offset: number;
};

export type ReviewLabelFilter = 'all' | 'pessoa' | 'carro' | 'moto' | 'onibus';

export type ReviewFilters = {
  cameraId?: string | null;
  label?: ReviewLabelFilter;
  onlyConfirmed?: boolean;
  unseenOnly?: boolean;
  limit?: number;
  /** Deslocamento da página (paginação). Sem ele, a tela só alcançava os primeiros
   *  `limit` eventos — com 500 não revisados, os demais eram inatingíveis. */
  offset?: number;
};

export const REVIEW_LABEL_OPTIONS: Array<{ key: ReviewLabelFilter; label: string }> = [
  { key: 'all', label: 'Todos' },
  { key: 'pessoa', label: 'Pessoa' },
  { key: 'carro', label: 'Carro' },
  { key: 'moto', label: 'Moto' },
  { key: 'onibus', label: 'Ônibus' },
];

const DEFAULT_LIMIT = 48;

// Rótulo semântico dos objetos reconhecidos pela IA (metadata.semanticLabel).
const OBJECT_LABEL: Record<string, string> = {
  pessoa: 'Pessoa',
  carro: 'Carro',
  moto: 'Moto',
  onibus: 'Ônibus',
  caminhao: 'Caminhão',
  bicicleta: 'Bicicleta',
  animal: 'Animal',
};

// Fallback quando não há objeto reconhecido: descreve o TIPO do evento.
const TYPE_LABEL: Record<string, string> = {
  MOTION_DETECTED: 'Movimento',
  OBJECT_DETECTED: 'Objeto',
  FACE_DETECTED: 'Rosto',
  FACE_UNKNOWN: 'Rosto desconhecido',
  FACE_RECOGNIZED: 'Rosto reconhecido',
};

function capitalize(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Monta a query do `/review/feed` respeitando os filtros escolhidos. Espelha o
 * que o `ReviewPage` do web envia: `label`/`onlyConfirmed`/`unseenOnly` só vão
 * quando ativos; `all` NÃO vira parâmetro (o backend interpretaria como rótulo).
 */
export function reviewFeedPath(filters: ReviewFilters = {}): string {
  const params: string[] = [];
  const limit = Number.isFinite(filters.limit) && (filters.limit as number) > 0 ? Math.floor(filters.limit as number) : DEFAULT_LIMIT;
  params.push(`limit=${encodeURIComponent(String(limit))}`);
  const offset = Number.isFinite(filters.offset) && (filters.offset as number) > 0 ? Math.floor(filters.offset as number) : 0;
  if (offset > 0) params.push(`offset=${encodeURIComponent(String(offset))}`);
  if (filters.cameraId) params.push(`cameraId=${encodeURIComponent(filters.cameraId)}`);
  if (filters.label && filters.label !== 'all') params.push(`label=${encodeURIComponent(filters.label)}`);
  if (filters.onlyConfirmed) params.push('onlyConfirmed=true');
  if (filters.unseenOnly) params.push('unseenOnly=true');
  return `/review/feed?${params.join('&')}`;
}

/**
 * Predicado local de filtro. O backend já filtra na query, mas isto mantém a
 * grade coerente SEM refetch quando o estado muda no cliente — ex.: marcar um
 * item como visto com "Só não vistos" ativo deve escondê-lo na hora.
 */
export function matchesReviewFilter(item: ReviewItem, filters: ReviewFilters = {}): boolean {
  if (filters.cameraId && item.cameraId !== filters.cameraId) return false;
  if (filters.label && filters.label !== 'all' && item.label !== filters.label) return false;
  if (filters.onlyConfirmed && !item.confirmed) return false;
  if (filters.unseenOnly && item.reviewed) return false;
  return true;
}

/** Texto do rótulo mostrado no badge: objeto reconhecido ou tipo do evento. */
export function labelDisplay(item: Pick<ReviewItem, 'label' | 'type'>): string {
  if (item.label) return OBJECT_LABEL[item.label] ?? capitalize(item.label);
  return TYPE_LABEL[item.type] ?? 'Evento';
}

/** Confiança em % inteiro (0–100), ou null quando ausente. Clampa em [0,1]. */
export function confidencePercent(item: Pick<ReviewItem, 'confidence'>): number | null {
  const c = item.confidence;
  if (typeof c !== 'number' || !Number.isFinite(c)) return null;
  const clamped = Math.max(0, Math.min(1, c));
  return Math.round(clamped * 100);
}

export function formatConfidence(item: Pick<ReviewItem, 'confidence'>): string {
  const percent = confidencePercent(item);
  return percent == null ? '' : `${percent}%`;
}

/** Data/hora local do evento no formato dd/MM HH:mm:ss (igual ao web). */
export function formatReviewTime(occurredAt: string | null | undefined): string {
  if (!occurredAt) return '';
  const date = new Date(occurredAt);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export type ReviewPlaybackTarget = {
  recordingId: string;
  cameraId: string;
  offsetSeconds: number;
};

/**
 * Alvo de reprodução no INSTANTE do evento. Retorna null quando o evento não
 * tem gravação que o cubra (não há o que abrir). `offsetSeconds` é saneado para
 * um inteiro não-negativo — o ponteiro de seek dentro da gravação.
 */
export function reviewPlaybackTarget(item: Pick<ReviewItem, 'recordingId' | 'cameraId' | 'offsetSeconds'>): ReviewPlaybackTarget | null {
  if (!item.recordingId) return null;
  const raw = item.offsetSeconds;
  const offsetSeconds = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
  return { recordingId: item.recordingId, cameraId: item.cameraId, offsetSeconds };
}

export function canOpenReviewPlayback(item: Pick<ReviewItem, 'recordingId'>): boolean {
  return Boolean(item.recordingId);
}

/**
 * URL de reprodução da gravação com o play-token de curta duração. Espelha
 * EXATAMENTE o formato usado pelo `openPlayback` do App (compatible=1). O
 * `offsetSeconds` NÃO vai na URL — o seek é aplicado no player após carregar.
 */
export function reviewPlayUrl(apiUrl: string, recordingId: string, playToken: string): string {
  return `${apiUrl}/recordings/${encodeURIComponent(recordingId)}/play?token=${encodeURIComponent(playToken)}&compatible=1`;
}

/** URL autenticada da miniatura do evento (gate de câmera privada no backend). */
export function reviewThumbnailUrl(apiUrl: string, eventId: string): string {
  return `${apiUrl}/review/${encodeURIComponent(eventId)}/thumbnail`;
}

/** Texto do badge de não-vistos (null = sem badge). Cap em 9+ como os alarmes. */
export function unseenBadge(count: number | null | undefined): string | null {
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return null;
  return count > 9 ? '9+' : String(Math.floor(count));
}
