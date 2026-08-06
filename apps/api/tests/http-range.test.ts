import test from 'node:test';
import assert from 'node:assert/strict';
import { resolverRange, validadoresDeCache } from '../src/recordings/helpers/http-range.helper';

// ── RANGE QUE MENTE = SEEK QUEBRADO SEM ERRO APARENTE ───────────────────────
//
// O parser antigo respondia 206 com bytes ERRADOS para sufixo (`bytes=-500`,
// os últimos N — onde mora o índice moov do MP4) e devolvia o arquivo inteiro
// rotulado de 206 para multi-range/malformado. Em link lento isso é o pior
// tipo de defeito: o player recebe lixo com cara de sucesso.

const SIZE = 10_000;

test('range normal: início e fim respeitados', () => {
  assert.deepEqual(resolverRange('bytes=100-199', SIZE), { tipo: 'parcial', start: 100, end: 199 });
});

test('range aberto no fim: até o último byte', () => {
  assert.deepEqual(resolverRange('bytes=9000-', SIZE), { tipo: 'parcial', start: 9000, end: SIZE - 1 });
});

test('SUFIXO devolve os ÚLTIMOS N bytes — é onde mora o índice do MP4', () => {
  assert.deepEqual(resolverRange('bytes=-500', SIZE), { tipo: 'parcial', start: SIZE - 500, end: SIZE - 1 });
});

test('sufixo maior que o arquivo: o arquivo inteiro como parcial válido', () => {
  assert.deepEqual(resolverRange(`bytes=-${SIZE * 2}`, SIZE), { tipo: 'parcial', start: 0, end: SIZE - 1 });
});

test('multi-range não implementado: IGNORA (200 completo), nunca 206 mentiroso', () => {
  assert.deepEqual(resolverRange('bytes=0-99,200-299', SIZE), { tipo: 'completo' });
});

test('malformado: 200 completo, nunca 206 do arquivo inteiro', () => {
  assert.deepEqual(resolverRange('bytes=abc-def', SIZE), { tipo: 'completo' });
  assert.deepEqual(resolverRange('quilometros=0-10', SIZE), { tipo: 'completo' });
});

test('início além do arquivo: 416', () => {
  assert.deepEqual(resolverRange(`bytes=${SIZE}-`, SIZE), { tipo: 'insatisfazivel' });
  assert.deepEqual(resolverRange('bytes=500-100', SIZE), { tipo: 'insatisfazivel' });
});

test('fim além do arquivo é RECORTADO, não recusado', () => {
  assert.deepEqual(resolverRange(`bytes=100-${SIZE * 9}`, SIZE), { tipo: 'parcial', start: 100, end: SIZE - 1 });
});

test('sem cabeçalho: completo', () => {
  assert.deepEqual(resolverRange(undefined, SIZE), { tipo: 'completo' });
});

test('validadores estáveis: mesmo arquivo, mesmo ETag — é o que permite 304', () => {
  const stats = { size: 1234, mtimeMs: 1_700_000_000_000 };
  const a = validadoresDeCache(stats);
  const b = validadoresDeCache(stats);
  assert.equal(a.etag, b.etag);
  assert.notEqual(validadoresDeCache({ size: 1235, mtimeMs: stats.mtimeMs }).etag, a.etag, 'tamanho diferente = conteúdo diferente');
});
