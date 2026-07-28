# Dependências, decisões e lacunas restantes

Este registro separa defeito demonstrado de escolhas de produto/operação.
Quando uma decisão ainda está aberta, o plano de correção não deve
silenciosamente codificar uma preferência.

## Decisões de produto e segurança

| Decisão | Achados/lotes | Opções relevantes | Recomendação inicial | Bloqueia |
|---|---|---|---|---|
| Raiz de confiança de releases | 001 / lote 1 | pin+SHA; assinatura; pacote assinado; mirror content-addressed | bloquear já branch móvel com commit+SHA e evoluir para release assinada | contrato do instalador e rollback |
| Política anti-downgrade | 001, 006, 007 | sempre monotônica; exceção assinada; versões LTS | monotônica por default, exceção administrativa fortemente auditada | testes de rollback/update |
| Redes de câmera permitidas | 003 | CIDRs por instalação; VLAN dedicada; allowlist por câmera; proxy de egress | allowlist explícita por instalação, negar control-plane/metadata sempre | implementação SSRF |
| Hostname/DNS/IPv6 | 003 | somente IP; hostname pinado; resolução revalidada | suportar hostname apenas com resolução completa e revalidação na conexão | testes de compatibilidade |
| Histórico em RESTRICTED | 004 | negar tudo; permitir evidência; permitir artefato prévio | negar todo consumo por default; exceção de evidência explícita/auditada | regra central de policy |
| Ações admin em câmera privada | 010 | admin técnico total; consentimento do owner; exceção emergencial | separar configuração técnica de PTZ/relay/record e exigir grant/fluxo emergencial | correção de autorização |
| Revogação Central | 005 | sessão atual; todas do usuário; todas da instalação | senha/delete/bloqueio revogam todas; logout revoga ao menos a atual | schema/contrato de sessão |
| Bearer admin estático Central | 005 | manter com rotação; escopar; remover | token curto/rotacionável e separado de sessão humana | modelo de revogação completo |
| Validade do installerToken | 008 | one-shot; TTL+N retries; janela offline | TTL curto, hash, revogação e poucos retries atômicos | UX de provisionamento |
| Máquina de estados de mídia | 002 | pending/ready/delete-pending/quarantine; journal/outbox | estados explícitos e reconciliador idempotente | migration e retenção |
| Política de órfãos | 002 | adotar, apagar, quarentenar ou intervenção | quarentenar por default; adoção só após validação/hash | recovery/restore |
| Propriedade após delete | 012 | Restrict; transferência; SetNull; cascade | transferência obrigatória ou Restrict; nunca cascade implícito | FK/migration |
| Duplicatas de permissão | 011 | máximo, recente, erro/manual | relatório e decisão manual para níveis conflitantes; dedupe automático apenas se idênticos | unique migration |
| API sem Redis | 013 | fail-fast; modo degradado | fail-fast com prazo e backoff até classificar endpoints seguros | comportamento de boot |
| Topologia Central | 009, 017 | service Compose; externa; host | uma definição versionada; não depender de container manual oculto | rede, proxy, deploy |
| HA da Central | 016 | singleton obrigatório; multi-instância | enforçar singleton agora; só anunciar HA após datastore concorrente | necessidade/forma da correção |
| Proxies confiáveis | 017 | hops fixos; CIDR allowlist; sem headers | socket default e allowlist explícita | IP/rate limit |
| Worker Go | 020 | suportar; congelar; remover | inventariar instalações; se nenhuma depende, aposentar formalmente | CI e correção Go |
| Autenticação web | 014 | cookie HttpOnly; access em memória+refresh cookie | access curto em memória + refresh rotativo HttpOnly, sujeito ao domínio/proxy | mudança de contrato/CSRF |
| Filesystems de storage | 019 | local; NFS; symlink permitido | documentar lista suportada e negar links por default | primitive segura de abertura |
| Modelos IA em produção | 015 | baked; volume RO; downloader verificado | código só na imagem; modelos em volume separado verificado/read-only quando possível | Compose/Dockerfile |
| UID/GID de volumes | 022 | fixo; remapeado; configurável | UID/GID dedicado e migração explícita por serviço | rollout non-root |
| RPO/RTO e janela | 006, 007 | definidos por produto/contrato | definir antes de redesenhar backup/restore | critérios de aceite operacionais |

## Comportamentos de sessão: classificação

| Sistema/comportamento | Classificação | Evidência/decisão |
|---|---|---|
| API access JWT assinado | JWT stateless na representação, mas **não** puramente stateless na validação | Cada request busca usuário ativo e confere `authVersion`. |
| API logout/troca de senha/reset/delete | Implementado | Incrementa `authVersion` e/ou revoga refresh; access anterior deixa de validar. |
| API alteração de papel | Implementado por leitura atual | Token carrega claims, mas guard recebe papel atual do DB; precisa teste de regressão. |
| API refresh | Implementado com rotação/hash | Rotação atômica e TTL configurável; default 7 dias. |
| Web access token | Risco de implementação/hardening | Persistido em `localStorage`; TTL default 8 h; web não usa refresh. |
| Web logout | Lacuna funcional de revogação da sessão corrente | Limpa localmente, mas não chama logout da API; revogações administrativas ainda funcionam via `authVersion`. |
| Mobile access/refresh | Implementado com SecureStore | Migra legado do AsyncStorage; logout remoto é best-effort e local sempre limpa. |
| Media tokens | Stateless curto com rechecagem parcial intencional | TTL aproximado de 5 min; consumidores rechecavam usuário/recurso. Política de revogação instantânea deve permanecer testada. |
| Central cookie opaco | Falha de implementação confirmada | Hash existe no datastore, mas request não revalida owner; delete/senha não revogam. |
| Central bearer admin | Requisito de segurança não resolvido | Capability estática/opcional; rotação, escopo e expiração exigem política. |
| Suspensão de instalação | Regra de produto, não revogação automaticamente | Feature policy restringe recursos; decidir se também revoga sessões/tokens. |
| Dispositivo perdido | Requisito incompleto | Não foi localizado painel/endpoint de revogação por dispositivo em todos os clientes. |

## Dependências de ambiente não disponíveis

| Dependência | O que impediu | Evidência obtida sem ela | Próximo ambiente seguro |
|---|---|---|---|
| Go 1.22 | `go test`, race e vet do worker | leitura completa, `go.mod`, Dockerfile, ausência de tests/listener/timeouts | CI/container fixado em Go 1.22 |
| PostgreSQL descartável dedicado | corrida 011, FK 012, duas Centrais PG e 13 testes Central PG | schema/fluxos demonstrados; banco ativo não foi tocado | container/namespace efêmero sem volumes reais |
| Redis descartável completo | boot Nest end-to-end e recuperação | `Queue.add` blackhole local ficou pendente | stack de integração isolada |
| Stack ML no host (`cv2`, `requests`, `supervision`) | 93 testes Python foram pulados | todos classificados; 237 restantes passaram | job CI ML já instala pins, com gate contra skips |
| Toolchain/câmera ONVIF/RTSP real | compatibilidade após política SSRF, PTZ e codecs | validação de funções/DTOs e mocks sem conexão externa | simuladores ONVIF/RTSP locais; hardware lab depois |
| IPv6/DNS namespace controlado | rebinding, mixed A/AAAA, redirects reais | fluxo sem pinagem demonstrado por análise | namespace sem egress com DNS autoritativo fake |
| Filesystems adicionais | TOCTOU/NFS/casefold/hardlinks | symlink em filesystem local reproduzido | matriz de filesystems oficialmente suportados |
| VM de update/restore | falhas reais, power loss, rollback e RPO/RTO | análise completa e `bash -n` | VM descartável com snapshots e fixtures |
| Disco cheio/power loss | durabilidade de gravação | ambos os sentidos DB↔FS reproduzidos por fault injection | loop device pequeno/VM crashável |
| Segunda Central isolada | lost update cross-process | algoritmo e ausência de lock demonstrados | duas instâncias contra JSON/PG efêmeros |
| Build-agent real | SLA e respostas grandes | blackhole local reproduziu bloqueio global | fake server com cenários determinísticos |
| Browser/device E2E | CSP, cookies futuros, background mobile e biometria | stores/contratos inspecionados; unit tests existentes | Playwright e emulador sem conta/dado real |
| Ambiente de instalação novo | falha de `/central/` no Compose puro | config não inclui service; host atual funciona via container manual | CI Compose descartável |

## Configurações que mudam a decisão

- DRAC-AUD-009: o host atual está protegido por container `drac-central`
  externo/manual na rede `infra_vms-net`; uma instalação baseada apenas no
  Compose versionado não recebe essa proteção.
- DRAC-AUD-016: singleton não sofre a corrida cross-process; nenhuma garantia
  executável de singleton foi encontrada.
- DRAC-AUD-017: o Nginx fornecido sobrescreve `X-Real-IP` e a porta atual está
  em loopback; exposição direta documentada manifesta o problema.
- DRAC-AUD-020: só afeta o profile `legacy-worker`, atualmente inativo.
- DRAC-AUD-003: a allowlist precisa conhecer a rede de câmeras, mas loopback,
  metadata e control-plane não devem ser liberados por serem “privados”.

## Hardware e produção

Não foram exercitados câmera física, PTZ, relé, GPU/NPU, MediaMTX real,
gravação real, perda de energia, disco cheio, NFS, restore real ou update real.
Também não foram enviados requests a metadata services ou hosts externos.
Essas lacunas impedem afirmar compatibilidade da futura correção, mas não
invalidam os fluxos já reproduzidos com stubs.

## Ordem das decisões

1. Aprovar raiz de confiança e política de release do lote 1.
2. Definir rede/destinos de câmeras e exceções SSRF.
3. Formalizar RESTRICTED/evidências e privacidade de ações admin.
4. Definir revogação de sessão e validade do installerToken.
5. Aprovar máquina de estados de gravação, órfãos e RPO/RTO.
6. Fixar topologia/HA/proxy da Central.
7. Decidir propriedade privada, duplicatas de permissão e worker Go.
8. Definir autenticação web, filesystems, modelos e UID/GID.

As quatro primeiras decisões fecham os maiores riscos remotos. A primeira
mitigação ainda deve ser o artefato imutável com digest; ela não precisa
esperar decisões de HA, UI, banco ou hardening.
