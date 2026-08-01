// ── DESCOBERTA DA PORTA ONVIF: o cadastro que ninguém preencheu ─────────────
//
// O problema que isto resolve, medido em campo (2026-07-31): das 21 câmeras da
// instalação, 6 usavam detecção nativa (evento ONVIF, custo zero de CPU) e 15
// caíam na análise de vídeo do servidor — 1,06 Mbps contínuos e ~2% de CPU
// CADA, mesmo com a cena parada.
//
// A causa não era o equipamento. A varredura mostrou que o roteador do cliente
// já redirecionava ONVIF para 15 câmeras (portas 8081–8095); só as SEIS
// primeiras tinham a porta digitada no cadastro do DRAC. As outras nove nunca
// foram sondadas, porque `probeMotionSupport` desiste sem `onvifPort` — e sem
// sonda, `motionTrigger` fica em SYSTEM para sempre.
//
// Ou seja: um campo em branco no cadastro custava metade da capacidade do
// servidor, e nada no sistema era capaz de notar.
//
// ── COMO ADIVINHAR A PORTA SEM CHUTAR ──────────────────────────────────────
//
// Duas fontes de candidatas, nesta ordem:
//
//  1. AS IRMÃS. Câmeras do mesmo endereço (mesmo site, mesmo roteador) que já
//     têm porta ONVIF revelam a REGRA daquele roteador. Nesta instalação:
//
//         RTSP 51554 → ONVIF 8081        RTSP 54554 → ONVIF 8084
//         RTSP 52554 → ONVIF 8082        RTSP 55554 → ONVIF 8085
//         RTSP 53554 → ONVIF 8083        RTSP 56554 → ONVIF 8086
//
//     É uma reta. Duas irmãs bastam para traçá-la, e as demais servem de
//     conferência: se QUALQUER irmã conhecida cair fora da reta, a regra é
//     descartada — instalação sem padrão não vira palpite.
//
//  2. AS PORTAS DE FÁBRICA. Para câmera ligada direto (sem NAT), a porta é uma
//     das poucas usadas pelos fabricantes.
//
// ── POR QUE PALPITE AQUI É SEGURO ──────────────────────────────────────────
//
// Porque não confiamos nele. Toda candidata é CONFIRMADA pela própria câmera
// antes de virar cadastro: pergunta-se o fluxo dela (GetStreamUri) e exige-se
// que o endereço devolvido seja exatamente o que temos registrado.
//
// Isso funciona nos dois mundos ao mesmo tempo:
//   · atrás de NAT, a câmera devolve o endereço EXTERNO (160.19.47.74:57554) —
//     medido, é assim que este roteador se comporta;
//   · ligada direto, devolve o próprio IP interno com a porta 554.
//
// Em ambos, bate com o cadastro só se for a câmera certa. Uma porta que responde
// mas aponta para OUTRA câmera do mesmo site é rejeitada — e é precisamente
// esse o erro que um mapeamento por posição cometeria.

/** Endereço que a câmera declara ao ser perguntada sobre seu próprio fluxo. */
export type StreamUriIdentity = { host: string; port: number };

/** Porta RTSP presumida quando a URI não traz porta explícita. */
const RTSP_DEFAULT_PORT = 554;

/**
 * Portas ONVIF de fábrica mais comuns. Ordem por frequência observada em campo;
 * a lista é curta de propósito — isto é sondagem contra o equipamento de um
 * cliente, não varredura de portas.
 */
export const COMMON_ONVIF_PORTS = [80, 8000, 8080, 2020, 8899] as const;

/** Teto de tentativas por câmera, para que a descoberta nunca vire tempestade. */
export const MAX_ONVIF_CANDIDATES = 6;

type PortPair = { rtspPort: number; onvifPort: number };

/**
 * Extrai host e porta de uma URI RTSP, ignorando credenciais embutidas.
 * Devolve null quando a URI não é reconhecível.
 */
export function parseStreamUri(uri: string): StreamUriIdentity | null {
  if (typeof uri !== 'string' || uri.length === 0) return null;
  // Não uso `new URL` porque senha de câmera costuma trazer caracteres que o
  // parser rejeita (e falhar aqui viraria "câmera não confirmada" silencioso).
  const semEsquema = uri.replace(/^rtsps?:\/\//i, '');
  if (semEsquema === uri) return null; // não era RTSP
  const semCredencial = semEsquema.slice(semEsquema.lastIndexOf('@') + 1);
  const autoridade = semCredencial.split(/[/?#]/)[0];
  if (!autoridade) return null;

  // IPv6 literal: [::1]:554
  const ipv6 = autoridade.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (ipv6) {
    return { host: ipv6[1], port: ipv6[2] ? Number(ipv6[2]) : RTSP_DEFAULT_PORT };
  }

  const [host, porta] = autoridade.split(':');
  if (!host) return null;
  if (porta !== undefined && !/^\d+$/.test(porta)) return null;
  return { host, port: porta ? Number(porta) : RTSP_DEFAULT_PORT };
}

/**
 * A câmera que respondeu É a que procurávamos?
 *
 * Critério: o fluxo que ela declara aponta para o endereço e a porta RTSP que
 * temos no cadastro. É o único sinal disponível que a PRÓPRIA câmera emite e
 * que distingue uma irmã da outra — série e modelo não distinguem, porque a
 * frota inteira costuma ser do mesmo lote.
 */
export function streamUriIdentifiesCamera(
  uri: string,
  camera: { ip: string; rtspPort?: number | null },
): boolean {
  const declarado = parseStreamUri(uri);
  if (!declarado) return false;
  if (declarado.host !== camera.ip) return false;
  return declarado.port === (camera.rtspPort ?? RTSP_DEFAULT_PORT);
}

/**
 * Traça a reta ONVIF×RTSP a partir das irmãs já cadastradas e prevê a porta
 * desta câmera. Devolve null quando não há regra confiável.
 *
 * Exigências (todas necessárias para não transformar coincidência em regra):
 *  · pelo menos duas irmãs com portas RTSP distintas;
 *  · TODAS as irmãs conhecidas caem exatamente sobre a reta;
 *  · a previsão cai num inteiro válido de porta.
 */
export function predictOnvifPortFromSiblings(
  rtspPort: number | null | undefined,
  siblings: PortPair[],
): number | null {
  if (!Number.isInteger(rtspPort) || !rtspPort) return null;

  // Uma porta RTSP não pode ter duas ONVIF: cadastro contraditório invalida a regra.
  const porRtsp = new Map<number, number>();
  for (const s of siblings) {
    if (!Number.isInteger(s.rtspPort) || !Number.isInteger(s.onvifPort)) continue;
    const existente = porRtsp.get(s.rtspPort);
    if (existente !== undefined && existente !== s.onvifPort) return null;
    porRtsp.set(s.rtspPort, s.onvifPort);
  }
  const pontos = [...porRtsp.entries()]
    .map(([r, o]) => ({ rtspPort: r, onvifPort: o }))
    .sort((a, b) => a.rtspPort - b.rtspPort);
  if (pontos.length < 2) return null;

  const [p1, p2] = [pontos[0], pontos[pontos.length - 1]];
  const dRtsp = p2.rtspPort - p1.rtspPort;
  const dOnvif = p2.onvifPort - p1.onvifPort;
  if (dRtsp === 0) return null;

  // Aritmética inteira de propósito: ponto flutuante aqui produziria 8086,999…
  const naReta = (r: number): number | null => {
    const numerador = (r - p1.rtspPort) * dOnvif;
    if (numerador % dRtsp !== 0) return null;
    return p1.onvifPort + numerador / dRtsp;
  };

  // Conferência: a reta tem de explicar TODAS as irmãs, não só as duas pontas.
  for (const ponto of pontos) {
    if (naReta(ponto.rtspPort) !== ponto.onvifPort) return null;
  }

  const previsto = naReta(rtspPort);
  if (previsto === null || previsto < 1 || previsto > 65535) return null;
  return previsto;
}

/**
 * Portas a tentar para esta câmera, da mais provável para a menos, sem repetir
 * e com teto. A previsão pelas irmãs vem primeiro porque, num site atrás de
 * NAT, é a única que pode estar certa — as portas de fábrica estarão todas
 * fechadas ali.
 */
export function candidateOnvifPorts(
  camera: { rtspPort?: number | null },
  siblings: PortPair[],
): number[] {
  const candidatas: number[] = [];
  const previsto = predictOnvifPortFromSiblings(camera.rtspPort, siblings);
  if (previsto !== null) candidatas.push(previsto);
  for (const porta of COMMON_ONVIF_PORTS) candidatas.push(porta);
  return [...new Set(candidatas)].slice(0, MAX_ONVIF_CANDIDATES);
}
