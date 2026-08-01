-- Ingestão por RTMP: a câmera disca para NÓS.
--
-- Todo o sistema até aqui pressupõe que nós alcançamos a câmera — IP público,
-- redirecionamento de porta ou VPN. Isso exclui o caso mais comum do mercado
-- brasileiro: equipamento atrás de CGNAT, 4G ou rede de terceiro onde ninguém
-- vai abrir porta nenhuma. Nesses lugares a conexão só pode nascer de dentro.
--
--   sourceMode              como o vídeo chega
--                             'rtsp_pull' → nós discamos (o de sempre)
--                             'rtmp_push' → a câmera publica em nós
--   rtmpIngestKeyHash       SHA-256 da chave de publicação. Só o hash fica aqui:
--                           autenticar comparando hash não exige guardar segredo
--                           em claro, e o índice único torna a busca O(1) sem
--                           varrer o cadastro a cada handshake de publicação.
--   rtmpIngestKeyEncrypted  a mesma chave cifrada (AES-256-GCM, mesma chave
--                           mestra das senhas de câmera), porque o administrador
--                           precisa relê-la para colar na câmera. NÃO autentica.
--
-- Toda câmera existente nasce em 'rtsp_pull' com as duas colunas NULL — que é
-- exatamente o estado real da frota hoje. O caminho de código do modo pull não
-- muda, então nenhuma instalação em produção percebe esta migração.
--
-- O índice é único e parcial: NULL não colide com NULL no PostgreSQL, então as
-- câmeras sem chave (a maioria) não ocupam o índice nem disputam unicidade.
ALTER TABLE "Camera"
ADD COLUMN IF NOT EXISTS "sourceMode" TEXT NOT NULL DEFAULT 'rtsp_pull',
ADD COLUMN IF NOT EXISTS "rtmpIngestKeyHash" TEXT,
ADD COLUMN IF NOT EXISTS "rtmpIngestKeyEncrypted" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Camera_rtmpIngestKeyHash_key"
ON "Camera" ("rtmpIngestKeyHash");
