// ── AVISO DE VERSÃO NOVA (sem loja) ─────────────────────────────────────────
//
// O APK é distribuído por link, não pela Play: não existe atualização
// automática nem aviso nenhum. Um usuário sideload só troca de versão se
// alguém lembrar de mandar o link outra vez — e a frota fica com versões
// misturadas sem ninguém saber.
//
// A infraestrutura já publica tudo o que falta: o `build-client.sh` grava
// `drac-<slug>-build-info.json` ao lado do APK, com `versionCode`, `versionName`
// e o nome do arquivo. Basta o app consultar e comparar.

export type BuildInfo = {
  schemaVersion?: number;
  client?: string;
  appName?: string;
  packageId?: string;
  versionName?: string;
  versionCode?: number;
  artifacts?: { apk?: { file?: string; sha256?: string } };
};

export type AtualizacaoDisponivel = {
  versionName: string;
  versionCode: number;
  /** URL absoluta do APK, para abrir no navegador. */
  url: string;
};

/**
 * Há versão mais nova publicada?
 *
 * Compara `versionCode` (inteiro monotônico controlado pelo build) — nunca
 * `versionName`, que é texto livre e não ordena de forma confiável ("1.10" <
 * "1.9" em comparação de string).
 *
 * `null` significa "não há novidade OU não deu para saber" — e as duas coisas
 * devem ser silenciosas: aviso de atualização que aparece por engano é pior que
 * aviso nenhum.
 */
export function avaliarAtualizacao(
  info: BuildInfo | null | undefined,
  versionCodeAtual: number | null | undefined,
  baseUrlDoApk: string,
): AtualizacaoDisponivel | null {
  if (!info || typeof info.versionCode !== 'number' || !Number.isFinite(info.versionCode)) return null;
  if (typeof versionCodeAtual !== 'number' || !Number.isFinite(versionCodeAtual)) return null;
  if (info.versionCode <= versionCodeAtual) return null;

  const arquivo = info.artifacts?.apk?.file;
  if (!arquivo) return null;
  const base = baseUrlDoApk.replace(/\/+$/, '');
  return {
    versionName: info.versionName ?? String(info.versionCode),
    versionCode: info.versionCode,
    url: `${base}/${arquivo}`,
  };
}

/**
 * Base pública onde o APK é servido, derivada da URL da API.
 *
 * O nginx monta os artefatos em `/apk/` na RAIZ do site, enquanto a API vive em
 * `/api` (ou numa porta própria). Então tira-se o sufixo `/api` e acrescenta-se
 * `/apk` — sem inventar host, para não apontar o download para outro servidor.
 */
export function baseDoApk(apiUrl: string | null | undefined): string | null {
  if (!apiUrl) return null;
  try {
    const url = new URL(apiUrl);
    const caminho = url.pathname.replace(/\/+$/, '').replace(/\/api$/i, '');
    return `${url.origin}${caminho}/apk`;
  } catch {
    return null;
  }
}

/** URL do manifesto de build do cliente, ao lado do APK publicado. */
export function urlDoBuildInfo(baseUrlDoApk: string, slug: string): string {
  return `${baseUrlDoApk.replace(/\/+$/, '')}/drac-${slug}-build-info.json`;
}
