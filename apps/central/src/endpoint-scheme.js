'use strict';

// ── DESCOBRIR O ESQUEMA DO ENDPOINT ─────────────────────────────────────────
//
// Antes o campo recusava `teste.endoip.sp2.com.br` e exigia que o operador
// digitasse `https://`. Ele não tem por que saber se aquele fornecedor atende em
// TLS ou não — o sistema tem como descobrir, e descobrir é mais confiável que a
// memória de quem cadastra.
//
// A ordem de tentativa é um palpite bom, não a resposta: quem responde é o
// servidor. O palpite só decide o que testar primeiro, para o caso comum
// acertar de primeira e o cadastro não esperar dois tempos de timeout.

/** Divide o que foi digitado em esquema (se houver) e resto. */
function partirEndpoint(bruto) {
  const texto = String(bruto ?? '').trim().replace(/\/+$/, '');
  const m = /^(https?):\/\/(.+)$/i.exec(texto);
  if (m) return { esquema: m[1].toLowerCase(), host: m[2], explicito: true };
  return { esquema: null, host: texto, explicito: false };
}

/** Endereço sem porta, para as heurísticas olharem só o host. */
function apenasHost(hostComPorta) {
  const semCaminho = String(hostComPorta || '').split('/')[0];
  // IPv6 entre colchetes: [::1]:9000
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(semCaminho);
  if (m) return { host: m[1], porta: m[2] ? Number(m[2]) : null };
  const partes = semCaminho.split(':');
  if (partes.length === 2 && /^\d+$/.test(partes[1])) return { host: partes[0], porta: Number(partes[1]) };
  return { host: semCaminho, porta: null };
}

/**
 * É um endereço de rede interna? Aí HTTP é o palpite melhor.
 *
 * MinIO de escritório, NAS e storage em LAN quase nunca têm certificado válido —
 * tentar HTTPS primeiro neles só gasta um timeout antes de acertar.
 */
function enderecoInterno(host) {
  const h = String(host || '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.internal')) return true;
  if (h === '::1') return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!ipv4) return false;
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * Em que ordem tentar. NUNCA decide sozinho: só ordena os candidatos.
 *
 *   · porta 443 → https primeiro, é o que ela significa;
 *   · porta 80 → http primeiro, idem;
 *   · outra porta explícita ou endereço interno → http primeiro (MinIO, NAS);
 *   · nome público sem porta → https primeiro, que é o padrão hoje.
 */
function ordemDeTentativa(bruto) {
  const { esquema, host, explicito } = partirEndpoint(bruto);
  if (explicito) return { explicito: true, candidatos: [`${esquema}://${host}`] };
  if (!host) return { explicito: false, candidatos: [] };

  const { host: apenas, porta } = apenasHost(host);
  let primeiro = 'https';
  if (porta === 80) primeiro = 'http';
  else if (porta === 443) primeiro = 'https';
  else if (porta !== null || enderecoInterno(apenas)) primeiro = 'http';

  const segundo = primeiro === 'https' ? 'http' : 'https';
  return { explicito: false, candidatos: [`${primeiro}://${host}`, `${segundo}://${host}`] };
}

/**
 * Resolve o endpoint SONDANDO os candidatos.
 *
 * Vale qualquer resposta HTTP, inclusive 403 ou 404: significa que há um
 * servidor falando HTTP naquele endereço, que é o que se quer saber. Exigir 200
 * recusaria um bucket que existe e só não deixa listar sem credencial.
 *
 * Se nenhum responder, devolve o primeiro palpite com `confirmado: false` — o
 * cadastro segue e o "Testar conexão" dirá o que há de errado. Travar aqui
 * impediria de configurar um storage que ainda vai subir.
 */
async function resolverEndpoint(bruto, { timeoutMs = 4000, sondar = sondaPadrao } = {}) {
  const { explicito, candidatos } = ordemDeTentativa(bruto);
  if (!candidatos.length) return { endpoint: '', confirmado: false, tentados: [] };
  if (explicito) return { endpoint: candidatos[0], confirmado: false, tentados: [] };

  const tentados = [];
  for (const candidato of candidatos) {
    const respondeu = await sondar(candidato, timeoutMs).catch(() => false);
    tentados.push({ candidato, respondeu });
    if (respondeu) return { endpoint: candidato, confirmado: true, tentados };
  }
  return { endpoint: candidatos[0], confirmado: false, tentados };
}

async function sondaPadrao(url, timeoutMs) {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    return Boolean(res);
  } catch {
    return false;
  }
}

module.exports = { resolverEndpoint, ordemDeTentativa, partirEndpoint, enderecoInterno };
