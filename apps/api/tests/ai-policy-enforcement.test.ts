import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudConnectorService } from '../src/cloud-connector/cloud-connector.service';

// ── Política de IA vinda da Central ─────────────────────────────────────────
// A ARMADILHA: antes, qualquer `aiAdvanced:false` chamava stopAll() e derrubava
// TODA a IA. Com a política granular, "somente movimento" — o estado desejado e
// mais comum — produz aiAdvanced:false. Um stopAll cego mataria o MOG2, que é o
// que ARMA a gravação por movimento: câmeras armadas parariam de gravar EM
// SILÊNCIO. Estes testes existem para essa regressão nunca acontecer.

function makeService() {
  const svc: any = Object.create(CloudConnectorService.prototype);
  const state = { stopAllCalls: 0, logs: [] as string[] };
  svc.logger = {
    warn: (m: string) => state.logs.push(`warn:${m}`),
    log: (m: string) => state.logs.push(`log:${m}`),
  };
  svc.moduleRef = {
    get: () => ({ stopAll: async () => { state.stopAllCalls += 1; } }),
  };
  return { svc, state };
}

test('somente movimento: NÃO para a IA (o MOG2 arma a gravação por movimento)', async () => {
  const { svc, state } = makeService();
  await svc.enforceAiRestrictions({ aiMotion: true, aiObject: false, aiFace: false, aiAdvanced: false });
  assert.equal(state.stopAllCalls, 0, 'aiAdvanced:false com movimento ligado NÃO pode derrubar a IA');
  assert.ok(state.logs.some((l) => l.includes('somente detecção de MOVIMENTO')), 'deve registrar o estado');
});

test('objeto liberado: também não para nada', async () => {
  const { svc, state } = makeService();
  await svc.enforceAiRestrictions({ aiMotion: true, aiObject: true, aiFace: false, aiAdvanced: true });
  assert.equal(state.stopAllCalls, 0);
});

test('movimento DESLIGADO: aí sim para tudo (movimento é a base)', async () => {
  const { svc, state } = makeService();
  await svc.enforceAiRestrictions({ aiMotion: false, aiObject: false, aiFace: false, aiAdvanced: false });
  assert.equal(state.stopAllCalls, 1);
  assert.ok(state.logs.some((l) => l.includes('parada por política')));
});

test('COMPATIBILIDADE: Central antiga (sem chaves granulares) mantém o comportamento histórico', async () => {
  const { svc, state } = makeService();
  // Sem aiMotion/aiObject/aiFace, aiAdvanced:false ainda deve parar tudo — senão
  // uma restrição comercial legítima deixaria de ser aplicada.
  await svc.enforceAiRestrictions({ aiAdvanced: false });
  assert.equal(state.stopAllCalls, 1);

  const b = makeService();
  await b.svc.enforceAiRestrictions({ aiAdvanced: true });
  assert.equal(b.state.stopAllCalls, 0);
});

test('falha ao parar a IA não propaga (heartbeat não pode quebrar por isso)', async () => {
  const { svc, state } = makeService();
  svc.moduleRef = { get: () => { throw new Error('ai fora do ar'); } };
  await assert.doesNotReject(() => svc.enforceAiRestrictions({ aiMotion: false }));
  assert.ok(state.logs.some((l) => l.startsWith('warn:')));
});

// QUARTA VIA (a que derrubou a IA em produção, 2026-07-27): performSyncAll
// bloqueava TODA a IA com isAllowed('aiAdvanced'). Com "somente movimento" —
// o estado normal — aiAdvanced é false, então o MOG2 morria e as câmeras armadas
// paravam de gravar, com a mensagem enganosa "IA bloqueada pela política
// comercial". Movimento tem de ter chave própria.
test('sync: aiAdvanced=false NÃO pode derrubar a IA (é o estado normal)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('src/ai/ai-manager.service.ts', 'utf8');
  const at = src.indexOf('private async performSyncAll');
  const corpo = src.slice(at, at + 1600);
  assert.match(corpo, /isAllowed\('aiMotion'\)/, 'o bloqueio total deve depender de aiMotion');
  const stopAt = corpo.indexOf('stopAll');
  const trechoAteStop = corpo.slice(0, stopAt);
  assert.doesNotMatch(
    trechoAteStop.replace(/\/\/[^\n]*/g, ''),
    /if \(!\(await this\.commercialPolicy\.isAllowed\('aiAdvanced'\)\)\) \{\s*$/m,
    'aiAdvanced sozinho não pode disparar o stopAll',
  );
});

test('sync: aiMotion é feature comercial reconhecida (senão o default seria negar)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('src/commercial-policy/commercial-policy.service.ts', 'utf8');
  assert.match(src, /'aiMotion'/, 'aiMotion precisa existir no tipo CommercialFeature');
  assert.match(src, /aiMotion: true/, 'e no default permissivo');
});
