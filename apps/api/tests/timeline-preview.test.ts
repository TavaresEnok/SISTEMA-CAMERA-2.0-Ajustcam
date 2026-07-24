import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planTimelinePreview,
  buildTimelinePreviewPath,
  buildTimelinePreviewArgs,
  locateTileAtSecond,
} from '../src/recordings/helpers/timeline-preview.helper';

// ─────────────────────────────────────────────────────────────────────────────
// 2.9 — Sprite de scrubbing da timeline. A lógica PURA (intervalo por duração,
// grid do mosaico, dimensões do tile, caminho e args do ffmpeg, mapa
// tempo→tile) é o coração testável. Se qualquer uma quebrar, o sprite gerado
// pelo ffmpeg e o mapa de scrubbing do front deixam de bater.
// ─────────────────────────────────────────────────────────────────────────────

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

test('interval respeita o piso mínimo em gravações curtas', () => {
  // 60s / (120-1) ~= 0.5 → arredonda p/ 1, mas o piso é 2s.
  const plan = planTimelinePreview({ durationSeconds: 60 });
  assert.equal(plan.intervalSeconds, 2, 'segmento curto usa o piso de 2s');
  // 60/2 + 1 = 31 tiles.
  assert.equal(plan.frameCount, 31);
});

test('interval cresce p/ nunca ultrapassar maxTiles em gravações longas', () => {
  // 1h = 3600s. Com piso 2s dariam 1801 tiles (>120). Deve subir o intervalo.
  const plan = planTimelinePreview({ durationSeconds: 3600 });
  assert.ok(plan.frameCount <= 120, `frameCount ${plan.frameCount} deve respeitar o teto 120`);
  // ceil(3600 / 119) = 31 → interval 31s.
  assert.equal(plan.intervalSeconds, 31);
  assert.equal(plan.frameCount, Math.floor(3600 / 31) + 1);
});

test('teto de tiles é honrado no limite exato (nunca estoura o grid)', () => {
  // Duração enorme: o frameCount nunca pode passar de maxTiles.
  const plan = planTimelinePreview({ durationSeconds: 86_400, maxTiles: 100 });
  assert.ok(plan.frameCount <= 100, `frameCount ${plan.frameCount} <= 100`);
  assert.equal(plan.columns * plan.rows >= plan.frameCount, true, 'grid comporta todos os tiles');
});

test('grid: colunas limitadas por maxColumns, linhas cobrem todos os tiles', () => {
  const plan = planTimelinePreview({ durationSeconds: 60, maxColumns: 10 });
  // 31 tiles → 10 colunas, 4 linhas (10*4=40 >= 31).
  assert.equal(plan.columns, 10);
  assert.equal(plan.rows, 4);
  assert.ok(plan.columns * plan.rows >= plan.frameCount);
});

test('grid encolhe colunas quando há poucos tiles', () => {
  // 4s / 2s + 1 = 3 tiles → colunas = min(10,3) = 3, 1 linha.
  const plan = planTimelinePreview({ durationSeconds: 4 });
  assert.equal(plan.frameCount, 3);
  assert.equal(plan.columns, 3);
  assert.equal(plan.rows, 1);
});

test('duração nula/inválida degrada p/ um único tile (não divide por zero)', () => {
  for (const bad of [0, null, undefined, NaN, -10]) {
    const plan = planTimelinePreview({ durationSeconds: bad as any });
    assert.equal(plan.frameCount, 1, `duração ${bad} → 1 tile`);
    assert.equal(plan.columns, 1);
    assert.equal(plan.rows, 1);
    assert.ok(plan.intervalSeconds >= 1);
  }
});

test('tile mantém aspecto 16:9 por padrão e dimensões pares (yuv/mjpeg safe)', () => {
  const plan = planTimelinePreview({ durationSeconds: 60, tileWidth: 160 });
  assert.equal(plan.tileWidth, 160);
  assert.equal(plan.tileHeight, 90, '160 em 16:9 = 90');
  assert.equal(plan.tileWidth % 2, 0);
  assert.equal(plan.tileHeight % 2, 0);
});

test('aspecto 4:3 é respeitado e ainda gera altura par', () => {
  const plan = planTimelinePreview({ durationSeconds: 60, tileWidth: 160, aspectWidth: 4, aspectHeight: 3 });
  assert.equal(plan.tileHeight, 120, '160 em 4:3 = 120');
  assert.equal(plan.tileHeight % 2, 0);
});

test('aspecto que daria altura ímpar é arredondado p/ par', () => {
  // 100 * 9/16 = 56.25 → 56 (par).
  const plan = planTimelinePreview({ durationSeconds: 60, tileWidth: 100 });
  assert.equal(plan.tileWidth % 2, 0);
  assert.equal(plan.tileHeight % 2, 0);
});

test('caminho do sprite fica ao lado do MP4 (herda gate/retensão da origem)', () => {
  assert.equal(
    buildTimelinePreviewPath('/rec/camera-1/2026/07/24/10/2026-07-24_10-00-00.mp4'),
    '/rec/camera-1/2026/07/24/10/2026-07-24_10-00-00.preview.jpg',
  );
  // TS também vira .preview.jpg (troca só a extensão final).
  assert.equal(buildTimelinePreviewPath('/rec/x/seg.ts'), '/rec/x/seg.preview.jpg');
  // Sem extensão: apenas anexa.
  assert.equal(buildTimelinePreviewPath('/rec/x/noext'), '/rec/x/noext.preview.jpg');
});

test('args do ffmpeg: filtro fps→scale→tile bate com o plano', () => {
  const plan = planTimelinePreview({ durationSeconds: 60 });
  const args = buildTimelinePreviewArgs('/in.mp4', '/out.jpg', plan);
  assert.equal(flagValue(args, '-i'), '/in.mp4');
  assert.equal(args[args.length - 1], '/out.jpg', 'saída é o último arg');
  assert.equal(flagValue(args, '-frames:v'), '1', 'só um quadro mosaicado sai');
  assert.ok(args.includes('-an'), 'áudio descartado');
  const vf = flagValue(args, '-vf')!;
  assert.equal(
    vf,
    `fps=1/${plan.intervalSeconds},scale=${plan.tileWidth}:${plan.tileHeight},tile=${plan.columns}x${plan.rows}`,
  );
  // A ordem fps→scale→tile importa: amostra, encolhe, mosaica (nessa ordem).
  assert.ok(vf.indexOf('fps=') < vf.indexOf('scale=') && vf.indexOf('scale=') < vf.indexOf('tile='));
});

test('mapa tempo→tile: instante cai no tile e offset corretos do sprite', () => {
  const plan = planTimelinePreview({ durationSeconds: 60 }); // interval 2s, 10 cols, 90h
  // t=0 → primeiro tile.
  const t0 = locateTileAtSecond(plan, 0);
  assert.deepEqual([t0.index, t0.column, t0.row, t0.x, t0.y], [0, 0, 0, 0, 0]);
  // t=5s → index floor(5/2)=2 → col 2, row 0.
  const t5 = locateTileAtSecond(plan, 5);
  assert.equal(t5.index, 2);
  assert.equal(t5.x, 2 * plan.tileWidth);
  assert.equal(t5.y, 0);
  // t=25s → index 12 → col 2, row 1 (10 cols).
  const t25 = locateTileAtSecond(plan, 25);
  assert.equal(t25.index, 12);
  assert.equal(t25.column, 2);
  assert.equal(t25.row, 1);
  assert.equal(t25.x, 2 * plan.tileWidth);
  assert.equal(t25.y, 1 * plan.tileHeight);
});

test('mapa tempo→tile satura no último tile (não sai do sprite)', () => {
  const plan = planTimelinePreview({ durationSeconds: 60 }); // 31 tiles (0..30)
  const over = locateTileAtSecond(plan, 10_000);
  assert.equal(over.index, plan.frameCount - 1, 'satura no último tile');
  const neg = locateTileAtSecond(plan, -5);
  assert.equal(neg.index, 0, 'negativo cai no primeiro tile');
});
