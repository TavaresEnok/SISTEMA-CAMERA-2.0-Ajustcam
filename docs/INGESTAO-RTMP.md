# Ingestão por RTMP — a câmera disca para o DRAC

## O problema

Todo o DRAC pressupunha que **nós** alcançamos a câmera: IP público, redirecionamento
de porta ou VPN. Nesta instalação isso custa **15 redirecionamentos feitos à mão** no
roteador do cliente — e foi esse trabalho meio-feito que deixou 8 câmeras sem porta
ONVIF cadastrada por meses.

Onde há CGNAT, 4G ou rede de terceiro, não existe redirecionamento possível. A conexão
só pode nascer de dentro.

No modo push a câmera publica em nós: ela abre a conexão de saída, atravessa CGNAT sem
nada configurado, e o vídeo entra por uma porta só — a nossa.

## Como configurar uma câmera

**1. Gere a chave** (administrador):

```bash
curl -X POST https://SEU-SERVIDOR/cameras/<id>/rtmp-ingest -H "Authorization: Bearer <token>"
```

A resposta traz os dois campos que a interface da câmera pede:

```json
{
  "serverUrl": "rtmp://SEU-SERVIDOR:1935/drac",
  "streamKey": "3f2a...c81d",
  "fullUrl":   "rtmp://SEU-SERVIDOR:1935/drac/3f2a...c81d",
  "sourceMode": "rtmp_push"
}
```

**2. Na câmera**, procure *Rede → RTMP* (ou *Live Streaming*, *Push Stream*):

- Campo **Servidor/URL** → `serverUrl`
- Campo **Chave/Stream key** → `streamKey`
- Interface com **um campo só** → `fullUrl`

**3. Pronto.** O path de live aponta sozinho para a ingestão. Não há sonda, não há
FFmpeg, não há transcode.

Para desfazer e voltar ao modo tradicional:

```bash
curl -X DELETE https://SEU-SERVIDOR/cameras/<id>/rtmp-ingest -H "Authorization: Bearer <token>"
```

Isso apaga a chave — sem apagar, ela continuaria autorizando publicação numa câmera
que ninguém espera que esteja publicando.

## O que é preciso ligar

| Item | Onde | Estado |
|---|---|---|
| Colunas no banco | migração `20260731210000_add_rtmp_push_ingest` | **precisa rodar** |
| Porta 1935 | `docker-compose.yml` (publicada) | pronta |
| Servidor RTMP | MediaMTX (ligado por padrão) | pronto |
| Autorização | `mediamtx-auth` na API | pronta |

> **A migração tem de rodar junto com o deploy da API, não depois.** O Prisma passa a
> pedir as colunas novas em toda consulta de câmera; subir o código sem a migração
> derruba a listagem de câmeras inteira.

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml exec api npx prisma migrate deploy
```

## Segurança — o que vale e o que não vale

**A chave é um credencial de publicação.** Quem a tiver pode empurrar vídeo como se
fosse aquela câmera. Por isso ela é rotacionável (basta um `POST` novo) e vale para
**publicar apenas naquele único path**.

**Publicar não dá acesso a nada.** Ler continua exigindo `streamToken`, exatamente como
antes. Vazar uma chave permite falsificar uma câmera, não assistir ao acervo.

**Nenhum publicador consegue assumir um path de câmera.** O padrão aceito é
`drac/<32 hexadecimais>` e nada mais; nenhum nome de path de câmera casa com ele. Há
teste dedicado para isso (`rtmp-publish-auth.test.ts`).

**Desabilitar a câmera corta a publicação na hora**, sem precisar rotacionar a chave.

**Guardamos só o SHA-256 da chave** para autenticar, comparado em tempo constante. A
cópia cifrada existe apenas para o administrador reler o valor.

### Limitação conhecida: a chave trafega em claro

RTMP não tem TLS. Entre a câmera e o servidor, quem observar o tráfego captura a chave.

O RTMPS resolveria, mas **não está habilitado**: exige `rtmpEncryption` e certificado no
MediaMTX, que hoje não estão configurados (só a porta 1935 escuta). O código já monta
URLs `rtmps://` quando `MEDIAMTX_RTMP_SCHEME=rtmps`, então habilitar é trabalho de
infraestrutura, não de aplicação.

Enquanto isso não existir, trate a chave como senha: rotacione ao trocar de instalador
e ao desmobilizar equipamento.

## Limites do protocolo

**RTMP clássico transporta H.264.** Câmera que só sai em H.265 não serve para este modo
— e a entrega é passthrough justamente por isso: sem transcode, custo de CPU zero por
câmera.

**Um fluxo só.** Quem publica manda um stream; não há sub-stream para a grade escolher.
Grade, tela cheia e "máxima qualidade" leem a mesma ingestão.

**Nem toda câmera sabe fazer push.** Verificado nesta instalação: as IntelBras
VIPC-1230-B-G2 e Positivo CIP-B1312-M **não têm RTMP** (a seção de configuração não
existe no firmware). O recurso serve para equipamento que tem — que é a maioria dos
DVR/NVR e boa parte das câmeras de outras marcas.

## O que não mudou

As instalações existentes seguem em `rtsp_pull`, que é o padrão da coluna. O desvio para
o modo push acontece antes de qualquer trabalho em `configurePathForCamera`, e
`isPushSourced` responde falso para qualquer valor inesperado — inclusive `null` e
coluna ausente. Uma câmera antiga nunca entra no caminho novo por acidente.
