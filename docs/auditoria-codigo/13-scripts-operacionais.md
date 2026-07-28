# Scripts Operacionais

Todos os scripts shell inventariados passaram em `bash -n`. Nenhum foi
executado funcionalmente.

## Achados

- DRAC-AUD-001: Central oferece execução remota de instalador móvel sem
  pin/hash/assinatura.
- DRAC-AUD-006: rollback de update restaura banco com a API nova ainda ativa,
  ignora erros e anuncia conclusão.
- DRAC-AUD-007: restore aplica `pg_restore --clean` diretamente ao banco alvo
  antes de validar integralmente o dump e não possui rollback.

## Pontos positivos

- scripts críticos usam `set -Eeuo pipefail`;
- update exige árvore limpa por padrão, cria snapshot de env e dump;
- backups automáticos gravam temporário, validam lista e renomeiam;
- `verify-backup-restore.sh` restaura em banco temporário e limpa via trap;
- caminhos temporários e quoting são geralmente explícitos;
- diagnóstico coleta contagens/configuração operacional, não dump de
  credenciais.

## Divergências

O verificador seguro de restore existe, mas `restore-drac.sh` não o chama. O
rollback de update engole falhas de `pg_restore`, build e `up`, portanto a
mensagem “Rollback finalizado” não prova recuperação.

## Próxima validação

Executar em laboratório descartável: dump válido/corrompido, migration que
falha, healthcheck que falha após migration, rollback, restore com storage,
interrupção por sinal e verificação byte-a-byte/contagem após recuperação.
