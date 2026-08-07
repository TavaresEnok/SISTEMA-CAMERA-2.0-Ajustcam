import test from 'node:test';
import assert from 'node:assert/strict';
import {
  montarUrlDeReproducao,
  proximaFonte,
  ehPreparoEmAndamento,
  esperaAteRetentar,
} from '../src/utils/playback-source';

// O app pedia `compatible=1` sempre: transcodava no servidor até gravação que
// já era H.264, e a primeira reprodução de qualquer H.265 sem cache caía no
// 503 "preparando" — que o player tratava como erro definitivo.

test('a fonte PADRÃO é a direta (sem transcode no servidor)', () => {
  const url = montarUrlDeReproducao('http://api', 'rec-1', 'tok');
  assert.match(url, /forceDirect=1/);
  assert.doesNotMatch(url, /compatible/, 'pedir compatible por padrão custa um FFmpeg por vídeo assistido');
});

test('o degrau de compatibilidade NÃO manda os dois parâmetros juntos', () => {
  // `compatible` vence `forceDirect` no backend: mandar ambos seria pedir
  // transcode sem querer.
  const url = montarUrlDeReproducao('http://api', 'rec-1', 'tok', 'compativel');
  assert.match(url, /compatible=1/);
  assert.doesNotMatch(url, /forceDirect/);
});

test('o token vai codificado (JWT tem pontos e pode ter caracteres de URL)', () => {
  const url = montarUrlDeReproducao('http://api', 'rec/1', 'a+b=c');
  assert.match(url, /token=a%2Bb%3Dc/);
  assert.match(url, /rec%2F1/, 'o id também é codificado');
});

test('há UM degrau só: direta → compatível → fim', () => {
  assert.equal(proximaFonte('direta'), 'compativel');
  assert.equal(proximaFonte('compativel'), null, 'sem isto o player entraria em laço de tentativas');
});

test('503 é PREPARO, não falha — o vídeo começa quando o transcode terminar', () => {
  assert.equal(ehPreparoEmAndamento(503), true);
  assert.equal(ehPreparoEmAndamento(404), false);
  assert.equal(ehPreparoEmAndamento(null), false);
});

test('a espera respeita o Retry-After do servidor, com teto', () => {
  assert.equal(esperaAteRetentar('5', 0), 5);
  assert.equal(esperaAteRetentar('600', 0), 30, 'teto evita espera absurda');
  assert.equal(esperaAteRetentar(null, 0), 4);
  assert.ok(esperaAteRetentar(null, 3) > esperaAteRetentar(null, 0), 'escada cresce sem cabeçalho');
  assert.ok(esperaAteRetentar(null, 50) <= 30, 'e tem teto');
});
