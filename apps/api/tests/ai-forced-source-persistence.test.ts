import test from 'node:test';
import assert from 'node:assert/strict';
import { AiManagerService } from '../src/ai/ai-manager.service';
import { CloudConnectorService } from '../src/cloud-connector/cloud-connector.service';

// ── A CURA SOBREVIVE AO RESTART, E O DEFEITO FICA VISÍVEL ───────────────────
//
// Duas metades da mesma exigência de antifragilidade:
//
// 1. A decisão "esta câmera só funciona pela entrega interna" custa minutos de
//    detector cego para descoberta (2 reinícios + cooldowns). Guardada só em
//    memória, CADA restart da API repetia a descoberta inteira. Persistida em
//    SystemSetting, a análise nasce direto na fonte que funciona.
//
// 2. O episódio real ficou INVISÍVEL: 9 câmeras cegas por horas e a Central
//    mostrando tudo normal, porque nenhuma métrica do heartbeat carregava essa
//    informação. `motionFailsafeCameras` passa a viajar no summary.

function armazemDeSettings() {
  const linhas = new Map<string, string>();
  return {
    linhas,
    systemSetting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        (linhas.has(where.key) ? { key: where.key, value: linhas.get(where.key) } : null),
      upsert: async ({ where, update, create }: any) => {
        linhas.set(where.key, (linhas.has(where.key) ? update.value : create.value));
      },
    },
  };
}

function montarAi(armazem = armazemDeSettings()) {
  const svc: any = Object.create(AiManagerService.prototype);
  svc.logger = { warn: () => {}, log: () => {}, error: () => {}, debug: () => {} };
  svc.prisma = armazem;
  return { svc, armazem };
}

test('a fonte forçada PERSISTE: outra instância (o restart) já nasce sabendo', async () => {
  const { svc, armazem } = montarAi();
  await svc.carregarFontesForcadas();
  svc.fontesForcadasInternas.add('cam-hevc');
  await svc.persistirFontesForcadas();

  // "Restart": instância nova, mesma tabela.
  const { svc: renascido } = montarAi(armazem);
  await renascido.carregarFontesForcadas();
  assert.ok(
    renascido.fontesForcadasInternas.has('cam-hevc'),
    'sem persistência, cada restart repete minutos de detector cego por câmera',
  );
});

test('valor corrompido no banco não derruba a IA — vira lista vazia', async () => {
  const armazem = armazemDeSettings();
  armazem.linhas.set('ai.forcedInternalSources', '{quebrado');
  const { svc } = montarAi(armazem);
  await svc.carregarFontesForcadas();
  assert.equal(svc.fontesForcadasInternas.size, 0);
});

test('banco indisponível não bloqueia a análise', async () => {
  const { svc } = montarAi();
  svc.prisma = { systemSetting: { findUnique: async () => { throw new Error('banco fora'); } } };
  await svc.carregarFontesForcadas();
  assert.equal(svc.fontesForcadasInternas.size, 0, 'persistência é reforço, nunca requisito');
});

test('a carga acontece UMA vez — o laço de análise não martela o banco', async () => {
  let leituras = 0;
  const armazem = armazemDeSettings();
  const { svc } = montarAi(armazem);
  const original = armazem.systemSetting.findUnique;
  armazem.systemSetting.findUnique = async (args: any) => { leituras += 1; return original(args); };
  await svc.carregarFontesForcadas();
  await svc.carregarFontesForcadas();
  await svc.carregarFontesForcadas();
  assert.equal(leituras, 1);
});

// ── O heartbeat carrega o número que faltou no dia do episódio ──────────────

function montarConnector(failsafe: string[] | null) {
  const svc: any = Object.create(CloudConnectorService.prototype);
  svc.moduleRef = {
    get: () => {
      if (failsafe === null) throw new Error('serviço indisponível');
      return { camerasEmFailsafeCego: () => failsafe };
    },
  };
  return svc;
}

test('heartbeat: câmeras em fail-safe viram métrica para a Central', () => {
  assert.equal(montarConnector(['a', 'b', 'c']).getMotionFailsafeCount(), 3);
  assert.equal(montarConnector([]).getMotionFailsafeCount(), 0);
});

test('heartbeat: gerenciador indisponível vira zero, nunca erro', () => {
  // O heartbeat é a linha de vida com a Central; uma métrica opcional jamais
  // pode derrubá-lo.
  assert.equal(montarConnector(null).getMotionFailsafeCount(), 0);
});
