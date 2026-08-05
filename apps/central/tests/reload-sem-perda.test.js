'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ── A RECARGA DE VERSÃO NÃO PODE ENGOLIR O TRABALHO DO OPERADOR ─────────────
//
// Relato: o operador roda o teste de desempenho do S3, espera ~10s, o número
// aparece — e até 30s depois a página recarrega sozinha e apaga tudo,
// voltando para a aba padrão.
//
// A recarga automática em si está certa (aba aberta por horas rodando JS de
// antes do deploy é pior). O que estava errado:
//   1. a guarda só ADIAVA a recarga durante a medição; terminou, o ciclo
//      seguinte recarregava e apagava o resultado recém-lido;
//   2. nada da tela atravessava a recarga — aba do detalhe, busca, filtros e
//      o resultado morriam juntos;
//   3. no sentido oposto, um cursor esquecido num campo segurava a recarga
//      PARA SEMPRE, e o operador ficava em código velho sem saber.
//
// O conserto: a tela é salva em sessionStorage antes do reload e devolvida no
// boot; e o adiamento passa a ter prazo — só edição NÃO SALVA segura sem
// limite. Como no arquivo vizinho, as funções são EXTRAÍDAS do painel e
// EXECUTADAS, não conferidas por palavras no texto-fonte.

const PANEL = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** Recorta uma função do painel contando chaves; preserva o `async` se houver. */
function extrairFuncao(nome) {
  const inicio = PANEL.indexOf(`function ${nome}(`);
  assert.ok(inicio > -1, `função ${nome} não encontrada no painel`);
  const prefixo = PANEL.slice(Math.max(0, inicio - 6), inicio) === 'async ' ? 'async ' : '';
  const abre = PANEL.indexOf('{', inicio);
  let nivel = 0;
  for (let i = abre; i < PANEL.length; i += 1) {
    if (PANEL[i] === '{') nivel += 1;
    else if (PANEL[i] === '}') {
      nivel -= 1;
      if (nivel === 0) return prefixo + PANEL.slice(inicio, i + 1);
    }
  }
  assert.fail(`não achei o fim de ${nome}`);
}

/** Constante extraída do próprio painel — o teste não pode divergir do valor real. */
function extrairConstante(nome) {
  const m = PANEL.match(new RegExp(`const ${nome} = ([^;]+);`));
  assert.ok(m, `constante ${nome} não encontrada no painel`);
  return vm.runInNewContext(m[1]);
}

const CHAVE_RECARGA = extrairConstante('CHAVE_RECARGA');
const VALIDADE_MS = extrairConstante('RECARGA_PERF_VALIDADE_MS');

/** sessionStorage de mentira com a mesma superfície usada pelo painel. */
function armazemFake() {
  const dados = new Map();
  return {
    getItem: (k) => (dados.has(k) ? dados.get(k) : null),
    setItem: (k, v) => dados.set(k, String(v)),
    removeItem: (k) => dados.delete(k),
    dados,
  };
}

function rodar(nomes, contexto) {
  vm.createContext(contexto);
  const fontes = nomes.map((n) => extrairFuncao(n)).join('\n');
  const exporta = nomes.map((n) => `this.${n} = ${n};`).join(' ');
  vm.runInContext(`${fontes}\n${exporta}`, contexto);
  return contexto;
}

// ── recargaSeguraAgora: quando a recarga pode acontecer ─────────────────────

function seguro(ativo, medindo, ocioso) {
  const ctx = rodar(['recargaSeguraAgora'], {});
  return ctx.recargaSeguraAgora(ativo, medindo, ocioso);
}

test('medição de S3 no ar segura a recarga', () => {
  assert.equal(seguro(null, 'inst-1', 999999), false);
});

test('medição terminada e foco fora de campo: a recarga PODE acontecer', () => {
  // Este é o cenário do relato. A recarga é permitida — o que protege o
  // resultado agora é a travessia por sessionStorage, testada mais abaixo.
  assert.equal(seguro({ tagName: 'BODY' }, null, 999999), true);
});

test('digitação recente segura, mesmo com o campo intocado', () => {
  const campo = { tagName: 'INPUT', value: '', defaultValue: '' };
  assert.equal(seguro(campo, null, 5000), false);
});

test('cursor esquecido num campo INTOCADO deixa de segurar após 90s ocioso', () => {
  // O furo antigo: bastava largar o cursor num campo e a aba nunca mais
  // atualizava — o operador ficava em código velho sem saber.
  const campo = { tagName: 'INPUT', value: 'MinIO do escritório', defaultValue: 'MinIO do escritório' };
  assert.equal(seguro(campo, null, 90000), true);
  assert.equal(seguro(campo, null, 89999), false, 'antes do prazo ainda é digitação em curso');
});

test('edição NÃO SALVA segura sem prazo', () => {
  // value≠defaultValue = tem coisa digitada que o HTML não trouxe. Perder
  // isso é pior que rodar código velho; o carimbo clicável fica à vista.
  const campo = { tagName: 'TEXTAREA', value: 'chave nova digitada', defaultValue: '' };
  assert.equal(seguro(campo, null, 99999999), false);
});

test('SELECT focado não conta como edição não salva', () => {
  // Um select não guarda texto digitado; depois do prazo ocioso, recarrega.
  const campo = { tagName: 'SELECT', value: '64', defaultValue: '' };
  assert.equal(seguro(campo, null, 90000), true);
});

// ── A tela atravessa a recarga: salvar → ler → aplicar → devolver ───────────

function contextoDeCaptura({ perfHtml = '', agora = 1000000 } = {}) {
  const armazem = armazemFake();
  const perfEl = { innerHTML: perfHtml };
  return rodar(['capturarTela', 'salvarTelaParaRecarga', 'lerTelaSalva'], {
    CHAVE_RECARGA,
    JSON,
    Date: { now: () => agora },
    sessionStorage: armazem,
    document: { querySelector: (sel) => (sel === '#cloud-perf-result' ? perfEl : null) },
    state: { detailTab: 'armazenamento', selectedId: 'inst-7' },
    els: {
      search: { value: 'eveo' },
      communication: { value: 'ONLINE' },
      contract: { value: 'all' },
      sort: { value: 'disk' },
    },
    armazem,
  });
}

test('salvar e ler devolvem a MESMA tela: resultado, aba, busca e filtros', () => {
  const ctx = contextoDeCaptura({ perfHtml: '<div class="perf">12ms</div>' });
  ctx.salvarTelaParaRecarga();
  const tela = ctx.lerTelaSalva(ctx.armazem);
  assert.equal(tela.detailTab, 'armazenamento');
  assert.equal(tela.busca, 'eveo');
  assert.deepEqual(tela.filtros, { communication: 'ONLINE', contract: 'all', sort: 'disk' });
  assert.deepEqual(tela.perf, { instalacao: 'inst-7', html: '<div class="perf">12ms</div>', em: 1000000 });
});

test('a tela salva vale para UMA recarga: a segunda leitura vem vazia', () => {
  // Se ficasse, um F5 de amanhã reidrataria o resultado de ontem.
  const ctx = contextoDeCaptura({ perfHtml: '<b>x</b>' });
  ctx.salvarTelaParaRecarga();
  assert.ok(ctx.lerTelaSalva(ctx.armazem));
  assert.equal(ctx.lerTelaSalva(ctx.armazem), null);
});

test('sem resultado na tela, perf salvo é null — não um html vazio', () => {
  const ctx = contextoDeCaptura({ perfHtml: '' });
  ctx.salvarTelaParaRecarga();
  assert.equal(ctx.lerTelaSalva(ctx.armazem).perf, null);
});

test('estado corrompido no armazenamento não derruba o boot', () => {
  const ctx = contextoDeCaptura({});
  ctx.armazem.setItem(CHAVE_RECARGA, '{quebrado');
  assert.equal(ctx.lerTelaSalva(ctx.armazem), null);
});

function contextoDeAplicacao({ agora = 2000000 } = {}) {
  return rodar(['aplicarTelaSalva'], {
    RECARGA_PERF_VALIDADE_MS: VALIDADE_MS,
    Date: { now: () => agora },
    perfRestaurado: null,
    state: { detailTab: 'visao' },
    els: {
      search: { value: '' },
      communication: { value: 'all' },
      contract: { value: 'all' },
      sort: { value: 'name' },
    },
  });
}

test('aplicar devolve o operador à aba, busca e filtros onde estava', () => {
  const ctx = contextoDeAplicacao();
  ctx.aplicarTelaSalva({
    detailTab: 'armazenamento',
    busca: 'eveo',
    filtros: { communication: 'ONLINE', contract: 'ACTIVE', sort: 'disk' },
    perf: { instalacao: 'inst-7', html: '<b>12ms</b>', em: 2000000 - 1000 },
  });
  assert.equal(ctx.state.detailTab, 'armazenamento', 'sem isto o operador "volta para a aba padrão"');
  assert.equal(ctx.els.search.value, 'eveo');
  assert.equal(ctx.els.communication.value, 'ONLINE');
  assert.equal(ctx.els.sort.value, 'disk');
  assert.deepEqual(ctx.perfRestaurado, { instalacao: 'inst-7', html: '<b>12ms</b>', em: 2000000 - 1000 });
});

test('medição velha demais NÃO é reidratada', () => {
  // Reidratar medição de meia hora atrás como se fosse fresca engana quem
  // está comparando fornecedor de storage.
  const ctx = contextoDeAplicacao();
  ctx.aplicarTelaSalva({ perf: { instalacao: 'i', html: '<b>x</b>', em: 2000000 - VALIDADE_MS - 1 } });
  assert.equal(ctx.perfRestaurado, null);
});

test('aplicar com tela nula (boot normal, sem recarga) não lança', () => {
  const ctx = contextoDeAplicacao();
  assert.doesNotThrow(() => ctx.aplicarTelaSalva(null));
  assert.equal(ctx.state.detailTab, 'visao');
});

function bodyComPerf(inicial = '') {
  const destino = { innerHTML: inicial };
  return { destino, body: { querySelector: (sel) => (sel === '#cloud-perf-result' ? destino : null) } };
}

test('devolver injeta o resultado na instalação certa e consome', () => {
  const ctx = rodar(['devolverPerfRestaurado'], {
    perfRestaurado: { instalacao: 'inst-7', html: '<b>12ms</b>', em: 1 },
  });
  const { destino, body } = bodyComPerf();
  ctx.devolverPerfRestaurado(body, 'inst-7');
  assert.equal(destino.innerHTML, '<b>12ms</b>');
  assert.equal(ctx.perfRestaurado, null, 'consumir uma vez: repinturas seguintes já preservam via transitórios');
});

test('instalação errada não recebe o resultado — e ele fica guardado para a certa', () => {
  // Reidratar no lugar errado atribuiria o link de um fornecedor ao outro.
  const ctx = rodar(['devolverPerfRestaurado'], {
    perfRestaurado: { instalacao: 'inst-7', html: '<b>12ms</b>', em: 1 },
  });
  const { destino, body } = bodyComPerf();
  ctx.devolverPerfRestaurado(body, 'inst-OUTRA');
  assert.equal(destino.innerHTML, '');
  assert.ok(ctx.perfRestaurado, 'a instalação certa ainda pode renderizar depois');
});

test('resultado fresco já na tela não é sobrescrito pelo antigo', () => {
  const ctx = rodar(['devolverPerfRestaurado'], {
    perfRestaurado: { instalacao: 'inst-7', html: '<b>velho</b>', em: 1 },
  });
  const { destino, body } = bodyComPerf('<b>fresco</b>');
  ctx.devolverPerfRestaurado(body, 'inst-7');
  assert.equal(destino.innerHTML, '<b>fresco</b>');
});

// ── marcarVersao de ponta a ponta: adia, salva e recarrega ──────────────────

function contextoDeVersao() {
  const eventos = [];
  const el = {
    dataset: {},
    style: {},
    textContent: '',
    addEventListener: () => {},
  };
  const ctx = {
    buildAoAbrir: null,
    ultimaDigitacao: 0,
    Date: { now: () => 500000 },
    state: { cloudMedindo: null },
    document: { getElementById: () => el, activeElement: { tagName: 'BODY' } },
    centralUrl: (p) => p,
    fetch: async () => ({ json: async () => ({ build: ctx.buildNoServidor }) }),
    setTimeout: (fn) => eventos.push('reload-agendado'),
    salvarTelaParaRecarga: () => eventos.push('tela-salva'),
    buildNoServidor: '2026-08-05 10:00',
    el,
    eventos,
  };
  return rodar(['recargaSeguraAgora', 'marcarVersao'], ctx);
}

test('mesma versão: nada de recarga, o carimbo mostra o build', async () => {
  const ctx = contextoDeVersao();
  await ctx.marcarVersao();
  await ctx.marcarVersao();
  assert.deepEqual(ctx.eventos, []);
  assert.equal(ctx.el.textContent, 'v 2026-08-05 10:00');
});

test('deploy detectado em momento seguro: salva a tela E SÓ ENTÃO agenda a recarga', async () => {
  const ctx = contextoDeVersao();
  await ctx.marcarVersao();
  ctx.buildNoServidor = '2026-08-05 11:00';
  await ctx.marcarVersao();
  // A ordem é o contrato inteiro: recarregar antes de salvar perde a tela.
  assert.deepEqual(ctx.eventos, ['tela-salva', 'reload-agendado']);
});

test('deploy no meio da medição: adia com aviso; medição acabou, o ciclo seguinte recarrega', async () => {
  const ctx = contextoDeVersao();
  await ctx.marcarVersao();
  ctx.buildNoServidor = '2026-08-05 11:00';

  ctx.state.cloudMedindo = 'inst-7';
  await ctx.marcarVersao();
  assert.deepEqual(ctx.eventos, [], 'recarregar no meio jogaria a amostra do bucket fora');
  assert.equal(ctx.el.textContent, 'versão nova — recarregar');

  ctx.state.cloudMedindo = null;
  await ctx.marcarVersao();
  assert.deepEqual(ctx.eventos, ['tela-salva', 'reload-agendado'], 'o adiamento é adiamento, não cancelamento');
});

// ── O ponto de costura na seção de nuvem ────────────────────────────────────

test('renderCloudSection devolve o restaurado DEPOIS dos transitórios e antes de religar os botões', () => {
  const corpo = extrairFuncao('renderCloudSection');
  const transitorios = corpo.indexOf('for (const [sel, conteudo] of transitorios)');
  const restaurado = corpo.indexOf('devolverPerfRestaurado(body, item.id)');
  const listeners = corpo.indexOf("querySelector('#cloud-add')");
  assert.ok(restaurado > -1, 'sem esta chamada o resultado salvo nunca volta à tela');
  assert.ok(restaurado > transitorios, 'devolver antes dos transitórios seria sobrescrito por eles');
  assert.ok(restaurado < listeners, 'devolver depois de religar os botões atrasaria o que o operador está esperando ver');
});
