import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string) => readFileSync(path, 'utf8');
const semComentarios = (texto: string) => texto
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((linha) => !linha.trim().startsWith('//') && !linha.trim().startsWith('*')).join('\n');

// ─────────────────────────────────────────────────────────────────────────────
// /playback, /review e /ptz usavam um <Select> cru com a frota inteira em lista
// plana: 27 itens, sem busca e sem dizer quem está no ar. Estes testes travam a
// convergência — o risco real aqui é uma das três telas ficar para trás numa
// refatoração futura, que foi exatamente como o problema nasceu.
// ─────────────────────────────────────────────────────────────────────────────

const TELAS_COM_SELETOR = [
  'src/pages/PlaybackPage.tsx',
  'src/pages/ReviewPage.tsx',
  'src/pages/PTZPage.tsx',
];

test('as três telas usam o MESMO seletor de câmera', () => {
  for (const tela of TELAS_COM_SELETOR) {
    const fonte = read(tela);
    assert.match(fonte, /<SeletorDeCamera/, `${tela} não usa o seletor compartilhado`);
    assert.match(fonte, /import \{ SeletorDeCamera \}/, `${tela} não importa o seletor`);
  }
});

test('nenhuma delas voltou a listar a frota num <Select> cru', () => {
  // O padrão que se quer impedir: mapear `cameras` direto para <SelectItem>.
  for (const tela of TELAS_COM_SELETOR) {
    const fonte = semComentarios(read(tela));
    assert.doesNotMatch(
      fonte,
      /cameras\s*\.?\s*map\([^)]*=>\s*\(?\s*<SelectItem/,
      `${tela} voltou a montar a lista de câmeras num <Select> cru`,
    );
  }
});

test('o seletor oferece busca e distingue câmera no ar da fora do ar', () => {
  const fonte = read('src/components/SeletorDeCamera.tsx');
  assert.match(fonte, /CommandInput/, 'sem campo de busca');
  assert.match(fonte, /placeholder="Buscar câmera/, 'busca sem rótulo visível');
  assert.match(fonte, /isOnline === false/, 'não distingue o estado da câmera');
  assert.match(fonte, /Fora do ar/, 'não agrupa as offline');
});

test('a busca casa por código E por nome', () => {
  // "21" tem que achar a Cam-21 — buscar só por nome quebraria isso, que é o
  // jeito mais rápido de achar câmera numa frota numerada.
  const fonte = read('src/components/SeletorDeCamera.tsx');
  assert.match(fonte, /value=\{`\$\{camera\.name\} \$\{camera\.code[^}]*\} \$\{camera\.id\}`\}/);
});

test('câmera offline continua SELECIONÁVEL', () => {
  // Esconder offline seria o extremo oposto do defeito: em /playback ela tem
  // gravação para rever, e em /ptz o operador pode querer tentar assim mesmo.
  const fonte = semComentarios(read('src/components/SeletorDeCamera.tsx'));
  assert.doesNotMatch(fonte, /disabled=\{camera\.isOnline === false\}/);
  assert.doesNotMatch(fonte, /filter\([^)]*isOnline\)/, 'não pode filtrar offline para fora da lista');
});

test('o seletor é operável por teclado e anunciado a leitor de tela', () => {
  const fonte = read('src/components/SeletorDeCamera.tsx');
  assert.match(fonte, /role="combobox"/);
  assert.match(fonte, /aria-expanded=/);
  assert.match(fonte, /aria-label=/);
});

test('a tela de PTZ não trata "ainda não sondada" como "sem PTZ"', () => {
  // A distinção que fez a diferença no caso real: as câmeras NOC têm PTZ, mas
  // estavam offline quando a varredura passou. Dizer só "nenhuma câmera
  // compatível" faria o dono concluir que o sistema não as reconhece.
  const fonte = read('src/pages/PTZPage.tsx');
  assert.match(fonte, /ptzDetectado === null/, 'não separa o estado pendente');
  assert.match(fonte, /fora do ar|não puderam ser verificadas/i, 'não explica a pendência ao operador');
});

test('a capacidade PTZ vem da API, não é deduzida no cliente', () => {
  // Era `Boolean(camera.onvifPath || camera.onvifProfileToken)`: "foi cadastrada
  // por ONVIF" virava "tem PTZ", e a tela enchia de câmera fixa.
  const store = semComentarios(read('src/store/vmsDataStore.ts'));
  assert.doesNotMatch(store, /ptzCapable:\s*Boolean\(\s*camera\.onvif/);
  assert.match(store, /ptzCapable:\s*camera\.ptzCapable === true/);
});
