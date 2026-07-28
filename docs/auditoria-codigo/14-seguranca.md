# Segurança

## Maiores riscos

1. DRAC-AUD-001: supply chain do instalador com execução remota privilegiada.
2. DRAC-AUD-003: SSRF/port scan para plano de controle interno.
3. DRAC-AUD-010: PTZ/relés/gravação em câmera privada por admin.
4. DRAC-AUD-004: bypass do bloqueio de histórico em ZIP/clip.
5. DRAC-AUD-005: sessão de admin sobrevive à exclusão/troca de senha.
6. DRAC-AUD-008: URL de instalador reutilizável sem expiração.
7. DRAC-AUD-014: JWT web acessível a JavaScript e CSP fraco.

## Segredos

Nenhum `.env` real foi lido. Não foi encontrado segredo privado obviamente
versionado por nome/extensão. O `google-services.json` cliente é versionado;
valores permaneceram mascarados/não reproduzidos (DRAC-AUD-025). Arquivos
locais de admin/env são ignorados e não foram abertos.

## Autenticação e autorização

A API tem guards globais e autorização por recurso extensa. A Central usa
hash forte e cookie HttpOnly. As falhas identificadas são de composição:
capabilities que não herdam privacidade, gate de live usado em download de
histórico e sessão não vinculada ao estado atual da conta.

## Rede e subprocessos

Não foi confirmada command injection nos caminhos ativos: TypeScript/Python/Go
usam argumentos separados ou não invocam shell para mídia. Shell quoting da
Central existe, mas não mitiga a confiança no conteúdo remoto do instalador.

## Hardening

DRAC-AUD-017/022/023 documentam confiança no proxy, execução root e cookie
Secure opt-in. São importantes porque a Central administra instalações e a API
processa mídia não confiável.
