import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PtzCapabilityService } from '../src/ptz/ptz-capability.service';

// ─────────────────────────────────────────────────────────────────────────────
// Capacidade PTZ deixou de ser adivinhada pelo front (era
// `Boolean(onvifPath || onvifProfileToken)`, que marcava toda câmera ONVIF como
// móvel). Estes testes travam as regras que fazem a sonda ser confiável o
// bastante para rodar sozinha.
// ─────────────────────────────────────────────────────────────────────────────

type CameraFake = Record<string, any>;

function montar(camera: CameraFake | null, diagnostico?: any) {
  const gravado: CameraFake[] = [];
  const prisma = {
    camera: {
      findUnique: async () => camera,
      findMany: async () => [],
      update: async ({ data }: any) => { gravado.push(data); return { ...camera, ...data }; },
    },
  } as any;
  const chamadasDeSonda: string[] = [];
  const onvif = {
    diagnoseCamera: async (c: any) => {
      chamadasDeSonda.push(c.id);
      if (diagnostico instanceof Error) throw diagnostico;
      return diagnostico;
    },
  } as any;
  return { svc: new PtzCapabilityService(prisma, onvif), gravado, chamadasDeSonda };
}

const CAM_BASE = { id: 'cam-1', name: 'Cam 1', enabled: true, ptzCapable: null, ptzCapableSource: null, ptzProbedAt: null };

test('sonda grava a capacidade E o endpoint que respondeu', async () => {
  const { svc, gravado } = montar(CAM_BASE, {
    ptzLikelyWorking: true,
    detected: { ok: true, protocol: 'onvif', onvifPort: 8000, onvifPath: '/onvif/ptz_service', onvifProfileToken: 'Profile001' },
  });

  const r = await svc.sondar('cam-1');
  assert.equal(r.sondou, true);
  assert.equal(r.ptzCapable, true);
  assert.equal(gravado[0].ptzCapable, true);
  assert.equal(gravado[0].ptzCapableSource, 'auto');
  // O ponto todo: guardar o endpoint faz o PRÓXIMO comando acertar de primeira,
  // em vez de tentar quatro caminhos e falhar em todos (o erro que o operador via).
  assert.equal(gravado[0].onvifPort, 8000);
  assert.equal(gravado[0].onvifPath, '/onvif/ptz_service');
  assert.equal(gravado[0].onvifProfileToken, 'Profile001');
});

test('decisão manual do operador NUNCA é sobrescrita pela sonda', async () => {
  const manual = { ...CAM_BASE, ptzCapable: true, ptzCapableSource: 'manual' };
  const { svc, gravado, chamadasDeSonda } = montar(manual, { ptzLikelyWorking: false, detected: null });

  const r = await svc.sondar('cam-1', { forcar: true });

  assert.equal(r.sondou, false);
  assert.equal(r.motivo, 'definido-manualmente');
  assert.equal(r.ptzCapable, true, 'mantém o que o operador definiu');
  assert.equal(chamadasDeSonda.length, 0, 'nem chega a incomodar a câmera');
  assert.equal(gravado.length, 0, 'não grava nada por cima');
});

test('falha de rede NÃO carimba a câmera como sem PTZ', async () => {
  // Distinção que evita o pior erro possível aqui: "não consegui perguntar" é
  // diferente de "perguntei e ela não tem". Carimbar false por cabo solto
  // esconderia o PTZ para sempre — a câmera some da varredura (que busca null).
  const { svc, gravado } = montar(CAM_BASE, new Error('ETIMEDOUT'));

  const r = await svc.sondar('cam-1');

  assert.equal(r.sondou, false);
  assert.equal(r.motivo, 'falha-na-sonda');
  assert.equal(gravado.length, 0, 'nada persistido');
  assert.equal(r.ptzCapable, null, 'segue desconhecida → volta na próxima varredura');
});

test('sondada há pouco não é re-sondada, mas "forçar" ignora o intervalo', async () => {
  const recente = { ...CAM_BASE, ptzProbedAt: new Date(Date.now() - 60_000), ptzCapableSource: 'auto', ptzCapable: false };
  const diag = { ptzLikelyWorking: true, detected: { ok: true, protocol: 'onvif' } };

  const a = montar(recente, diag);
  const semForcar = await a.svc.sondar('cam-1');
  assert.equal(semForcar.sondou, false);
  assert.equal(semForcar.motivo, 'sondada-recentemente');
  assert.equal(a.chamadasDeSonda.length, 0, 'câmera que oscila o dia todo não vira tempestade de sondas');

  const b = montar(recente, diag);
  const forcando = await b.svc.sondar('cam-1', { forcar: true });
  assert.equal(forcando.sondou, true);
  assert.equal(forcando.ptzCapable, true);
});

test('câmera desativada não é sondada', async () => {
  const { svc, chamadasDeSonda } = montar({ ...CAM_BASE, enabled: false }, { ptzLikelyWorking: true, detected: {} });
  const r = await svc.sondar('cam-1');
  assert.equal(r.motivo, 'camera-desativada');
  assert.equal(chamadasDeSonda.length, 0);
});

test('sem PTZ: grava false e NÃO apaga a configuração ONVIF existente', async () => {
  const { svc, gravado } = montar(CAM_BASE, { ptzLikelyWorking: false, detected: { ok: false } });
  await svc.sondar('cam-1');
  assert.equal(gravado[0].ptzCapable, false);
  assert.equal(gravado[0].ptzCapableSource, 'auto');
  assert.equal('onvifPath' in gravado[0], false, 'não mexe no cadastro de rede quando não achou PTZ');
});

test('definir à mão marca a origem como manual', async () => {
  const { svc, gravado } = montar(CAM_BASE);
  await svc.definirManualmente('cam-1', true);
  assert.equal(gravado[0].ptzCapable, true);
  assert.equal(gravado[0].ptzCapableSource, 'manual');
});

test('voltar ao automático limpa origem e data, devolvendo a câmera à varredura', async () => {
  const { svc, gravado } = montar({ ...CAM_BASE, ptzCapable: true, ptzCapableSource: 'manual' });
  await svc.voltarAoAutomatico('cam-1');
  assert.equal(gravado[0].ptzCapableSource, null);
  assert.equal(gravado[0].ptzProbedAt, null);
});
