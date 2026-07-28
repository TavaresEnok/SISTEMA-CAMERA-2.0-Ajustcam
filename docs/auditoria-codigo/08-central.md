# DRAC Central

## Proteções confirmadas

- PBKDF2-SHA256 com 600 mil iterações, salt e comparação timing-safe.
- Sessão aleatória é armazenada por hash; cookie é HttpOnly/SameSite Lax.
- Limite de corpo, histórico limitado, auditoria e sanitização de logs SSH.
- JSON é gravado por arquivo temporário/rename e mantém `.bak`.
- Rotas que tocam banco são serializadas por `_dbGate` dentro de um processo.
- Escritas Postgres usam transação; identidade de host SSH usa TOFU.

## Achados de alta prioridade

- DRAC-AUD-001: instalador remoto baixa `scripts/install-drac.sh` da branch
  `main` sem digest/assinatura e executa por shell.
- DRAC-AUD-005: excluir usuário ou mudar senha não invalida suas sessões; a
  autenticação não revalida a existência/estado da conta.
- DRAC-AUD-008: `installerToken` não expira, não é consumido e não rotaciona ao
  visualizar novamente; o script devolvido contém licença.
- DRAC-AUD-009: o proxy `/central/` depende de um serviço que não existe no
  Compose entregue.

## Achados condicionais

- DRAC-AUD-016: `_dbGate` não funciona entre processos/hosts. Duas instâncias
  fazem load-modify-write de snapshots inteiros e podem apagar updates.
- DRAC-AUD-017: quando a porta 9765 é publicada diretamente, qualquer cliente
  pode forjar `X-Real-IP`, que alimenta rate limit e auditoria.
- DRAC-AUD-018: chamadas ao build-agent não têm timeout/AbortSignal e podem
  prender toda a fila serial de rotas.
- DRAC-AUD-023: `Secure` do cookie é opt-in; a documentação pede a flag em TLS,
  mas o default permanece perigoso.

## Itens invalidados na revisão

A primeira função `clientIp` confia em `X-Forwarded-For`, porém uma segunda
declaração posterior a substitui por hoisting e usa `X-Real-IP`. Atrás do
Nginx fornecido, o header é sobrescrito com `$remote_addr`; portanto não há
bypass de XFF nesse caminho padrão. O risco só permanece na exposição direta.

O suposto lost-update no processo único também foi rebaixado: `startServer`
aplica `runSerialized` a `/api/` e `/install/`, e há teste específico de ordem.
