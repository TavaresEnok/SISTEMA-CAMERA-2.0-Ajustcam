'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ── UMA MEDIÇÃO DE STORAGE NÃO PODE DERRUBAR A FROTA ────────────────────────
//
// `runSerialized` envolve a promessa INTEIRA da rota — e existe por um motivo
// legítimo (o datastore JSON faz read-modify-write sem lock). Só que o teste de
// desempenho dura MINUTOS por natureza: 256 MB num link lento têm teto de 30
// minutos. Dentro do portão, ele para TODO `/api/*` atrás de si — inclusive o
// heartbeat de todas as instalações. Com o limiar de 180s, a frota inteira
// aparece OFFLINE por causa de um clique em "Desempenho".
//
// A escrita continua serializada (é onde a corrida existe); a ESPERA, não.

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
const PROBE = fs.readFileSync(path.join(__dirname, '..', 'src', 's3-probe.js'), 'utf8');

/** Reproduz a decisão de portão do servidor para uma URL. */
function passaPeloPortao(url) {
  const m = SERVER.match(/const rotaLonga = ([^;]+);/);
  assert.ok(m, 'a regra de rota longa sumiu do servidor');
  const contexto = { url, resultado: null };
  vm.createContext(contexto);
  vm.runInContext(`resultado = ${m[1]}`, contexto);
  const longa = contexto.resultado;
  return !longa && ((url.startsWith('/api/') && url !== '/api/health') || url.startsWith('/install/'));
}

test('a medição de desempenho roda FORA do portão', () => {
  assert.equal(
    passaPeloPortao('/api/admin/installations/inst-1/cloud-storage/performance'),
    false,
    'dentro do portão, 30 min de medição = 30 min de heartbeats na fila = frota OFFLINE',
  );
});

test('a instalação remota (SSH, minutos) também fica fora', () => {
  assert.equal(passaPeloPortao('/api/admin/installations/inst-1/remote-install'), false);
});

test('as rotas normais CONTINUAM serializadas — a corrida do JSON é real', () => {
  // Sem o portão, duas edições concorrentes se sobrescrevem: foi assim que o
  // nome do app definido pelo operador voltava sozinho para "DRAC Local".
  for (const url of [
    '/api/admin/installations',
    '/api/admin/installations/inst-1/cloud-storage',
    '/api/agent/heartbeat',
    '/install/script.sh',
  ]) {
    assert.equal(passaPeloPortao(url), true, `${url} precisa continuar serializada`);
  }
});

test('/api/health nunca entra na fila — é o sinal de vida da própria Central', () => {
  assert.equal(passaPeloPortao('/api/health'), false);
});

test('a gravação da auditoria da medição É serializada, com o banco RELIDO', () => {
  // Rodando fora do portão, o `db` carregado no início da rota está velho ao
  // fim de 30 minutos: gravá-lo apagaria tudo que chegou nesse meio-tempo.
  const trecho = SERVER.slice(SERVER.indexOf('cloud_storage_measured') - 900, SERVER.indexOf('cloud_storage_measured') + 500);
  assert.match(trecho, /runSerialized\(/, 'a escrita tem de entrar na fila');
  assert.match(trecho, /await loadDb\(\)/, 'sem reler, a medição sobrescreve 30 min de mudanças');
});

test('a amostra é gerada em BLOCOS assíncronos, não com randomBytes síncrono', () => {
  // randomBytes(256MB) é síncrono: enquanto o CSPRNG trabalha, o laço de
  // eventos não atende NADA — nem o heartbeat.
  assert.match(PROBE, /async function gerarAmostra/, 'a geração precisa ser assíncrona');
  assert.ok(
    !/randomBytes\((?:mb|alvo) \* 1024 \* 1024\)/.test(PROBE),
    'voltou a gerar a amostra inteira de forma síncrona',
  );
  assert.match(PROBE, /randomFill/, 'randomFill é a versão que devolve o controle entre blocos');
});
