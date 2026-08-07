import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string) => readFileSync(path, 'utf8');
const semComentarios = (texto: string) => texto
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

// ─────────────────────────────────────────────────────────────────────────────
// Linha de perímetro no editor de zonas (opção B). O que estes testes protegem
// é a diferença ENTRE os dois tipos de desenho: área e linha têm exigências
// OPOSTAS, e tratá-las igual produz zona que nunca dispara ou linha sem
// direção — falhas silenciosas nos dois casos.
// ─────────────────────────────────────────────────────────────────────────────

const EDITOR = 'src/components/DetectionZonesEditor.tsx';

test('o editor oferece o modo linha ao lado das áreas', () => {
  const fonte = read(EDITOR);
  assert.match(fonte, /Linha de perímetro/, 'sem botão para o modo linha');
  assert.match(fonte, /drawKind === 'line'/, 'o modo não é distinguido no desenho');
});

test('linha exige EXATAMENTE 2 pontos; área exige 3 ou mais', () => {
  const fonte = semComentarios(read(EDITOR));
  assert.match(fonte, /drawKind === 'line' && drawing\.length !== 2/, 'linha aceita número livre de pontos');
  assert.match(fonte, /drawKind !== 'line' && drawing\.length < 3/, 'área deixou de exigir 3 pontos');
});

test('a linha é desenhada como segmento, não como polígono', () => {
  // Um polígono de 2 pontos é invisível ou vira um traço fechado sobre si —
  // e a seta de direção não teria onde ancorar.
  const fonte = read(EDITOR);
  assert.match(fonte, /<line\b/, 'linha renderizada como polígono');
  assert.match(fonte, /zone\.kind === 'line' \?/, 'não separa o render por tipo');
});

test('a SETA de direção existe — sem ela "ab" e "ba" não significam nada', () => {
  const fonte = read(EDITOR);
  assert.match(fonte, /<marker\b/, 'sem marcador de seta');
  assert.match(fonte, /markerEnd=/, 'seta não é aplicada ao sentido ab');
  assert.match(fonte, /markerStart=/, 'seta não é aplicada ao sentido ba');
});

test('o operador escolhe o sentido proibido', () => {
  const fonte = read(EDITOR);
  assert.match(fonte, /Qualquer sentido/);
  assert.match(fonte, /value="ab"/);
  assert.match(fonte, /value="ba"/);
  // Os rótulos falam de início/fim da linha, não de "entrar"/"sair": o que é
  // entrar depende de como a linha foi desenhada, e o operador não tem como
  // saber isso sem olhar a seta.
  assert.match(fonte, /inicio|início/i);
});

test('a cor da linha é distinta das duas áreas', () => {
  // Confundir "limite que não se atravessa" com "área monitorada" faz o
  // operador desenhar a coisa errada.
  const fonte = read(EDITOR);
  const cores = fonte.match(/(exclude|include|line):\s*\{\s*stroke:\s*'([^']+)'/g) ?? [];
  assert.equal(cores.length, 3, 'os três tipos precisam de cor própria');
  const valores = cores.map((c) => c.split("'")[1]);
  assert.equal(new Set(valores).size, 3, 'duas cores iguais entre tipos diferentes');
});

test('o tipo da zona no cliente acompanha o da API', () => {
  const fonte = read(EDITOR);
  assert.match(fonte, /kind:\s*'include'\s*\|\s*'exclude'\s*\|\s*'line'/);
  assert.match(fonte, /sentido\?:\s*'ambos'\s*\|\s*'ab'\s*\|\s*'ba'/);
});
