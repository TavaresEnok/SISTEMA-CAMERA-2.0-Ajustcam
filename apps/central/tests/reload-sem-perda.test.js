'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ── O TRABALHO DO OPERADOR SOBREVIVE A RECARGA E A REPINTURA ────────────────
//
// Dois defeitos com o MESMO sintoma ("fiz o teste de S3, esperei o número, e
// ele sumiu sozinho"):
//
//  1. A recarga automática de versão apagava a tela. Conserto: a tela
//     atravessa o reload por sessionStorage e o adiamento ganhou prazo.
//  2. Mesmo SEM recarga, a repintura de 30s destruía o resultado: a série
//     temporal desliza a janela a cada ciclo, a assinatura do detalhe inteiro
//     mudava sempre, e o innerHTML global recriava tudo — inclusive o
//     #cloud-perf-result, cujo "resgate" vivia só no DOM que acabava de
//     morrer. Conserto: o resultado mora em `state.cloudPerfResult` (o DOM é
//     projeção), a casca do detalhe é estável com corpos voláteis separados,
//     e as tabelas repintam SÓ a linha que mudou.
//
// Como no arquivo vizinho, as funções são EXTRAÍDAS do painel e EXECUTADAS,
// não conferidas por palavras no texto-fonte.

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
  // O que protege o resultado é a travessia por sessionStorage + o state ser
  // o dono dele — não o bloqueio eterno da recarga.
  assert.equal(seguro({ tagName: 'BODY' }, null, 999999), true);
});

test('digitação recente segura, mesmo com o campo intocado', () => {
  const campo = { tagName: 'INPUT', value: '', defaultValue: '' };
  assert.equal(seguro(campo, null, 5000), false);
});

test('cursor esquecido num campo INTOCADO deixa de segurar após 90s ocioso', () => {
  const campo = { tagName: 'INPUT', value: 'MinIO do escritório', defaultValue: 'MinIO do escritório' };
  assert.equal(seguro(campo, null, 90000), true);
  assert.equal(seguro(campo, null, 89999), false, 'antes do prazo ainda é digitação em curso');
});

test('edição NÃO SALVA segura sem prazo', () => {
  const campo = { tagName: 'TEXTAREA', value: 'chave nova digitada', defaultValue: '' };
  assert.equal(seguro(campo, null, 99999999), false);
});

test('SELECT focado não conta como edição não salva', () => {
  const campo = { tagName: 'SELECT', value: '64', defaultValue: '' };
  assert.equal(seguro(campo, null, 90000), true);
});

// ── A tela atravessa a recarga: salvar → ler → aplicar → projetar ───────────

function contextoDeCaptura({ perf = null } = {}) {
  const armazem = armazemFake();
  return rodar(['capturarTela', 'salvarTelaParaRecarga', 'lerTelaSalva'], {
    CHAVE_RECARGA,
    JSON,
    sessionStorage: armazem,
    state: { detailTab: 'armazenamento', selectedId: 'inst-7', cloudPerfResult: perf },
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
  const perf = { instalacao: 'inst-7', html: '<div class="perf">12ms</div>', em: 1000000 };
  const ctx = contextoDeCaptura({ perf });
  ctx.salvarTelaParaRecarga();
  const tela = ctx.lerTelaSalva(ctx.armazem);
  assert.equal(tela.detailTab, 'armazenamento');
  assert.equal(tela.busca, 'eveo');
  assert.deepEqual(tela.filtros, { communication: 'ONLINE', contract: 'all', sort: 'disk' });
  // O perf vem do STATE, que é o dono do resultado. Ler do DOM aqui já
  // falhou uma vez: qualquer repintura o esvaziava antes da hora.
  assert.deepEqual(tela.perf, perf);
});

test('a tela salva vale para UMA recarga: a segunda leitura vem vazia', () => {
  const ctx = contextoDeCaptura({ perf: { instalacao: 'i', html: '<b>x</b>', em: 1 } });
  ctx.salvarTelaParaRecarga();
  assert.ok(ctx.lerTelaSalva(ctx.armazem));
  assert.equal(ctx.lerTelaSalva(ctx.armazem), null);
});

test('sem resultado no state, perf salvo é null — não um html vazio', () => {
  const ctx = contextoDeCaptura({ perf: null });
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
    state: { detailTab: 'visao', cloudPerfResult: null },
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
  const perf = { instalacao: 'inst-7', html: '<b>12ms</b>', em: 2000000 - 1000 };
  ctx.aplicarTelaSalva({
    detailTab: 'armazenamento',
    busca: 'eveo',
    filtros: { communication: 'ONLINE', contract: 'ACTIVE', sort: 'disk' },
    perf,
  });
  assert.equal(ctx.state.detailTab, 'armazenamento', 'sem isto o operador "volta para a aba padrão"');
  assert.equal(ctx.els.search.value, 'eveo');
  assert.equal(ctx.els.communication.value, 'ONLINE');
  assert.equal(ctx.els.sort.value, 'disk');
  assert.deepEqual(ctx.state.cloudPerfResult, perf, 'o resultado volta para o state — o render projeta de lá');
});

test('medição velha demais NÃO é reidratada', () => {
  const ctx = contextoDeAplicacao();
  ctx.aplicarTelaSalva({ perf: { instalacao: 'i', html: '<b>x</b>', em: 2000000 - VALIDADE_MS - 1 } });
  assert.equal(ctx.state.cloudPerfResult, null);
});

test('aplicar com tela nula (boot normal, sem recarga) não lança', () => {
  const ctx = contextoDeAplicacao();
  assert.doesNotThrow(() => ctx.aplicarTelaSalva(null));
  assert.equal(ctx.state.detailTab, 'visao');
});

// ── perfSalvoHtml: o DOM é projeção do state ────────────────────────────────

test('a seção projeta o resultado da instalação certa, e só dela', () => {
  const ctx = rodar(['perfSalvoHtml'], {
    state: { cloudPerfResult: { instalacao: 'inst-7', html: '<b>12ms</b>', em: 1 } },
  });
  assert.equal(ctx.perfSalvoHtml('inst-7'), '<b>12ms</b>');
  // Projetar na instalação errada atribuiria o link de um fornecedor ao outro.
  assert.equal(ctx.perfSalvoHtml('inst-OUTRA'), '');
});

test('sem resultado guardado a projeção é vazia', () => {
  const ctx = rodar(['perfSalvoHtml'], { state: { cloudPerfResult: null } });
  assert.equal(ctx.perfSalvoHtml('inst-7'), '');
});

test('renderCloudSection desenha o resultado A PARTIR do state, não resgata do DOM', () => {
  const corpo = extrairFuncao('renderCloudSection');
  assert.ok(
    corpo.includes('id="cloud-perf-result">${perfSalvoHtml(item.id)}'),
    'o resultado tem de entrar pela assinatura da seção — resgatar do DOM morre quando o ANCESTRAL repinta',
  );
  const listaDeResgate = corpo.match(/const transitorios = \[([^\]]*)\]/)?.[1] || '';
  assert.ok(
    !listaDeResgate.includes('#cloud-perf-result'),
    'com dois donos (state e resgate do DOM) um sobrescreve o outro — o state é o único dono',
  );
});

test('medir grava o resultado no state antes de pintar a tela', () => {
  const corpo = extrairFuncao('medirDesempenhoStorage');
  const noState = corpo.indexOf('state.cloudPerfResult = { instalacao: installationId');
  const naTela = corpo.indexOf('alvo.innerHTML = resultadoHtml');
  assert.ok(noState > -1, 'sem gravar no state, a primeira repintura do detalhe apaga o resultado de novo');
  assert.ok(naTela > noState, 'o state é o dono; a tela é projeção');
  assert.ok(corpo.indexOf('state.cloudPerfResult = null') > -1, 'medição nova supersede a anterior');
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

// ── A casca do detalhe é estável; o volátil vive nos corpos ─────────────────

test('a casca do detalhe NÃO interpola conteúdo que muda a cada ciclo', () => {
  // Foi a causa raiz do "reinicia a cada 30s": a janela do gráfico desliza a
  // CADA ciclo; inline na casca, mudava a assinatura do detalhe inteiro e o
  // innerHTML global destruía tudo — inclusive o resultado do teste de S3.
  const corpo = extrairFuncao('renderDetail');
  const casca = corpo.slice(corpo.indexOf('const html = `'), corpo.indexOf('pintarSeMudou(els.detail, html)'));
  for (const volatil of ['renderSpark(', 'renderTrends(', 'installationChartHtml(', 'problemCamerasHtml(', 'metric(item']) {
    assert.ok(!casca.includes(volatil), `${volatil}…) voltou para dentro da casca — a assinatura muda a cada ciclo e o detalhe inteiro volta a ser destruído`);
  }
  for (const slot of ['id="estado-body"', 'id="servidor-body"', 'id="trends-body"', 'id="chart-slot"', 'id="cams-problema-slot"']) {
    assert.ok(casca.includes(slot), `a casca precisa do corpo ${slot}`);
  }
  const corpos = corpo.indexOf('pintarCorposDoDetalhe(item)');
  const desiste = corpo.indexOf('if (!trocou) return');
  assert.ok(corpos > -1 && desiste > corpos, 'os corpos são pintados SEMPRE — mesmo quando a casca não mudou');
});

function elementoPintavel() {
  const el = { dataset: {}, escritas: [] };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._h || ''; },
    set(v) { this._h = v; this.escritas.push(v); },
  });
  return el;
}

test('heartbeat novo repinta SÓ os corpos cujo dado mudou — a casca fica de pé', () => {
  const corposPorId = {
    '#estado-body': elementoPintavel(),
    '#servidor-body': elementoPintavel(),
    '#trends-body': elementoPintavel(),
    '#chart-slot': elementoPintavel(),
    '#cams-problema-slot': elementoPintavel(),
  };
  const wires = [];
  const ctx = rodar(['pintarSeMudou', 'pintarCorposDoDetalhe', 'estadoOperacionalHtml', 'servidorClienteHtml'], {
    els: { detail: { querySelector: (sel) => corposPorId[sel] || null } },
    // Dependências dos templates reais, reduzidas ao essencial.
    escapeHtml: String,
    fmt: { format: String },
    number: Number,
    metric: (item, key, dflt) => (item.metrics && item.metrics[key] != null ? item.metrics[key] : dflt),
    readinessClass: () => 'ok',
    readinessLabel: () => 'Pronto',
    platformLabel: () => 'Linux',
    bytes: (v) => `${v}B`,
    Math,
    renderSpark: (item) => `<spark>${item.metrics.cameraOnline}</spark>`,
    renderTrends: () => '<trends>estáveis</trends>',
    installationChartHtml: (item) => `<chart>${item.chartJanela}</chart>`,
    problemCamerasHtml: () => '',
    wireChart: () => wires.push('chart'),
    lastInstallationChartModel: { reduced: [1] },
  });
  const item = {
    metrics: { recordingCount: 10, cameraOnline: 5 },
    server: { hostname: 'srv', cpuCount: 4 },
    storage: null,
    chartJanela: 'janela-1',
  };

  ctx.pintarCorposDoDetalhe(item);
  ctx.pintarCorposDoDetalhe(item);
  for (const [sel, el] of Object.entries(corposPorId)) {
    assert.ok(el.escritas.length <= 1, `${sel} repintado com dado idêntico — a piscada voltou`);
  }
  assert.deepEqual(wires, ['chart'], 'o gráfico religa os controles quando pintado');

  // Chega um heartbeat: só as métricas mudam.
  item.metrics = { recordingCount: 11, cameraOnline: 4 };
  ctx.pintarCorposDoDetalhe(item);
  assert.equal(corposPorId['#estado-body'].escritas.length, 2, 'métrica nova TEM de repintar o estado');
  assert.equal(corposPorId['#servidor-body'].escritas.length, 2, 'o sparkline de câmeras mora no corpo do servidor');
  assert.equal(corposPorId['#trends-body'].escritas.length, 1, 'tendência idêntica não repinta');
  assert.equal(corposPorId['#chart-slot'].escritas.length, 1, 'gráfico com a mesma janela não repinta');

  // Desliza a janela do gráfico: só o gráfico.
  item.chartJanela = 'janela-2';
  ctx.pintarCorposDoDetalhe(item);
  assert.equal(corposPorId['#chart-slot'].escritas.length, 2);
  assert.equal(corposPorId['#estado-body'].escritas.length, 2, 'a janela do gráfico não pode repintar o resto');
  assert.deepEqual(wires, ['chart', 'chart'], 'religa só quando o SVG trocou de verdade');
});

// ── reconciliarLinhas: heartbeat de UMA instalação não destrói a tabela ─────

function bancadaDeTabela() {
  const eventos = [];
  function fakeTr(id, html) {
    return {
      dataset: { id },
      _html: html,
      replaceWith(nova) {
        const i = tbody.children.indexOf(this);
        tbody.children[i] = nova;
        eventos.push(`replace:${id}`);
      },
    };
  }
  const tbody = {
    children: [],
    dataset: {},
  };
  Object.defineProperty(tbody, 'innerHTML', {
    get() { return this._h || ''; },
    set(v) {
      this._h = v;
      eventos.push('rebuild');
      this.children = [...v.matchAll(/<tr data-id="([^"]+)"/g)].map((m) => fakeTr(m[1], v));
    },
  });
  const documento = {
    createElement: () => {
      const molde = { _h: '' };
      Object.defineProperty(molde, 'innerHTML', { set(v) { this._h = v; }, get() { return this._h; } });
      molde.content = {
        get firstElementChild() {
          const id = /data-id="([^"]+)"/.exec(molde._h)?.[1];
          return id ? fakeTr(id, molde._h) : null;
        },
      };
      return molde;
    },
  };
  return { tbody, documento, eventos };
}

function rodarReconciliar(b) {
  return rodar(['reconciliarLinhas'], { document: b.documento, Array }).reconciliarLinhas;
}

const linha = (id, extra = '') => ({ id, html: `<tr data-id="${id}">${id}${extra}</tr>` });

test('mesmos dados duas vezes: a tabela não é tocada', () => {
  const b = bancadaDeTabela();
  const reconciliar = rodarReconciliar(b);
  const ligadas = [];
  const linhas = [linha('a'), linha('b'), linha('c')];
  reconciliar(b.tbody, linhas, (tr) => ligadas.push(tr.dataset.id));
  reconciliar(b.tbody, linhas, (tr) => ligadas.push(tr.dataset.id));
  assert.deepEqual(b.eventos, ['rebuild'], 'a segunda passada com dado idêntico não pode mexer no DOM');
  assert.deepEqual(ligadas, ['a', 'b', 'c'], 'religar duplicaria cada clique');
});

test('heartbeat de UMA instalação troca SÓ a linha dela', () => {
  const b = bancadaDeTabela();
  const reconciliar = rodarReconciliar(b);
  reconciliar(b.tbody, [linha('a'), linha('b'), linha('c')], () => {});
  const antesA = b.tbody.children[0];
  const antesC = b.tbody.children[2];

  reconciliar(b.tbody, [linha('a'), linha('b', ' sinal-novo'), linha('c')], () => {});
  assert.deepEqual(b.eventos, ['rebuild', 'replace:b'], 'era o defeito: TODAS as linhas morriam por um "Último sinal" novo');
  assert.equal(b.tbody.children[0], antesA, 'linha sem mudança preserva o nó (e o texto de idade que vive nele)');
  assert.equal(b.tbody.children[2], antesC);
});

test('o cache do guarda continua verdadeiro depois da troca pontual', () => {
  const b = bancadaDeTabela();
  const reconciliar = rodarReconciliar(b);
  reconciliar(b.tbody, [linha('a'), linha('b')], () => {});
  const linhas = [linha('a'), linha('b', ' novo')];
  reconciliar(b.tbody, linhas, () => {});
  assert.equal(
    b.tbody.dataset.assinatura,
    linhas.map((l) => l.html).join(''),
    'cache mentindo = a próxima escrita idêntica é pulada com o DOM já diferente',
  );
});

test('mudou a ordem (ordenação/filtro): reconstrói tudo, uma vez', () => {
  const b = bancadaDeTabela();
  const reconciliar = rodarReconciliar(b);
  reconciliar(b.tbody, [linha('a'), linha('b')], () => {});
  reconciliar(b.tbody, [linha('b'), linha('a')], () => {});
  assert.deepEqual(b.eventos, ['rebuild', 'rebuild']);
});

test('estrutura nova mas HTML idêntico ao do cache: não religa listeners', () => {
  // Só acontece se o DOM foi mexido por fora; religar aqui duplicaria cliques.
  const b = bancadaDeTabela();
  const reconciliar = rodarReconciliar(b);
  const ligadas = [];
  const linhas = [linha('a')];
  reconciliar(b.tbody, linhas, (tr) => ligadas.push(tr.dataset.id));
  b.tbody.children = []; // alguém zerou o DOM por fora, cache ficou
  reconciliar(b.tbody, linhas, (tr) => ligadas.push(tr.dataset.id));
  assert.deepEqual(ligadas, ['a']);
});
