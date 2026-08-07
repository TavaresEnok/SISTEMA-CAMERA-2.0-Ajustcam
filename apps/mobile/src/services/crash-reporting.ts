import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';

// ── RELATÓRIO DE TRAVAMENTO ─────────────────────────────────────────────────
//
// Os APKs são distribuídos por link, fora da Play Store. Isso custa exatamente
// o painel que a loja daria de graça: quando o app fecha sozinho no celular de
// um cliente, ninguém fica sabendo — nem que aconteceu, nem em qual tela, nem
// por quê. Com uma frota de APKs por cliente (cada um com aparelho, versão de
// Android e câmeras diferentes), descobrir travamento por telefonema não
// escala.
//
// O destino é o GlitchTip HOSPEDADO NA PRÓPRIA AJUSTCONSULTING (fala o
// protocolo do Sentry, por isso o SDK é o mesmo): os relatórios saem dos
// celulares dos clientes e ficam na infraestrutura de casa, não em terceiro.
//
// O QUE NUNCA PODE IR JUNTO. Um relatório de erro carrega, por padrão, muito
// mais do que a pilha: URLs completas (com token na query, que é como o
// MediaMTX exige), cabeçalhos de autenticação, corpo de requisição. Numa
// instalação de videomonitoramento isso significaria mandar credencial de
// sessão e endereço de câmera para fora do aparelho. O `beforeSend` abaixo
// existe para impedir isso, e é a parte deste arquivo que merece revisão.

/** Chaves cujo VALOR nunca sai do aparelho. */
const CAMPOS_SENSIVEIS = /(token|senha|password|authorization|secret|key|cookie|credential)/i;

/** Remove o valor de qualquer parâmetro sensível de uma URL, preservando o resto. */
function limparUrl(valor: string): string {
  return valor
    .replace(/([?&](?:token|access_token|key|secret|password)=)[^&#\s]*/gi, '$1REDACTED')
    // Basic/Bearer embutido no host (rtsp://user:senha@ip) — o app não monta
    // URL assim, mas uma mensagem de erro do servidor pode trazer.
    .replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//REDACTED@');
}

function limparProfundo(valor: unknown, profundidade = 0): unknown {
  if (profundidade > 6 || valor == null) return valor;
  if (typeof valor === 'string') return limparUrl(valor);
  if (Array.isArray(valor)) return valor.map((item) => limparProfundo(item, profundidade + 1));
  if (typeof valor === 'object') {
    const saida: Record<string, unknown> = {};
    for (const [chave, item] of Object.entries(valor as Record<string, unknown>)) {
      saida[chave] = CAMPOS_SENSIVEIS.test(chave) ? '[REDACTED]' : limparProfundo(item, profundidade + 1);
    }
    return saida;
  }
  return valor;
}

export function iniciarRelatorioDeTravamento(): void {
  const dsn = String(Constants.expoConfig?.extra?.crashDsn ?? '').trim();
  // Sem DSN configurado, o app segue exatamente como antes. Relatório de
  // travamento nunca pode ser motivo de o app não abrir.
  if (!dsn) return;

  try {
    Sentry.init({
      dsn,
      // Só o que interessa: falha. Nada de rastreamento de navegação/desempenho,
      // que geraria volume e guardaria caminho do usuário sem necessidade.
      tracesSampleRate: 0,
      enableAutoPerformanceTracing: false,
      // `sendDefaultPii` FALSE é o padrão, mas é declarado porque aqui a
      // consequência é concreta: sem isso iriam IP e identificadores do
      // aparelho junto de cada relatório.
      sendDefaultPii: false,
      environment: __DEV__ ? 'desenvolvimento' : 'producao',
      release: `${Constants.expoConfig?.version ?? '0'}+${Constants.expoConfig?.extra?.client ?? 'default'}`,
      beforeSend(evento) {
        try {
          // 1) Nada de dado de usuário identificável.
          delete evento.user;
          delete evento.server_name;
          // 2) URLs e cabeçalhos da requisição que falhou.
          if (evento.request) {
            if (evento.request.url) evento.request.url = limparUrl(evento.request.url);
            delete evento.request.headers;
            delete evento.request.cookies;
            delete evento.request.data;
          }
          // 3) Rastro de navegação: o SDK guarda cada requisição HTTP feita
          //    antes do erro — é onde os tokens realmente aparecem.
          evento.breadcrumbs = evento.breadcrumbs?.map((migalha) => ({
            ...migalha,
            message: migalha.message ? limparUrl(migalha.message) : migalha.message,
            data: limparProfundo(migalha.data) as Record<string, unknown> | undefined,
          }));
          // 4) Contexto extra e mensagem do próprio erro.
          if (evento.extra) evento.extra = limparProfundo(evento.extra) as Record<string, unknown>;
          if (evento.message) evento.message = limparUrl(evento.message);
          if (evento.exception?.values) {
            evento.exception.values = evento.exception.values.map((v) => ({
              ...v,
              value: v.value ? limparUrl(v.value) : v.value,
            }));
          }
        } catch {
          // Falhar aqui NÃO pode derrubar o app: na dúvida, não envia.
          return null;
        }
        return evento;
      },
    });
  } catch {
    // idem: o app abre mesmo que o relatório não inicialize.
  }
}

/** Marca a instalação (não a pessoa) — para separar travamento por cliente. */
export function marcarInstalacao(cliente: string | null | undefined): void {
  try {
    Sentry.setTag('cliente', cliente || 'default');
  } catch {
    // ignore
  }
}
