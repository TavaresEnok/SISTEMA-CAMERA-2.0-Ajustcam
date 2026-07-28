import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
  type StdioOptions,
} from 'node:child_process';
import type { Writable } from 'node:stream';

const SECRET_INPUT_FD = 3;
const SECRET_INPUT_URL = `pipe:${SECRET_INPUT_FD}`;
const INPUT_PROTOCOLS = 'file,pipe,tcp,udp,rtp,rtsp,http,https,tls';
const MAX_SECRET_URL_BYTES = 16 * 1024;
const SECRET_INPUT_OPTION_NAMES = new Set([
  '-analyzeduration',
  '-err_detect',
  '-fflags',
  '-flags',
  '-max_delay',
  '-probesize',
  '-rtsp_transport',
  '-rw_timeout',
  '-stimeout',
  '-timeout',
  '-user_agent',
]);

type ExecSecretUrlOptions = SpawnOptions & {
  encoding?: BufferEncoding | 'buffer';
  maxBuffer?: number;
  timeout?: number;
};

export type SecretUrlExecResult = {
  stdout: string | Buffer;
  stderr: string | Buffer;
};

function assertSecretUrl(value: string) {
  if (
    !value
    || Buffer.byteLength(value, 'utf8') > MAX_SECRET_URL_BYTES
    || /[\0\r\n]/.test(value)
  ) {
    throw new Error('URL secreta inválida para o processo de mídia.');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('URL secreta inválida para o processo de mídia.');
  }
  if (!['rtsp:', 'rtsps:', 'http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Protocolo não permitido para o processo de mídia.');
  }
}

/**
 * Escaping do lexer do concat demuxer. O documento nunca toca o filesystem:
 * segue por um pipe herdado e é apagado da memória do processo chamador após a
 * escrita. A URL autenticada, portanto, não aparece em argv ou arquivo
 * temporário.
 */
export function buildSecretConcatDocument(
  secretUrl: string,
  inputOptions: ReadonlyArray<readonly [string, string]> = [],
): string {
  assertSecretUrl(secretUrl);
  const escaped = secretUrl.replace(/'/g, `'\\''`);
  const optionLines = inputOptions.map(([name, value]) => {
    if (
      !/^[a-z0-9_]+$/i.test(name)
      || !value
      || Buffer.byteLength(value, 'utf8') > 4096
      || /[\0\r\n]/.test(value)
    ) {
      throw new Error('Opção inválida para o canal privado de mídia.');
    }
    return `option ${name} ${value.replace(/'/g, `'\\''`)}`;
  });
  return [
    'ffconcat version 1.0',
    `file '${escaped}'`,
    ...optionLines,
    '',
  ].join('\n');
}

function prepareSecretInput(args: readonly string[], secretUrl: string) {
  assertSecretUrl(secretUrl);
  const indexes = args
    .map((value, index) => value === secretUrl ? index : -1)
    .filter((index) => index >= 0);
  if (indexes.length !== 1) {
    throw new Error('O comando de mídia deve conter exatamente uma ocorrência da URL secreta.');
  }
  const index = indexes[0];
  const inputStart = index > 0 && args[index - 1] === '-i' ? index - 1 : index;
  const inputEnd = index + 1;
  const prefix: string[] = [];
  const inputOptions: Array<[string, string]> = [];
  for (let cursor = 0; cursor < inputStart; cursor += 1) {
    const name = args[cursor];
    if (SECRET_INPUT_OPTION_NAMES.has(name)) {
      const value = args[cursor + 1];
      if (value === undefined) {
        throw new Error(`Opção ${name} sem valor no comando de mídia.`);
      }
      inputOptions.push([name.slice(1), value]);
      cursor += 1;
      continue;
    }
    prefix.push(name);
  }
  return {
    args: [
    ...prefix,
    '-protocol_whitelist',
    INPUT_PROTOCOLS,
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    SECRET_INPUT_URL,
    ...args.slice(inputEnd),
    ],
    document: buildSecretConcatDocument(secretUrl, inputOptions),
  };
}

export function replaceSecretUrlWithPipe(args: readonly string[], secretUrl: string): string[] {
  return prepareSecretInput(args, secretUrl).args;
}

function stdioWithSecretPipe(stdio: StdioOptions | undefined): StdioOptions {
  if (Array.isArray(stdio)) {
    const values = [...stdio];
    values[SECRET_INPUT_FD] = 'pipe';
    return values;
  }
  if (stdio === 'ignore') return ['ignore', 'ignore', 'ignore', 'pipe'];
  if (stdio === 'inherit') return ['inherit', 'inherit', 'inherit', 'pipe'];
  return ['pipe', 'pipe', 'pipe', 'pipe'];
}

function feedSecretInput(child: ChildProcess, document: string) {
  const input = child.stdio[SECRET_INPUT_FD] as Writable | null;
  if (!input) {
    child.kill('SIGKILL');
    throw new Error('Não foi possível criar o canal privado da URL de mídia.');
  }
  // EPIPE só significa que o binário recusou os argumentos antes de ler o
  // manifesto. O evento normal do processo continua sendo a autoridade do erro.
  input.on('error', () => undefined);
  input.end(document, 'utf8');
}

export function spawnWithSecretUrl(
  command: string,
  args: readonly string[],
  secretUrl: string,
  options: SpawnOptions = {},
): ChildProcess {
  const prepared = prepareSecretInput(args, secretUrl);
  const child = spawn(
    command,
    prepared.args,
    {
      ...options,
      stdio: stdioWithSecretPipe(options.stdio),
    },
  );
  feedSecretInput(child, prepared.document);
  return child;
}

export function execFileWithSecretUrl(
  command: string,
  args: readonly string[],
  secretUrl: string,
  options: ExecSecretUrlOptions = {},
): Promise<SecretUrlExecResult> {
  const {
    encoding = 'utf8',
    maxBuffer = 1024 * 1024,
    timeout = 0,
    ...spawnOptions
  } = options;
  const child = spawnWithSecretUrl(command, args, secretUrl, {
    ...spawnOptions,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (
      error?: Error & { stdout?: string | Buffer; stderr?: string | Buffer },
    ) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const stdoutBuffer = Buffer.concat(stdoutChunks);
      const stderrBuffer = Buffer.concat(stderrChunks);
      const stdout = encoding === 'buffer'
        ? stdoutBuffer
        : stdoutBuffer.toString(encoding);
      const stderr = encoding === 'buffer'
        ? stderrBuffer
        : stderrBuffer.toString(encoding);
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    };

    const collect = (
      chunks: Buffer[],
      currentBytes: number,
      chunk: Buffer,
      streamName: 'stdout' | 'stderr',
    ) => {
      const nextBytes = currentBytes + chunk.length;
      if (nextBytes > maxBuffer) {
        child.kill('SIGKILL');
        const error = new Error(
          `${command} excedeu maxBuffer em ${streamName}.`,
        );
        finish(error);
        return currentBytes;
      }
      chunks.push(chunk);
      return nextBytes;
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes = collect(stdoutChunks, stdoutBytes, chunk, 'stdout');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes = collect(stderrChunks, stderrBytes, chunk, 'stderr');
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      const error = new Error(
        `${command} encerrou com código ${code ?? 'null'}${signal ? ` (${signal})` : ''}.`,
      );
      finish(error);
    });
    if (timeout > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new Error(`${command} excedeu o prazo de ${timeout}ms.`));
      }, timeout);
      timer.unref();
    }
  });
}
