# Mobile Expo/React Native

## Resultado

Os 35 testes e o typecheck passaram. A sessão atual usa Expo SecureStore; há
migração única de uma sessão legada no AsyncStorage e remoção posterior.
Favoritos, grupos, tema e índice de clips ficam em AsyncStorage, escopados por
servidor/usuário.

## Transporte e sessão

- `app.base.json` desabilita cleartext por padrão.
- `app.config.js` só habilita cleartext por opção explícita do cliente/env, e o
  build-client rejeita APK que o habilite indevidamente.
- `cleanApiUrl` apenas normaliza texto e aceita host arbitrário. Isso é
  necessário para white-label e não foi classificado como bug isolado; builds
  que habilitem cleartext devem ser tratados como exceção de risco.
- O app implementa refresh em 401 e limpa SecureStore/AsyncStorage de sessão no
  logout.

## Arquivos e compartilhamento

Downloads usam IDs saneados e áreas privadas do app; temporários de snapshot e
share são apagados best-effort. Clips offline persistentes permanecem por
design, com índice escopado. Não houve teste em dispositivo para confirmar
remoção após uninstall/logout, permissões do provedor de arquivos ou
interrupção no meio de download.

## Achado

DRAC-AUD-024: não há `FLAG_SECURE`/ScreenCapture para telas de câmera,
playback ou identidade. Screenshots e snapshot da tela recente são possíveis;
a necessidade de bloquear isso depende da regra de privacidade/usabilidade.

## Limitações

Não foram executados prebuild, Gradle, teste de certificado, push real,
background/foreground, WebRTC/HLS em aparelho ou biometria física.
