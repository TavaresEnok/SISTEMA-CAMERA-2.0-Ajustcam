const URL_WITH_CREDENTIALS = /\b((?:rtsp|rtsps|http|https):\/\/)([^\s/@:]+):([^\s/@]+)@/gi;
const AUTHORITY_WITH_REDACTED_CREDENTIALS = /\b((?:rtsp|rtsps|http|https):\/\/)(?:\*{3}|<redacted>):(?:\*{3}|<redacted>)@/gi;

/**
 * Redação em nível de TEXTO: não conhece Error, não descarta stack. É a peça
 * que o logger global usa para varrer tudo que sai (mensagem, stack, argumento
 * solto), onde jogar fora o stack seria perder o diagnóstico.
 *
 * `sanitizeSensitiveText` continua sendo a porta de entrada para os pontos de
 * chamada que querem "texto curto de erro" (ele reduz Error à `.message`).
 */
export function redactSensitiveText(text: string): string {
  return text
    .replace(URL_WITH_CREDENTIALS, '$1<redacted>@')
    .replace(AUTHORITY_WITH_REDACTED_CREDENTIALS, '$1<redacted>@');
}

/**
 * Remove credenciais embutidas em URLs antes de enviar texto para logs,
 * diagnósticos ou respostas da API. O helper aceita mensagens completas do
 * FFmpeg/ffprobe e substitui todas as URLs encontradas, não apenas a primeira.
 */
export function sanitizeSensitiveText(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value ?? '');
  return redactSensitiveText(text);
}

export function containsCredentialBearingUrl(value: unknown): boolean {
  URL_WITH_CREDENTIALS.lastIndex = 0;
  const found = URL_WITH_CREDENTIALS.test(String(value ?? ''));
  URL_WITH_CREDENTIALS.lastIndex = 0;
  return found;
}
