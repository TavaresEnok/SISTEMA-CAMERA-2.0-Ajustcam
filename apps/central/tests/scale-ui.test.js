'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ── Tela "Escala · nós de computação" (Fase 4) ──────────────────────────────
// O painel é HTML+JS puro, sem build: não há typecheck nem bundler para pegar
// erro. Estes testes cobrem o que dá para cobrir sem navegador — e a UI aqui
// mexe em control-plane de escala, então errar em silêncio é caro.

const PANEL = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('a seção de escala existe e é renderizada a partir do detalhe', () => {
  assert.match(PANEL, /id="scale-section"/, 'a seção precisa existir no detalhe da instalação');
  assert.match(PANEL, /renderScaleSection\(item\.id\)/, 'o detalhe precisa disparar a renderização');
  assert.match(PANEL, /async function renderScaleSection\(/);
});

test('todo dado do servidor passa por escapeHtml (o painel já sofreu XSS armazenado)', () => {
  const inicio = PANEL.indexOf('async function renderScaleSection(');
  const fim = PANEL.indexOf('async function scaleRequest(');
  assert.ok(inicio > -1 && fim > inicio);
  const corpo = PANEL.slice(inicio, fim);

  // Campos de texto livre digitados por humano — os perigosos.
  for (const campo of ['n.label', 'n.host', 'n.role']) {
    const usos = corpo.split(campo).length - 1;
    assert.ok(usos > 0, `${campo} deveria ser renderizado`);
  }
  // Nenhuma interpolação desses campos pode aparecer sem escapeHtml em volta.
  const cru = corpo.match(/\$\{(?!escapeHtml|fmt\.|view\.|porNo|linhas|assignments)[^}]*n\.(label|host|role|id)[^}]*\}/g) || [];
  assert.deepEqual(cru, [], `interpolação sem escapeHtml: ${cru.join(', ')}`);
});

test('degrada com elegância: recurso indisponível e falha de rede não quebram o painel', () => {
  const inicio = PANEL.indexOf('async function renderScaleSection(');
  const corpo = PANEL.slice(inicio, PANEL.indexOf('async function scaleRequest('));
  assert.match(corpo, /res\.status === 404/, '404 (disjuntor desligado) precisa de tratamento próprio');
  assert.match(corpo, /Recurso de escala indisponível/);
  assert.match(corpo, /catch\s*\{/, 'falha de rede não pode explodir a renderização');
});

test('após escrever, o estado vem do SERVIDOR (não assume que deu certo)', () => {
  const inicio = PANEL.indexOf('async function scaleRequest(');
  const corpo = PANEL.slice(inicio, inicio + 900);
  assert.match(corpo, /await load\(\)/, 'precisa recarregar do servidor');
  assert.match(corpo, /renderDetail\(\)/, 'e redesenhar a partir do dado recarregado');
  // O catch NÃO pode engolir e seguir como se tivesse gravado: o reload é o que
  // revela a verdade, então ele tem de acontecer FORA do try.
  const posCatch = corpo.indexOf('catch');
  const posLoad = corpo.indexOf('await load()');
  assert.ok(posLoad > posCatch, 'o reload deve ocorrer depois do catch, sempre');
});

test('os três controles do operador existem: ligar, cadastrar nó e replanejar', () => {
  assert.match(PANEL, /id="scale-toggle"/, 'interruptor do scheduler');
  assert.match(PANEL, /id="scale-add"/, 'cadastro de nó');
  assert.match(PANEL, /id="scale-replan"/, 'replanejamento');
  assert.match(PANEL, /class="ghost scale-del"/, 'remoção de nó');
  // E cada um fala com o endpoint certo.
  assert.match(PANEL, /scaleRequest\(installationId, '\/scheduler', 'PATCH'/);
  assert.match(PANEL, /scaleRequest\(installationId, '\/compute-nodes', 'PATCH'/);
  assert.match(PANEL, /scaleRequest\(installationId, '\/scheduler\/replan', 'POST'/);
});

test('o id do nó é derivado de forma segura (sem quebrar a validação do servidor)', () => {
  // O servidor valida id; um label com espaço/acento não pode virar id inválido.
  const derive = (label) => (label || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40);
  assert.equal(derive('Servidor Bahia'), 'servidor-bahia');
  assert.equal(derive('Nó #2 (São Paulo)'), 'n-2-s-o-paulo-');
  assert.match(PANEL, /replace\(\/\[\^a-z0-9-\]\+\/g, '-'\)/, 'a derivação precisa estar no painel');
});

// ── Tela de IA por instalação ───────────────────────────────────────────────
test('IA: a seção existe e é renderizada a partir do detalhe', () => {
  assert.match(PANEL, /id="ai-section"/);
  assert.match(PANEL, /renderAiSection\(item\)/);
  assert.match(PANEL, /async function aiPolicyRequest\(/);
});

test('IA: as três capacidades aparecem, com movimento marcado como essencial', () => {
  assert.match(PANEL, /Movimento \(MOG2\)/);
  assert.match(PANEL, /Detecção de objeto/);
  assert.match(PANEL, /Reconhecimento facial/);
  assert.match(PANEL, /Essencial — arma a gravação por movimento/);
});

test('IA: desligar movimento e desativar todas EXIGEM confirmação (param a gravação)', () => {
  const i = PANEL.indexOf('function renderAiSection(');
  const corpo = PANEL.slice(i, PANEL.indexOf('async function aiPolicyRequest('));
  assert.match(corpo, /cap === 'motion' && !el\.checked/, 'desligar movimento é o caso perigoso');
  assert.match(corpo, /confirm\(/, 'precisa confirmar antes de parar a gravação por movimento');
  assert.match(corpo, /PARAREM de gravar/, 'o aviso precisa dizer a consequência real');
  assert.match(corpo, /Desativar TODAS as IAs/);
});

test('IA: contrato sem IA avançada desabilita objeto/face na tela', () => {
  const i = PANEL.indexOf('function renderAiSection(');
  const corpo = PANEL.slice(i, PANEL.indexOf('async function aiPolicyRequest('));
  assert.match(corpo, /avancadaBloqueada/);
  assert.match(corpo, /cap\.key !== 'motion' && avancadaBloqueada \? 'disabled' : ''/, 'movimento nunca é bloqueado pelo contrato');
});

test('IA: dado do servidor escapado e estado recarregado do servidor', () => {
  const i = PANEL.indexOf('function renderAiSection(');
  const corpo = PANEL.slice(i, PANEL.indexOf('async function aiPolicyRequest('));
  assert.match(corpo, /escapeHtml\(cap\.nome\)/);
  assert.match(corpo, /escapeHtml\(cap\.desc\)/);
  const req = PANEL.slice(PANEL.indexOf('async function aiPolicyRequest('), PANEL.indexOf('async function aiPolicyRequest(') + 800);
  assert.match(req, /await load\(\)/, 'o teto da licença é aplicado no servidor: recarregue');
});
