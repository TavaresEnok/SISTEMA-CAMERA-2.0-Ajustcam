# Instalação limpa

## Pré-requisitos

- Linux x86-64 atualizado, Docker Engine e Compose.
- 8 GB de RAM ou mais para múltiplas câmeras e IA.
- Armazenamento dimensionado para bitrate, quantidade de câmeras e retenção.
- DNS e certificado HTTPS válidos.

## Procedimento

1. Clone uma tag de release e confirme que `git status --short` está vazio.
2. Copie `infra/.env.prod.example` para `infra/.env`, preencha os segredos e aplique modo `600`.
3. Fixe o instalador no commit conferido da release e execute
   `DRAC_INSTALLER_COMMIT="$(git rev-parse HEAD)" bash scripts/install-drac.sh`,
   ou suba o Compose de produção.
4. Aplique as migrações com `pnpm db:migrate`.
5. Crie o primeiro administrador e ative senha forte.
6. Cadastre uma câmera de homologação e valide live, poster, gravação, thumbnail e playback.
7. Execute os três gates:

```bash
pnpm verify
bash scripts/production-readiness.sh
bash scripts/prod-regression.sh
```

8. Confirme o watchdog em `infra/storage/.monitor/runtime-status.json`.
9. Gere o app somente pela Central/agente e arquive AAB, `build-info.json` e `SHA256SUMS`.

Uma instalação não é considerada concluída enquanto algum gate retornar bloqueio.
