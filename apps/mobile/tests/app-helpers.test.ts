/// <reference types="node" />
// Cobre a lógica PURA extraída do App.tsx (item 3.3, primeira fatia):
// - buildOperationalMessages (banner de status)
// - shiftDateKey (navegação de data da reprodução)
// - cameraPosterUrl / recordingThumbnailUrl / clipDownloadUrl (URLs de mídia)
import { test } from 'node:test';
import { buildOperationalMessages } from '../src/utils/operational';
import { shiftDateKey, localDateKey } from '../src/utils/format';
import { cameraPosterUrl, recordingThumbnailUrl, clipDownloadUrl } from '../src/utils/media-endpoints';
import { reviewFeedPath } from '../src/utils/review';
import type { Camera } from '../src/types';

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

const cam = (status: string): Pick<Camera, 'status'> => ({ status });

test('operationalMessages: erro de sync + contagem de offline, no máx. 3', () => {
  assert(buildOperationalMessages([], null).length === 0, 'sem erro e sem câmeras não gera mensagem');
  const onlyOffline = buildOperationalMessages([cam('ONLINE'), cam('OFFLINE'), cam('UNKNOWN')], null);
  assert(onlyOffline.length === 1, 'apenas a contagem de offline aparece');
  assert(onlyOffline[0] === '2 câmera(s) offline ou sem comunicação.', `texto inesperado: ${onlyOffline[0]}`);
  const withError = buildOperationalMessages([cam('OFFLINE')], 'Servidor indisponível');
  assert(withError[0] === 'Servidor indisponível', 'erro de sync vem primeiro');
  assert(withError[1] === '1 câmera(s) offline ou sem comunicação.', 'seguido da contagem de offline');
});

test('operationalMessages: status case-sensitive (só "ONLINE" exato é online) e cap em 3', () => {
  // Espelha o App: usa igualdade exata "!== 'ONLINE'", NÃO a normalização isOnline.
  assert(buildOperationalMessages([cam('online')], null).length === 1, '"online" minúsculo conta como offline');
  // Muitas offline + erro nunca ultrapassa 3 mensagens (só há 2 fontes hoje, mas o corte é garantido).
  const many = buildOperationalMessages(Array.from({ length: 10 }, () => cam('OFFLINE')), 'erro');
  assert(many.length <= 3, `nunca mais que 3 mensagens (got ${many.length})`);
});

test('shiftDateKey: avança/retrocede dias e NUNCA passa de hoje', () => {
  assert(shiftDateKey('2026-07-10', -1, '2026-07-23') === '2026-07-09', 'retrocede um dia');
  assert(shiftDateKey('2026-07-10', 3, '2026-07-23') === '2026-07-13', 'avança três dias');
  // Tentar ir para o futuro fica preso em hoje.
  assert(shiftDateKey('2026-07-23', 5, '2026-07-23') === '2026-07-23', 'não passa de hoje ao avançar');
  assert(shiftDateKey('2026-07-25', 0, '2026-07-23') === '2026-07-23', 'chave já futura é limitada a hoje');
  // Atravessa fronteira de mês corretamente.
  assert(shiftDateKey('2026-07-01', -1, '2026-07-23') === '2026-06-30', 'cruza a virada de mês');
  // Sem o parâmetro today usa o dia atual do aparelho: avançar do próprio hoje fica em hoje.
  assert(shiftDateKey(localDateKey(), 10) === localDateKey(), 'padrão today = hoje do aparelho');
});

test('media URLs: poster e miniatura escapam ids/tokens e carregam cache-buster', () => {
  const poster = cameraPosterUrl('https://api.local/', 'cam 1', 'tok/en', 999);
  assert(poster === 'https://api.local/camera-stream/cam%201/poster?token=tok%2Fen&v=999', `poster inesperado: ${poster}`);
  const thumb = recordingThumbnailUrl('https://api.local', 'rec+9', 'a b', 42);
  assert(thumb === 'https://api.local/recordings/rec%2B9/thumbnail?token=a%20b&v=42', `miniatura inesperada: ${thumb}`);
  const clip = clipDownloadUrl('https://api.local///', 'clip 7');
  assert(clip === 'https://api.local/camera-stream/clip/clip%207/download', `clip inesperado: ${clip}`);
});

test('media URLs: base sem barra final e cache-buster default numérico', () => {
  // apiBase remove múltiplas barras finais (idempotente).
  assert(cameraPosterUrl('https://api.local//', 'c', 't', 1).startsWith('https://api.local/camera-stream/'), 'barras finais são removidas');
  // Sem cacheBust explícito cai em Date.now() (número), preservando o &v=... inline original.
  const auto = cameraPosterUrl('https://api.local', 'c', 't');
  const version = auto.split('&v=')[1];
  assert(/^\d+$/.test(version), `cache-buster default deve ser numérico (got ${version})`);
});

// Paginação da Revisão: sem offset, a tela só alcançava os primeiros `limit`
// eventos — com 500 não revisados, os demais eram inatingíveis.
test('reviewFeedPath: offset entra na query e é omitido na primeira página', () => {
  assert(!reviewFeedPath({}).includes('offset='), 'primeira página não deve mandar offset');
  assert(reviewFeedPath({ offset: 48 }).includes('offset=48'), 'offset deve ir na query');
  assert(!reviewFeedPath({ offset: 0 }).includes('offset='), 'offset 0 é a primeira página');
  assert(!reviewFeedPath({ offset: -5 }).includes('offset='), 'offset negativo é ignorado');
  assert(reviewFeedPath({ offset: 10.7 }).includes('offset=10'), 'offset fracionário é truncado');
});
