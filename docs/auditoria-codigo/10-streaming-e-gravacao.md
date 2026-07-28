# Streaming e Gravação

## Proteções observadas

- FFmpeg/ffprobe recebem arrays de argumentos nos caminhos TypeScript/Go
  revisados; não foi confirmada injeção de shell.
- Há timeouts, fallback TCP/UDP, circuit breaker, backoff, controle de
  processos, métricas e testes extensos de VOD/source gateway.
- MediaMTX está fixado por digest, API e RTSP administrativos ficam internos,
  HLS/signaling em loopback e mídia WebRTC usa UDP público por necessidade.
- Autorização de mídia usa tokens curtos e revalidação por câmera.

## Achados

- DRAC-AUD-002: retenção e `deleteAllRecordings` podem deixar arquivo órfão,
  linha sem arquivo ou apagar metadado mesmo após falha de unlink.
- DRAC-AUD-003: sondas de câmera podem atingir loopback/link-local/rede privada.
- DRAC-AUD-004: downloads ZIP/clip furam o estado comercial `RESTRICTED`.
- DRAC-AUD-010: PTZ/relé/gravação em câmera privada não herdam o gate de
  conteúdo.
- DRAC-AUD-019: symlink sob storage escapa da validação lexical.
- DRAC-AUD-020: o worker Go opt-in nunca satisfaz o healthcheck configurado e
  usa clientes HTTP sem timeout em caminhos de controle.

## Disco cheio e recuperação

Há disk guard, retenção, scanner/reconcile, quarentena e proteção de
evidências. Contudo, a deleção não possui estado intermediário/outbox/tombstone
durável. Crash ou erro parcial não é recuperado atomicamente.

## Limitações

RTSP e2e e teste de mídia VOD não foram executados porque criariam containers,
rede e arquivos. Não houve câmera real, perda de energia, filesystem cheio,
NFS, symlink adversarial ou teste de horas de processos.
