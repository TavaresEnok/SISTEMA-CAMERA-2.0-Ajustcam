'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ── A TELA PISCANDO A CADA 30s ──────────────────────────────────────────────
//
// Relato do operador: "a central fica piscando a cada 30s; faço um teste de
// desempenho no S3 e quando pisca eu perco todas as informações".
//
// Medido: comparando a resposta de /api/admin/installations com 30s de
// intervalo, UM ÚNICO campo muda — `ageSeconds`, a idade do último sinal, que
// por definição muda a cada leitura. Esse número entrava no HTML de vários
// blocos, mudava a assinatura de cada um, e o painel inteiro era destruído e
// recriado duas vezes por minuto.
//
// Escrever `innerHTML` não "atualiza o texto": destrói e recria TODOS os nós
// filhos. Por isso levava junto o que tivesse sido escrito ali depois — como o
// resultado do teste de S3, que o operador esperou 10 segundos para ver.
//
// O painel é HTML+JS puro, sem build. Em vez de conferir se o texto-fonte
// contém as palavras certas (que passa mesmo com a lógica invertida), aqui as
// funções são EXTRAÍDAS e EXECUTADAS contra um DOM de mentira.

const PANEL = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** Recorta uma função do painel contando chaves a partir da assinatura dela. */
function extrairFuncao(nome) {
  const inicio = PANEL.indexOf(`function ${nome}(`);
  assert.ok(inicio > -1, `função ${nome} não encontrada no painel`);
  const abre = PANEL.indexOf('{', inicio);
  let nivel = 0;
  for (let i = abre; i < PANEL.length; i += 1) {
    if (PANEL[i] === '{') nivel += 1;
    else if (PANEL[i] === '}') {
      nivel -= 1;
      if (nivel === 0) return PANEL.slice(inicio, i + 1);
    }
  }
  assert.fail(`não achei o fim de ${nome}`);
}

/**
 * Elemento de mentira com a MESMA mecânica do DOM real: `innerHTML` é um
 * acessor no protótipo, que é exatamente o que a guarda precisa interceptar.
 */
function bancada() {
  const escritas = [];
  const textos = [];
  // `textContent` mora no Node e `innerHTML` no Element, como no DOM de
  // verdade: a guarda precisa achar cada um no protótipo certo.
  class Node {}
  Object.defineProperty(Node.prototype, 'textContent', {
    configurable: true,
    get() { return this._texto || ''; },
    set(v) { this._texto = v; textos.push(v); },
  });
  class Element extends Node {}
  Object.defineProperty(Element.prototype, 'innerHTML', {
    configurable: true,
    get() { return this._html || ''; },
    set(v) { this._html = v; escritas.push(v); },
  });
  const el = new Element();
  el.dataset = {};
  return { Node, Element, el, escritas, textos, novo: () => Object.assign(new Element(), { dataset: {} }) };
}

function carregarGuarda(b) {
  const contexto = { Element: b.Element, Node: b.Node, Object };
  vm.createContext(contexto);
  vm.runInContext(`${extrairFuncao('ignorarRepinturaIgual')}; this.fn = ignorarRepinturaIgual;`, contexto);
  return contexto.fn;
}

test('escrever o MESMO html duas vezes só mexe no DOM uma vez', () => {
  const b = bancada();
  const { el, escritas } = b;
  carregarGuarda(b)(el);

  el.innerHTML = '<b>igual</b>';
  el.innerHTML = '<b>igual</b>';
  el.innerHTML = '<b>igual</b>';

  // Este é o defeito inteiro: três escritas idênticas destruíam e recriavam os
  // nós três vezes — a piscada, e o que estivesse dentro ia junto.
  assert.equal(escritas.length, 1, 'repintou conteúdo idêntico: a tela volta a piscar');
});

test('html diferente PRECISA chegar ao DOM', () => {
  const b = bancada();
  const { el, escritas } = b;
  carregarGuarda(b)(el);

  el.innerHTML = '<b>antes</b>';
  el.innerHTML = '<b>depois</b>';

  // Uma guarda que segura demais é pior que a piscada: o painel congela e o
  // operador toma decisão com dado velho.
  assert.deepEqual(escritas, ['<b>antes</b>', '<b>depois</b>']);
});

test('ler de volta devolve o que foi escrito', () => {
  const b = bancada();
  const { el } = b;
  carregarGuarda(b)(el);
  el.innerHTML = '<i>x</i>';
  assert.equal(el.innerHTML, '<i>x</i>', 'o getter não pode se perder no caminho');
});

test('proteger duas vezes não empilha guardas', () => {
  const b = bancada();
  const { el, escritas } = b;
  const guarda = carregarGuarda(b);
  guarda(el);
  guarda(el);
  el.innerHTML = 'a';
  el.innerHTML = 'a';
  assert.equal(escritas.length, 1);
});

test('a guarda NÃO é instalada no protótipo — só nos elementos nomeados', () => {
  const b = bancada();
  const { el, escritas } = b;
  carregarGuarda(b)(el);
  const outro = b.novo();
  outro.innerHTML = 'z';
  outro.innerHTML = 'z';
  // Mexer no Element.prototype mudaria o comportamento da página inteira,
  // inclusive de código que DEPENDE de recriar os nós (remontar um formulário,
  // reiniciar uma animação). O elemento não protegido tem de continuar cru.
  assert.equal(escritas.filter((v) => v === 'z').length, 2);
});

test('escrever o MESMO texto duas vezes não troca o nó', () => {
  const b = bancada();
  const { el, textos } = b;
  carregarGuarda(b)(el);

  el.textContent = 'Atualizado 17:56:00';
  el.textContent = 'Atualizado 17:56:00';
  el.textContent = 'Atualizado 17:56:30';

  // Atribuir `textContent` SEMPRE descarta o nó de texto e cria outro, mesmo
  // com a frase idêntica. Medido: com só o innerHTML protegido ainda morriam
  // 18 nós por ciclo, todos assim.
  assert.deepEqual(textos, ['Atualizado 17:56:00', 'Atualizado 17:56:30']);
});

test('a guarda de texto não engole uma mudança de verdade', () => {
  const b = bancada();
  const { el, textos } = b;
  carregarGuarda(b)(el);
  el.textContent = 'há 10s';
  el.textContent = 'há 40s';
  assert.deepEqual(textos, ['há 10s', 'há 40s'], 'o contador precisa continuar contando');
});

test('elemento inexistente não derruba a inicialização', () => {
  const b = bancada();
  const guarda = carregarGuarda(b);
  assert.doesNotThrow(() => guarda(null));
  assert.doesNotThrow(() => guarda(undefined));
});

// ── O CONTADOR VOLÁTIL FICA FORA DA ASSINATURA ──────────────────────────────

test('a idade do último sinal NÃO é escrita dentro do html dos blocos', () => {
  // Se `timeAgo(ageSeconds)` voltar para dentro de um template, a assinatura
  // volta a mudar a cada 30s e a guarda acima deixa de ter efeito — o painel
  // pisca de novo, com todo o código "correto" no lugar.
  // `reasonsFor` alimenta a fila de atenção; as outras duas desenham a linha
  // da tabela de Operação e o cabeçalho do detalhe. São os três lugares onde
  // a idade aparecia interpolada. (A linha da Operação hoje mora em
  // `linhaOperacaoHtml`, extraída de renderRows para a reconciliação por
  // linha — a regra vale igual.)
  for (const nome of ['linhaOperacaoHtml', 'renderDetailHero', 'reasonsFor']) {
    const corpo = extrairFuncao(nome);
    assert.ok(
      !/timeAgo\(\s*(item|a|b)\.ageSeconds\s*\)/.test(corpo),
      `${nome} voltou a interpolar a idade no html — a assinatura fica instável e a tela pisca`,
    );
    assert.ok(corpo.includes('data-idade='), `${nome} precisa emitir o span vazio de idade`);
  }
});

test('atualizarIdades escreve TEXTO, nunca html', () => {
  const corpo = extrairFuncao('atualizarIdades');
  assert.ok(corpo.includes('textContent'), 'trocar texto é o que evita destruir os nós em volta');
  assert.ok(!corpo.includes('innerHTML'), 'usar innerHTML aqui reintroduz a piscada');
});

test('atualizarIdades preenche o span certo e não toca em quem já está certo', () => {
  const nos = [
    { dataset: { idade: 'inst-a' }, textContent: '' },
    { dataset: { idade: 'inst-b' }, textContent: 'há 2 min' },
    { dataset: { idade: 'sumiu' }, textContent: 'há 9 min' },
  ];
  const contexto = {
    state: { installations: [{ id: 'inst-a', ageSeconds: 40 }, { id: 'inst-b', ageSeconds: 120 }] },
    timeAgo: (s) => (s < 60 ? `${s}s` : `${Math.round(s / 60)} min`),
    document: { querySelectorAll: () => nos },
    Map,
  };
  vm.createContext(contexto);
  vm.runInContext(`${extrairFuncao('atualizarIdades')}; atualizarIdades();`, contexto);

  assert.equal(nos[0].textContent, 'há 40s');
  assert.equal(nos[1].textContent, 'há 2 min');
  // Instalação que saiu da frota: manter o texto antigo é melhor que apagar e
  // deixar um espaço vazio sem explicação.
  assert.equal(nos[2].textContent, 'há 9 min');
});

// ── O RESULTADO DO TESTE DE S3 SOBREVIVE AO REFRESH ─────────────────────────

test('renderCloudSection guarda o transitório ANTES de pintar e devolve DEPOIS', () => {
  const corpo = extrairFuncao('renderCloudSection');
  const guardou = corpo.indexOf('const transitorios');
  const pintou = corpo.indexOf('pintarSeMudou(body, html)');
  const devolveu = corpo.indexOf('for (const [sel, conteudo] of transitorios)');

  assert.ok(guardou > -1, 'sem a captura, feedbacks e a confirmação de exclusão morrem no refresh');
  assert.ok(pintou > guardou, 'capturar depois de pintar captura o vazio — não adianta nada');
  assert.ok(devolveu > pintou, 'devolver antes de pintar é sobrescrito na hora seguinte');
  // O resultado do desempenho NÃO está mais na lista de resgate: o dono dele
  // é `state.cloudPerfResult` e ele entra pela assinatura (perfSalvoHtml) —
  // o resgate via DOM morria junto quando o detalhe INTEIRO repintava.
  // O comportamento novo é coberto em reload-sem-perda.test.js.
  assert.ok(corpo.includes('perfSalvoHtml(item.id)'), 'o resultado tem de ser projetado do state');
});

test('medição em curso trava a repintura da seção de nuvem', () => {
  const corpo = extrairFuncao('renderCloudSection');
  const trava = corpo.indexOf('state.cloudMedindo === item.id');
  const primeiraEscrita = corpo.indexOf('pintarSeMudou(body, html)');
  assert.ok(trava > -1, 'sem esta trava o refresh reabilita o botão no meio do teste');
  assert.ok(trava < primeiraEscrita, 'a trava precisa vir ANTES de mexer no DOM');
});

test('a bandeira de medição é sempre baixada, mesmo com erro', () => {
  const corpo = extrairFuncao('medirDesempenhoStorage');
  const finaliza = corpo.indexOf('} finally {');
  const limpa = corpo.indexOf('state.cloudMedindo = null');
  assert.ok(limpa > -1 && finaliza > -1);
  // Se ficasse presa, a seção de nuvem NUNCA mais se atualizaria naquela aba —
  // um erro de rede congelaria o painel até recarregar a página.
  assert.ok(limpa > finaliza, 'baixar a bandeira precisa estar no finally, não no caminho feliz');
});

test('render() atualiza as idades DEPOIS de desenhar os blocos', () => {
  const corpo = extrairFuncao('render');
  const desenha = corpo.lastIndexOf('renderWall()');
  const idades = corpo.indexOf('atualizarIdades()');
  assert.ok(idades > -1, 'sem esta chamada os spans de idade ficam vazios na tela');
  assert.ok(idades > desenha, 'preencher antes de desenhar é apagado pelo desenho');
});
