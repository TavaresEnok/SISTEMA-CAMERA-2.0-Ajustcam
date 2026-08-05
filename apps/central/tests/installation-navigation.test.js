'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ── Clicar num cliente TEM que abrir a instalação ───────────────────────────
//
// A Central lista as mesmas instalações em duas tabelas: "Operação"
// (renderRows) e "Clientes" (renderInventory). Só a primeira tinha handler de
// clique na linha. A segunda já marcava `data-id` em cada `<tr>` e já chamava
// `event.stopPropagation()` nos botões de ação — ou seja, o clique de linha era
// esperado pelo código e simplesmente nunca foi escrito.
//
// Para quem usa, o sintoma não é "falta um handler", é "a Central não
// responde": clicar no nome do cliente não fazia nada, sem erro, sem console,
// sem pista. E o operador que reporta isso está certo, mesmo que a outra aba
// funcione — ninguém deve precisar descobrir por qual tabela o clique vale.
//
// O painel é HTML+JS puro, sem build nem typecheck. Estes testes são a única
// rede aqui, então travam a NAVEGAÇÃO nas duas tabelas de uma vez.

const PANEL = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** Corpo de uma função do painel, do nome dela até a próxima declaração. */
function corpoDaFuncao(nome) {
  const inicio = PANEL.indexOf(`function ${nome}(`);
  assert.ok(inicio > -1, `função ${nome} não encontrada no painel`);
  const proxima = PANEL.indexOf('\n      function ', inicio + 1);
  return PANEL.slice(inicio, proxima > inicio ? proxima : PANEL.length);
}

test('AS DUAS tabelas abrem o detalhe ao clicar na linha', () => {
  // As linhas hoje nascem em reconciliarLinhas (repintura por linha, para o
  // heartbeat de UMA instalação não destruir a tabela inteira): o clique é
  // ligado no callback `ligar`, em cada <tr> criado — inclusive nos recriados
  // um a um quando só uma linha muda.
  for (const fn of ['renderRows', 'renderInventory']) {
    const corpo = corpoDaFuncao(fn);
    assert.match(corpo, /reconciliarLinhas\(/, `${fn}: as linhas devem nascer pela reconciliação, que é quem religa os cliques`);
    assert.match(
      corpo,
      /tr\.addEventListener\('click', \(\) => openInstallationDetail\(tr\.dataset\.id\)\)/,
      `${fn}: linha sem handler de clique — o usuário clica no cliente e nada acontece`,
    );
  }
});

test('a navegação centralizada persiste a seleção e abre a tela de detalhe', () => {
  // As duas tabelas delegam para a mesma função. A persistência pertence a
  // essa fronteira, não deve ser duplicada em cada origem de navegação.
  const corpo = corpoDaFuncao('openInstallationDetail');
  assert.match(corpo, /state\.selectedId = installationId/);
  assert.match(
    corpo,
    /localStorage\.setItem\('drac-central-selected', installationId\)/,
    'sem persistir, recarregar a página joga o operador de volta para a lista',
  );
  assert.match(corpo, /setView\('detalhe'\)/, 'a seleção também precisa abrir a página da instalação');
});

test('botões de ação NÃO disparam a navegação da linha', () => {
  // Regressão real e cara: "Gerar app" fica dentro do <tr>. Sem
  // stopPropagation, clicar nele geraria o app E navegaria para outra tela no
  // mesmo gesto — o operador perde de vista o que acabou de disparar.
  const corpo = corpoDaFuncao('renderInventory');
  for (const acao of ['data-genapp', 'data-editapp']) {
    const i = corpo.indexOf(`[${acao}]`);
    assert.ok(i > -1, `${acao} deveria existir em renderInventory`);
    const trecho = corpo.slice(i, i + 260);
    assert.match(
      trecho,
      /event\.stopPropagation\(\)/,
      `${acao}: precisa parar a propagação antes de agir`,
    );
  }
});

test('o handler é registrado DEPOIS de escrever o DOM, nos dois caminhos', () => {
  // Ordem importa: innerHTML descarta os nós antigos junto com seus listeners.
  // Registrar antes deixa a tabela renderizada e morta — o mesmo sintoma
  // ("clico e não acontece nada") que este arquivo existe para impedir. A
  // fronteira que escreve DOM hoje é reconciliarLinhas, então é lá que a
  // ordem se garante — no rebuild inteiro e na troca de linha única.
  const corpo = corpoDaFuncao('reconciliarLinhas');
  const escreveuTudo = corpo.indexOf('tbody.innerHTML = htmlCompleto');
  const ligouTudo = corpo.indexOf('ligar(tr)');
  assert.ok(escreveuTudo > -1 && ligouTudo > escreveuTudo, 'religar antes do innerHTML seria descartado na hora');
  const criouLinha = corpo.indexOf('molde.content.firstElementChild');
  const ligouLinha = corpo.indexOf('ligar(nova)');
  assert.ok(criouLinha > -1 && ligouLinha > criouLinha, 'a linha recriada precisa nascer com o próprio clique ligado');
});
