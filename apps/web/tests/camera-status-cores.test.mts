import test from 'node:test';
import assert from 'node:assert/strict';
import { CLASSE_CONEXAO, PONTO_CONEXAO, CLASSE_MODO_GRAVACAO, estadoConexao } from '../src/lib/camera-status.ts';

// A COR também precisa dizer a verdade.
//
// O rótulo passou a dizer "Online" para gravando e para movimento, mas a cor
// continuava vindo do status CRU: apareciam três "Online" — verde, âmbar e
// vermelho. Dois deles gritando alarme sem haver alarme nenhum.

test('conectada é VERDE, caída é VERMELHA — e só essas duas sinalizam', () => {
  assert.match(CLASSE_CONEXAO[estadoConexao('online')], /status-online/);
  assert.match(CLASSE_CONEXAO[estadoConexao('recording')], /status-online/);
  assert.match(CLASSE_CONEXAO[estadoConexao('motion')], /status-online/);
  assert.match(CLASSE_CONEXAO[estadoConexao('offline')], /destructive/);
});

test('gravando e com movimento NÃO pintam de vermelho nem de âmbar', () => {
  // Era exatamente isto na tela: "Online" com fundo vermelho porque a câmera
  // estava gravando, e "Online" âmbar porque detectou movimento.
  for (const s of ['recording', 'motion', 'alarm']) {
    const classe = CLASSE_CONEXAO[estadoConexao(s)];
    assert.doesNotMatch(classe, /destructive/, s);
    assert.doesNotMatch(classe, /amber|chart-4/, s);
  }
});

test('estado intermediário é NEUTRO, não vermelho', () => {
  // Pintar "Sem sinal" de vermelho o equipara a câmera fora do ar, e quem olha
  // a lista perde a capacidade de priorizar.
  for (const s of ['no_signal', 'maintenance']) {
    assert.doesNotMatch(CLASSE_CONEXAO[estadoConexao(s)], /destructive|status-online/, s);
  }
});

test('o MODO de gravação não usa nenhuma cor de alerta', () => {
  // Modo é configuração, não incidente. Uma lista de câmeras saudáveis não pode
  // parecer painel de emergência — senão o vermelho de verdade some no meio.
  assert.doesNotMatch(CLASSE_MODO_GRAVACAO, /destructive|status-online|amber|chart-2|chart-4/);
});

test('o ponto colorido segue a mesma regra do selo', () => {
  assert.match(PONTO_CONEXAO[estadoConexao('recording')], /status-online/);
  assert.match(PONTO_CONEXAO[estadoConexao('offline')], /destructive/);
});
