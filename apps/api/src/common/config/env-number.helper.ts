/**
 * Leitura NUMÉRICA de variável de ambiente com FALLBACK GARANTIDO.
 *
 * ⚠️ POR QUE ISTO EXISTE — modo de falha real encontrado em produção:
 * `Number(process.env.X ?? 92)` devolve `NaN` para qualquer coisa que não seja um
 * número puro (`"92%"`, `"92 "`, `"noventa"`, vírgula decimal). E `NaN` não
 * explode: ele SILENCIOSAMENTE desarma comparações.
 *
 *   - Guarda de disco: `Number.isFinite(NaN) && ...` vira `false` → a guarda NUNCA
 *     dispara. O disco enche a 100% e TODAS as câmeras param de gravar, sem um
 *     único erro no log. Falha ABERTA, que é a pior de todas.
 *   - `setInterval`: `Math.max(10_000, NaN)` é `NaN`, e `setInterval(fn, NaN)`
 *     dispara em rajada (~1ms) — tempestade de CPU no host do cliente.
 *
 * A regra aqui é a oposta: valor inválido NUNCA vira NaN nem zero silencioso —
 * cai no default seguro e AVISA, para o operador descobrir pelo log em vez de
 * pelo cliente ligando.
 */

export type EnvNumberOptions = {
  /** Piso (inclusive). Valor abaixo é elevado a ele. */
  min?: number;
  /** Teto (inclusive). Valor acima é reduzido a ele. */
  max?: number;
  /** Exige inteiro (trunca o que vier fracionário). */
  integer?: boolean;
  /** Chamado quando o valor bruto é inválido — normalmente um logger.warn. */
  onInvalid?: (message: string) => void;
};

/**
 * Converte para número finito ou devolve `null`. Nunca lança, nunca devolve NaN.
 * Aceita vírgula decimal (pt-BR) porque `.env` escrito por humano brasileiro é
 * caso real, não hipótese.
 */
export function parseFiniteNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Só aceita algo que seja NUMÉRICO por inteiro. "92%" e "92px" são REJEITADOS
  // de propósito: aceitar o prefixo esconderia o erro de digitação do operador.
  const normalized = trimmed.replace(',', '.');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

/**
 * Lê `name` do ambiente com default garantido. O retorno é SEMPRE um número
 * finito dentro dos limites — nunca NaN.
 */
export function envNumber(
  name: string,
  fallback: number,
  options: EnvNumberOptions = {},
  source: Record<string, string | undefined> = process.env,
): number {
  const raw = source[name];
  const parsed = parseFiniteNumber(raw);

  let value: number;
  if (parsed === null) {
    // Só avisa quando o operador REALMENTE escreveu algo — variável ausente é o
    // caso normal e não deve poluir o log no boot.
    if (raw !== undefined && String(raw).trim() !== '') {
      options.onInvalid?.(
        `Valor inválido em ${name}="${raw}" — ignorado; usando ${fallback}. `
        + 'Use apenas dígitos (ex.: 92), sem símbolo nem unidade.',
      );
    }
    value = fallback;
  } else {
    value = parsed;
  }

  if (options.integer) value = Math.trunc(value);
  if (options.min !== undefined && value < options.min) value = options.min;
  if (options.max !== undefined && value > options.max) value = options.max;
  // Cinto e suspensórios: se um fallback inválido escapar pelo chamador, ainda
  // assim não devolvemos NaN para quem vai usar isto num setInterval.
  return Number.isFinite(value) ? value : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Leitura BOOLEANA — o mesmo silêncio, em outro disfarce.
//
// `String(process.env.X ?? 'true') !== 'false'` aceita QUALQUER coisa como
// verdadeiro; `=== 'true'` recusa tudo que não seja exatamente "true". Nos dois
// casos o operador escreve algo no `.env`, o sistema IGNORA e ninguém é avisado:
//
//   MEDIAMTX_ENABLED=0        → hoje continua LIGADO (ele jura que desligou).
//   ..._PORT_FALLBACK=TRUE    → hoje continua DESLIGADO (ele jura que ligou).
//
// Aqui as grafias UNIVERSAIS de sim/não são honradas (case-insensitive) e o que
// não for reconhecido cai no default seguro e AVISA. O conjunto aceito é curto e
// explícito de propósito: nada de heurística, nada de prefixo, nada de idioma —
// `RETENTION_TWO_TIER_ENABLED=sim` continua sendo lixo (e agora reclama), porque
// adivinhar intenção em flag que apaga gravação é como o NaN: silencioso e caro.
// ─────────────────────────────────────────────────────────────────────────────

const BOOL_TRUE = new Set(['1', 'true', 't', 'yes', 'y', 'on']);
const BOOL_FALSE = new Set(['0', 'false', 'f', 'no', 'n', 'off']);

export type EnvBoolOptions = {
  /** Chamado quando o valor bruto é inválido — normalmente um logger.warn. */
  onInvalid?: (message: string) => void;
};

/** Converte para booleano ou devolve `null`. Nunca lança, nunca chuta. */
export function parseBooleanish(raw: unknown): boolean | null {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  if (BOOL_TRUE.has(normalized)) return true;
  if (BOOL_FALSE.has(normalized)) return false;
  return null;
}

/**
 * Lê `name` do ambiente como flag. O retorno é SEMPRE booleano; valor não
 * reconhecido cai no `fallback` (o lado seguro escolhido pelo chamador) e avisa.
 */
export function envBool(
  name: string,
  fallback: boolean,
  options: EnvBoolOptions = {},
  source: Record<string, string | undefined> = process.env,
): boolean {
  const raw = source[name];
  const parsed = parseBooleanish(raw);
  if (parsed !== null) return parsed;
  // Ausente/vazio é o caso normal no boot e não deve poluir o log.
  if (raw !== undefined && String(raw).trim() !== '') {
    options.onInvalid?.(
      `Valor inválido em ${name}="${raw}" — ignorado; usando ${fallback}. `
      + 'Use true/false (ou 1/0, yes/no, on/off).',
    );
  }
  return fallback;
}
