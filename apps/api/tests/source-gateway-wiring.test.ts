import test from 'node:test';
import assert from 'node:assert/strict';
import {
  liveViewModeToSourceProfile,
  sourceProfileToLiveViewMode,
  consumerRequiresDirectSource,
} from '../src/camera-stream/helpers/source-profile.helper';

// ── Ligação do Source Gateway (Fase 3, passo A+B+C) ──────────────────────────
// O gateway existia mas era inalcançável: ninguém traduzia o vocabulário de
// perfil (main|sub) para o do proxy (selected|grid|original), ninguém avisava
// que havia origem publicada, e nenhum consumidor perguntava a ele.

test('tradutor: grid usa o SUBSTREAM; selected e original usam o principal', () => {
  assert.equal(liveViewModeToSourceProfile('grid'), 'sub');
  assert.equal(liveViewModeToSourceProfile('selected'), 'main');
  assert.equal(liveViewModeToSourceProfile('original'), 'main');
});

test('tradutor: a volta devolve o modo canônico de cada perfil', () => {
  assert.equal(sourceProfileToLiveViewMode('sub'), 'grid');
  assert.equal(sourceProfileToLiveViewMode('main'), 'selected');
  // Ida e volta a partir do modo canônico é estável (a relação é muitos-para-um).
  for (const mode of ['grid', 'selected'] as const) {
    assert.equal(sourceProfileToLiveViewMode(liveViewModeToSourceProfile(mode)), mode);
  }
});

// INVARIANTE DE QUALIDADE: o pilar do DRAC é gravar o bitstream ORIGINAL em
// `-c copy`. Se a gravação lesse de um path que o MediaMTX transcodificou para
// entrega (H.265→H.264 para o navegador), gravaríamos vídeo DEGRADADO — o mesmo
// defeito que torna o worker-go legado inaceitável.
test('gravação, pré-buffer e clipe JAMAIS podem ser reroteados para a origem interna', () => {
  assert.equal(consumerRequiresDirectSource('recording'), true);
  assert.equal(consumerRequiresDirectSource('prebuffer'), true);
  assert.equal(consumerRequiresDirectSource('clip'), true);
});

test('IA, live, grade e poster PODEM usar a origem interna (só precisam de quadros)', () => {
  for (const consumer of ['ai', 'live', 'grid', 'poster', 'probe']) {
    assert.equal(consumerRequiresDirectSource(consumer), false, `${consumer} não deveria exigir direto`);
  }
});

// ── O consumidor da IA de fato consulta o gateway ────────────────────────────
// Teste de estrutura (o buildAiSource depende de câmera/cripto/proxy reais):
// prova que o ponto de decisão existe, ANTES do retorno direto, e que o retorno
// direto continua sendo o caminho quando o gateway não redireciona.
test('ai-manager: consulta o gateway antes de cair no RTSP direto', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('src/ai/ai-manager.service.ts', 'utf8');
  const gatewayAt = src.indexOf('this.sourceGateway?.resolveSourceUrl');
  const directAt = src.indexOf("sourceKind: 'direct_camera'");
  assert.notEqual(gatewayAt, -1, 'o ai-manager precisa consultar o Source Gateway');
  assert.ok(gatewayAt < directAt, 'a consulta ao gateway tem de vir ANTES do retorno direto');
  assert.match(src.slice(gatewayAt, gatewayAt + 400), /consumer: 'ai'/, 'deve se identificar como consumidor ai');
});

test('mediamtx-proxy: registra a origem publicada ao preparar o path', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('src/camera-stream/mediamtx-proxy.service.ts', 'utf8');
  const at = src.indexOf('registerPublishedSource');
  assert.notEqual(at, -1, 'sem registrar a origem, o gateway nunca tem o que oferecer');
  const block = src.slice(at - 400, at + 400);
  assert.match(block, /try \{/, 'o registro precisa ser best-effort (não pode derrubar o live)');
  assert.match(block, /liveViewModeToSourceProfile/, 'precisa traduzir o modo de entrega para o perfil');
});

// CAUSA-RAIZ medida em produção: o gateway ficou ativo com ZERO reroteamentos
// porque a IA resolvia a fonte ANTES de qualquer origem ser publicada — sem
// origem, o gateway (corretamente) caía no direto, e a economia nunca acontecia.
// A IA passa a GARANTIR o path antes de perguntar.
test('ai-manager: GARANTE o path do MediaMTX antes de consultar o gateway', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('src/ai/ai-manager.service.ts', 'utf8');
  const ensureAt = src.indexOf("ensurePathForCamera(cam.id, 'grid')");
  const gatewayAt = src.indexOf('this.sourceGateway?.resolveSourceUrl');
  assert.notEqual(ensureAt, -1, 'a IA precisa garantir a origem antes de perguntar');
  assert.ok(ensureAt < gatewayAt, 'o ensure tem de vir ANTES da consulta ao gateway');
  // E sem path garantido não se pergunta nada (evita URL interna inválida).
  assert.match(src.slice(ensureAt, gatewayAt + 200), /ensured\?\.pathName/);
});

// REGRESSÃO REAL (produção, 2026-07-27): sem prazo, o `await ensurePathForCamera`
// pendurou a subida da IA. Aquele método compartilha uma promessa em voo por
// (câmera, modo): se ela travar, todo chamador seguinte espera para sempre — e o
// `.catch()` NÃO salva, porque nada rejeita, apenas nunca resolve. A detecção de
// movimento (que arma a gravação) ficou fora do ar sem UM erro no log.
test('ai-manager: o ensure do gateway tem PRAZO (otimização não segura a IA)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('src/ai/ai-manager.service.ts', 'utf8');
  // O fallback de HEVC também chama ensurePathForCamera (e vem antes no arquivo),
  // então olhamos a chamada do GATEWAY: a que alimenta resolveSourceUrl.
  const gatewayAt = src.indexOf('this.sourceGateway?.resolveSourceUrl');
  const trecho = src.slice(Math.max(0, gatewayAt - 700), gatewayAt);
  assert.match(trecho, /withTimeout\(/, 'o ensure do gateway precisa correr contra um prazo');
  assert.match(trecho, /ensurePathForCamera\(cam\.id, 'grid'\)/, 'e ser o ensure do path de grade');
  assert.match(src, /private withTimeout<T>/, 'o helper de prazo precisa existir');
});
