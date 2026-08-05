import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordingsService } from '../src/recordings/recordings.service';

// ── O ENDPOINT QUE CONGELAVA A API, AGORA COM ORÇAMENTO ─────────────────────
//
// Os testes vizinhos (`health-summary-scan.test.ts`) provam as REGRAS. Estes
// provam a FIAÇÃO: o método real de verdade, com um banco e um disco de
// mentira, porque o defeito nunca esteve nas regras — esteve em quem chamava o
// quê, quantas vezes, dentro de um laço.
//
// O que se mede aqui é o que doeu em produção:
//   · quantas idas ao BANCO (era uma por gravação, em série);
//   · quantas medições CARAS (era um ffprobe por gravação, em série);
//   · quantas leituras do CACHE (era uma por gravação — 1,6 MB reinterpretados
//     1.200 vezes, os 11 segundos de tela congelada);
//   · e se o resumo AVISA que olhou só um pedaço do dia.

type Chamadas = {
  countBanco: number;
  findManyBanco: number;
  medicoes: string[];
  leiturasDeCache: number;
};

/**
 * Monta o serviço sem passar pelo construtor (padrão já usado na suíte) e
 * substitui as fronteiras caras: banco, cache e a medição do arquivo.
 */
function montarServico(opcoes: {
  totalNoBanco: number;
  gravacoes: Array<{ id: string; cameraId: string; minutosAtras: number }>;
  cache?: Record<string, unknown>;
  env?: Record<string, string>;
}) {
  const chamadas: Chamadas = { countBanco: 0, findManyBanco: 0, medicoes: [], leiturasDeCache: 0 };
  const svc: any = Object.create(RecordingsService.prototype);
  const agora = Date.now();

  svc.logger = { warn: () => {}, log: () => {}, error: () => {} };
  svc.prisma = {
    recording: {
      count: async () => {
        chamadas.countBanco += 1;
        return opcoes.totalNoBanco;
      },
      findMany: async ({ take }: { take: number }) => {
        chamadas.findManyBanco += 1;
        return opcoes.gravacoes.slice(0, take).map((g) => ({
          id: g.id,
          cameraId: g.cameraId,
          startedAt: new Date(agora - g.minutosAtras * 60_000),
          filePath: `cam/${g.id}.mp4`,
        }));
      },
    },
  };

  const cache: Record<string, unknown> = { ...(opcoes.cache ?? {}) };
  svc.readDiagnosticsCache = () => {
    chamadas.leiturasDeCache += 1;
    return cache;
  };
  svc.writeDiagnosticsCache = (novo: Record<string, unknown>) => {
    Object.assign(cache, novo);
  };
  // A fronteira cara: no código real isto abre o arquivo e roda `ffprobe`.
  svc.medirDiagnosticoDeGravacao = async (registro: { id: string }) => {
    chamadas.medicoes.push(registro.id);
    return { recordingId: registro.id, fileExists: true, fileSizeBytes: 5_000_000, compatibleRecommended: false };
  };

  return { svc, chamadas };
}

function comEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const anterior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    anterior[k] = process.env[k];
    process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(anterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

const gravacoes = (n: number, cameraId = 'cam-1') =>
  Array.from({ length: n }, (_, i) => ({ id: `rec-${i}`, cameraId, minutosAtras: 1 }));

test('cache frio: o laço NÃO dispara uma medição cara por gravação', async () => {
  // O defeito latente: 1.200 gravações sem cache = 1.200 ffprobe EM SÉRIE, a
  // cada troca de aba. Hoje só não explode porque o offload apaga a cópia
  // local; basta o modo mudar para "Direto" para virar minutos de CPU.
  const { svc, chamadas } = montarServico({ totalNoBanco: 1200, gravacoes: gravacoes(1200) });
  const resumo: any = await comEnv({ RECORDING_HEALTH_SUMMARY_PROBE_BUDGET: '24' }, () =>
    svc.getRecordingHealthSummary({}),
  );

  assert.equal(chamadas.medicoes.length, 24, `${chamadas.medicoes.length} medições caras — o orçamento não está sendo respeitado`);
  assert.equal(resumo.cameras[0].total, 1200, 'todas as gravações continuam contadas');
  assert.equal(resumo.pendingDiagnostics, 1176, 'o que não foi medido tem de aparecer como pendente');
  assert.equal(resumo.cameras[0].broken, 0, 'pendente NUNCA pode virar defeito — seria alarme inventado');
});

test('sem N+1: uma consulta de lista, uma de contagem, e nada por gravação', async () => {
  // Cada gravação sem cache fazia a PRÓPRIA consulta (ensureRecordingExists)
  // para descobrir o filePath — 1.200 idas ao banco em série por requisição.
  // Agora o filePath vem na consulta da lista.
  const { svc, chamadas } = montarServico({ totalNoBanco: 300, gravacoes: gravacoes(300) });
  await comEnv({ RECORDING_HEALTH_SUMMARY_PROBE_BUDGET: '10' }, () => svc.getRecordingHealthSummary({}));

  assert.equal(chamadas.findManyBanco, 1);
  assert.equal(chamadas.countBanco, 1);
});

test('o cache é lido POUCAS vezes, não uma por gravação', async () => {
  // Era exatamente isto que parava a API por 11 segundos: o arquivo de 1,6 MB
  // reinterpretado a cada volta do laço. A varredura lê uma vez; cada medição
  // cara lê ao gravar o resultado (barato, memoizado em RAM).
  const { svc, chamadas } = montarServico({ totalNoBanco: 500, gravacoes: gravacoes(500) });
  await comEnv({ RECORDING_HEALTH_SUMMARY_PROBE_BUDGET: '0' }, () => svc.getRecordingHealthSummary({}));

  assert.equal(chamadas.leiturasDeCache, 1, 'uma leitura para a varredura inteira');
});

test('o corte deixou de ser mudo: a resposta diz que olhou só um pedaço do dia', async () => {
  // 8.500 gravações num dia real. Cortar em 1.200 e devolver "nenhuma câmera
  // em atenção" fazia o resumo afirmar sobre 86% que nunca leu.
  const { svc } = montarServico({ totalNoBanco: 8500, gravacoes: gravacoes(1200) });
  const resumo: any = await comEnv(
    { RECORDING_HEALTH_SUMMARY_MAX_RECORDS: '1200', RECORDING_HEALTH_SUMMARY_PROBE_BUDGET: '0' },
    () => svc.getRecordingHealthSummary({}),
  );

  assert.equal(resumo.truncated, true);
  assert.equal(resumo.totalMatchingRecordings, 8500);
  assert.equal(resumo.scannedRecordings, 1200);
  assert.equal(resumo.scanLimit, 1200);
});

test('dia que cabe inteiro NÃO é marcado como cortado', async () => {
  const { svc } = montarServico({ totalNoBanco: 40, gravacoes: gravacoes(40) });
  const resumo: any = await comEnv({ RECORDING_HEALTH_SUMMARY_PROBE_BUDGET: '100' }, () =>
    svc.getRecordingHealthSummary({}),
  );

  assert.equal(resumo.truncated, false);
  assert.equal(resumo.pendingDiagnostics, 0, 'com orçamento de sobra, nada fica pendente');
  assert.equal(resumo.totalRecordings, 40, 'o campo antigo continua existindo para quem já consome');
});

test('cache quente não gasta NENHUMA medição', async () => {
  const cache: Record<string, unknown> = {};
  for (const g of gravacoes(200)) {
    cache[g.id] = {
      checkedAt: new Date().toISOString(),
      diagnostics: { recordingId: g.id, fileExists: true, fileSizeBytes: 5_000_000, compatibleRecommended: false },
    };
  }
  const { svc, chamadas } = montarServico({ totalNoBanco: 200, gravacoes: gravacoes(200), cache });
  const resumo: any = await comEnv({ RECORDING_HEALTH_SUMMARY_PROBE_BUDGET: '24' }, () =>
    svc.getRecordingHealthSummary({}),
  );

  assert.deepEqual(chamadas.medicoes, [], 'medir o que o cache já responde é o gasto que não pode existir');
  assert.equal(resumo.pendingDiagnostics, 0);
  assert.equal(resumo.cameras[0].directLikely, 200);
});

test('uma medição que falha vira pendente, não defeito, e não derruba o resumo', async () => {
  const { svc } = montarServico({ totalNoBanco: 3, gravacoes: gravacoes(3) });
  svc.medirDiagnosticoDeGravacao = async () => {
    throw new Error('ffprobe sumiu');
  };
  const resumo: any = await comEnv({ RECORDING_HEALTH_SUMMARY_PROBE_BUDGET: '10' }, () =>
    svc.getRecordingHealthSummary({}),
  );

  assert.equal(resumo.pendingDiagnostics, 3);
  assert.equal(resumo.cameras[0].broken, 0, 'falha ao MEDIR não é defeito da gravação');
  assert.equal(resumo.camerasNeedingAttention, 0);
});
