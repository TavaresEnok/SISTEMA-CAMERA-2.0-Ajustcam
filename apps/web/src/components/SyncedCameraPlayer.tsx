import { useCallback, useEffect, useRef, useState } from 'react';
import {
  absoluteToVodPosition,
  normalizeVodPlaylist,
  refreshSegmentUrl,
  segmentTokens,
  type VodPlaylist,
} from '../lib/vod-continuous';
import {
  decideSyncAction,
  followerStatusLabel,
  needsSourceChange,
  resolveFollowerTarget,
  shouldApplyRate,
  SYNC_CHECK_INTERVAL_MS,
} from '../lib/playback-sync';

// ─────────────────────────────────────────────────────────────────────────────
// UM PLAYER DE CÂMERA ANCORADO EM TEMPO ABSOLUTO.
//
// Existe para a revisão multi-câmera: seguir uma pessoa entre ambientes exige
// ver N câmeras no MESMO instante de parede. Cada câmera tem o seu acervo, com
// fronteiras de arquivo e buracos próprios, então "instante X" vira arquivo +
// offset diferente em cada uma — a tradução vive em `resolveFollowerTarget`.
//
// POR QUE NÃO REUSAR O MOTOR DA PÁGINA DE PLAYBACK: aquele caminho é de câmera
// única e carrega estado global de player único (`videoRef`,
// `pendingSeekSeconds`, `autoResumeRef`) mais um `vodFallback` STICKY que, ao
// ser acionado, derruba a continuidade da página inteira. Reaproveitá-lo para N
// câmeras cruzaria os seeks e faria uma câmera ruim desligar as outras. Aqui o
// player é simples de propósito: um `<video>`, sem pré-aquecimento de próximo
// segmento, sem fallback global — o custo é uma troca de arquivo visível na
// virada de segmento, aceitável numa tela de comparação.
//
// A LÓGICA QUE PODE ERRAR EM SILÊNCIO NÃO MORA AQUI. Tradução de instante,
// decisão de corrigir e rótulo de "sem imagem" vivem em `lib/playback-sync.ts`
// e `lib/vod-continuous.ts`, ambos puros e testados. Este componente é a cola
// que executa a decisão no elemento.
// ─────────────────────────────────────────────────────────────────────────────

type Props = {
  cameraId: string;
  cameraName: string;
  /** Instante de parede que o mestre está exibindo. Null = sem posição. */
  targetAbsoluteMs: number | null;
  masterPaused: boolean;
  /** Velocidade escolhida pelo operador; a correção MULTIPLICA este valor. */
  userSpeed: number;
  /** Busca a playlist do dia desta câmera (a página injeta o cliente HTTP). */
  fetchPlaylist: (cameraId: string) => Promise<unknown>;
  /** Prefixo da API para montar a URL do segmento. */
  apiUrl: string;
  /** Navegador decodifica HEVC? Repete a regra do caminho de câmera única. */
  forceDirect: boolean;
};

export function SyncedCameraPlayer({
  cameraId,
  cameraName,
  targetAbsoluteMs,
  masterPaused,
  userSpeed,
  fetchPlaylist,
  apiUrl,
  forceDirect,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playlistRef = useRef<VodPlaylist | null>(null);
  const tokensRef = useRef<Record<string, string>>({});
  const loadedRecordingIdRef = useRef<string | null>(null);
  const lastSeekAtRef = useRef<number | null>(null);
  const [statusLabel, setStatusLabel] = useState<string | null>('Carregando...');
  // Renova a playlist (e com ela os tokens de segmento) antes de o TTL de ~5
  // minutos vencer. A página principal renova a cada 15s; o seguidor buscava
  // UMA vez e, numa comparação mais longa que o TTL, a virada de segmento
  // usava token morto → 401 silencioso → célula preta com cara de "sem cena".
  const [playlistNonce, setPlaylistNonce] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setPlaylistNonce((n) => n + 1), 4 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Playlist do dia desta câmera. Falha é SILENCIOSA e vira rótulo na célula:
  // uma câmera sem gravação no dia não pode virar tela de erro no meio de uma
  // investigação das outras.
  useEffect(() => {
    let cancelled = false;
    const renovacao = playlistNonce > 0 && playlistRef.current !== null;
    if (!renovacao) {
      playlistRef.current = null;
      tokensRef.current = {};
      loadedRecordingIdRef.current = null;
      setStatusLabel('Carregando...');
    }

    void (async () => {
      try {
        const raw = await fetchPlaylist(cameraId);
        if (cancelled) return;
        const playlist = normalizeVodPlaylist(raw, Date.now());
        playlistRef.current = playlist;
        tokensRef.current = segmentTokens(playlist);
        if (!renovacao) setStatusLabel(playlist ? null : 'Sem gravação neste dia');
      } catch {
        // Renovação que falhou não derruba o que está tocando: os tokens
        // antigos podem ainda valer, e a próxima renovação tenta de novo.
        if (!cancelled && !renovacao) setStatusLabel('Sem gravação neste dia');
      }
    })();

    return () => { cancelled = true; };
  }, [cameraId, fetchPlaylist, playlistNonce]);

  const segmentUrl = useCallback((playUrl: string) => {
    const path = refreshSegmentUrl(playUrl, tokensRef.current);
    const suffix = forceDirect ? `${path.includes('?') ? '&' : '?'}forceDirect=1` : '';
    return `${apiUrl}${path}${suffix}`;
  }, [apiUrl, forceDirect]);

  // Laço de sincronia. Cadência curta (~100ms) porque a correção fina só é
  // imperceptível se for aplicada cedo; esperar 1s deixaria a deriva crescer até
  // a faixa do salto seco, que é justamente o que se quer evitar.
  useEffect(() => {
    const interval = window.setInterval(() => {
      const video = videoRef.current;
      const playlist = playlistRef.current;
      if (!video) return;

      const position = targetAbsoluteMs === null
        ? null
        : absoluteToVodPosition(playlist, targetAbsoluteMs);
      const target = resolveFollowerTarget(playlist, position);

      if (target.status !== 'ready') {
        setStatusLabel(followerStatusLabel(target));
        // Congela em vez de buscar o segmento vizinho: exibir OUTRO instante com
        // cara de sincronizado faria o operador concluir errado sobre a cena.
        if (!video.paused) video.pause();
        return;
      }
      setStatusLabel(null);

      if (needsSourceChange(loadedRecordingIdRef.current, target)) {
        const segment = playlist?.segments[target.segmentIndex];
        if (segment) {
          loadedRecordingIdRef.current = target.recordingId;
          video.src = segmentUrl(segment.playUrl);
          video.currentTime = target.offsetInSegmentSeconds;
          lastSeekAtRef.current = Date.now();
          if (!masterPaused) void video.play().catch(() => undefined);
        }
        return;
      }

      const followerAbsoluteMs = Number.isFinite(video.currentTime)
        ? targetAbsoluteMs !== null
          ? targetAbsoluteMs - (target.offsetInSegmentSeconds - video.currentTime) * 1000
          : null
        : null;

      const action = decideSyncAction({
        masterAbsoluteMs: targetAbsoluteMs,
        masterPaused,
        userSpeed,
        nowMs: Date.now(),
        follower: {
          absoluteMs: followerAbsoluteMs,
          readyState: video.readyState,
          paused: video.paused,
          placement: 'inside',
          offsetInSegmentSeconds: target.offsetInSegmentSeconds,
          segmentLoaded: true,
          lastSeekAtMs: lastSeekAtRef.current,
        },
      });

      switch (action.kind) {
        case 'rate':
          if (shouldApplyRate(video.playbackRate, action.playbackRate)) {
            video.playbackRate = action.playbackRate;
          }
          break;
        case 'seek':
          video.currentTime = action.toSeconds;
          lastSeekAtRef.current = Date.now();
          break;
        case 'pause':
          if (!video.paused) video.pause();
          break;
        case 'reselect-segment':
          loadedRecordingIdRef.current = null;
          break;
        default:
          break;
      }

      // Play/pause acompanha o mestre: o operador controla um transporte só.
      if (masterPaused && !video.paused) video.pause();
      if (!masterPaused && video.paused && video.readyState >= 2) {
        void video.play().catch(() => undefined);
      }
    }, SYNC_CHECK_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [targetAbsoluteMs, masterPaused, userSpeed, segmentUrl]);

  return (
    <div className="relative overflow-hidden rounded bg-black">
      <video
        ref={videoRef}
        className="h-full w-full object-contain"
        muted
        playsInline
        preload="auto"
        crossOrigin="use-credentials"
        // Sem isto, um 401/404 no src virava retângulo preto SEM AVISO — numa
        // tela feita para "seguir a pessoa entre ambientes", célula congelada
        // com cara de câmera sem cena induz conclusão errada. Zerar o
        // loadedRecordingId faz o laço de sync recarregar o segmento com o
        // token renovado no próximo tick.
        onError={() => {
          loadedRecordingIdRef.current = null;
          setStatusLabel('Falha no vídeo — recarregando…');
        }}
      />
      {statusLabel && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70 px-2 text-center text-[10px] text-[hsl(var(--muted-foreground))]">
          {statusLabel}
        </div>
      )}
      <div className="pointer-events-none absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
        {cameraName}
      </div>
    </div>
  );
}
