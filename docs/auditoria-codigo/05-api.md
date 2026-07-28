# API NestJS

## Proteções confirmadas

- `ValidationPipe` global usa `whitelist`, `transform` e
  `forbidNonWhitelisted`.
- Helmet, CORS configurável, limite de corpo, request ID, throttling e guards
  globais de JWT/função/permissão estão presentes.
- Segredos JWT, criptografia de câmera e serviço interno rejeitam valores
  ausentes/fracos conhecidos.
- Refresh tokens e reset tokens são persistidos por hash; refresh é rotativo e
  revogável.
- FFmpeg/ffprobe são, em geral, chamados com `spawn`/`execFile` e `argv`, sem
  concatenação em shell.
- Tokens públicos de mídia normalmente rechecavam usuário e gate de recurso.

## Achados

- DRAC-AUD-003: IPs digitados para cadastro/teste aceitam loopback, link-local
  e toda a rede privada; é SSRF/port scan a partir do servidor.
- DRAC-AUD-004: ZIP em lote e download de clip usam `assertCanViewCamera`, não
  o gate de playback, furando `RESTRICTED`.
- DRAC-AUD-010: admins recebem `canControl` e `canRecord` em câmera privada,
  podendo mover PTZ, disparar relé físico e iniciar/parar gravação.
- DRAC-AUD-011/012: constraints ausentes em permissão e proprietário.
- DRAC-AUD-013: o bootstrap agenda jobs BullMQ de modo bloqueante sem política
  explícita de fail-fast/degradação quando Redis está fora.
- DRAC-AUD-019: validação lexical de caminho não detém symlink sob a raiz.

## Erros e concorrência

Há uso consistente de timeout em várias integrações (IA, webhooks, MediaMTX e
FFmpeg), e as filas de exportação têm IDs/concurrency explícitos. Não foi
encontrada evidência de command injection em argumentos FFmpeg ativos. Foram
vistos catches best-effort contextualizados; não foram promovidos
automaticamente a bugs.

O rate limit de login/API permanece local ao processo. É aceitável no Compose
de instância única, mas não fornece limite global quando a API for replicada.

## Lacunas de teste

A matriz de privacidade prova que admin não visualiza câmera privada e até
declara `canAdmin=true`, mas não testa `canControl`/`canRecord` em câmera
privada. O teste estrutural de histórico não inclui download ZIP e classifica
download de clip somente como derivado de conteúdo, ocultando a divergência
com a regra `RESTRICTED`.
