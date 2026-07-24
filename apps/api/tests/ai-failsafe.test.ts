import { test } from 'node:test';
import assert from 'node:assert/strict';
import { of, throwError } from 'rxjs';
import { AiService } from '../src/ai/ai.service';
import { OnvifEventsService } from '../src/cameras/onvif-events.service';

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANTE 1.3 do plano: "IA fora ⇒ grava".
// A IA nunca pode SUPRIMIR uma gravação por estar indisponível, lenta ou em erro.
// Só um resultado explícito confirmed=false (frame lido, sem objeto) suprime.
// Provamos os DOIS lados: (A) o cliente de IA cai para null quando fora/erro;
// (B) o handler ONVIF grava quando a confirmação é null/true e só pula em false.
// ─────────────────────────────────────────────────────────────────────────────

function configFake(values: Record<string, string> = {}) {
  return { get: (key: string) => values[key] } as any;
}

// ── Lado A: AiService.confirmMotion nunca "inventa" um false ──────────────────

test('failsafe A: IA desabilitada ⇒ confirmed=null e NÃO chama o serviço', async () => {
  const prev = process.env.AI_AUTO_START_ENABLED;
  process.env.AI_AUTO_START_ENABLED = 'false';
  try {
    let posted = false;
    const http = { post: () => { posted = true; return of({ data: {} }); } } as any;
    const svc = new AiService(http, configFake({ aiBaseUrl: 'http://ai:8000' }));
    const result = await svc.confirmMotion('cam-1', 'rtsp://x/grid');
    assert.equal(result.confirmed, null, 'IA desabilitada deve devolver null (não sei), nunca false');
    assert.equal(result.reason, 'ai_disabled');
    assert.equal(posted, false, 'não deve chamar o ai-service quando desabilitada');
  } finally {
    if (prev === undefined) delete process.env.AI_AUTO_START_ENABLED;
    else process.env.AI_AUTO_START_ENABLED = prev;
  }
});

test('failsafe A: erro de rede/timeout ⇒ confirmed=null (falha segura)', async () => {
  const http = { post: () => throwError(() => new Error('ECONNREFUSED')) } as any;
  const svc = new AiService(http, configFake({ aiBaseUrl: 'http://ai:8000' }));
  const result = await svc.confirmMotion('cam-1', 'rtsp://x/grid');
  assert.equal(result.confirmed, null, 'erro do ai-service deve virar null, nunca false');
  assert.match(result.reason ?? '', /^error:/);
});

test('failsafe A: resposta não-booleana ⇒ confirmed=null (defensivo)', async () => {
  const http = { post: () => of({ data: { confirmed: 'talvez', labels: 'x' } }) } as any;
  const svc = new AiService(http, configFake({ aiBaseUrl: 'http://ai:8000' }));
  const result = await svc.confirmMotion('cam-1', 'rtsp://x/grid');
  assert.equal(result.confirmed, null, 'confirmed não-boolean deve degradar para null');
  assert.deepEqual(result.labels, [], 'labels não-array deve virar []');
});

test('failsafe A: confirmed=false só quando o serviço AFIRMA sem objeto', async () => {
  const http = { post: () => of({ data: { confirmed: false, labels: [], reason: 'no_object' } }) } as any;
  const svc = new AiService(http, configFake({ aiBaseUrl: 'http://ai:8000' }));
  const result = await svc.confirmMotion('cam-1', 'rtsp://x/grid');
  assert.equal(result.confirmed, false);
});

test('failsafe A: confirmed=true propaga labels e confiança', async () => {
  const http = { post: () => of({ data: { confirmed: true, labels: ['person'], confidence: 0.9 } }) } as any;
  const svc = new AiService(http, configFake({ aiBaseUrl: 'http://ai:8000' }));
  const result = await svc.confirmMotion('cam-1', 'rtsp://x/grid');
  assert.equal(result.confirmed, true);
  assert.deepEqual(result.labels, ['person']);
  assert.equal(result.confidence, 0.9);
});

// ── Lado B: o handler ONVIF grava em null/true, suprime só em false ───────────

function makeHandler(confirmation: { confirmed: boolean | null; labels: string[]; reason?: string }) {
  const recordCalls: Array<{ id: string; meta: any }> = [];
  const recorder = {
    handleMotionDetected: (id: string, meta: any) => {
      recordCalls.push({ id, meta });
      return Promise.resolve();
    },
  };
  const prisma = {
    camera: { findUnique: async () => ({ recordingMode: 'motion', enabled: true }) },
  } as any;
  const moduleRef = {
    get: (token: any) => (token?.name === 'RecordingProcessManagerService' ? recorder : undefined),
  } as any;
  const svc = new OnvifEventsService(prisma, {} as any, moduleRef);
  // costura: controla a confirmação sem precisar de MediaMTX/AiService reais.
  (svc as any).confirmNativeMotion = async () => confirmation;
  return { svc, recordCalls };
}

test('failsafe B: confirmação NULL (IA fora) ⇒ GRAVA', async () => {
  const { svc, recordCalls } = makeHandler({ confirmed: null, labels: [] });
  await (svc as any).handleNativeMotion('cam-1');
  assert.equal(recordCalls.length, 1, 'confirmação null deve acionar a gravação');
  assert.equal(recordCalls[0].id, 'cam-1');
});

test('failsafe B: confirmação FALSE (sem objeto) ⇒ NÃO grava (suprime)', async () => {
  const { svc, recordCalls } = makeHandler({ confirmed: false, labels: [], reason: 'no_object' });
  await (svc as any).handleNativeMotion('cam-1');
  assert.equal(recordCalls.length, 0, 'só confirmed=false suprime a gravação');
});

test('failsafe B: confirmação TRUE ⇒ GRAVA com o rótulo semântico', async () => {
  const { svc, recordCalls } = makeHandler({ confirmed: true, labels: ['person'] });
  await (svc as any).handleNativeMotion('cam-1');
  assert.equal(recordCalls.length, 1, 'objeto confirmado deve gravar');
  assert.equal(recordCalls[0].meta?.semanticLabel, 'person');
});
