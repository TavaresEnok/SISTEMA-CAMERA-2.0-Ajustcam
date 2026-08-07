'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.CENTRAL_STORAGE_SECRET = process.env.CENTRAL_STORAGE_SECRET || 'chave-de-teste-com-tamanho-suficiente';
const alertas = require('../src/alertas');

// ─────────────────────────────────────────────────────────────────────────────
// Alertas por instalação. O que estes testes protegem NÃO é a formatação da
// mensagem — é o conjunto de regras que separa "canal de alerta confiável" de
// "canal que parece configurado e não avisa ninguém".
// ─────────────────────────────────────────────────────────────────────────────

test('o token do bot é cifrado e NUNCA sai na leitura pública', () => {
  const config = alertas.mesclarAlertas({}, {
    telegramEnabled: true,
    telegramChatId: '6598371845',
    telegramBotToken: '123456:SEGREDO-DO-BOT',
  });

  assert.notEqual(config.telegramBotTokenEncrypted, '123456:SEGREDO-DO-BOT', 'guardado em claro');
  assert.equal(alertas.decifrar(config.telegramBotTokenEncrypted), '123456:SEGREDO-DO-BOT', 'não volta ao original');

  const publico = alertas.alertasPublicos(config);
  const serializado = JSON.stringify(publico);
  assert.doesNotMatch(serializado, /SEGREDO-DO-BOT/, 'token vazou na saída pública');
  assert.doesNotMatch(serializado, /telegramBotTokenEncrypted/, 'nem a forma cifrada deve sair');
  assert.equal(publico.telegramTokenConfigurado, true, 'a tela precisa saber que EXISTE um token');
});

test('salvar outros campos NÃO apaga o token já guardado', () => {
  // O formulário nunca recebe o token de volta (ele não sai na leitura), então
  // ele chega vazio em todo salvamento seguinte. Sem esta regra, trocar um
  // e-mail derrubaria silenciosamente o canal do Telegram.
  const inicial = alertas.mesclarAlertas({}, {
    telegramEnabled: true, telegramChatId: '123', telegramBotToken: 'TOKEN-ORIGINAL',
  });
  const depois = alertas.mesclarAlertas(inicial, { emails: ['a@b.com'], emailEnabled: true });

  assert.equal(alertas.decifrar(depois.telegramBotTokenEncrypted), 'TOKEN-ORIGINAL');
  assert.equal(depois.telegramEnabled, true, 'o canal continua ligado');
});

test('apagar o token é ação explícita', () => {
  const inicial = alertas.mesclarAlertas({}, { telegramEnabled: true, telegramChatId: '123', telegramBotToken: 'X' });
  const limpo = alertas.mesclarAlertas(inicial, { limparTelegramToken: true });
  assert.equal(limpo.telegramBotTokenEncrypted, '');
  assert.equal(limpo.telegramEnabled, false, 'sem token o canal não pode continuar "ligado"');
});

test('canal não fica ligado sem destino', () => {
  // "E-mail ativo" sem nenhum endereço é a pior mentira possível aqui: só se
  // descobre quando o alerta não chega.
  const semEmail = alertas.normalizarAlertas({ emailEnabled: true, emails: [] });
  assert.equal(semEmail.emailEnabled, false);

  const semChat = alertas.normalizarAlertas({ telegramEnabled: true, telegramChatId: '', telegramBotTokenEncrypted: 'abc' });
  assert.equal(semChat.telegramEnabled, false);

  const semToken = alertas.normalizarAlertas({ telegramEnabled: true, telegramChatId: '123', telegramBotTokenEncrypted: '' });
  assert.equal(semToken.telegramEnabled, false);
});

test('e-mails são normalizados, deduplicados e limitados', () => {
  const c = alertas.normalizarAlertas({
    emailEnabled: true,
    emails: ['  A@B.com ', 'a@b.com', 'c@d.com', 'lixo', '', 'e@f.com', 'g@h.com', 'i@j.com', 'k@l.com'],
  });
  assert.ok(!c.emails.includes('lixo'), 'endereço inválido entrou');
  assert.equal(c.emails.filter((e) => e === 'a@b.com').length, 1, 'duplicata sobreviveu');
  assert.ok(c.emails.length <= alertas.LIMITE_EMAILS);
});

test('o selo do teste não pode ser forjado pelo corpo da requisição', () => {
  // Mesma lição do teste de storage: um chamador mandava `lastTestOk: true` e a
  // Central exibia "OK" sobre um canal que ninguém tocou.
  const c = alertas.mesclarAlertas({}, { emails: ['a@b.com'], emailEnabled: true, ultimoTesteOk: true, ultimoTesteAt: '2020-01-01' });
  assert.equal(c.ultimoTesteOk, null, 'aceitou selo vindo do corpo');
  assert.equal(c.ultimoTesteAt, null);
});

test('a mensagem responde onde/o quê/quando e escapa HTML', () => {
  const m = alertas.montarMensagem({
    instalacao: { name: 'Cliente <Teste>' },
    alertas: [{ message: 'Disco em 95% & subindo' }, { message: 'Câmera 3 offline' }],
  });
  assert.match(m.assunto, /Cliente <Teste>/);
  assert.match(m.texto, /Disco em 95% & subindo/);
  assert.match(m.texto, /Câmera 3 offline/);
  // O Telegram interpreta HTML: nome com < > quebraria a mensagem inteira.
  assert.match(m.html, /Cliente &lt;Teste&gt;/);
  assert.match(m.html, /95% &amp; subindo/);
});

test('mensagem de recuperação é distinta da de falha', () => {
  const falha = alertas.montarMensagem({ instalacao: { name: 'X' }, alertas: [{ message: 'a' }] });
  const volta = alertas.montarMensagem({ instalacao: { name: 'X' }, alertas: [{ message: 'a' }], recuperado: true });
  assert.notEqual(falha.assunto, volta.assunto, 'operador não pode confundir queda com recuperação');
  assert.match(volta.assunto, /Normalizado/);
});

test('lista longa de alertas é truncada com aviso de quantos sobraram', () => {
  const muitos = Array.from({ length: 20 }, (_, i) => ({ message: `alerta ${i}` }));
  const m = alertas.montarMensagem({ instalacao: { name: 'X' }, alertas: muitos });
  assert.match(m.texto, /e mais 12/, 'truncou sem dizer quanto ficou de fora');
});

test('sem SMTP configurado o canal de e-mail se declara indisponível', async () => {
  const anterior = process.env.CENTRAL_SMTP_HOST;
  delete process.env.CENTRAL_SMTP_HOST;
  try {
    assert.equal(alertas.smtpConfigurado(), false);
    assert.equal(alertas.alertasPublicos({}).emailDisponivel, false, 'a tela precisa poder explicar por que o e-mail não vai');
    const r = await alertas.enviarEmail(['a@b.com'], 'x', 'y');
    assert.equal(r.ok, false);
    assert.match(r.erro, /servidor de e-mail/i, 'erro genérico não ajuda ninguém');
  } finally {
    if (anterior !== undefined) process.env.CENTRAL_SMTP_HOST = anterior;
  }
});

test('um canal quebrado não impede o outro', async () => {
  // Telegram com token inválido + e-mail sem SMTP: os dois falham, mas o
  // despacho tenta AMBOS e reporta cada um. Se o primeiro erro abortasse, uma
  // configuração meio-quebrada silenciaria o canal que ainda funciona.
  const config = alertas.normalizarAlertas({
    emailEnabled: true, emails: ['a@b.com'],
    telegramEnabled: true, telegramChatId: '1', telegramBotTokenEncrypted: alertas.cifrar('invalido'),
  });
  const m = alertas.montarMensagem({ instalacao: { name: 'X' }, alertas: [{ message: 'teste' }] });
  const resultados = await alertas.despacharAlerta(config, m);
  assert.equal(resultados.length, 2, 'não tentou os dois canais');
  assert.deepEqual(resultados.map((r) => r.canal).sort(), ['email', 'telegram']);
});

// ─────────────────────────────────────────────────────────────────────────────
// DEDUPLICAÇÃO — a regra que decide se o canal é usável ou vira spam.
//
// `updateAlertHistory` vive no server.js (que sobe um servidor ao ser
// carregado), então o teste extrai só a função. Feio, mas o alvo é a lógica de
// transição, e ela é o coração do recurso: sem isto, um disco cheio manda 60
// mensagens por hora e o operador silencia o canal — justamente antes da
// próxima ocorrência que importava.
// ─────────────────────────────────────────────────────────────────────────────

function carregarUpdateAlertHistory() {
  const fonte = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/server.js'), 'utf8');
  const inicio = fonte.indexOf('function updateAlertHistory(');
  const fim = fonte.indexOf('\nfunction ', inicio + 10);
  const corpo = fonte.slice(inicio, fim);
  const crypto = require('node:crypto');
  const ALERT_HISTORY_LIMIT = 500;
  const alertKey = (a) => `${String(a?.code || 'generic').toLowerCase()}:${String(a?.message || '').toLowerCase().slice(0, 120)}`;
  // eslint-disable-next-line no-eval
  return eval(`(${corpo.replace('function updateAlertHistory', 'function')})`);
}

test('alerta que PERSISTE não gera aviso repetido a cada heartbeat', () => {
  const updateAlertHistory = carregarUpdateAlertHistory();
  const disco = [{ code: 'disk', message: 'Disco em 95%', level: 'critical' }];

  const r1 = updateAlertHistory({}, disco, '2026-08-07T16:00:00Z');
  assert.equal(r1.novos.length, 1, 'alerta inédito precisa avisar');

  const r2 = updateAlertHistory({ alertHistory: r1.history }, disco, '2026-08-07T16:01:00Z');
  assert.equal(r2.novos.length, 0, 'o MESMO alerta ativo não pode avisar de novo');
});

test('recuperação avisa uma vez, e reincidência conta como novo', () => {
  const updateAlertHistory = carregarUpdateAlertHistory();
  const disco = [{ code: 'disk', message: 'Disco em 95%', level: 'critical' }];

  const ativo = updateAlertHistory({}, disco, '2026-08-07T16:00:00Z');
  const resolvido = updateAlertHistory({ alertHistory: ativo.history }, [], '2026-08-07T16:02:00Z');
  assert.equal(resolvido.resolvidos.length, 1, 'não avisou que normalizou');
  assert.equal(resolvido.novos.length, 0);

  const voltou = updateAlertHistory({ alertHistory: resolvido.history }, disco, '2026-08-07T16:03:00Z');
  assert.equal(voltou.novos.length, 1, 'problema que volta é informação, não repetição');
});
