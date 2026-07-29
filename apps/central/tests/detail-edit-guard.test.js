'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ── O refresh de 30s NÃO pode apagar o que o operador digita ────────────────
//
// O painel recarrega tudo a cada 30s (setInterval(load, 30000) → render →
// renderDetail), e renderDetail reescrevia o innerHTML do detalhe inteiro —
// recriando os formulários e APAGANDO o texto em digitação. O formulário de
// storage tem 7 campos (dois deles chaves coladas com cuidado): ninguém
// termina em 30s. Resultado observado ao vivo: cadastrar nuvem pela interface
// era IMPOSSÍVEL, sem nenhuma mensagem — o texto só sumia.
//
// O painel é HTML+JS puro, sem build: estes testes estáticos são a única rede.

const PANEL = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function corpoDaFuncao(nome) {
  const inicio = PANEL.indexOf(`function ${nome}(`);
  assert.ok(inicio > -1, `função ${nome} não encontrada`);
  const proxima = PANEL.indexOf('\n      function ', inicio + 1);
  return PANEL.slice(inicio, proxima > inicio ? proxima : PANEL.length);
}

test('renderDetail desiste ANTES de mexer no DOM quando há edição em curso', () => {
  const corpo = corpoDaFuncao('renderDetail');
  const guarda = corpo.indexOf('state.cloudEditing || digitandoNoDetalhe');
  // A escrita real no DOM, não a palavra "innerHTML" (que também aparece no
  // comentário que explica a guarda).
  const primeiraEscrita = corpo.indexOf('els.detail.innerHTML =');
  assert.ok(guarda > -1, 'a guarda anti-redesenho sumiu — o refresh de 30s volta a apagar formulário');
  assert.ok(primeiraEscrita > -1);
  assert.ok(
    guarda < primeiraEscrita,
    'a guarda precisa vir ANTES de qualquer escrita no DOM, senão o estrago já aconteceu',
  );
});

test('a guarda cobre digitação em QUALQUER campo do detalhe, não só o de nuvem', () => {
  // IA, escala e formulários futuros não têm flag própria de edição; o que os
  // protege é o foco estar num campo dentro do detalhe. Se esta verificação
  // regredir para "só cloudEditing", os outros formulários voltam a ser
  // apagados em silêncio.
  const corpo = corpoDaFuncao('renderDetail');
  assert.match(corpo, /document\.activeElement/, 'precisa olhar onde está o foco');
  assert.match(corpo, /els\.detail\.contains\(foco\)/, 'só segura o redesenho se o foco está DENTRO do detalhe');
  assert.match(
    corpo,
    /INPUT\|SELECT\|TEXTAREA/,
    'foco em botão/link não pode congelar o painel — só campo editável',
  );
});

test('trocar de instalação abandona a edição (não congela o DOM da anterior)', () => {
  // Sem isto, abrir OUTRA instalação com um formulário aberto deixaria a tela
  // presa no conteúdo da instalação anterior — a guarda protegeria o DOM
  // errado. É o custo de segurar o redesenho, e ele é pago aqui.
  const corpo = corpoDaFuncao('openInstallationDetail');
  const zera = corpo.indexOf('state.cloudEditing = null');
  const troca = corpo.indexOf('state.selectedId = installationId');
  assert.ok(zera > -1, 'abrir outra instalação precisa descartar a edição em curso');
  assert.ok(troca > -1);
  assert.ok(zera < troca, 'zere a edição ANTES de trocar o selectedId');
});

test('salvar/cancelar liberam o refresh de volta (cloudEditing volta a null)', () => {
  // A guarda só é aceitável porque é TEMPORÁRIA: assim que o operador sai do
  // formulário, o painel volta a acompanhar o servidor sozinho.
  assert.match(PANEL, /state\.cloudEditing = null/, 'algum caminho precisa soltar a guarda');
  const salvar = PANEL.indexOf("feedback.innerHTML = '<span class=\"badge ok\">Salvo</span>'");
  assert.ok(salvar > -1, 'fluxo de salvar não encontrado');
  const trecho = PANEL.slice(salvar, salvar + 300);
  assert.match(trecho, /state\.cloudEditing = null/, 'salvar com sucesso precisa fechar o modo edição');
});
