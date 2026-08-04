import test from 'node:test';
import assert from 'node:assert/strict';
import { estadoConexao, atividadeAgora, ROTULO_CONEXAO } from '../src/lib/camera-status.ts';

// ─────────────────────────────────────────────────────────────────────────────
// STATUS × ATIVIDADE × MODO
//
// `camera.status` carrega três ideias no mesmo campo: conexão, atividade do
// instante e evento. Jogado cru numa coluna chamada "Status", produzia uma lista
// em que uma câmera dizia "Gravando", a de baixo "Movimento" e a outra "Online"
// — três respostas para perguntas diferentes, empilhadas como se fossem
// comparáveis.
//
// Pior: a coluna vizinha mostra o MODO configurado, e as duas exibiam
// "Movimento" lado a lado com sentidos distintos — uma é o que aconteceu agora,
// a outra é como a câmera está configurada há meses.
// ─────────────────────────────────────────────────────────────────────────────

test('gravando e com movimento são câmeras CONECTADAS', () => {
  // O erro que isto corrige: tratar atividade como se fosse alternativa a
  // "Online", quando ela só acontece PORQUE a câmera está online.
  for (const s of ['recording', 'motion', 'alarm', 'online']) {
    assert.equal(estadoConexao(s), 'online', s);
  }
});

test('os estados que realmente falam de conexão são preservados', () => {
  assert.equal(estadoConexao('offline'), 'offline');
  assert.equal(estadoConexao('no_signal'), 'sem_sinal');
  assert.equal(estadoConexao('maintenance'), 'manutencao');
});

test('status desconhecido não vira "offline" por engano', () => {
  // Um estado novo no backend apareceria como câmera caída na tela inteira, e
  // o operador sairia atrás de um problema de rede que não existe.
  assert.equal(estadoConexao('gravando_em_nuvem'), 'online');
  assert.equal(estadoConexao(''), 'online');
});

test('a atividade só existe quando há algo acontecendo', () => {
  assert.equal(atividadeAgora('recording'), 'Gravando agora');
  assert.equal(atividadeAgora('motion'), 'Movimento agora');
  assert.equal(atividadeAgora('alarm'), 'Alarme');
});

test('câmera ociosa NÃO ganha rótulo de atividade', () => {
  // Devolver "Parada" poria um selo em cada câmera ociosa — ruído que esconde
  // as duas que estão gravando.
  assert.equal(atividadeAgora('online'), null);
  assert.equal(atividadeAgora('offline'), null);
});

test('a palavra "Movimento" não aparece como estado de conexão', () => {
  // A redundância na tela era exatamente esta: coluna de conexão e coluna de
  // modo exibindo a mesma palavra.
  const rotulos = Object.values(ROTULO_CONEXAO);
  assert.ok(!rotulos.some((r) => r.toLowerCase().includes('movimento')));
  assert.ok(!rotulos.some((r) => r.toLowerCase().includes('gravando')));
});
