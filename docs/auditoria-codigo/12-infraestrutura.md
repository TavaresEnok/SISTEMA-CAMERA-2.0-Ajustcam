# Infraestrutura

## Compose e rede

`docker compose ... config --quiet` passou usando `.env.example`, sem expor
valores reais. API/web/HLS/signaling estão ligados a loopback; UDP WebRTC é
público. Postgres/Redis só recebem portas via overrides e default loopback.
MediaMTX tem digest fixo e auth HTTP.

Achados:

- DRAC-AUD-009: ausência de `drac-central` no Compose quebra o destino Nginx.
- DRAC-AUD-013: `depends_on` da API não espera saúde de Redis/Postgres.
- DRAC-AUD-015: bind mount de fonte da IA permanece em produção.
- DRAC-AUD-022: API, Central, IA e worker não declaram usuário não-root,
  read-only rootfs ou drop de capabilities; API/IA têm bind mounts graváveis.

O serviço `go2rtc-eval` usa imagem `latest`, mas é profile experimental e não
participa do runtime normal. MediaMTX, por contraste, está pinado.

## Nginx e headers

HSTS, nosniff, frame deny, referrer e permissions policy estão presentes. O
CSP só define `base-uri`, `object-src`, `frame-ancestors` e upgrade; não limita
scripts/conexões/fontes. Isso agrava DRAC-AUD-014.

## Defaults

O Compose ainda contém fallback textual conhecido para senha Postgres, porém
outros segredos são obrigatórios e o instalador gera valores. O fallback deve
ser removido como defesa em profundidade, mas não foi demonstrado que uma
instalação oficial sobe com ele.

## Limitações

Não foram construídas imagens nem inspecionadas layers, SBOM, CVEs, UID em
runtime, firewall, TLS externo ou permissões reais dos volumes.
