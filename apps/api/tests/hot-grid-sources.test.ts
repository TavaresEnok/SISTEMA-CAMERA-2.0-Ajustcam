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
