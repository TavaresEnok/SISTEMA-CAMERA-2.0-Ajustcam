# Web React

## Resultado

O frontend tem separação clara de API base, store de autenticação, páginas,
players e helpers de VOD. Os 109 testes e o typecheck passaram.

## Achados

- DRAC-AUD-014: access token JWT é persistido em `localStorage` por padrão e
  tem TTL default de 8h. O CSP do Nginx não define `default-src` ou
  `script-src`, portanto não reduz materialmente o impacto de um XSS futuro.
- A única ocorrência de `dangerouslySetInnerHTML` está em `ui/chart.tsx`,
  gerando CSS a partir de configurações internas. Não foi demonstrada entrada
  remota não sanitizada nesse componente; não foi classificada como XSS.

## Players, polling e cleanup

`LiveStreamPlayer` concentra WebRTC/HLS, timers, renew e fallbacks. A inspeção
por chamadas mostrou rotinas de cleanup e os testes cobrem boa parte da lógica
VOD, mas não houve teste de navegador com várias câmeras, troca de aba,
unmount e falha prolongada. Pollers em páginas são a principal área de risco de
performance e deveriam receber teste com fake timers/AbortController.

## Autorização

A UI usa capabilities devolvidas pela API, mas segurança continua no backend.
A divergência de `canControl/canRecord` de câmera privada nasce na API e é
refletida pelo web, não uma autorização exclusiva do frontend.

## Dados sensíveis

Não foi localizada persistência de credencial RTSP. Layouts, preferências,
tema e qualidade/protocolo live são persistidos localmente. A identidade
cacheada contém nome/e-mail/role e também fica em `localStorage`.
