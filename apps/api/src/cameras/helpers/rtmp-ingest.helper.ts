import { createHash, randomBytes, timingSafeEqual } from 'crypto';

// ── INGESTÃO POR RTMP: quando a câmera é que disca ─────────────────────────
//
// O problema que isto resolve: todo o DRAC pressupõe que NÓS alcançamos a
// câmera. Medido nesta instalação, isso custa 15 redirecionamentos de porta
// feitos à mão no roteador do cliente — e foi esse trabalho meio-feito que
// deixou 8 câmeras sem ONVIF por meses. Onde há CGNAT, 4G ou rede de terceiro,
// não existe redirecionamento possível: a conexão só pode nascer de dentro.
//
// No modo push a câmera publica em nós. Ela abre a conexão de saída, atravessa
// CGNAT sem nada configurado, e o vídeo entra por uma porta só — a nossa.
//
// ── POR QUE A CHAVE É O CAMINHO ────────────────────────────────────────────
//
// A interface de RTMP de câmera é quase sempre dois campos:
//
//     Servidor:  rtmp://host:1935/drac
//     Chave:     <32 hex>
//
// e o equipamento concatena os dois. Não há campo de usuário nem senha em boa
// parte dos modelos. Então a chave TEM de ser o credencial — é assim que
// YouTube, Twitch e Facebook fazem, pelo mesmo motivo.
//
// Consequências que o desenho assume de frente:
//  · a chave aparece no nome do path (e portanto em log do MediaMTX). Por isso
//    ela é ROTACIONÁVEL e vale só para PUBLICAR naquele único path — vazá-la
//    permite empurrar vídeo falso numa câmera, não ler o acervo;
//  · guardamos apenas o SHA-256 para autenticar. Comparar hash não exige o
//    segredo em claro, e o índice único no banco torna a busca O(1) — sem isso,
//    cada handshake varreria o cadastro inteiro;
//  · a comparação é em tempo constante, porque o atacante controla a entrada e
//    um `===` vazaria o prefixo correto byte a byte.
//
// ── O QUE ESTE MÓDULO DELIBERADAMENTE NÃO FAZ ──────────────────────────────
//
// Não autoriza leitura. Publicar e assistir são permissões distintas: o token
// de stream continua sendo a única via para ler, exatamente como hoje.

/** Prefixo do path de ingestão. Curto porque vai na tela, digitado por humano. */
export const RTMP_INGEST_APP = 'drac';
/** Alias para equipamentos cujo campo único não comporta o path canônico. */
export const RTMP_INGEST_COMPACT_APP = 'd';
/** Limite medido no campo "Endereço personalizado" de câmeras Intelbras. */
export const RTMP_SINGLE_FIELD_MAX_LENGTH = 63;

/** 128 bits em hexa: espaço de busca inviável e ainda cabe em campo de câmera. */
const KEY_BYTES = 16;
const KEY_PATTERN = /^[0-9a-f]{32}$/;
const COMPACT_KEY_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** `drac/<32 hex>` e nada mais — sem subcaminho, sem query, sem travessia. */
const INGEST_PATH_PATTERN = new RegExp(`^${RTMP_INGEST_APP}/([0-9a-f]{32})$`);
/** `d/<22 base64url>` representa os mesmos 128 bits, sem reduzir a entropia. */
const COMPACT_INGEST_PATH_PATTERN = new RegExp(`^${RTMP_INGEST_COMPACT_APP}/([A-Za-z0-9_-]{22})$`);

export type RtmpPublishTarget = {
  /** Cole no campo "Servidor"/"URL" da câmera. */
  serverUrl: string;
  /** Cole no campo "Chave"/"Stream key". */
  streamKey: string;
  /** URL inteira, para câmeras com um campo só. */
  fullUrl: string;
  /** URL canônica, preservada para diagnóstico quando a compacta for escolhida. */
  canonicalFullUrl: string;
  /** Alternativa montada com IP/host curto, quando configurada. */
  compactFullUrl: string | null;
  /** Evita que a interface recomende uma URL que o equipamento truncará. */
  fullUrlFitsSingleField: boolean;
  singleFieldMaxLength: number;
};

/** Gera uma chave de ingestão nova, com aleatoriedade criptográfica. */
export function generateIngestKey(): string {
  return randomBytes(KEY_BYTES).toString('hex');
}

/** A chave tem a forma exata esperada? Rejeita antes de qualquer consulta. */
export function isValidIngestKey(key: unknown): key is string {
  return typeof key === 'string' && KEY_PATTERN.test(key);
}

/**
 * Codifica os mesmos 16 bytes da chave hexadecimal em Base64URL sem padding.
 * São 22 caracteres, mas continuam sendo exatamente 128 bits aleatórios.
 */
export function encodeCompactIngestKey(key: unknown): string | null {
  if (!isValidIngestKey(key)) return null;
  return Buffer.from(key, 'hex').toString('base64url');
}

/**
 * Volta a representação curta para o hexadecimal canônico armazenado no banco.
 * A recodificação bloqueia entradas não canônicas que o parser permissivo de
 * Buffer poderia aceitar silenciosamente.
 */
export function decodeCompactIngestKey(key: unknown): string | null {
  if (typeof key !== 'string' || !COMPACT_KEY_PATTERN.test(key)) return null;
  const bytes = Buffer.from(key, 'base64url');
  if (bytes.length !== KEY_BYTES || bytes.toString('base64url') !== key) return null;
  return bytes.toString('hex');
}

/**
 * Hash de busca/autenticação. SHA-256 puro (sem sal) é correto AQUI e seria
 * errado para senha de usuário: a chave tem 128 bits de entropia própria, então
 * não há dicionário a defender, e o sal impediria a busca por índice — que é
 * justamente o ponto.
 */
export function hashIngestKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/**
 * Compara hashes em tempo constante. Recebe o hash já calculado dos dois lados
 * para que o custo não dependa do conteúdo.
 */
export function ingestHashMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // `timingSafeEqual` lança se os tamanhos diferem — o que já vaza o tamanho,
  // mas hash SHA-256 em hexa tem tamanho fixo, então divergir aqui só acontece
  // com dado corrompido, nunca com tentativa de adivinhação.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Nome do path no MediaMTX onde esta chave publica. */
export function ingestPathName(key: string): string {
  return `${RTMP_INGEST_APP}/${key}`;
}

/** Nome compacto do mesmo segredo no MediaMTX. */
export function compactIngestPathName(key: string): string {
  const compactKey = encodeCompactIngestKey(key);
  if (!compactKey) throw new Error('Chave de ingestão inválida para codificação compacta.');
  return `${RTMP_INGEST_COMPACT_APP}/${compactKey}`;
}

/**
 * Ordem preferencial das representações aceitas. O alias novo vem primeiro;
 * o path histórico permanece durante toda a migração da frota.
 */
export function ingestPathNames(key: string): string[] {
  return [compactIngestPathName(key), ingestPathName(key)];
}

/**
 * Extrai a chave de um nome de path, ou null se o path não for de ingestão.
 *
 * Estrito de propósito: qualquer coisa fora de `drac/<32 hex>` ou do alias
 * canônico `d/<22 base64url>` é recusada sem consulta ao banco. É a barreira
 * que impede um publicador de tentar assumir um path `cam_*`.
 */
export function ingestKeyFromPathName(pathName: unknown): string | null {
  if (typeof pathName !== 'string') return null;
  const canonical = INGEST_PATH_PATTERN.exec(pathName);
  if (canonical) return canonical[1];
  const compact = COMPACT_INGEST_PATH_PATTERN.exec(pathName);
  return compact ? decodeCompactIngestKey(compact[1]) : null;
}

/**
 * Monta o que o instalador vai digitar na câmera.
 *
 * `host` é o endereço público do servidor DRAC; `scheme` permite RTMPS quando a
 * instalação tiver TLS na borda (a câmera exige o esquema exato, não negocia).
 */
export function buildPublishTarget(input: {
  host: string;
  compactHost?: string | null;
  port: number;
  key: string;
  scheme?: 'rtmp' | 'rtmps';
}): RtmpPublishTarget {
  const scheme = input.scheme ?? 'rtmp';
  const serverUrl = `${scheme}://${input.host}:${input.port}/${RTMP_INGEST_APP}`;
  const canonicalFullUrl = `${serverUrl}/${input.key}`;
  const compactKey = encodeCompactIngestKey(input.key);
  const portaPadrao = (scheme === 'rtmp' && input.port === 1935)
    || (scheme === 'rtmps' && input.port === 443);
  const domainCompactFullUrl = compactKey
    ? `${scheme}://${input.host}${portaPadrao ? '' : `:${input.port}`}/${RTMP_INGEST_COMPACT_APP}/${compactKey}`
    : null;
  const compactHost = String(input.compactHost ?? '').trim();
  const compactHostSeguro = compactHost !== input.host
    && /^[a-z0-9.-]+$/i.test(compactHost)
    && !compactHost.startsWith('.')
    && !compactHost.endsWith('.');
  const compactHostFullUrl = compactHostSeguro
    ? `${scheme}://${compactHost}:${input.port}/${RTMP_INGEST_APP}/${input.key}`
    : null;
  // A primeira alternativa mantém o domínio e os mesmos 128 bits, apenas
  // codificados em Base64URL. O host curto fica como fallback para instalações
  // cujo domínio ainda não caiba. Nunca truncamos o segredo.
  const compactFullUrl = canonicalFullUrl.length > RTMP_SINGLE_FIELD_MAX_LENGTH
    ? [domainCompactFullUrl, compactHostFullUrl]
      .find((url): url is string => Boolean(url && url.length <= RTMP_SINGLE_FIELD_MAX_LENGTH)) ?? null
    : null;
  const fullUrl = canonicalFullUrl.length <= RTMP_SINGLE_FIELD_MAX_LENGTH
    ? canonicalFullUrl
    : compactFullUrl
      ? compactFullUrl
      : canonicalFullUrl;
  return {
    serverUrl,
    streamKey: input.key,
    fullUrl,
    canonicalFullUrl,
    compactFullUrl,
    fullUrlFitsSingleField: fullUrl.length <= RTMP_SINGLE_FIELD_MAX_LENGTH,
    singleFieldMaxLength: RTMP_SINGLE_FIELD_MAX_LENGTH,
  };
}

// ── EQUIPAMENTO QUE NÃO DEIXA ESCOLHER O CAMINHO ───────────────────────────
//
// Medido em campo (2026-08-01, Positivo CIP-B1312-M): a câmera pega só o
// ENDEREÇO da URL e monta o caminho sozinha a partir do número de série —
// `live/liveStream_H3ZL2802830WB_0_0C` — descartando o que vem depois do host.
// O diálogo RTMP vai até o `publish` e só então é recusado.
//
// Exigir o nosso formato deixaria essa classe inteira de equipamento de fora.
// Então o sistema APRENDE o caminho que o aparelho usa, e o administrador
// confirma de qual câmera é. A confirmação é o que separa a câmera do cliente
// de qualquer um na internet — a porta 1935 é pública.

/** Teto de tamanho: nome de fluxo real cabe folgado, e limita abuso de memória. */
const MAX_INGEST_PATH = 128;

/**
 * Caminho aprendido é aceitável?
 *
 * Permissivo no CONTEÚDO (cada fabricante inventa o seu) e rígido na FORMA:
 *  · só letras, números, ponto, hífen, sublinhado e UMA barra por segmento;
 *  · sem `..`, sem barra no início ou fim, sem barra dupla — nada que possa
 *    escapar do próprio caminho;
 *  · nunca pode casar com o prefixo `cam_`, que é o espaço dos paths de
 *    entrega: um publicador jamais deve conseguir assumir um stream de câmera.
 */
export function isAcceptableIngestPath(path: unknown): path is string {
  if (typeof path !== 'string') return false;
  const limpo = path.trim();
  if (limpo.length === 0 || limpo.length > MAX_INGEST_PATH) return false;
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(limpo)) return false;
  if (limpo.split('/').some((seg) => seg === '.' || seg === '..')) return false;
  // O espaço de entrega é intocável, venha o pedido de onde vier.
  if (/^cam_/i.test(limpo)) return false;
  return true;
}

/** Normaliza para comparação e armazenamento (a barra e o caso importam ao RTMP). */
export function normalizeIngestPath(path: string): string {
  return path.trim();
}

/** Modos de origem aceitos. String, e não enum do Prisma, para migrar sem downtime. */
export const SOURCE_MODE_PULL = 'rtsp_pull';
export const SOURCE_MODE_PUSH = 'rtmp_push';

/**
 * Esta câmera é alimentada por publicação?
 *
 * Conservador por desenho: qualquer valor inesperado (null, vazio, lixo vindo de
 * migração parcial) responde FALSO e a câmera segue no caminho de hoje. Errar
 * para o lado do comportamento conhecido é o que mantém a frota existente
 * intocada.
 */
export function isPushSourced(camera: { sourceMode?: string | null } | null | undefined): boolean {
  return String(camera?.sourceMode ?? SOURCE_MODE_PULL).trim().toLowerCase() === SOURCE_MODE_PUSH;
}
