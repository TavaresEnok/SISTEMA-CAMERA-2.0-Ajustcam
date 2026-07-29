# 00 — Metodologia

## 1. Escopo

Análise técnica e comercial de 8 sistemas VMS/NVR disponíveis localmente (7 dos
13 concorrentes solicitados foram encontrados; 6 estão ausentes do diretório
`concorrentes/` e não puderam ser obtidos, pois a tarefa proíbe acesso à
internet e downloads).
A comparação tem como referência o modelo comercial do DRAC: produto brasileiro,
multi-tenant, white-label, vendido por provedores e integradores.

Cada sistema foi inspecionado por um analista independente (agente dedicado)
sem acesso ao histórico desta conversa, seguindo o mesmo protocolo, a mesma
rubrica de notas e a mesma obrigação de busca ativa por implementações não
óbvias antes de atribuir nota baixa (Passo D) — para o DRAC, adicionalmente,
uma seção de revisão adversarial obrigatória (Passo C) tentando refutar cada
ponto forte identificado. Os dossiês brutos estão consolidados em
`02-dossies.md`; este documento e os demais (`03` a `08`) são a síntese e
calibração horizontal (Passo B) feita a partir deles.

## 2. Sistemas inspecionados

| # | Sistema | Caminho local | Presente |
|---|---------|---------------|----------|
| 1 | DRAC | /home/flashnet/Drac | Sim |
| 2 | Frigate | /home/flashnet/Drac/concorrentes/frigate | Sim |
| 3 | Scrypted | /home/flashnet/Drac/concorrentes/scrypted | Sim |
| 4 | ZoneMinder | /home/flashnet/Drac/concorrentes/zoneminder | Sim |
| 5 | Shinobi | /home/flashnet/Drac/concorrentes/Shinobi | Sim |
| 6 | Bluecherry | /home/flashnet/Drac/concorrentes/bluecherry-apps | Sim |
| 7 | Moonfire NVR | /home/flashnet/Drac/concorrentes/moonfire-nvr | Sim |
| 8 | Viseron | /home/flashnet/Drac/concorrentes/viseron | Sim |
| 9 | Motion | ausente do repositório local | **AUSENTE** |
| 10 | Motioneye | ausente do repositório local | **AUSENTE** |
| 11 | LightNVR | ausente do repositório local | **AUSENTE** |
| 12 | Valkka-core | ausente do repositório local | **AUSENTE** |
| 13 | VibeNVR | ausente do repositório local | **AUSENTE** |
| 14 | Agent | ausente do repositório local | **AUSENTE** |

Os 6 sistemas ausentes **não receberam notas**. O ranking é parcial.

## 3. Fontes de evidência aceitas

Código-fonte ativo, testes automatizados, migrations, schemas (Prisma/SQL/SQLite),
Dockerfiles, docker-compose, workflows de CI, arquivos de dependências,
scripts operacionais, implementações de API/web/mobile.

READMEs foram usados apenas para **localizar componentes** e identificar
alegações a verificar no código. Nenhuma funcionalidade foi aceita com base
exclusiva em README.

## 4. Exclusões explícitas

`node_modules/`, `dist/`, builds gerados, `__pycache__/`, arquivos
compactados, `archive/`, `legacy/`, `novo-design/`, `novo-mockup-app-drac/`,
`Drac-app-redesign/` (redesign não integrado), `notebooks/` (Frigate),
`datasets/`, `screenshots/` (Moonfire).

## 5. Escala de notas

| Nota | Significado |
|------|-------------|
| 0 | Funcionalidade comprovadamente ausente ou incompatível |
| 1 | Implementação mínima, experimental, incompleta ou fortemente limitada |
| 2 | Funcionalidade básica com lacunas importantes de robustez |
| 3 | Implementação funcional e utilizável, sem maturidade avançada |
| 4 | Implementação robusta, integrada, com tratamento de erros e bons testes |
| 5 | Diferenciada, completa, madura e fortemente sustentada pelas evidências |
| N/V | Não verificável de forma responsável por análise estática |

## 6. Dimensões e pesos

| # | Dimensão | Peso |
|---|----------|------|
| 1 | Ingestão e streaming ao vivo | 3 |
| 2 | Gravação | 3 |
| 3 | Detecção e IA | 3 |
| 4 | Playback e revisão | 2 |
| 5 | Multi-tenancy, RBAC e privacidade | 3 |
| 6 | Mobile | 2 |
| 7 | Operação e observabilidade | 2 |
| 8 | Escalabilidade e eficiência | 2 |
| 9 | Maturidade de engenharia | 2 |
| 10 | White-label e comercialização | 2 |
| **Total** | | **24** |

## 7. Fórmula de pontuação

```
pontuacao_observada = soma(nota x peso) / soma(5 x pesos_verificados) x 100

cobertura = soma(pesos_verificados) / 24 x 100

pontuacao_ajustada = pontuacao_observada x (cobertura/100)
                   + 50 x (1 - cobertura/100)
```

Dimensões N/V recebem 50 pontos (ponto neutro) no ajuste, evitando tanto
punição injusta por inspecionabilidade limitada quanto inflação por ausência
de contra-evidências.

Sistemas com cobertura < 60% recebem ressalva explícita.

## 8. Processo de análise em quatro passos

**Passo A** — Dossiês individuais: arquitetura, escopo, funcionalidades,
limitações, notas preliminares.

**Passo B** — Calibração horizontal: comparação por dimensão entre todos os
sistemas antes de fechar qualquer nota.

**Passo C** — Revisão adversarial do DRAC: tentativa de refutar cada vantagem.

**Passo D** — Revisão adversarial dos concorrentes: busca de implementações
não encontradas na primeira passagem.

## 9. Limitações gerais

- Análise exclusivamente estática: nenhum sistema foi executado.
- 6 sistemas ausentes — o ranking é incompleto em relação ao solicitado.
- Binários externos (go2rtc, MediaMTX, FFmpeg) referenciados por configuração.
- Latência real, precisão e capacidade por host não podem ser afirmadas.
- Toda nota de desempenho refere-se a mecanismos no código, não a resultados medidos.
