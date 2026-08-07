import test from 'node:test';
import assert from 'node:assert/strict';
import { formatarBytes, formatarDataHora, formatarNumero } from '../src/lib/formato.ts';

// A auditoria encontrou "0.03 GB" para uma câmera de 30 MB e "1234.56 GB" com
// ponto decimal e sem separador de milhar — numa interface em português.

test('escolhe a unidade pelo tamanho, em vez de forçar GB', () => {
  assert.equal(formatarBytes(0), '0 B');
  assert.equal(formatarBytes(900), '900 B');
  assert.equal(formatarBytes(30 * 1024 * 1024), '30 MB');
  assert.match(formatarBytes(1024 ** 4), /TB$/);
});

test('usa vírgula decimal e separador de milhar do pt-BR', () => {
  // PB é a maior unidade da escala, então o número não sobe mais: 1.500,5 PB
  // exercita os dois — milhar com ponto e decimal com vírgula.
  const resultado = formatarBytes(1500.5 * 1024 ** 5);
  assert.match(resultado, /1\.500/, `milhar com ponto — recebido: ${resultado}`);
  assert.match(resultado, /,5/, `decimal com vírgula — recebido: ${resultado}`);
});

test('valor ausente ou inválido vira N/D, nunca NaN na tela', () => {
  assert.equal(formatarBytes(null), 'N/D');
  assert.equal(formatarBytes('abc'), 'N/D');
  assert.equal(formatarDataHora(null), 'N/D');
  assert.equal(formatarDataHora('data inválida'), 'N/D');
  assert.equal(formatarNumero(undefined), 'N/D');
});

test('aceita bytes como string (a API devolve BigInt serializado)', () => {
  assert.equal(formatarBytes('1048576'), '1 MB');
});
