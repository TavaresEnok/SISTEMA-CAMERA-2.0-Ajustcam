import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeHotGridSet,
  pruneHistory,
  seedEmptyHistory,
} from '../src/camera-stream/helpers/hot-grid-sources.helper';
import { MediamtxProxyService } from '../src/camera-stream/mediamtx-proxy.service';

// ─────────────────────────────────────────────────────────────────────────────
// FONTES QUENTES POR RELEVÂNCIA — a política que substituiu a regra burra.
//
// "Sempre quente para todas" era ou abertura instantânea (21 câmeras) ou
// ataque de negação de serviço contra os DVRs da própria frota (2.000 câmeras
// ≈ 1,1 Gbps contínuos + 2.000 sessões RTSP). Estes testes travam a política
// que faz o custo acompanhar o USO (quem os operadores olham), não o tamanho
// do cadastro.
// ─────────────────────────────────────────────────────────────────────────────

const H = 3600_000;
const AGORA = 1_753_800_000_000; // fixo: nada aqui depende do relógio real

test('quente = as N mais recentes DENTRO da janela; resto fica frio', () => {
  const hot = computeHotGridSet(
    [
      { cameraId: 'a', lastViewedAt: AGORA - 1 * H },
      { cameraId: 'b', lastViewedAt: AGORA - 2 * H },
      { cameraId: 'c', lastViewedAt: AGORA - 3 * H },
      { cameraId: 'velha', lastViewedAt: AGORA - 200 * H }, // fora da janela de 168h
    ],
    2,
    168 * H,
    AGORA,
  );
  assert.deepEqual([...hot].sort(), ['a', 'b'], 'orçamento 2 → só as 2 mais recentes');
  assert.equal(hot.has('velha'), false, 'turno que acabou há uma semana não reserva banda');
});

test('orçamento ZERO desliga tudo (o botão "tudo frio" continua existindo)', () => {
  const hot = computeHotGridSet([{ cameraId: 'a', lastViewedAt: AGORA }], 0, 168 * H, AGORA);
  assert.equal(hot.size, 0);
});

test('2.000 câmeras vistas: o conjunto quente NUNCA passa do orçamento', () => {
  // O cenário exato da pergunta do dono ("e se tiver 2 mil câmeras?").
  const frota = Array.from({ length: 2000 }, (_, i) => ({
    cameraId: `cam-${String(i).padStart(4, '0')}`,
    lastViewedAt: AGORA - i * 1000,
  }));
  const hot = computeHotGridSet(frota, 64, 168 * H, AGORA);
  assert.equal(hot.size, 64, 'o custo acompanha o orçamento, não o cadastro');
  assert.ok(hot.has('cam-0000') && hot.has('cam-0063'), 'as 64 mais recentes');
  assert.ok(!hot.has('cam-0064'), 'a 65ª fica sob demanda');
});

test('empate de recência tem desempate ESTÁVEL (sem flip-flop quente↔frio)', () => {
  // Cada flip é uma reconexão RTSP contra a câmera do cliente. Dois candidatos
  // empatados têm que produzir o MESMO corte em toda reconciliação.
  const empatadas = [
    { cameraId: 'zulu', lastViewedAt: AGORA },
    { cameraId: 'alfa', lastViewedAt: AGORA },
  ];
  const a = computeHotGridSet(empatadas, 1, 168 * H, AGORA);
  const b = computeHotGridSet([...empatadas].reverse(), 1, 168 * H, AGORA);
  assert.deepEqual([...a], [...b], 'a ordem de entrada não pode mudar o resultado');
});

test('semente de histórico vazio + poda de entradas mortas', () => {
  const semente = seedEmptyHistory(['a', 'b'], AGORA);
  assert.equal(semente.length, 2);
  assert.ok(semente.every((e) => e.lastViewedAt === AGORA), 'primeiro boot: tudo "visto agora" (o orçamento corta)');

  const podado = pruneHistory(
    [
      { cameraId: 'viva', lastViewedAt: AGORA - 1 * H },
      { cameraId: 'morta', lastViewedAt: AGORA - 500 * H },
      { cameraId: 'lixo', lastViewedAt: Number.NaN },
    ],
    168 * H,
    AGORA,
  );
  assert.deepEqual(podado.map((e) => e.cameraId), ['viva'], 'fora da janela e NaN não se acumulam no SystemSetting');
});

test('isGridSourceHot: quente decide a fonte; env "tudo sob demanda" VENCE a política', () => {
  const svc: any = Object.create(MediamtxProxyService.prototype);
  svc.logger = { warn() {}, log() {}, debug() {}, error() {} };
  svc.gridViewAt = new Map([['cam-vista', Date.now()]]);
  svc.configService = { get: (k: string) => (k === 'mediaMtxSourceOnDemand' ? false : undefined) };

  assert.equal(svc.isGridSourceHot('cam-vista'), true, 'vista recentemente → quente');
  assert.equal(svc.isGridSourceHot('cam-nunca-vista'), false, 'fora do histórico → sob demanda');

  // Operador que setou MEDIAMTX_SOURCE_ON_DEMAND=true pediu "tudo frio":
  // política nenhuma pode ligar fonte por cima de uma escolha explícita.
  svc.configService = { get: (k: string) => (k === 'mediaMtxSourceOnDemand' ? true : undefined) };
  assert.equal(svc.isGridSourceHot('cam-vista'), false);
});

// ── O ORÇAMENTO PRECISA ALCANÇAR O PATH QUE EXISTE DE VERDADE ───────────────
//
// Defeito medido em produção em 2026-08-01: 4 paths de grade puxando vídeo com
// ZERO espectadores, 1,7 GB em 8 minutos — projeção de ~304 GB/dia de banda WAN
// paga para ninguém, mais 4 sessões RTSP presas nas câmeras (o mesmo recurso
// escasso que o Source Gateway existe para economizar).
//
// A causa foi uma premissa que deixou de valer. O aquecimento de boot configura
// TODOS os paths habilitados, e se justifica assim, no próprio código:
//
//   "Path sob demanda não abre conexão nenhuma com a câmera ao ser configurado;
//    ele só disca quando alguém assiste."
//
// Verdade — para path SOB DEMANDA. Só que `configurePathForCamera` lia
// `sourceOnDemand` direto da env global (`MEDIAMTX_SOURCE_ON_DEMAND=false` em
// produção), então TODO path configurado nascia sempre-conectado. Aquecer 22
// câmeras virou 22 sessões RTSP permanentes.
//
// O orçamento existia e estava em 0 — mas `reconcileHotGridSources` só age em
// paths com sufixo `_grid_source`, que deixaram de existir quando o salto
// privado virou opt-in (revert fdc79ff). O controle olhava para um path que a
// produção não tem mais.
//
// Regra: quem decide se o path da GRADE fica conectado é o orçamento quente,
// por câmera — não uma env global que ignora o orçamento.

function proxyComOrcamento(opts: { budget: number; envOnDemand?: boolean; vistas?: string[] }) {
  // Captura o que de fato é ENVIADO ao MediaMTX. Testar `resolveGridSourceOnDemand`
  // isolado não prova nada: a primeira versão destes testes seguia verde com a
  // correção removida, porque o helper existia e o `desiredPath` continuava lendo
  // a env global. O que importa é o payload do POST /v3/config/paths/add.
  const enviados: Array<{ path: string; body: any }> = [];
  const svc: any = Object.create(MediamtxProxyService.prototype);
  svc.logger = { warn() {}, log() {}, debug() {}, error() {} };
  svc.configService = {
    get: (key: string) => {
      if (key === 'mediaMtxSourceOnDemand') return opts.envOnDemand;
      if (key === 'ffmpegRtspTransport') return 'tcp';
      return undefined;
    },
  };
  svc.gridViewAt = new Map((opts.vistas ?? []).map((id) => [id, Date.now()]));
  svc.camerasService = {
    getCameraOrThrow: async (id: string) => ({
      id, name: 'Cam', enabled: true, ip: '10.0.0.9', rtspPort: 554,
      username: 'admin', passwordEncrypted: 'x', rtspPath: '/cam', audioEnabled: false,
    }),
  };
  svc.cryptoService = { decrypt: () => 'senha' };
  svc.settingsService = { isGpuAccelerationEnabled: async () => false };
  svc.chooseGridSource = async () => ({
    profile: { channel: 1, subtype: 1 }, sourceUrl: 'rtsp://x/sub',
    isHevc: false, usedSubStream: true, requiresSanitization: false,
  });
  svc.chooseLiveSource = async () => ({
    profile: { channel: 1, subtype: 0 }, sourceUrl: 'rtsp://x/main', isHevc: false,
  });
  svc.sourceGateway = undefined;
  svc.apiRequest = async (method: string, path: string, body?: any) => {
    if (method === 'POST') enviados.push({ path, body });
    if (method === 'GET') {
      // FIEL: só 404 significa "não existe, pode criar". Qualquer outro erro faz
      // o código PRESERVAR o path (guarda contra derrubar leitores por soluço do
      // plano de controle). Um fake que lançasse erro genérico nunca chegaria ao
      // POST — e o teste passaria a medir a guarda, não a decisão de on-demand.
      const err: any = new Error('path not found');
      err.status = 404;
      throw err;
    }
    return '{}';
  };
  const anterior = process.env.MEDIAMTX_HOT_GRID_SOURCES_MAX;
  process.env.MEDIAMTX_HOT_GRID_SOURCES_MAX = String(opts.budget);
  const restore = () => {
    if (anterior === undefined) delete process.env.MEDIAMTX_HOT_GRID_SOURCES_MAX;
    else process.env.MEDIAMTX_HOT_GRID_SOURCES_MAX = anterior;
  };
  return { svc, enviados, restore };
}

/** `sourceOnDemand` do payload que o MediaMTX receberia para o path da grade. */
async function onDemandEnviado(svc: any, enviados: any[], cameraId: string) {
  enviados.length = 0;
  await svc.configurePathForCamera(cameraId, 'grid');
  const criado = enviados.find((e) => e.path.includes('_grid'));
  assert.ok(criado, 'o path da grade deveria ter sido criado no MediaMTX');
  return criado.body.sourceOnDemand;
}

test('orçamento 0: o path da GRADE é criado SOB DEMANDA — aquecer não abre sessão RTSP', async () => {
  const { svc, enviados, restore } = proxyComOrcamento({ budget: 0, envOnDemand: false, vistas: ['cam-a', 'cam-b'] });
  try {
    assert.equal(
      await onDemandEnviado(svc, enviados, 'cam-a'), true,
      'com orçamento 0 nenhuma câmera é quente: configurar o path NÃO pode abrir sessão permanente',
    );
  } finally { restore(); }
});

test('orçamento 2: câmera DENTRO do orçamento é criada sempre-conectada; fora, sob demanda', async () => {
  const { svc, enviados, restore } = proxyComOrcamento({ budget: 2, envOnDemand: false, vistas: ['cam-a', 'cam-b'] });
  try {
    assert.equal(await onDemandEnviado(svc, enviados, 'cam-a'), false, 'quente: abre instantâneo para o operador');
    assert.equal(await onDemandEnviado(svc, enviados, 'cam-fora'), true, 'fria: não pode segurar sessão da câmera');
  } finally { restore(); }
});

test('env "tudo sob demanda" continua vencendo o orçamento (decisão explícita do operador)', async () => {
  const { svc, enviados, restore } = proxyComOrcamento({ budget: 50, envOnDemand: true, vistas: ['cam-a'] });
  try {
    assert.equal(
      await onDemandEnviado(svc, enviados, 'cam-a'), true,
      'MEDIAMTX_SOURCE_ON_DEMAND=true é escolha explícita e não pode ser sobreposta pelo orçamento',
    );
  } finally { restore(); }
});
