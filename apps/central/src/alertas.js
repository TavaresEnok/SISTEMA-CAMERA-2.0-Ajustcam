'use strict';

/**
 * ALERTAS POR INSTALAÇÃO — para quem avisar quando algo quebra.
 *
 * O que já existia: a instalação manda seus alertas no heartbeat, a Central
 * monta um histórico ACTIVE/RESOLVED e desenha na tela. Só isso. Quem não
 * estivesse com o painel aberto não ficava sabendo de nada — e o painel de
 * uma central de monitoramento não fica aberto de madrugada.
 *
 * Havia um alerta por Telegram, mas era do WATCHDOG DE UMA MÁQUINA
 * (scripts/runtime-watchdog.sh), com o destino cozido no .env do servidor.
 * Não servia para uma frota: cada cliente precisa avisar gente diferente.
 *
 * Duas decisões que orientam o módulo:
 *
 * 1. O TOKEN DO BOT É SEGREDO e é cifrado igual à chave do S3 (AES-256-GCM,
 *    `CENTRAL_STORAGE_SECRET`). Quem tem o token manda mensagem como o bot —
 *    tratar como campo comum seria vazá-lo em toda leitura do painel.
 *
 * 2. O REMETENTE DE E-MAIL É DA CENTRAL, o destinatário é da instalação. Não
 *    faz sentido pedir uma conta SMTP por cliente; faz sentido cada cliente
 *    dizer para qual caixa avisar. Sem SMTP configurado na Central, o canal de
 *    e-mail se declara indisponível em vez de falhar calado.
 */

const { createCipheriv, createDecipheriv, createHash, randomBytes } = require('node:crypto');
const net = require('node:net');
const tls = require('node:tls');

const LIMITE_EMAILS = 5;
const TEMPO_LIMITE_MS = 10_000;

const CONFIG_PADRAO = Object.freeze({
  emailEnabled: false,
  emails: [],
  telegramEnabled: false,
  telegramChatId: '',
  telegramBotTokenEncrypted: '',
  // Alerta de recuperação avisa que voltou ao normal. Nasce LIGADO: sem ele o
  // operador fica sem saber se o problema passou, e continua acordado.
  avisarRecuperacao: true,
  updatedAt: null,
  ultimoTesteAt: null,
  ultimoTesteOk: null,
  ultimoTesteMensagem: '',
});

// ── Segredo ─────────────────────────────────────────────────────────────────

function chaveDeCifra() {
  const raw = String(process.env.CENTRAL_STORAGE_SECRET || '');
  if (raw.length < 16) {
    // Mesma postura do cloud-storage: falhar alto é melhor que cifrar com chave
    // fraca e passar a impressão de que o token do cliente está protegido.
    throw new Error('CENTRAL_STORAGE_SECRET é obrigatório (mínimo 16 caracteres) para guardar o token do bot.');
  }
  return createHash('sha256').update(raw).digest();
}

function cifrar(plain) {
  if (!plain) return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', chaveDeCifra(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

function decifrar(payload) {
  if (!payload) return '';
  const raw = Buffer.from(String(payload), 'base64');
  if (raw.length <= 28) return '';
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const decipher = createDecipheriv('aes-256-gcm', chaveDeCifra(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

// ── Normalização ────────────────────────────────────────────────────────────

function lerBool(valor, padrao) {
  if (typeof valor === 'boolean') return valor;
  if (valor === 'true') return true;
  if (valor === 'false') return false;
  return padrao;
}

/** Validação deliberadamente frouxa: recusar endereço válido por regex estrita
 *  é pior que aceitar um errado, que o teste de envio revela na hora. */
function emailPlausivel(valor) {
  const texto = String(valor ?? '').trim();
  return texto.length >= 5 && texto.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(texto);
}

function normalizarAlertas(entrada) {
  const fonte = entrada && typeof entrada === 'object' && !Array.isArray(entrada) ? entrada : {};
  const emails = Array.isArray(fonte.emails)
    ? [...new Set(fonte.emails.map((e) => String(e ?? '').trim().toLowerCase()).filter(emailPlausivel))].slice(0, LIMITE_EMAILS)
    : [];
  return {
    // Canal só fica ligado se HOUVER destino. Sem isto, o painel exibiria
    // "e-mail ativo" sem nenhum endereço — o pior tipo de mentira num sistema
    // de alerta, porque só se descobre quando o alerta não chega.
    emailEnabled: lerBool(fonte.emailEnabled, CONFIG_PADRAO.emailEnabled) && emails.length > 0,
    emails,
    telegramEnabled:
      lerBool(fonte.telegramEnabled, CONFIG_PADRAO.telegramEnabled)
      && Boolean(String(fonte.telegramChatId ?? '').trim())
      && Boolean(String(fonte.telegramBotTokenEncrypted ?? '').trim()),
    telegramChatId: String(fonte.telegramChatId ?? '').trim().slice(0, 64),
    telegramBotTokenEncrypted: String(fonte.telegramBotTokenEncrypted ?? ''),
    avisarRecuperacao: lerBool(fonte.avisarRecuperacao, CONFIG_PADRAO.avisarRecuperacao),
    updatedAt: fonte.updatedAt ?? null,
    // O selo do teste é emitido pelo SERVIDOR, nunca aceito do corpo — mesma
    // lição do cloud-storage, onde um chamador podia mandar `lastTestOk: true`
    // e a Central exibia "OK" sobre um canal que ninguém tocou.
    ultimoTesteAt: fonte.ultimoTesteAt ?? null,
    ultimoTesteOk: typeof fonte.ultimoTesteOk === 'boolean' ? fonte.ultimoTesteOk : null,
    ultimoTesteMensagem: String(fonte.ultimoTesteMensagem ?? '').slice(0, 300),
  };
}

/** O que pode ir para o navegador: token JAMAIS sai, nem cifrado. */
function alertasPublicos(config) {
  const c = normalizarAlertas(config);
  return {
    emailEnabled: c.emailEnabled,
    emails: c.emails,
    telegramEnabled: c.telegramEnabled,
    telegramChatId: c.telegramChatId,
    telegramTokenConfigurado: Boolean(c.telegramBotTokenEncrypted),
    avisarRecuperacao: c.avisarRecuperacao,
    updatedAt: c.updatedAt,
    ultimoTesteAt: c.ultimoTesteAt,
    ultimoTesteOk: c.ultimoTesteOk,
    ultimoTesteMensagem: c.ultimoTesteMensagem,
    emailDisponivel: smtpConfigurado(),
  };
}

/**
 * Mescla o que veio do formulário sobre o que já existe.
 *
 * O token só é reescrito quando o operador digita um novo. Sem essa regra,
 * salvar qualquer outro campo (trocar um e-mail, ligar o aviso de recuperação)
 * apagaria o token — o formulário nunca o recebe de volta, então ele chegaria
 * vazio no salvamento seguinte.
 */
function mesclarAlertas(atual, patch) {
  const base = normalizarAlertas(atual);
  const p = patch && typeof patch === 'object' ? patch : {};
  const tokenNovo = String(p.telegramBotToken ?? '').trim();

  return normalizarAlertas({
    ...base,
    ...(p.emails !== undefined ? { emails: p.emails } : {}),
    ...(p.emailEnabled !== undefined ? { emailEnabled: p.emailEnabled } : {}),
    ...(p.telegramChatId !== undefined ? { telegramChatId: p.telegramChatId } : {}),
    ...(p.telegramEnabled !== undefined ? { telegramEnabled: p.telegramEnabled } : {}),
    ...(p.avisarRecuperacao !== undefined ? { avisarRecuperacao: p.avisarRecuperacao } : {}),
    ...(tokenNovo ? { telegramBotTokenEncrypted: cifrar(tokenNovo) } : {}),
    // Apagar o token é uma ação EXPLÍCITA, não um efeito de salvar vazio.
    ...(p.limparTelegramToken === true ? { telegramBotTokenEncrypted: '' } : {}),
    updatedAt: new Date().toISOString(),
  });
}

// ── Envio: Telegram ─────────────────────────────────────────────────────────

async function enviarTelegram(config, texto) {
  const token = decifrar(config.telegramBotTokenEncrypted);
  if (!token || !config.telegramChatId) return { ok: false, erro: 'Telegram não configurado.' };

  const controle = new AbortController();
  const corte = setTimeout(() => controle.abort(), TEMPO_LIMITE_MS);
  try {
    const resposta = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: config.telegramChatId, text: texto, parse_mode: 'HTML' }),
      signal: controle.signal,
    });
    if (resposta.ok) return { ok: true };
    // A resposta do Telegram diz o que houve ("chat not found", "bot was
    // blocked") — é a informação que resolve o problema do operador. Mas ela
    // pode ecoar o corpo enviado, então o token nunca entra na URL de log.
    let detalhe = `HTTP ${resposta.status}`;
    try {
      const corpo = await resposta.json();
      if (corpo && corpo.description) detalhe = String(corpo.description).slice(0, 200);
    } catch { /* corpo não-JSON: fica o status */ }
    return { ok: false, erro: detalhe };
  } catch (erro) {
    return { ok: false, erro: erro?.name === 'AbortError' ? 'Telegram não respondeu a tempo.' : String(erro?.message || erro) };
  } finally {
    clearTimeout(corte);
  }
}

// ── Envio: e-mail ───────────────────────────────────────────────────────────

function smtpConfigurado() {
  return Boolean(String(process.env.CENTRAL_SMTP_HOST || '').trim());
}

function configSmtp() {
  return {
    host: String(process.env.CENTRAL_SMTP_HOST || '').trim(),
    port: Number(process.env.CENTRAL_SMTP_PORT || 587),
    secure: String(process.env.CENTRAL_SMTP_SECURE || '') === 'true',
    user: String(process.env.CENTRAL_SMTP_USER || '').trim(),
    pass: String(process.env.CENTRAL_SMTP_PASS || ''),
    from: String(process.env.CENTRAL_SMTP_FROM || process.env.CENTRAL_SMTP_USER || '').trim(),
  };
}

/**
 * Cliente SMTP mínimo, escrito à mão.
 *
 * Por que não uma biblioteca: a Central tem HOJE duas dependências (`pg` e
 * `ssh2`) e é o painel que administra a frota inteira. Puxar uma árvore de
 * pacotes nova para mandar uma mensagem de texto aumenta a superfície de
 * atualização de um alvo sensível. O que precisamos é o caminho feliz do SMTP
 * — EHLO, STARTTLS, AUTH LOGIN, MAIL/RCPT/DATA — e ele cabe aqui, legível.
 *
 * Não pretende ser um servidor de e-mail: sem anexo, sem retentativa, sem
 * fila. Falhou, reporta e o alerta segue pelo Telegram.
 */
function falarSmtp(socket, comando, esperado) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const aoReceber = (chunk) => {
      buffer += chunk.toString('utf8');
      // Resposta SMTP termina em "NNN <espaço>"; com hífen ("NNN-") ainda vem mais.
      const linhas = buffer.split('\r\n').filter(Boolean);
      const ultima = linhas[linhas.length - 1];
      if (!ultima || !/^\d{3} /.test(ultima)) return;
      socket.removeListener('data', aoReceber);
      const codigo = Number(ultima.slice(0, 3));
      if (esperado.includes(codigo)) resolve(buffer);
      else reject(new Error(`SMTP respondeu ${codigo}: ${ultima.slice(4, 120)}`));
    };
    socket.on('data', aoReceber);
    if (comando !== null) socket.write(`${comando}\r\n`);
  });
}

async function enviarEmail(destinatarios, assunto, corpo) {
  if (!smtpConfigurado()) return { ok: false, erro: 'A Central não tem servidor de e-mail configurado.' };
  if (!destinatarios.length) return { ok: false, erro: 'Nenhum destinatário.' };

  const cfg = configSmtp();
  let socket;
  try {
    socket = await new Promise((resolve, reject) => {
      const conectar = cfg.secure ? tls.connect : net.connect;
      const s = conectar({ host: cfg.host, port: cfg.port, servername: cfg.host }, () => resolve(s));
      s.setTimeout(TEMPO_LIMITE_MS, () => { s.destroy(); reject(new Error('Servidor de e-mail não respondeu a tempo.')); });
      s.once('error', reject);
    });

    await falarSmtp(socket, null, [220]);
    await falarSmtp(socket, 'EHLO drac-central', [250]);

    if (!cfg.secure) {
      // Porta 587 exige subir para TLS antes de mandar senha. Sem isto a
      // credencial iria em claro pela rede.
      await falarSmtp(socket, 'STARTTLS', [220]);
      socket = await new Promise((resolve, reject) => {
        const seguro = tls.connect({ socket, servername: cfg.host }, () => resolve(seguro));
        seguro.once('error', reject);
      });
      await falarSmtp(socket, 'EHLO drac-central', [250]);
    }

    if (cfg.user) {
      await falarSmtp(socket, 'AUTH LOGIN', [334]);
      await falarSmtp(socket, Buffer.from(cfg.user).toString('base64'), [334]);
      await falarSmtp(socket, Buffer.from(cfg.pass).toString('base64'), [235]);
    }

    await falarSmtp(socket, `MAIL FROM:<${cfg.from}>`, [250]);
    for (const destino of destinatarios) {
      await falarSmtp(socket, `RCPT TO:<${destino}>`, [250, 251]);
    }
    await falarSmtp(socket, 'DATA', [354]);

    const cabecalho = [
      `From: DRAC Central <${cfg.from}>`,
      `To: ${destinatarios.join(', ')}`,
      `Subject: =?UTF-8?B?${Buffer.from(assunto).toString('base64')}?=`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(corpo).toString('base64').replace(/(.{76})/g, '$1\r\n'),
    ].join('\r\n');

    await falarSmtp(socket, `${cabecalho}\r\n.`, [250]);
    socket.write('QUIT\r\n');
    socket.end();
    return { ok: true };
  } catch (erro) {
    try { socket?.destroy(); } catch { /* já morto */ }
    return { ok: false, erro: String(erro?.message || erro).slice(0, 200) };
  }
}

// ── Mensagem ────────────────────────────────────────────────────────────────

const ESCAPE_HTML = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const escaparTelegram = (t) => String(t ?? '').replace(/[&<>]/g, (c) => ESCAPE_HTML[c]);

/**
 * Monta a mensagem. Curta de propósito: chega no celular de alguém que talvez
 * esteja dormindo, e precisa responder "onde, o quê, quando" sem abrir nada.
 */
function montarMensagem({ instalacao, alertas, recuperado = false }) {
  const nome = instalacao?.name || instalacao?.customerName || instalacao?.id || 'Instalação';
  const titulo = recuperado ? `✅ Normalizado — ${nome}` : `🔴 Alerta — ${nome}`;
  const linhas = alertas.slice(0, 8).map((a) => `• ${a.message || a.key || 'ocorrência'}`);
  if (alertas.length > 8) linhas.push(`• …e mais ${alertas.length - 8}`);
  const quando = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  return {
    assunto: titulo,
    texto: [titulo, '', ...linhas, '', `Em ${quando}`].join('\n'),
    html: [
      `<b>${escaparTelegram(titulo)}</b>`,
      '',
      ...linhas.map(escaparTelegram),
      '',
      `<i>Em ${escaparTelegram(quando)}</i>`,
    ].join('\n'),
  };
}

/** Dispara nos canais LIGADOS. Um canal quebrado não impede o outro. */
async function despacharAlerta(config, mensagem) {
  const c = normalizarAlertas(config);
  const resultados = [];
  if (c.telegramEnabled) {
    const r = await enviarTelegram(c, mensagem.html);
    resultados.push({ canal: 'telegram', ...r });
  }
  if (c.emailEnabled) {
    const r = await enviarEmail(c.emails, mensagem.assunto, mensagem.texto);
    resultados.push({ canal: 'email', ...r });
  }
  return resultados;
}

module.exports = {
  CONFIG_PADRAO,
  LIMITE_EMAILS,
  normalizarAlertas,
  alertasPublicos,
  mesclarAlertas,
  montarMensagem,
  despacharAlerta,
  enviarTelegram,
  enviarEmail,
  smtpConfigurado,
  cifrar,
  decifrar,
  emailPlausivel,
};
