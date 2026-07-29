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

// ── O MESMO ERRO, UM NÍVEL ABAIXO: `startCamera` ────────────────────────────
//
// `performSyncAll` aprendeu que `aiAdvanced` é OBJETO/FACE, não "IA em geral".
// `startCamera` não: ele abria com `isAllowed('aiAdvanced')` e devolvia
// `commercial_restriction` — em SILÊNCIO, sem log e sem erro.
//
// Isso matava exatamente o caminho de auto-cura. Quando o ai-service reinicia,
// ele perde todos os processadores; o watchdog percebe, chama `startCamera` e
// nada acontece, porque no estado NORMAL e DESEJADO ("somente movimento")
// `aiAdvanced` é false. Resultado observado em produção em 2026-07-28: câmera
// armada por movimento ficou sem detecção — logo, SEM GRAVAR — até alguém
// reiniciar a API. O `.catch()` do watchdog não ajudava: não havia erro, havia
// um retorno bem-comportado dizendo "desabilitado".
//
// Regra: o portão de `startCamera` tem que ser o da capacidade que ele vai
// usar — `aiMotion` para modo movimento, `aiAdvanced` só para objeto/face.

import { AiManagerService } from '../src/ai/ai-manager.service';

function managerFake(opts: { mode?: string; allowed: Record<string, boolean>; camera?: Record<string, unknown> }) {
  const calls: string[] = [];
  const mgr: any = Object.create(AiManagerService.prototype);
  mgr.logger = { warn() {}, log() {}, debug() {}, error() {} };
  mgr.commercialPolicy = {
    isAllowed: async (feature: string) => opts.allowed[feature] ?? false,
  };
  mgr.getSettings = async () => ({ enabled: true, mode: opts.mode ?? 'motion' });
  mgr.camerasService = {
    getCameraOrThrow: async () => ({
      id: 'cam-1', name: 'Portaria', aiEnabled: true, motionTrigger: 'SYSTEM',
      recordingMode: 'motion',
      ...(opts.camera ?? {}),
    }),
  };
  mgr.buildAiSource = async () => ({ rtspUrl: 'rtsp://x/grid', info: {} });
  mgr.aiService = {
    startAnalysisWithConfig: async (id: string, _url: string, mode: string) => {
      calls.push(`start:${id}:${mode}`);
      return { status: 'started' };
    },
  };
  return { mgr, calls };
}

test('startCamera: "somente movimento" (aiAdvanced=false) PRECISA iniciar a análise', async () => {
  const { mgr, calls } = managerFake({ mode: 'motion', allowed: { aiMotion: true, aiAdvanced: false } });

  const result = await mgr.startCamera('cam-1');

  assert.deepEqual(calls, ['start:cam-1:motion'], 'este é o estado normal do produto: tem que ligar o MOG2');
  assert.notEqual((result as any)?.status, 'disabled', 'devolver "disabled" aqui é a gravação parando em silêncio');
});

test('startCamera: movimento PROIBIDO pela licença continua bloqueando', async () => {
  const { mgr, calls } = managerFake({ mode: 'motion', allowed: { aiMotion: false, aiAdvanced: false } });

  const result = await mgr.startCamera('cam-1');

  assert.deepEqual(calls, [], 'sem direito nem a movimento, nada pode subir');
  assert.equal((result as any).status, 'disabled');
});

test('startCamera: modo OBJETO sem aiAdvanced continua bloqueado (a IA pesada segue desligada)', async () => {
  const { mgr, calls } = managerFake({ mode: 'object', allowed: { aiMotion: true, aiAdvanced: false } });

  const result = await mgr.startCamera('cam-1');

  assert.deepEqual(calls, [], 'liberar movimento não pode virar uma porta para objeto/face');
  assert.equal((result as any).status, 'disabled');
});

test('startCamera: modo OBJETO COM aiAdvanced sobe normalmente', async () => {
  const { mgr, calls } = managerFake({ mode: 'object', allowed: { aiMotion: true, aiAdvanced: true } });

  await mgr.startCamera('cam-1');

  assert.deepEqual(calls, ['start:cam-1:object']);
});

test('startCamera: falha ao consultar a política não pode derrubar o movimento', async () => {
  const { mgr, calls } = managerFake({ mode: 'motion', allowed: {} });
  mgr.commercialPolicy = { isAllowed: async () => { throw new Error('central fora do ar'); } };

  await mgr.startCamera('cam-1');

  assert.deepEqual(calls, ['start:cam-1:motion'], 'central inacessível não pode significar "pare de gravar"');
});

// ─────────────────────────────────────────────────────────────────────────────
// RECONCILIAÇÃO REVERSA do watchdog: processador ÓRFÃO é parado.
//
// O watchdog sempre soube RELIGAR processador ausente de câmera armada, mas
// nunca fez o caminho de volta. Como o ai-service sobrevive a restarts da API,
// processador de câmera DESARMADA rodava para sempre: produção acumulou 9
// ativos com UMA câmera armada. Custo duplo: CPU de análise e o transcode da
// grade preso 24/7 (a IA é leitor permanente do path _grid) — o live ficou
// lento "do nada" e o operador via IA em câmera que a Central dizia desligada.
// ─────────────────────────────────────────────────────────────────────────────

function watchdogFake(opts: { active: string[]; armadas: string[] }) {
  const stopped: string[] = [];
  const started: string[] = [];
  const mgr: any = Object.create(AiManagerService.prototype);
  mgr.logger = { warn() {}, log() {}, debug() {}, error() {} };
  mgr.degradedStrikes = new Map();
  mgr.strayStrikes = new Map();
  mgr.lastDegradedRecoveryAt = new Map();
  mgr.getSettings = async () => ({ enabled: true, mode: 'motion' });
  mgr.aiService = {
    getHealth: async () => ({ status: 'online', active_processors: opts.active, degraded_processors: [] }),
    stopAnalysis: async (id: string) => { stopped.push(id); },
  };
  mgr.startCamera = async (id: string) => { started.push(id); return { status: 'started' }; };
  mgr.prisma = {
    camera: {
      findMany: async (args: any) => {
        // A query de religar filtra motionTrigger=SYSTEM; a de órfãos, não.
        const ids = opts.armadas.map((id) => ({ id, name: id }));
        return args?.where?.motionTrigger === 'SYSTEM' ? ids : ids;
      },
    },
  };
  return { mgr, stopped, started };
}

test('watchdog: processador de câmera DESARMADA é parado no 2º tick (não no 1º)', async () => {
  const { mgr, stopped } = watchdogFake({ active: ['cam-orfa', 'cam-armada'], armadas: ['cam-armada'] });

  await mgr.recoverDegradedProcessors();
  assert.deepEqual(stopped, [], '1º tick só marca: teste manual rápido não pode morrer no meio');

  await mgr.recoverDegradedProcessors();
  assert.deepEqual(stopped, ['cam-orfa'], '2º tick seguido para o órfão');
});

test('watchdog: câmera que REARMA no meio zera a contagem de órfão', async () => {
  const cen = watchdogFake({ active: ['cam-x'], armadas: [] });
  await cen.mgr.recoverDegradedProcessors(); // strike 1 como órfã

  // Operador rearma a câmera entre os ticks: ela vira legítima.
  cen.mgr.prisma.camera.findMany = async () => [{ id: 'cam-x', name: 'cam-x' }];
  await cen.mgr.recoverDegradedProcessors();
  assert.deepEqual(cen.stopped, [], 'rearmar limpa o strike — o processador fica');

  // E mesmo que desarme de novo, a contagem recomeça do zero.
  cen.mgr.prisma.camera.findMany = async () => [];
  await cen.mgr.recoverDegradedProcessors();
  assert.deepEqual(cen.stopped, [], 'strike recomeçou: 1º tick de novo, ainda não para');
});

test('watchdog: processador de câmera ARMADA nunca é tocado pela reconciliação', async () => {
  const { mgr, stopped } = watchdogFake({ active: ['cam-armada'], armadas: ['cam-armada'] });
  await mgr.recoverDegradedProcessors();
  await mgr.recoverDegradedProcessors();
  await mgr.recoverDegradedProcessors();
  assert.deepEqual(stopped, [], 'a reconciliação reversa só existe para órfãos');
});

// ─────────────────────────────────────────────────────────────────────────────
// ABRIR O LIVE não semeia processador em câmera desarmada.
//
// Os três endpoints de live-view do controller auto-iniciam a IA quando não há
// processador. O processador criado assim é PERSISTENTE: fechar o live só
// derruba a lease, e restart da API não o toca (mora no ai-service). Era a
// FÁBRICA dos órfãos: cada tile aberto em câmera com o toggle ligado semeava
// um MOG2 eterno — 9 processadores com uma câmera armada, live degradado, e a
// reconciliação enxugando gelo.
// ─────────────────────────────────────────────────────────────────────────────

test('liveAutoStart: câmera DESARMADA não ganha processador ao abrir o live', async () => {
  const { mgr, calls } = managerFake({
    mode: 'motion',
    allowed: { aiMotion: true, aiAdvanced: false },
    camera: { recordingMode: 'manual' },
  });
  const result = await mgr.startCamera('cam-1', { liveAutoStart: true });
  assert.deepEqual(calls, [], 'abrir tile não pode semear MOG2 persistente');
  assert.equal((result as any).status, 'disabled');
  assert.equal((result as any).reason, 'not_armed');
});

test('liveAutoStart: câmera ARMADA continua ganhando processador pelo live', async () => {
  const { mgr, calls } = managerFake({
    mode: 'motion',
    allowed: { aiMotion: true, aiAdvanced: false },
    camera: { recordingMode: 'motion' },
  });
  const result = await mgr.startCamera('cam-1', { liveAutoStart: true });
  assert.deepEqual(calls, ['start:cam-1:motion'], 'a armada é exatamente quem PRECISA da análise');
  assert.notEqual((result as any)?.status, 'disabled');
});

test('liveAutoStart: modo AVANÇADO (objeto/face licenciado) segue permitido pelo live', async () => {
  // No modo avançado o overlay é real (caixa de objeto/face); o gate é só do
  // modo movimento, onde IA de câmera desarmada não produz nada visível.
  const { mgr, calls } = managerFake({
    mode: 'object',
    allowed: { aiMotion: true, aiAdvanced: true },
    camera: { recordingMode: 'manual' },
  });
  await mgr.startCamera('cam-1', { liveAutoStart: true });
  assert.deepEqual(calls, ['start:cam-1:object']);
});

test('start SEM origem live (watchdog/boot) não é afetado pelo gate', async () => {
  const { mgr, calls } = managerFake({
    mode: 'motion',
    allowed: { aiMotion: true, aiAdvanced: false },
    camera: { recordingMode: 'manual' },
  });
  // O watchdog/boot decide por conta própria QUEM ligar; o gate é específico
  // do caminho "espectador abriu um tile".
  await mgr.startCamera('cam-1');
  assert.deepEqual(calls, ['start:cam-1:motion']);
});
