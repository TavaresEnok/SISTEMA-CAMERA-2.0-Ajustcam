/// <reference types="node" />
import { formatBytes, formatDateLabel, formatDuration, formatResolution, formatTime, isOnline, localDateKey, localDayIsoRange } from '../src/utils/format';
import { normalizeServerUrl, request, setTokenRefreshHandler, setUnauthorizedHandler } from '../src/services/api';
import { authenticatedMediaUrl, isSecureMediaUrl } from '../src/services/media-urls';
import { computeDetectionRect } from '../src/utils/detection-geometry';
import { matchesPlaybackFilter, recordingKind, timelineRange } from '../src/utils/playback';
import { contrastRatio, ensureReadableText, fetchBranding } from '../src/services/branding';
import { clearStreamUrlsCache, requestCachedStreamUrls } from '../src/services/stream-urls-cache';
import type { Camera, Recording } from '../src/types';
import { readFileSync } from 'node:fs';

import { test } from 'node:test';

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

test('formatters: tempo, duração, bytes e resolução', () => {
  assert(formatTime(null) === '--:--', 'formatTime deve tratar valor vazio');
  assert(formatDuration(0) === 'em andamento', 'formatDuration deve tratar zero como em andamento');
  assert(formatDuration(90) === '1m 30s', 'formatDuration deve formatar minutos e segundos');
  assert(formatBytes(1024) === '1 KB', 'formatBytes deve formatar KB');
  assert(formatBytes(1024 * 1024) === '1.0 MB', 'formatBytes deve formatar MB');
  assert(formatResolution({ detectedWidth: 1920, detectedHeight: 1080, detectedFps: 30 } as Camera) === '1920x1080 @ 30 FPS', 'formatResolution deve incluir FPS');
});

test('android security: build bloqueia permissões e backup inseguros', () => {
  const base = JSON.parse(readFileSync('app.base.json', 'utf8')).expo;
  const blocked = new Set<string>(base.android?.blockedPermissions ?? []);
  assert(blocked.has('android.permission.SYSTEM_ALERT_WINDOW'), 'overlay deve estar bloqueado');
  assert(blocked.has('android.permission.WRITE_EXTERNAL_STORAGE'), 'storage legado deve estar bloqueado');
  assert((base.plugins ?? []).includes('./plugins/withAndroidSecurity'), 'plugin de hardening deve executar em todo prebuild');
  const plugin = readFileSync('plugins/withAndroidSecurity.js', 'utf8');
  assert(plugin.includes("android:allowBackup'] = 'false'"), 'backup Android deve ser desativado');
  assert(plugin.includes("android:requestLegacyExternalStorage'] = 'false'"), 'storage legado deve ser desativado');
});

test('white-label build: senha da keystore nunca em texto claro (invariante 1.2.ii)', () => {
  // build-client.sh roda no HOST (fora do container) com acesso às keystores de
  // assinatura. A senha de cada cliente vive num arquivo 0600 ao lado da keystore
  // e JAMAIS pode: virar argumento de linha de comando (visível no `ps` p/ outros
  // usuários), cair numa variável de shell, ou aparecer num echo. Este teste trava
  // a regressão que reintroduziria isso no fluxo de assinatura do APK e do AAB.
  const sh = readFileSync('scripts/build-client.sh', 'utf8');

  // Toda ferramenta de assinatura lê a senha do arquivo 0600, nunca de um argumento.
  assert(sh.includes('-storepass:file "$PASS_FILE" -keypass:file "$PASS_FILE"'),
    'keytool/jarsigner devem ler a senha via -storepass:file (não como argumento)');
  assert(sh.includes('--ks-pass "file:$PASS_FILE"'),
    'apksigner deve ler a senha via --ks-pass file: (não como argumento)');

  // Nenhum `-storepass <valor>` / `-keypass <valor>` em texto claro: no fluxo
  // seguro só existem as formas com dois-pontos (`-storepass:file`/`:env`), então
  // um espaço após a flag denuncia a senha exposta no process list.
  assert(!/-storepass /.test(sh), 'nenhum -storepass com senha em texto claro (use :file)');
  assert(!/-keypass /.test(sh), 'nenhum -keypass com senha em texto claro (use :file)');

  // A senha não pode ser slurpada para uma variável de shell (rastro em `set -x`,
  // core dump, ou reuso acidental como argumento).
  assert(!/KS_PASS=/.test(sh), 'a senha da keystore não pode cair numa variável de shell');
  assert(!/cat "\$PASS_FILE"/.test(sh), 'a senha não pode ser lida via cat do arquivo .pass');

  // Falha CEDO e clara se a senha não estiver disponível — nunca gera um artefato
  // sem assinatura nem assina com senha vazia.
  assert(/\[\[ ! -s "\$PASS_FILE" \]\]/.test(sh),
    'deve falhar cedo quando o arquivo de senha estiver ausente/vazio');
});

test('formatDateLabel: hoje e data histórica', () => {
  const today = localDateKey();
  assert(formatDateLabel(today) === 'Hoje', 'data atual deve ser Hoje');
  assert(formatDateLabel('2026-05-20').includes('20'), 'data histórica deve conter dia');
});

test('playback: filtra origem da gravação e calcula posição na linha do tempo', () => {
  const motion = { id: '1', cameraId: 'c1', startedAt: '2026-07-14T06:00:00', durationSeconds: 60, triggerMode: 'motion', fileUsable: true } as Recording;
  const unavailable = { ...motion, id: '2', triggerMode: 'continuous', fileUsable: false } as Recording;
  assert(recordingKind(motion) === 'motion', 'modo motion deve ser reconhecido');
  assert(matchesPlaybackFilter(motion, 'motion'), 'gravação de movimento deve passar no filtro');
  assert(!matchesPlaybackFilter(unavailable, 'continuous'), 'arquivo indisponível não deve aparecer como contínuo disponível');
  assert(matchesPlaybackFilter(unavailable, 'unavailable'), 'arquivo ausente deve aparecer em indisponíveis');
  const range = timelineRange(motion);
  assert(Math.abs(range.left - 25) < 0.01, `06:00 deve ficar em 25% do dia (got ${range.left})`);
  assert(range.width >= 0.45, 'trechos curtos devem continuar tocáveis e visíveis');
});

test('localDateKey: usa componentes locais sem converter para UTC', () => {
  const fakeLocalDate = {
    getFullYear: () => 2026,
    getMonth: () => 6,
    getDate: () => 9,
  } as Date;
  assert(localDateKey(fakeLocalDate) === '2026-07-09', 'data local deve preservar ano, mês e dia');
});

test('localDayIsoRange: envia início e fim do dia civil no fuso do aparelho', () => {
  const range = localDayIsoRange('2026-07-09');
  const from = new Date(range.from);
  const to = new Date(range.to);
  assert(localDateKey(from) === '2026-07-09', 'início deve permanecer no dia local solicitado');
  assert(localDateKey(to) === '2026-07-09', 'fim deve permanecer no dia local solicitado');
  assert(from.getHours() === 0 && from.getMinutes() === 0, 'início deve ser meia-noite local');
  assert(to.getHours() === 23 && to.getMinutes() === 59, 'fim deve ser 23:59 local');
});

test('branding: corrige combinações de texto sem contraste', () => {
  assert((contrastRatio('#ffffff', '#000000') ?? 0) > 20, 'preto e branco devem ter contraste máximo');
  assert(ensureReadableText('#ffffff', ['#ffffff']) === '#0b0d12', 'texto branco sobre fundo branco deve ser corrigido');
  assert(ensureReadableText('#ffffff', ['#000000']) === '#ffffff', 'combinação legível deve ser preservada');
});

test('branding: separa as paletas clara e escura recebidas do servidor', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    facilityName: 'Instalação',
    brandUseDefaultColors: true,
    brandPrimaryColor: '#111111',
    brandBackgroundColor: '#000000',
    brandLightPrimaryColor: '#222222',
    brandLightBackgroundColor: '#ffffff',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  try {
    const branding = await fetchBranding('https://api.local');
    assert(branding.useDefaultColors, 'toggle de cores padrão deve ser mapeado');
    assert(branding.dark.primaryColor === '#111111', 'tema escuro deve usar chaves históricas');
    assert(branding.dark.backgroundColor === '#000000', 'fundo escuro deve ser mapeado');
    assert(branding.light.primaryColor === '#222222', 'tema claro deve usar chaves brandLight');
    assert(branding.light.backgroundColor === '#ffffff', 'fundo claro deve ser mapeado');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('isOnline: normaliza status da câmera', () => {
  assert(isOnline({ status: 'ONLINE' } as Camera), 'ONLINE deve estar online');
  assert(isOnline({ status: 'online' } as Camera), 'online deve estar online');
  assert(!isOnline({ status: 'OFFLINE' } as Camera), 'OFFLINE deve estar offline');
});

test('normalizeServerUrl: troca localhost pelo host da API', () => {
  const normalized = normalizeServerUrl('http://localhost:3002/camera-stream/1/poster', 'http://168.194.13.70:3002');
  assert(normalized === 'http://168.194.13.70:3002/camera-stream/1/poster', 'localhost deve ser substituído');
  assert(normalizeServerUrl(null, 'http://api.local') === null, 'null deve retornar null');
});

test('media URL: preserva query e adiciona streamToken curto', () => {
  const url = authenticatedMediaUrl('https://media.local/cam/whep?view=grid', 'https://api.local', 'token curto');
  assert(url != null, 'URL válida deve ser retornada');
  const parsed = new URL(url!);
  assert(parsed.searchParams.get('view') === 'grid', 'query existente deve ser preservada');
  assert(parsed.searchParams.get('token') === 'token curto', 'streamToken deve ser anexado');
  assert(isSecureMediaUrl(url), 'HTTPS deve ser reconhecido como seguro');
  assert(!isSecureMediaUrl('http://media.local/live.m3u8'), 'HTTP não deve ser tratado como seguro');
});

test('request: envia autorização e parseia JSON', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  const data = await request<{ ok: boolean }>('http://api.local', '/ping', 'token-123');
  assert(data.ok === true, 'request deve retornar JSON');
  assert(calls[0]?.url === 'http://api.local/ping', 'request deve montar URL');
  assert((calls[0]?.init?.headers as Record<string, string>).Authorization === 'Bearer token-123', 'request deve enviar bearer token');
});

test('request: transforma AbortError em mensagem amigável', async () => {
  globalThis.fetch = (async () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  }) as typeof fetch;

  let message = '';
  try {
    await request('http://api.local', '/slow');
  } catch (error) {
    message = error instanceof Error ? error.message : '';
  }
  assert(message === 'Tempo esgotado. Verifique a conexão.', 'AbortError deve virar timeout amigável');
});

test('cache de stream: deduplica por sessão sem compartilhar credenciais', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  clearStreamUrlsCache();
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? '';
    return new Response(JSON.stringify({ authorization }), { status: 200 });
  }) as typeof fetch;
  try {
    const [first, duplicate] = await Promise.all([
      requestCachedStreamUrls<{ authorization: string }>('https://api.local', 'cam-1', 'token-a'),
      requestCachedStreamUrls<{ authorization: string }>('https://api.local', 'cam-1', 'token-a'),
    ]);
    const otherSession = await requestCachedStreamUrls<{ authorization: string }>('https://api.local', 'cam-1', 'token-b');
    assert(calls === 2, `mesma sessão deve deduplicar e outra sessão deve buscar novamente (got ${calls})`);
    assert(first.authorization === 'Bearer token-a' && duplicate.authorization === 'Bearer token-a', 'resposta deduplicada deve manter a sessão correta');
    assert(otherSession.authorization === 'Bearer token-b', 'cache não deve vazar token entre contas');
  } finally {
    clearStreamUrlsCache();
    globalThis.fetch = originalFetch;
  }
});

test('cache de stream: erro não JSON continua legível', async () => {
  const originalFetch = globalThis.fetch;
  clearStreamUrlsCache();
  globalThis.fetch = (async () => new Response('gateway indisponível', { status: 502 })) as typeof fetch;
  let message = '';
  try {
    await requestCachedStreamUrls('https://api.local', 'cam-2', 'token-a');
  } catch (error) {
    message = error instanceof Error ? error.message : '';
  } finally {
    clearStreamUrlsCache();
    globalThis.fetch = originalFetch;
  }
  assert(message === 'gateway indisponível', 'erro textual do servidor deve ser preservado');
});

test('computeDetectionRect: mapeia bbox respeitando o letterbox do contain', () => {
  // Frame 1000x1000 num container 200x100 → vídeo renderizado fica 100x100,
  // centralizado, com 50px de letterbox em cada lado horizontal.
  const rect = computeDetectionRect([0, 0, 500, 500], 1000, 1000, 200, 100);
  assert(Math.abs(rect.left - 50) < 0.001, `left deve considerar offset do letterbox (got ${rect.left})`);
  assert(Math.abs(rect.top - 0) < 0.001, `top deve ser 0 (got ${rect.top})`);
  assert(Math.abs(rect.width - 50) < 0.001, `width deve escalar pela menor dimensão (got ${rect.width})`);
  assert(Math.abs(rect.height - 50) < 0.001, `height deve escalar pela menor dimensão (got ${rect.height})`);

  // Caixa degenerada não deve sumir: largura/altura mínima de 2px.
  const tiny = computeDetectionRect([10, 10, 10, 10], 1000, 1000, 100, 100);
  assert(tiny.width >= 2 && tiny.height >= 2, 'caixa mínima deve ter ao menos 2px');
});

test('api 401: requisição AUTENTICADA dispara o handler de sessão expirada', async () => {
  const originalFetch = globalThis.fetch;
  let fired = 0;
  let receivedToken = '';
  setUnauthorizedHandler((token) => { fired += 1; receivedToken = token ?? ''; });
  globalThis.fetch = (async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ message: 'expired' }),
  })) as unknown as typeof fetch;
  try {
    await request('http://x', '/cameras', 'a-token').catch(() => undefined);
    assert(fired === 1, `handler deveria disparar 1x em 401 autenticado (got ${fired})`);
    assert(receivedToken === 'a-token', 'handler deve identificar qual sessão originou o 401');
  } finally {
    globalThis.fetch = originalFetch;
    setUnauthorizedHandler(null);
  }
});

test('api 401: SEM token (login) NÃO dispara o handler', async () => {
  const originalFetch = globalThis.fetch;
  let fired = 0;
  setUnauthorizedHandler(() => { fired += 1; });
  globalThis.fetch = (async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ message: 'senha inválida' }),
  })) as unknown as typeof fetch;
  try {
    await request('http://x', '/auth/login').catch(() => undefined);
    assert(fired === 0, `handler NÃO deve disparar em 401 sem token (got ${fired})`);
  } finally {
    globalThis.fetch = originalFetch;
    setUnauthorizedHandler(null);
  }
});

test('api 401: renova o token e repete a requisição sem desconectar', async () => {
  const originalFetch = globalThis.fetch;
  const authorizations: string[] = [];
  let unauthorized = 0;
  setUnauthorizedHandler(() => { unauthorized += 1; });
  setTokenRefreshHandler(async (expired) => expired === 'token-antigo' ? 'token-novo' : null);
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? '';
    authorizations.push(authorization);
    if (authorization === 'Bearer token-antigo') {
      return new Response(JSON.stringify({ message: 'expired' }), { status: 401 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await request<{ ok: boolean }>('http://x', '/cameras', 'token-antigo');
    assert(result.ok === true, 'requisição repetida deve ter sucesso');
    assert(authorizations.join(',') === 'Bearer token-antigo,Bearer token-novo', 'deve repetir com o token renovado');
    assert(unauthorized === 0, 'renovação bem-sucedida não deve desconectar');
  } finally {
    globalThis.fetch = originalFetch;
    setTokenRefreshHandler(null);
    setUnauthorizedHandler(null);
  }
});
