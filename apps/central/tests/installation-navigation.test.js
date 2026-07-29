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
  for (const fn of ['renderRows', 'renderInventory']) {
    const corpo = corpoDaFuncao(fn);
    assert.match(
      corpo,
      /querySelectorAll\('tr\[data-id\]'\)\.forEach\(row => row\.addEventListener\('click'/,
      `${fn}: linha sem handler de clique — o usuário clica no cliente e nada acontece`,
    );
    assert.match(
      corpo,
      /openInstallationDetail\(state\.selectedId\)/,
      `${fn}: o clique precisa NAVEGAR para a instalação, não só marcar seleção`,
    );
  }
});

test('o clique persiste a seleção (a página sobrevive a um F5)', () => {
  for (const fn of ['renderRows', 'renderInventory']) {
    const corpo = corpoDaFuncao(fn);
    assert.match(
      corpo,
      /localStorage\.setItem\('drac-central-selected'/,
      `${fn}: sem persistir, recarregar a página joga o operador de volta para a lista`,
    );
  }
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

test('o handler é registrado DEPOIS de escrever o innerHTML', () => {
  // Ordem importa: innerHTML descarta os nós antigos junto com seus listeners.
  // Registrar antes deixa a tabela renderizada e morta — exatamente o mesmo
  // sintoma ("clico e não acontece nada") que este arquivo existe para impedir,
  // e ainda mais difícil de enxergar porque o código parece correto.
  const corpo = corpoDaFuncao('renderInventory');
  const escreveu = corpo.indexOf('els.inventoryRows.innerHTML');
  const registrou = corpo.indexOf("querySelectorAll('tr[data-id]')");
  assert.ok(escreveu > -1 && registrou > -1);
  assert.ok(
    registrou > escreveu,
    'o listener foi registrado antes do innerHTML — seria descartado na hora',
  );
});
