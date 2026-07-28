# Fluxos Críticos

## Autenticação e sessão

| Item | Descrição |
|---|---|
| Origem/destino | web/mobile → `AuthController` → `AuthService`/Prisma |
| Autenticação | login e reset públicos; demais rotas JWT |
| Entrada/persistência | credenciais; refresh token aleatório é armazenado como hash em `AuthSession`; reset também usa hash |
| Dependências | PostgreSQL, bcrypt, SMTP opcional |
| Falha/recuperação | JWT curto continua verificável; refresh pode ser revogado e rotacionado; web não usa refresh e persiste access token por até 8h |

Na Central, login cria token aleatório, persiste somente SHA-256 e envia cookie
HttpOnly/SameSite. Sessões são absolutas por 8h. Exclusão/troca de senha de
usuário não revoga as sessões existentes (DRAC-AUD-005).

## Cadastro e acesso a câmera

| Item | Descrição |
|---|---|
| Origem/destino | web/mobile → API → Prisma, ONVIF/RTSP/ffprobe |
| Autenticação | admin ou usuário com feature/cota no cadastro privado |
| Entrada | IP, portas, usuário/senha, paths, perfis e topologia |
| Persistência | câmera; senha cifrada; permissão direta do dono |
| Falhas | alvo inalcançável, timeout, credencial inválida, provisionamento parcial |
| Recuperação | diagnóstico/reteste e reconciliação posterior |

O validador aceita deliberadamente loopback, link-local e toda rede privada,
permitindo varredura do plano de controle (DRAC-AUD-003).

## Live, PTZ e relés

| Item | Descrição |
|---|---|
| Origem/destino | cliente → API → MediaMTX/FFmpeg/ONVIF → câmera |
| Autenticação | JWT e gate por câmera; mídia recebe token curto |
| Dados | cameraId, perfil, comandos PTZ e token de relé |
| Persistência | paths/estado runtime e auditoria |
| Falhas | codec incompatível, ICE, RTSP travado, processo órfão |
| Recuperação | fallback HLS/WebRTC, backoff/circuit breaker e reap de processos |

O gate de controle ignora privacidade para admins, permitindo PTZ e acionamento
físico de relés de câmeras privadas (DRAC-AUD-010).

## Gravação, playback e evidência

| Item | Descrição |
|---|---|
| Origem/destino | API → FFmpeg → storage → Prisma; cliente → API → arquivo |
| Autenticação | record/playback/export gates e tokens curtos |
| Persistência | `Recording`, `ExportedClip`, arquivos MP4/TS, thumbnails, sprites, evidências |
| Falhas | queda da câmera/processo, disco cheio, arquivo sem linha ou linha sem arquivo |
| Recuperação | auto-restart, scan/reconcile, retenção, integridade e backups |

Há bypass de `RESTRICTED` em ZIP/clip (DRAC-AUD-004) e exclusão não atômica
entre filesystem e banco (DRAC-AUD-002). O helper de raiz não considera
symlink (DRAC-AUD-019).

## IA

| Item | Descrição |
|---|---|
| Origem/destino | API → FastAPI interno → OpenCV/modelos → API |
| Autenticação | token interno, exceto health/ready |
| Entrada | cameraId, URL RTSP interna/direta, modo e zonas |
| Persistência | eventos voltam à API; estado de processadores/modelos fica em memória |
| Falhas | stream/modelo indisponível, timeout, excesso de CPU |
| Recuperação | latest-frame-only, backoff, watchdog e confirmação fail-safe |

O restart perde processadores em memória; `AiManagerService` os reconcilia. A
imagem de produção é sobreposta por fonte do host (DRAC-AUD-015).

## Heartbeat/licença e Central

| Item | Descrição |
|---|---|
| Origem/destino | instalação → Central |
| Autenticação | installation id + license key |
| Entrada | métricas, saúde por câmera, versão e endereço observado |
| Persistência | instalação, histórico limitado, alertas e série temporal PG |
| Falhas | Central fora, dado stale, escrita concorrente entre processos |
| Recuperação | conector local faz retry; JSON tem `.bak`; PG usa transações |

A serialização é somente por processo; múltiplas instâncias ainda podem perder
updates (DRAC-AUD-016).

## Instalação, atualização, backup e restore

- A Central fornece URL com `installerToken` e script que baixa `main` e
  executa via shell (DRAC-AUD-001/008).
- `update-drac.sh` cria dump e snapshot de env antes de fast-forward/build/
  migration, mas o rollback de banco corre com serviços ativos e ignora falha
  (DRAC-AUD-006).
- `restore-drac.sh` aplica `--clean` antes de validar integralmente o dump e não
  possui rollback do estado anterior (DRAC-AUD-007).
- Backups automáticos validam `pg_restore --list`; verificador restaura banco
  temporário. Esses mecanismos não são chamados automaticamente pelo restore.
