'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolverEndpoint, ordemDeTentativa, partirEndpoint, enderecoInterno } = require('../src/endpoint-scheme');

// ─────────────────────────────────────────────────────────────────────────────
// ESQUEMA DO ENDPOINT INFERIDO
//
// O campo exigia `https://` na frente. Quem cadastra um storage não tem por que
// saber se aquele fornecedor atende em TLS — e a máquina descobre isso melhor
// que a memória de quem digita.
//
// A regra: a heurística só ORDENA os candidatos, quem decide é o servidor que
// responde. É a diferença entre inferir e adivinhar.
// ─────────────────────────────────────────────────────────────────────────────

test('esquema digitado é respeitado, sem sondagem', async () => {
  let sondou = false;
  const r = await resolverEndpoint('http://192.0.2.10:9000', { sondar: async () => { sondou = true; return true; } });
  assert.equal(r.endpoint, 'http://192.0.2.10:9000');
  assert.equal(sondou, false, 'quem escreveu o esquema já disse o que quer — sondar seria ignorá-lo');
});

test('barra no fim não vira parte do endereço', () => {
  assert.equal(partirEndpoint('https://exemplo.com/').host, 'exemplo.com');
  assert.deepEqual(ordemDeTentativa('exemplo.com//').candidatos[0], 'https://exemplo.com');
});

test('nome público sem porta tenta HTTPS primeiro', () => {
  assert.deepEqual(ordemDeTentativa('teste.endoip.sp2.com.br').candidatos, [
    'https://teste.endoip.sp2.com.br',
    'http://teste.endoip.sp2.com.br',
  ]);
});

test('endereço de rede interna tenta HTTP primeiro', () => {
  // MinIO de escritório, NAS e storage em LAN quase nunca têm certificado
  // válido: tentar TLS primeiro neles só gasta um timeout antes de acertar.
  for (const alvo of ['192.168.0.50:9000', '10.0.0.5', '172.16.4.9', 'localhost:9000', 'nas.local']) {
    assert.equal(ordemDeTentativa(alvo).candidatos[0].startsWith('http://'), true, alvo);
  }
});

test('172.32 NÃO é rede interna — o intervalo privado para em 172.31', () => {
  assert.equal(enderecoInterno('172.31.255.1'), true);
  assert.equal(enderecoInterno('172.32.0.1'), false);
  assert.equal(enderecoInterno('172.15.0.1'), false);
});

test('porta diz o esquema quando é 80 ou 443', () => {
  assert.equal(ordemDeTentativa('exemplo.com:443').candidatos[0], 'https://exemplo.com:443');
  assert.equal(ordemDeTentativa('exemplo.com:80').candidatos[0], 'http://exemplo.com:80');
});

test('IPv6 entre colchetes não é confundido com host:porta', () => {
  assert.equal(ordemDeTentativa('[2001:db8::1]:9000').candidatos[0], 'http://[2001:db8::1]:9000');
  assert.equal(enderecoInterno('::1'), true);
});

test('quem RESPONDE decide, mesmo contra a heurística', async () => {
  // Nome público: a ordem começa por HTTPS. Se só o HTTP atender, é o HTTP que
  // vale — senão a "inteligência" seria só um palpite teimoso.
  const r = await resolverEndpoint('storage.exemplo.com.br', {
    sondar: async (url) => url.startsWith('http://'),
  });
  assert.equal(r.endpoint, 'http://storage.exemplo.com.br');
  assert.equal(r.confirmado, true);
});

test('403 conta como resposta — bucket que existe e não deixa listar', async () => {
  // A sonda pergunta "há um servidor HTTP aqui?", não "posso ler?". Exigir 200
  // recusaria um endpoint perfeitamente válido.
  const r = await resolverEndpoint('storage.exemplo.com.br', { sondar: async () => true });
  assert.equal(r.endpoint, 'https://storage.exemplo.com.br');
  assert.equal(r.confirmado, true);
});

test('ninguém responde: salva o palpite e NÃO trava o cadastro', async () => {
  // Storage que ainda vai subir, ou firewall no caminho. Travar aqui impediria
  // de configurar antecipadamente; o "Testar conexão" dirá o que há de errado.
  const r = await resolverEndpoint('storage.exemplo.com.br', { sondar: async () => false });
  assert.equal(r.endpoint, 'https://storage.exemplo.com.br');
  assert.equal(r.confirmado, false);
  assert.equal(r.tentados.length, 2, 'os dois foram tentados antes de desistir');
});

test('sonda que explode é tratada como "não respondeu"', async () => {
  const r = await resolverEndpoint('storage.exemplo.com.br', {
    sondar: async (url) => { if (url.startsWith('https://')) throw new Error('DNS'); return true; },
  });
  assert.equal(r.endpoint, 'http://storage.exemplo.com.br');
});

test('campo vazio não vira endpoint nenhum', async () => {
  const r = await resolverEndpoint('   ', { sondar: async () => true });
  assert.equal(r.endpoint, '');
});

test('a sonda para na PRIMEIRA que responde, sem gastar a segunda', async () => {
  const tentados = [];
  await resolverEndpoint('exemplo.com', {
    sondar: async (url) => { tentados.push(url); return true; },
  });
  assert.equal(tentados.length, 1);
});
