# Banco, Prisma, Redis e BullMQ

## Prisma/PostgreSQL

O schema validou com sucesso. Há 38 migrations. Relações centrais usam chaves
estrangeiras e vários índices/unicidades adequados.

Achados:

- DRAC-AUD-011: `CameraPermission` tem apenas índices; duas concessões
  concorrentes podem duplicar o mesmo vínculo, e revogar um ID deixa outro
  vigente.
- DRAC-AUD-012: `Camera.ownerUserId` não é relação/FK. Exclusão do proprietário
  pode deixar câmera privada órfã.
- DRAC-AUD-026: migration histórica remove duplicatas de `Recording` por
  `ctid` antes de criar unicidade, sem escolher semanticamente a linha canônica.

Não foi executado migration status/deploy nem teste contra Postgres real. Os 13
testes PG da Central ficaram pulados.

## Transações e consistência

A exportação/evidência usa filas e transações em pontos importantes. O maior
problema encontrado é a fronteira banco/filesystem de retenção
(DRAC-AUD-002), que não pode ser resolvida somente com transação SQL.

## Redis/BullMQ

Sete filas foram inventariadas. Repeat jobs têm `jobId` estável; exportações
usam IDs idempotentes e concurrency. `removeOnFail` é limitado.

DRAC-AUD-013: `JobsModule.onModuleInit` aguarda três `Queue.add`. A conexão
BullMQ não configura prazo/fail-fast/degradação, e o Compose só usa
`depends_on` de início. Redis indisponível pode manter o bootstrap pendente,
fazendo healthcheck falhar indefinidamente.

Não houve teste com Redis desligado, restart no meio de job, lock preso ou
failover. O rate limit distribuído também não usa Redis.
