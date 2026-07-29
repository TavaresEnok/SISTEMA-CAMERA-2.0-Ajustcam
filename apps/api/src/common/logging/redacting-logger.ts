import { ConsoleLogger } from '@nestjs/common';
import { redactSensitiveText } from '../security/sensitive-text.helper';

// ─────────────────────────────────────────────────────────────────────────────
// REDAÇÃO DE CREDENCIAL NA SAÍDA DO LOGGER, NÃO NO PONTO DE CHAMADA.
//
// Antes: a defesa contra vazar `rtsp://user:senha@host` no log era chamar
// `sanitizeSensitiveText()` em cada lugar que loga — mais de 50 pontos de
// chamada. Isso é uma lista de oportunidades de esquecer: basta UM `logger.error`
// novo com a mensagem crua do FFmpeg (cujo stderr traz a URL inteira) para a
// senha da câmera do cliente ir parar no `docker logs`, que é lido por suporte,
// vai em diagnóstico e sobrevive em arquivo.
//
// O Frigate resolve isso no lugar certo — a redação mora no logger
// (`frigate/log.py` aplicando `clean_camera_user_pass` de `util/builtin.py`), de
// modo que NENHUM call site consegue escapar. Mesma ideia aqui, reimplementada
// sobre o `ConsoleLogger` do Nest.
//
// Isto NÃO substitui `sanitizeSensitiveText()` nos pontos de chamada: aquilo
// continua necessário para o que vai em RESPOSTA de API e em diagnóstico
// gravado. Isto é a última linha de defesa do log — as duas coexistem de
// propósito (redigir duas vezes é inofensivo; o `<redacted>` já redigido não
// casa de novo com o padrão de credencial).
//
// Só `string` e `Error` são varridos. É onde a URL do FFmpeg realmente aparece
// (mensagem, stack, stderr repassado como string) e evita serializar objeto
// arbitrário só para logar — o que mudaria a formatação de toda a saída.
// ─────────────────────────────────────────────────────────────────────────────

function scrub(value: unknown): unknown {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (value instanceof Error) {
    // Preserva o stack (é o diagnóstico) e redige o texto. Cópia rasa: mutar o
    // Error original afetaria quem for tratá-lo depois do log.
    const copy = new Error(redactSensitiveText(value.message));
    copy.name = value.name;
    copy.stack = value.stack ? redactSensitiveText(value.stack) : undefined;
    return copy;
  }
  return value;
}

export class RedactingLogger extends ConsoleLogger {
  log(message: unknown, ...rest: unknown[]): void {
    super.log(scrub(message) as string, ...rest.map(scrub));
  }

  error(message: unknown, ...rest: unknown[]): void {
    super.error(scrub(message) as string, ...rest.map(scrub));
  }

  warn(message: unknown, ...rest: unknown[]): void {
    super.warn(scrub(message) as string, ...rest.map(scrub));
  }

  debug(message: unknown, ...rest: unknown[]): void {
    super.debug(scrub(message) as string, ...rest.map(scrub));
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    super.verbose(scrub(message) as string, ...rest.map(scrub));
  }

  fatal(message: unknown, ...rest: unknown[]): void {
    super.fatal(scrub(message) as string, ...rest.map(scrub));
  }
}

/** Exportado para teste: a regra de varredura, isolada do transporte de log. */
export const __scrubForTest = scrub;
