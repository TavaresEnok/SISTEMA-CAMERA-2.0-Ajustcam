# Performance e Disponibilidade

## Riscos principais

- DRAC-AUD-002: retenção pode degradar consistência até downloads e limpeza
  posteriores.
- DRAC-AUD-009: Central indisponível no caminho Nginx padrão.
- DRAC-AUD-013: API pode ficar em bootstrap pendente quando Redis cai.
- DRAC-AUD-018: build-agent sem timeout bloqueia a fila serial da Central.
- DRAC-AUD-020: worker legado fica unhealthy e pode prender HTTP/FFmpeg.
- DRAC-AUD-006/007: falha operacional pode prolongar downtime e corromper
  estado.

## Performance observada no desenho

- source gateway, substreams, latest-frame-only, adaptive QoS e transcode
  seletivo reduzem conexões/CPU;
- filas de exportação têm concurrency e jobs estáveis;
- listas/históricos têm vários limites e a Central poda histórico;
- logs Docker têm rotação;
- gravação canônica usa cópia/remux, enquanto worker legado reencoda continuamente.

## Pontos que exigem carga real

- centenas de câmeras e pollers web;
- memória/threads dos modelos e múltiplos processadores;
- latência de filesystem durante retenção/exportação;
- fila BullMQ durante outage/restart;
- série temporal Central e `_dbGate` durante build-agent lento;
- WebRTC sob NAT e reconexões longas;
- tempo de recovery após Redis/Postgres/MediaMTX indisponíveis.

Nenhum benchmark, soak test, fault injection ou teste de disco cheio foi
executado nesta etapa.
