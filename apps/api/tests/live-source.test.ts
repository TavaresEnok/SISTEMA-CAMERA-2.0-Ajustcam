import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MediamtxProxyService } from '../src/camera-stream/mediamtx-proxy.service';

// ─────────────────────────────────────────────────────────────────────────────
// D1 (ingestão) — escolha de fonte do mediamtx-proxy.
// Helpers puros de troca de protocolo (Hik↔Dahua) + a decisão real de
// chooseLiveSource (recuperar main degradado escolhendo a MAIOR resolução),
// testada sobrescrevendo os seams de I/O (probeStreamVideoMetadata). Sem tocar
// produção, sem subir ffprobe.
// ─────────────────────────────────────────────────────────────────────────────

function makeProxy() {
  const config = { get: () => undefined } as any;
  const mgr = new MediamtxProxyService(config, {} as any, {} as any, {} as any) as any;
  mgr.logger = { error() {}, warn() {}, log() {}, debug() {} };
  return mgr;
}

// ── Helpers puros de troca de protocolo ──────────────────────────────────────

test('D1 alternateMainPath: Dahua↔Hikvision para o MAIN (subtype 0 → 01)', () => {
  const mgr = makeProxy();
  assert.equal(mgr.alternateMainPath('/cam/realmonitor?channel=1&subtype=0', 1), '/Streaming/Channels/101');
  assert.equal(mgr.alternateMainPath('/Streaming/Channels/101', 2), '/cam/realmonitor?channel=2&subtype=0');
  assert.equal(mgr.alternateMainPath('/algo/desconhecido', 1), null, 'path não reconhecido → sem alternativa');
});

test('D1 alternateSubPath: Dahua↔Hikvision para o SUB (subtype 1 → 02)', () => {
  const mgr = makeProxy();
  assert.equal(mgr.alternateSubPath('/Streaming/Channels/101', 1), '/cam/realmonitor?channel=1&subtype=1');
  assert.equal(mgr.alternateSubPath('/cam/realmonitor?channel=1&subtype=1', 3), '/Streaming/Channels/302');
  assert.equal(mgr.alternateSubPath('/nada', 1), null);
});

test('D1 streamPixels: área do stream, 0 quando ausente/ inválido', () => {
  const mgr = makeProxy();
  assert.equal(mgr.streamPixels({ width: 1920, height: 1080 }), 2073600);
  assert.equal(mgr.streamPixels(null), 0);
  assert.equal(mgr.streamPixels({ width: null, height: 720 }), 0);
});

// ── chooseLiveSource: recuperação de main degradado ──────────────────────────

const degradedCamera = () => ({
  username: 'admin', ip: '10.0.0.20', rtspPort: 554,
  rtspPath: '/Streaming/Channels/101',
  updatedAt: new Date('2026-07-24T00:00:00Z'),
  detectedWidth: 640, detectedHeight: 360, // < 720p → dispara a checagem de main alternativo
  streamWidth: null, streamHeight: null,
  detectedVideoCodec: 'h264',
});

test('D1 chooseLiveSource: main degradado → escolhe o path alternativo de MAIOR resolução', async () => {
  const mgr = makeProxy();
  mgr.probeStreamVideoMetadata = async (url: string) =>
    url.includes('realmonitor')
      ? { codec: 'h264', width: 1920, height: 1080 }
      : { codec: 'h264', width: 640, height: 360 };
  const result = await mgr.chooseLiveSource('cam-1', degradedCamera(), 'senha', 'tcp');
  assert.match(result.sourceUrl, /\/cam\/realmonitor\?channel=1&subtype=0$/, 'deve migrar para o main de 1080p');
  assert.equal(result.isHevc, false);
});

test('D1 chooseLiveSource: alternativo NÃO é melhor → mantém o principal', async () => {
  const mgr = makeProxy();
  mgr.probeStreamVideoMetadata = async (url: string) =>
    url.includes('realmonitor')
      ? { codec: 'h264', width: 640, height: 360 }
      : { codec: 'h264', width: 1920, height: 1080 };
  const result = await mgr.chooseLiveSource('cam-1', degradedCamera(), 'senha', 'tcp');
  assert.match(result.sourceUrl, /\/Streaming\/Channels\/101$/, 'não troca por uma fonte pior');
});

test('D1 chooseLiveSource: main já saudável NÃO sonda alternativa', async () => {
  const mgr = makeProxy();
  let probeCalls = 0;
  mgr.probeStreamVideoMetadata = async () => { probeCalls++; return null; };
  mgr.resolveLiveStreamIsHevc = async () => false; // evita ffprobe real do codec
  const healthy = { ...degradedCamera(), detectedWidth: 1920, detectedHeight: 1080 };
  const result = await mgr.chooseLiveSource('cam-1', healthy, 'senha', 'tcp');
  assert.equal(probeCalls, 0, 'main saudável não deve custear probes de alternativa');
  assert.match(result.sourceUrl, /\/Streaming\/Channels\/101$/);
});

// ── Autocura da GRADE: decisão cacheada morta é descartada e re-sondada ──────
//
// Caso real (Cam-03/09 do Grupo Flash): câmera OEM responde ao ffprobe no
// endpoint "alternativo" na hora da escolha, mas na sessão contínua do
// MediaMTX aceita o RTSP e nunca envia mídia. O path fica ready SEM faixas, o
// tile fica em 0 fps e, sem autocura, isso dura até o TTL do cache — que o
// operador lê como "a grade travou".

const gridCamera = () => ({
  username: 'admin', ip: '10.0.0.30', rtspPort: 554,
  rtspPath: '/Streaming/Channels/101',
  updatedAt: new Date('2026-07-29T00:00:00Z'),
  detectedVideoCodec: 'h264',
  streamWidth: null, streamHeight: null,
});

test('grade: gridPathLooksDead reconhece os DOIS estados de morte e nada mais', async () => {
  const mgr = makeProxy();
  mgr.isEnabled = () => true;
  const respostas = new Map<string, any>();
  mgr.apiRequest = async (_m: string, url: string) => {
    const r = respostas.get('atual');
    if (r === undefined) throw new Error('404');
    return JSON.stringify(r);
  };

  // ready sem NENHUMA faixa: câmera aceitou a sessão e não descreveu mídia.
  respostas.set('atual', { ready: true, tracks: [], readers: [], bytesReceived: 12345 });
  assert.equal(await mgr.gridPathLooksDead('cam-1'), true);

  // leitor esperando, fonte nunca pronta, zero bytes: demanda sem entrega.
  respostas.set('atual', { ready: false, tracks: [], readers: [{ type: 'webrtc' }], bytesReceived: 0 });
  assert.equal(await mgr.gridPathLooksDead('cam-1'), true);

  // saudável (ready com faixa) NÃO é morte.
  respostas.set('atual', { ready: true, tracks: ['H265'], readers: [], bytesReceived: 999 });
  assert.equal(await mgr.gridPathLooksDead('cam-1'), false);

  // cold start on-demand (path nem existe / 404) NÃO é morte.
  respostas.delete('atual');
  assert.equal(await mgr.gridPathLooksDead('cam-1'), false);

  // fonte não pronta mas SEM leitor: ninguém pediu ainda, não mexe.
  respostas.set('atual', { ready: false, tracks: [], readers: [], bytesReceived: 0 });
  assert.equal(await mgr.gridPathLooksDead('cam-1'), false);
});

test('grade: decisão cacheada MORTA é re-sondada; saudável continua cacheada', async () => {
  const mgr = makeProxy();
  mgr.isEnabled = () => true;
  let probes = 0;
  mgr.probeStreamVideoMetadata = async () => { probes++; return { codec: 'h265', width: 640, height: 360, hasDataTrack: false }; };

  // 1ª chamada: sem cache → sonda e decide (1 probe: sub H.265, sem alternativa H.264 → 2º probe do alternativo).
  mgr.gridPathLooksDead = async () => false;
  await mgr.chooseGridSource('cam-9', gridCamera(), 'senha', 'tcp');
  const probesDaDecisao = probes;
  assert.ok(probesDaDecisao >= 1);

  // 2ª chamada com path SAUDÁVEL: cache responde, zero probe novo.
  await mgr.chooseGridSource('cam-9', gridCamera(), 'senha', 'tcp');
  assert.equal(probes, probesDaDecisao, 'decisão saudável não paga novo probe');

  // 3ª chamada com path MORTO: cache é descartado e re-sondado.
  mgr.gridPathLooksDead = async () => true;
  await mgr.chooseGridSource('cam-9', gridCamera(), 'senha', 'tcp');
  assert.ok(probes > probesDaDecisao, 'decisão morta TEM que ser re-sondada');

  // 4ª chamada logo em seguida, ainda "morto": o COOLDOWN segura a enxurrada —
  // sem ele, cada request da grade custaria probes contra uma câmera doente.
  const probesAposCura = probes;
  await mgr.chooseGridSource('cam-9', gridCamera(), 'senha', 'tcp');
  assert.equal(probes, probesAposCura, 'cooldown de 60s impede re-probe em rajada');
});
