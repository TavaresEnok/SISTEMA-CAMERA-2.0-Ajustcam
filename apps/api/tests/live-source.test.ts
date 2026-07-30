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

test('grade: sub 2 em H.264 é encontrado quando sub 1 é H.265 (a busca não para no primeiro)', async () => {
  // Caso do operador que configurou "o segundo stream em H.264 para o live":
  // em muitas câmeras isso mora no ÍNDICE 2 (Dahua subtype=2 / Hik canal N03),
  // e o sub 1 segue H.265 de fábrica. A busca parava no sub 1 e condenava a
  // câmera a transcode para sempre com o stream certo parado do lado.
  const mgr = makeProxy();
  mgr.isEnabled = () => true;
  mgr.gridPathLooksDead = async () => false;
  const sondados: string[] = [];
  mgr.probeStreamVideoMetadata = async (url: string) => {
    sondados.push(url);
    if (url.includes('subtype=2')) return { codec: 'h264', width: 640, height: 360, hasDataTrack: false };
    return { codec: 'h265', width: 640, height: 360, hasDataTrack: false };
  };
  const r = await mgr.chooseGridSource('cam-sub2', gridCamera(), 'senha', 'tcp');
  assert.match(r.sourceUrl, /subtype=2/, 'o H.264 do sub 2 tem que vencer o H.265 do sub 1');
  assert.equal(r.isHevc, false, 'passthrough, sem transcode');
});

test('grade: câmera com sub 1 já em H.264 continua custando UM probe (escada preservada)', async () => {
  const mgr = makeProxy();
  mgr.isEnabled = () => true;
  mgr.gridPathLooksDead = async () => false;
  let probes = 0;
  mgr.probeStreamVideoMetadata = async () => {
    probes++;
    return { codec: 'h264', width: 704, height: 480, hasDataTrack: false };
  };
  await mgr.chooseGridSource('cam-h264', gridCamera(), 'senha', 'tcp');
  assert.equal(probes, 1, 'sub 1 H.264 encontrado → nenhum degrau extra é sondado');
});

test('grade: /media/videoN (streams reais das OEM) está na escada de busca', async () => {
  // Descoberto em produção via ONVIF GetProfiles: a câmera declara
  // "perfil 2: H264 640x360 -> /media/video2", endpoint que NENHUM degrau
  // antigo sondava. O operador tinha configurado exatamente esse stream para
  // o live e a busca não o encontrava — transcode eterno com o H.264 do lado.
  const mgr = makeProxy();
  mgr.isEnabled = () => true;
  mgr.gridPathLooksDead = async () => false;
  mgr.probeStreamVideoMetadata = async (url: string) => {
    if (url.includes('/media/video2')) return { codec: 'h264', width: 640, height: 360, hasDataTrack: false };
    return { codec: 'h265', width: 640, height: 360, hasDataTrack: false };
  };
  const r = await mgr.chooseGridSource('cam-media', gridCamera(), 'senha', 'tcp');
  assert.match(r.sourceUrl, /\/media\/video2/, 'o H.264 real da câmera tem que ser encontrado');
  assert.equal(r.isHevc, false);
});

// ── A CHAVE DE CACHE NÃO PODE DEPENDER DE `updatedAt` ────────────────────────
//
// O health check reescreve a linha da câmera a cada ciclo (rotação de ~10s por
// câmera na frota real). Com `updatedAt` na chave, os três caches de fonte
// viravam LIXO: toda abertura de tile re-pagava a escada de ffprobes (até 5
// sondas de 8s). Era a causa que sobreviveu a todas as outras correções do
// "primeiro acesso demora 30s" — o cache de 30min nunca vivia 10 segundos.

test('cache da grade SOBREVIVE a mudança de updatedAt (health check)', async () => {
  const mgr = makeProxy();
  mgr.isEnabled = () => true;
  mgr.gridPathLooksDead = async () => false;
  let probes = 0;
  mgr.probeStreamVideoMetadata = async () => {
    probes++;
    return { codec: 'h264', width: 640, height: 360, hasDataTrack: false };
  };

  const cam1 = { ...gridCamera(), updatedAt: new Date('2026-07-30T00:00:00Z') };
  await mgr.chooseGridSource('cam-1', cam1, 'senha', 'tcp');
  const depoisDaPrimeira = probes;
  assert.ok(depoisDaPrimeira > 0);

  // Health check tocou a linha: MESMA câmera, MESMA configuração, updatedAt novo.
  const cam2 = { ...gridCamera(), updatedAt: new Date('2026-07-30T00:00:10Z') };
  await mgr.chooseGridSource('cam-1', cam2, 'senha', 'tcp');
  assert.equal(probes, depoisDaPrimeira, 'updatedAt novo NÃO pode custar re-sondagem');
});

test('cache da grade É invalidado quando a configuração REALMENTE muda', async () => {
  // O contraste que dá sentido ao teste acima: se nada invalidasse, uma câmera
  // reconfigurada continuaria usando a URL velha para sempre.
  const mgr = makeProxy();
  mgr.isEnabled = () => true;
  mgr.gridPathLooksDead = async () => false;
  let probes = 0;
  mgr.probeStreamVideoMetadata = async () => {
    probes++;
    return { codec: 'h264', width: 640, height: 360, hasDataTrack: false };
  };

  await mgr.chooseGridSource('cam-1', gridCamera(), 'senha', 'tcp');
  const base = probes;

  await mgr.chooseGridSource('cam-1', { ...gridCamera(), ip: '10.0.0.99' }, 'senha', 'tcp');
  assert.ok(probes > base, 'IP novo tem que re-sondar');

  const base2 = probes;
  await mgr.chooseGridSource('cam-1', { ...gridCamera(), rtspPath: '/outro/caminho' }, 'senha', 'tcp');
  assert.ok(probes > base2, 'caminho novo tem que re-sondar');
});
