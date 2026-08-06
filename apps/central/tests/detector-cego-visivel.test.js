'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ── O DETECTOR CEGO TEM DE APARECER NA CENTRAL ──────────────────────────────
//
// Episódio real (2026-08-05): 9 câmeras armadas por movimento ficaram com o
// detector sem frames por HORAS — sem gravar nada — e a Central mostrou tudo
// normal o dia inteiro. Nenhuma métrica do heartbeat carregava a informação,
// então nenhuma tela tinha COMO acusar.
//
// A instalação agora se defende sozinha (fail-safe grava contínuo) e manda o
// número no heartbeat (`motionFailsafeCameras`). Este teste EXECUTA o
// `reasonsFor` da Central e garante que o número vira linha na fila de
// atenção — o elo final entre "o sistema se defendeu" e "o dono ficou sabendo".

const PANEL = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

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

function rodarReasonsFor(item) {
  const contexto = {
    escapeHtml: String,
    number: Number,
    fmt: { format: String },
    metric: (it, key, dflt) => (it.metrics && it.metrics[key] != null ? it.metrics[key] : dflt),
    infraCritical: () => false,
    readinessStatus: () => 'ok',
    camIssues: () => 0,
    diskPercent: () => 40,
    configPending: () => false,
  };
  vm.createContext(contexto);
  vm.runInContext(`${extrairFuncao('reasonsFor')}; this.fn = reasonsFor;`, contexto);
  return contexto.fn(item);
}

const saudavel = { status: 'ONLINE', licenseStatus: 'ACTIVE', metrics: { cameraTotal: 5, cameraOnline: 5 } };

test('detector cego em fail-safe vira linha VERMELHA na fila de atenção', () => {
  const razoes = rodarReasonsFor({
    ...saudavel,
    metrics: { ...saudavel.metrics, motionFailsafeCameras: 3 },
  });
  const linha = razoes.find(([, texto]) => texto.includes('detector'));
  assert.ok(linha, 'sem esta linha o episódio das 9 câmeras cegas seria invisível DE NOVO');
  assert.equal(linha[0], 'bad', 'a instalação se defende sozinha, mas a causa segue de pé — é vermelho');
  assert.ok(linha[1].includes('3'), 'o operador precisa da contagem, não só do aviso');
});

test('instalação saudável (zero em fail-safe) não ganha a linha', () => {
  const razoes = rodarReasonsFor({
    ...saudavel,
    metrics: { ...saudavel.metrics, motionFailsafeCameras: 0 },
  });
  assert.ok(!razoes.some(([, texto]) => texto.includes('detector')), 'alarme sem defeito treina o operador a ignorar alarmes');
});

test('instalação ANTIGA (heartbeat sem a métrica) não quebra nem alarma', () => {
  // A frota atualiza aos poucos; a Central sempre convive com heartbeats de
  // versões anteriores, que não mandam o campo.
  const razoes = rodarReasonsFor(saudavel);
  assert.ok(Array.isArray(razoes));
  assert.ok(!razoes.some(([, texto]) => texto.includes('detector')));
  assert.ok(!razoes.some(([, texto]) => texto.includes('nuvem')));
});

// ── O ENVIO À NUVEM PARADO TAMBÉM TEM DE APARECER ───────────────────────────
//
// Episódio real: horas de NoSuchBucket, 100% das subidas falhando, e nenhuma
// linha na Central — o disco encheu e virou perda antes de alguém saber.

test('envio falhando com fila vira linha VERMELHA com o código do erro', () => {
  const razoes = rodarReasonsFor({
    ...saudavel,
    metrics: {
      ...saudavel.metrics,
      cloudUploadPending: 812,
      cloudUploadLastErrorCode: 'NoSuchBucket',
      cloudUploadLastErrorAgeSeconds: 60,
      cloudUploadLastSuccessAgeSeconds: 7200,
    },
  });
  const linha = razoes.find(([, texto]) => texto.includes('nuvem'));
  assert.ok(linha, 'sem esta linha o NoSuchBucket fica invisível DE NOVO');
  assert.equal(linha[0], 'bad');
  assert.ok(linha[1].includes('NoSuchBucket'), 'o código é o que aponta a causa');
  assert.ok(linha[1].includes('812'), 'o tamanho da fila dimensiona o atraso');
});

test('falha ANTIGA com envio recente é ruído — não alarma', () => {
  // Uma falha transitória de ontem, com subidas funcionando agora, não pode
  // pintar a instalação de vermelho: alarme falso ensina a ignorar alarmes.
  const razoes = rodarReasonsFor({
    ...saudavel,
    metrics: {
      ...saudavel.metrics,
      cloudUploadPending: 40,
      cloudUploadLastErrorCode: 'NetworkError',
      cloudUploadLastErrorAgeSeconds: 86400,
      cloudUploadLastSuccessAgeSeconds: 30,
    },
  });
  assert.ok(!razoes.some(([, texto]) => texto.includes('nuvem')));
});

test('fila grande SEM erro registrado vira atenção amarela', () => {
  const razoes = rodarReasonsFor({
    ...saudavel,
    metrics: { ...saudavel.metrics, cloudUploadPending: 500 },
  });
  const linha = razoes.find(([, texto]) => texto.includes('nuvem'));
  assert.ok(linha, 'fila acumulando sem falha visível ainda é atraso de arquivamento');
  assert.equal(linha[0], 'warn');
});

test('fila pequena e sem erro: nenhuma linha de nuvem', () => {
  const razoes = rodarReasonsFor({
    ...saudavel,
    metrics: { ...saudavel.metrics, cloudUploadPending: 12 },
  });
  assert.ok(!razoes.some(([, texto]) => texto.includes('nuvem')));
});

test('gravações apagadas POR FORA do bucket viram linha VERMELHA própria', () => {
  // Não é indisponibilidade: a vigilância conferiu o bucket saudável e o
  // objeto não estava lá. O dono precisa saber ANTES de precisar do vídeo.
  const razoes = rodarReasonsFor({
    ...saudavel,
    metrics: { ...saudavel.metrics, cloudCopiesMissing: 37 },
  });
  const linha = razoes.find(([, texto]) => texto.includes('apagada'));
  assert.ok(linha, 'perda externa invisível é como o incidente começou');
  assert.equal(linha[0], 'bad');
  assert.ok(linha[1].includes('37'));
});
