import assert from 'node:assert/strict';
import test from 'node:test';
import {
  locateTileAtSecond,
  recordingOffsetSeconds,
  spriteTileStyle,
  type TimelinePreviewMeta,
} from '../src/lib/timeline-preview.ts';

// 2.9 — o tile mostrado no hover TEM que alinhar com o que o backend mosaicou.
// Estes casos espelham locateTileAtSecond do backend
// (apps/api/src/recordings/helpers/timeline-preview.helper.ts): mesma entrada →
// mesmo índice/coluna/linha, senão o preview mostra o frame errado.

const meta: TimelinePreviewMeta = {
  recordingId: 'rec-1',
  durationSeconds: 300,
  spriteUrl: '/recordings/rec-1/preview-sprite',
  intervalSeconds: 5, // 1 frame a cada 5s
  frameCount: 25, // 5 colunas × 5 linhas
  columns: 5,
  rows: 5,
  tileWidth: 160,
  tileHeight: 90,
};

test('locateTileAtSecond mapeia o segundo para o tile (floor pelo intervalo)', () => {
  assert.deepEqual(locateTileAtSecond(meta, 0), { index: 0, column: 0, row: 0 });
  // 12s → índice 2 (floor 12/5), 3ª coluna da 1ª linha.
  assert.deepEqual(locateTileAtSecond(meta, 12), { index: 2, column: 2, row: 0 });
  // 30s → índice 6 → coluna 1, linha 1 (quebra de linha em columns=5).
  assert.deepEqual(locateTileAtSecond(meta, 30), { index: 6, column: 1, row: 1 });
});

test('locateTileAtSecond faz clamp nas bordas (nada de tile fora do sprite)', () => {
  // Antes do início / NaN → primeiro tile.
  assert.deepEqual(locateTileAtSecond(meta, -10), { index: 0, column: 0, row: 0 });
  assert.deepEqual(locateTileAtSecond(meta, Number.NaN), { index: 0, column: 0, row: 0 });
  // Muito além do fim → último tile (índice frameCount-1 = 24 → col 4, linha 4).
  assert.deepEqual(locateTileAtSecond(meta, 99999), { index: 24, column: 4, row: 4 });
});

test('recordingOffsetSeconds converte minuto-do-dia em segundos dentro da gravação', () => {
  // Gravação começa em 10:00 (600 min). Cursor em 10:00:20 → ~20s. Tolerância de
  // float: o eixo é minuto-do-dia (fração), erro sub-µs é irrelevante — o offset
  // ainda alimenta um floor pelo intervalo (segundos inteiros), então não desloca tile.
  assert.ok(Math.abs(recordingOffsetSeconds(600 + 20 / 60, 600) - 20) < 1e-6);
  // Cursor antes do início nunca vira negativo.
  assert.equal(recordingOffsetSeconds(599, 600), 0);
});

test('spriteTileStyle posiciona o tile por porcentagem (encaixa em caixa arbitrária)', () => {
  // 30s → col 1, linha 1 num grid 5×5: posição 25% 25% (i/(n-1)).
  assert.deepEqual(spriteTileStyle(meta, 30), {
    backgroundSize: '500% 500%',
    backgroundPosition: '25% 25%',
  });
  // Primeiro tile no canto superior-esquerdo.
  assert.deepEqual(spriteTileStyle(meta, 0), {
    backgroundSize: '500% 500%',
    backgroundPosition: '0% 0%',
  });
});

test('spriteTileStyle não divide por zero com 1 coluna/1 linha', () => {
  const single: TimelinePreviewMeta = { ...meta, columns: 1, rows: 1, frameCount: 1 };
  assert.deepEqual(spriteTileStyle(single, 999), {
    backgroundSize: '100% 100%',
    backgroundPosition: '0% 0%',
  });
});
