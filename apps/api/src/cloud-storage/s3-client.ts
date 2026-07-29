import { createHash, createHmac } from 'node:crypto';

// ─────────────────────────────────────────────────────────────────────────────
// CLIENTE S3 MÍNIMO (AWS Signature V4), SEM SDK.
//
// Por que não `@aws-sdk/client-s3`: o SDK traz dezenas de pacotes transitivos
// para usarmos cinco verbos. Aqui a superfície é PUT/GET/HEAD/DELETE/LIST, e a
// assinatura V4 cabe em ~80 linhas de `node:crypto`. Menos dependência é menos
// superfície de supply chain num serviço que já carrega credencial de cliente.
//
// COMPATIBILIDADE: V4 é o mesmo protocolo em AWS S3, MinIO, Backblaze B2
// (endpoint S3), Eveo e Wasabi. O que muda é `endpoint` e `region` — por isso os
// dois são configuráveis e nada aqui assume domínio da Amazon.
//
// `forcePathStyle` é o padrão: MinIO e a maioria dos compatíveis servem em
// `endpoint/bucket/chave`. Virtual-host (`bucket.endpoint`) exige DNS coringa e
// quebra em IP puro — que é justamente o caso de um MinIO on-premise.
//
// SEGREDO: a `secretAccessKey` nunca entra em URL, em log ou em mensagem de
// erro. As mensagens carregam status e código do S3, não a credencial.
// ─────────────────────────────────────────────────────────────────────────────

export type S3Config = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Prefixo opcional dentro do bucket (isola instalações que dividem bucket). */
  prefix?: string;
  forcePathStyle?: boolean;
};

export type S3ObjectSummary = {
  key: string;
  size: number;
  lastModified: string | null;
};

// Mínimo do protocolo S3 para parte que não seja a última: 5 MiB. Abaixo disso
// o bucket recusa a conclusão do upload.
const MIN_MULTIPART_PART_BYTES = 5 * 1024 * 1024;
// 16 MiB equilibra número de requisições (cada uma custa) e memória por parte.
const DEFAULT_PART_BYTES = 16 * 1024 * 1024;

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/**
 * Codificação de caminho exigida pelo SigV4: cada segmento é percent-encoded,
 * mas a `/` que separa segmentos permanece. `encodeURIComponent` não basta —
 * ele deixa `!'()*` passarem, e a AWS exige que sejam codificados, senão a
 * assinatura não fecha.
 */
export function encodeS3Path(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');
}

/** Junta prefixo e chave sem gerar `//` nem barra inicial sobrando. */
export function joinS3Key(prefix: string | undefined, key: string): string {
  const clean = (value: string) => value.replace(/^\/+|\/+$/g, '');
  const p = clean(prefix ?? '');
  const k = clean(key);
  return p ? `${p}/${k}` : k;
}

export type SignedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
};

/**
 * Assinatura V4. Exportada para teste: é a peça que falha silenciosamente —
 * uma assinatura errada só aparece como 403 no runtime, então ela merece ser
 * verificável sem rede.
 */
export function signS3Request(
  config: S3Config,
  params: {
    method: string;
    key?: string;
    query?: Record<string, string>;
    payload?: Buffer;
    now?: Date;
    extraHeaders?: Record<string, string>;
  },
): SignedRequest {
  const endpoint = config.endpoint.replace(/\/+$/, '');
  const url = new URL(endpoint);
  const payload = params.payload ?? Buffer.alloc(0);
  const payloadHash = payload.length ? sha256Hex(payload) : EMPTY_SHA256;

  const now = params.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const pathStyle = config.forcePathStyle !== false;
  const bucketPart = pathStyle ? `/${config.bucket}` : '';
  const keyPart = params.key ? `/${encodeS3Path(params.key)}` : '';
  const canonicalUri = `${bucketPart}${keyPart}` || '/';

  // Query canônica: chaves ordenadas e valores codificados. Ordem errada aqui
  // também derruba a assinatura.
  const query = params.query ?? {};
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
    .join('&');

  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...(params.extraHeaders ?? {}),
  };

  const headerNames = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const signedHeaders = headerNames.join(';');
  const canonicalHeaders = headerNames
    .map((name) => {
      const original = Object.keys(headers).find((h) => h.toLowerCase() === name)!;
      return `${name}:${String(headers[original]).trim()}\n`;
    })
    .join('');

  const canonicalRequest = [
    params.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  let signingKey = hmac(`AWS4${config.secretAccessKey}`, dateStamp);
  signingKey = hmac(signingKey, config.region);
  signingKey = hmac(signingKey, 's3');
  signingKey = hmac(signingKey, 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  headers.Authorization =
    `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, `
    + `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const suffix = canonicalQuery ? `?${canonicalQuery}` : '';
  // Path-style: o bucket já está em `canonicalUri` (endpoint/bucket/chave).
  // Virtual-host: o bucket vai no hostname e a URI leva só a chave.
  const finalUrl = pathStyle
    ? `${endpoint}${canonicalUri}${suffix}`
    : `${url.protocol}//${config.bucket}.${url.host}${keyPart || '/'}${suffix}`;

  return { url: finalUrl, method: params.method, headers };
}

export class S3Error extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'S3Error';
  }
}

/** Extrai `<Code>` do XML de erro do S3 sem puxar um parser de XML. */
export function parseS3ErrorCode(body: string): string {
  const match = /<Code>([^<]+)<\/Code>/i.exec(body);
  return match ? match[1] : 'Unknown';
}

/** Extrai chaves e tamanhos de um ListObjectsV2 sem parser de XML. */
export function parseListObjects(body: string): S3ObjectSummary[] {
  const out: S3ObjectSummary[] = [];
  const contents = body.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? [];
  for (const block of contents) {
    const key = /<Key>([^<]*)<\/Key>/.exec(block)?.[1];
    if (!key) continue;
    out.push({
      key,
      size: Number(/<Size>(\d+)<\/Size>/.exec(block)?.[1] ?? 0),
      lastModified: /<LastModified>([^<]*)<\/LastModified>/.exec(block)?.[1] ?? null,
    });
  }
  return out;
}

export class S3Client {
  constructor(private readonly config: S3Config) {}

  private async request(params: {
    method: string;
    key?: string;
    query?: Record<string, string>;
    payload?: Buffer;
    extraHeaders?: Record<string, string>;
    // O ETag é devolvido porque o upload multipart precisa dele: a conclusão
    // envia a lista de ETags na ordem das partes, e sem eles o bucket recusa.
  }): Promise<{ status: number; body: Buffer; etag: string | null }> {
    const signed = signS3Request(this.config, params);
    let response: Response;
    try {
      response = await fetch(signed.url, {
        method: signed.method,
        headers: signed.headers,
        body: params.payload?.length ? new Uint8Array(params.payload) : undefined,
      });
    } catch (error) {
      // Falha de rede/DNS/TLS: mensagem sem credencial, com a causa original.
      const detail = error instanceof Error ? error.message : String(error);
      throw new S3Error(0, 'NetworkError', `Falha de conexão com o storage: ${detail}`);
    }

    const body = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      const code = parseS3ErrorCode(body.toString('utf8'));
      throw new S3Error(response.status, code, `S3 respondeu ${response.status} (${code}).`);
    }
    return { status: response.status, body, etag: response.headers.get('etag') };
  }

  private fullKey(key: string): string {
    return joinS3Key(this.config.prefix, key);
  }

  async putObject(key: string, payload: Buffer, contentType = 'application/octet-stream'): Promise<void> {
    await this.request({
      method: 'PUT',
      key: this.fullKey(key),
      payload,
      extraHeaders: { 'content-type': contentType, 'content-length': String(payload.length) },
    });
  }

  async getObject(key: string): Promise<Buffer> {
    const { body } = await this.request({ method: 'GET', key: this.fullKey(key) });
    return body;
  }

  /**
   * GET com Range, para servir vídeo.
   *
   * O S3 implementa Range nativamente e devolve 206 + `Content-Range`. Por isso
   * o range do navegador é REPASSADO em vez de recalculado aqui: quem sabe o
   * tamanho real do objeto é o bucket, e recomputar offset do nosso lado
   * introduziria um erro de um byte na hora de fazer seek em vídeo.
   *
   * Devolve o stream em vez do Buffer inteiro: um segmento de gravação pode ter
   * centenas de MB, e materializá-lo na memória da API por requisição derrubaria
   * o processo com poucos operadores assistindo ao mesmo tempo.
   */
  async getObjectStream(
    key: string,
    range?: string,
  ): Promise<{
    status: number;
    body: ReadableStream<Uint8Array> | null;
    contentLength: string | null;
    contentRange: string | null;
    contentType: string | null;
  }> {
    const signed = signS3Request(this.config, {
      method: 'GET',
      key: this.fullKey(key),
      extraHeaders: range ? { range } : {},
    });

    let response: Response;
    try {
      response = await fetch(signed.url, { method: 'GET', headers: signed.headers });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new S3Error(0, 'NetworkError', `Falha de conexão com o storage: ${detail}`);
    }

    if (!response.ok && response.status !== 206) {
      const text = await response.text().catch(() => '');
      throw new S3Error(response.status, parseS3ErrorCode(text), `S3 respondeu ${response.status}.`);
    }

    return {
      status: response.status,
      body: response.body,
      contentLength: response.headers.get('content-length'),
      contentRange: response.headers.get('content-range'),
      contentType: response.headers.get('content-type'),
    };
  }

  async deleteObject(key: string): Promise<void> {
    await this.request({ method: 'DELETE', key: this.fullKey(key) });
  }

  async headObject(key: string): Promise<{ exists: boolean }> {
    try {
      await this.request({ method: 'HEAD', key: this.fullKey(key) });
      return { exists: true };
    } catch (error) {
      if (error instanceof S3Error && (error.status === 404 || error.code === 'NoSuchKey')) {
        return { exists: false };
      }
      throw error;
    }
  }

  async listObjects(prefix = '', maxKeys = 1000): Promise<S3ObjectSummary[]> {
    const { body } = await this.request({
      method: 'GET',
      query: {
        'list-type': '2',
        'max-keys': String(maxKeys),
        prefix: this.fullKey(prefix),
      },
    });
    return parseListObjects(body.toString('utf8'));
  }

  /**
   * Upload em MÚLTIPLAS PARTES, para objeto grande.
   *
   * Por que existe: o PUT simples materializa o arquivo inteiro na memória e,
   * na prática, tem teto (a AWS documenta 5GB, mas muito antes disso a memória
   * do processo de gravação é o limite real). Um segmento longo — câmera com
   * `segment_time` alto, ou exportação de intervalo — estouraria.
   *
   * O protocolo tem três passos e o do meio pode ser repetido: inicia, envia
   * cada parte recebendo um ETag, e conclui enviando a lista de ETags na ordem.
   *
   * ABORTA explicitamente em caso de falha. Sem isso, as partes já enviadas
   * ficam ocupando espaço no bucket sem nunca formarem um objeto — cobrando do
   * cliente por lixo invisível, que é o modo de falha clássico de multipart.
   */
  async putObjectMultipart(
    key: string,
    read: (offset: number, length: number) => Promise<Buffer>,
    totalBytes: number,
    options?: { partSizeBytes?: number; contentType?: string },
  ): Promise<void> {
    const fullKey = this.fullKey(key);
    const partSize = Math.max(MIN_MULTIPART_PART_BYTES, options?.partSizeBytes ?? DEFAULT_PART_BYTES);
    const contentType = options?.contentType ?? 'application/octet-stream';

    const iniciado = await this.request({
      method: 'POST',
      key: fullKey,
      query: { uploads: '' },
      extraHeaders: { 'content-type': contentType },
    });
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(iniciado.body.toString('utf8'))?.[1];
    if (!uploadId) throw new S3Error(0, 'MultipartInitFailed', 'O storage não devolveu UploadId.');

    try {
      const etags: string[] = [];
      let offset = 0;
      let partNumber = 1;
      while (offset < totalBytes) {
        const length = Math.min(partSize, totalBytes - offset);
        const chunk = await read(offset, length);
        const parte = await this.request({
          method: 'PUT',
          key: fullKey,
          query: { partNumber: String(partNumber), uploadId },
          payload: chunk,
          extraHeaders: { 'content-length': String(chunk.length) },
        });
        const etag = parte.etag;
        if (!etag) throw new S3Error(0, 'MultipartPartNoETag', `Parte ${partNumber} sem ETag.`);
        etags.push(etag);
        offset += length;
        partNumber += 1;
      }

      const corpo = Buffer.from(
        `<CompleteMultipartUpload>${etags
          .map((etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${etag}</ETag></Part>`)
          .join('')}</CompleteMultipartUpload>`,
        'utf8',
      );
      await this.request({
        method: 'POST',
        key: fullKey,
        query: { uploadId },
        payload: corpo,
        extraHeaders: { 'content-type': 'application/xml', 'content-length': String(corpo.length) },
      });
    } catch (error) {
      // Best-effort: se o abort também falhar, o erro ORIGINAL é o que importa
      // para quem for diagnosticar.
      await this.request({ method: 'DELETE', key: fullKey, query: { uploadId } }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Verificação de credencial/bucket para o botão "testar conexão".
   *
   * Faz LIST **e** PUT+DELETE: só listar prova leitura, e uma credencial
   * somente-leitura passaria no teste e falharia na primeira gravação — que é
   * exatamente o cenário em que o cliente perde vídeo achando que configurou
   * certo.
   */
  async verifyAccess(): Promise<{ ok: true; canRead: boolean; canWrite: boolean }> {
    await this.listObjects('', 1);
    const probeKey = `.drac-connectivity-check-${Date.now()}`;
    await this.putObject(probeKey, Buffer.from('drac'), 'text/plain');
    await this.deleteObject(probeKey).catch(() => undefined);
    return { ok: true, canRead: true, canWrite: true };
  }
}
