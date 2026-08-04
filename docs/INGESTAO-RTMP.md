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
  "canonicalFullUrl": "rtmp://SEU-DOMINIO:1935/drac/3f2a...c81d",
  "fullUrlFitsSingleField": true,
  "singleFieldMaxLength": 63,
  "sourceMode": "rtmp_push"
}
```

Se o domínio tornar a URL maior que o campo do equipamento e
`MEDIAMTX_RTMP_SHORT_HOST` estiver configurado, a API prioriza esse endereço
curto com a porta 1935 explícita. Para deixar margem ao firmware, o endereço
usa `d/<22 base64url>`: são os mesmos 16 bytes/128 bits da chave, apenas em
outra representação, nunca um recorte. Sem alternativa segura, a API responde
`fullUrlFitsSingleField=false`.

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
| Servidor RTMP público | SRS tradutor → MediaMTX interno | pronto |
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

**Campos curtos existem.** Equipamentos Intelbras medidos aceitam no máximo 63
caracteres em "Endereço personalizado". Na instalação oficial, o
`MEDIAMTX_RTMP_SHORT_HOST` permite usar IP + porta explícita + `d/` + chave
Base64URL em 50 caracteres, preservando os 128 bits e deixando 13 caracteres
de margem para firmwares que reservam espaço interno. O formato histórico
`drac/<32 hex>` continua aceito e autenticado pela mesma chave canônica.

**Alguns equipamentos ignoram o caminho.** A Positivo CIP-B1312-M medida em campo
usa somente host/porta e publica em um nome derivado do número de série. O fluxo de
"equipamentos tentando publicar" permite vincular esse caminho a uma câmera. O SRS
na borda também responde ao dialeto Adobe/FMLE legado (`onFCPublish`) antes de
repassar o vídeo ao MediaMTX.

**Nem toda câmera sabe fazer push.** O recurso só se aplica quando o firmware possui
RTMP, Live Streaming ou Push Stream. A disponibilidade varia por modelo e versão.

## O que não mudou

As instalações existentes seguem em `rtsp_pull`, que é o padrão da coluna. O desvio para
o modo push acontece antes de qualquer trabalho em `configurePathForCamera`, e
`isPushSourced` responde falso para qualquer valor inesperado — inclusive `null` e
coluna ausente. Uma câmera antiga nunca entra no caminho novo por acidente.
