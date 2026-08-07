import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Image,
  type ImageStyle,
  PanResponder,
  Pressable,
  StyleSheet,
  type StyleProp,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { ehPreparoEmAndamento, esperaAteRetentar } from '../utils/playback-source';
import { useVideoPlayer, VideoView, type VideoSource } from 'expo-video';
import { WebRtcVideo } from './WebRtcVideo';
import { Icon } from './Icon';
import { useTheme } from '../theme/ThemeProvider';

export type LiveStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'offline';

// Janela de tolerância para o PRIMEIRO frame. O path da câmera no MediaMTX pode
// estar em cold start (runOnDemand reabrindo o FFmpeg após 5 min sem espectador):
// reconectar antes disso só reinicia o relógio do arranque. 20s cobre o cold start
// sem deixar uma câmera realmente offline "pendurada" para sempre.
const FIRST_FRAME_GRACE_MS = 20_000;
// Tempo SEM o relógio de live avançar (congelamento real) antes de reconectar.
const STALL_RECONNECT_MS = 9_000;
const WATCHDOG_INTERVAL_MS = 3_000;
const RECONNECT_BASE_MS = 1_500;
const RECONNECT_MAX_MS = 8_000;

type LiveVideoProps = {
  uri: string | null;
  whepUri?: string | null;
  posterUri?: string | null;
  videoStyle: StyleProp<ViewStyle>;
  emptyStyle: StyleProp<ViewStyle>;
  posterStyle: StyleProp<ImageStyle>;
  emptyTitleStyle: StyleProp<TextStyle>;
  emptyTextStyle: StyleProp<TextStyle>;
  onStatusChange?: (status: LiveStatus) => void;
  muted?: boolean;
  contentFit?: 'contain' | 'cover';
  /** Só no caminho WebRTC: informa se o stream tem faixa de áudio. */
  onAudioAvailable?: (available: boolean) => void;
  /** Solicita ao pai URLs/tokens novos antes de uma reconexão. */
  onNeedRefresh?: () => void;
};

/**
 * Player ao vivo: tenta WebRTC (WHEP, baixa latência) primeiro e, se não conectar,
 * cai automaticamente para HLS — mesma estratégia do web. A falha do WebRTC marca
 * `webrtcFailed` e re-renderiza no caminho HLS (reseta ao trocar de câmera).
 */
export function LiveVideo(props: LiveVideoProps) {
  const { whepUri } = props;
  const [webrtcFailed, setWebrtcFailed] = useState(false);
  let whepIdentity = whepUri;
  try {
    if (whepUri) {
      const parsed = new URL(whepUri);
      parsed.search = '';
      parsed.hash = '';
      whepIdentity = parsed.toString();
    }
  } catch { /* mantém a string original */ }

  useEffect(() => {
    setWebrtcFailed(false);
  // Renovar apenas o token/query não deve reiniciar um WHEP que já falhou; isso
  // criaria um loop WHEP→token novo→WHEP e impediria o HLS de permanecer ativo.
  // Uma câmera/path realmente diferente ainda ganha uma nova tentativa WebRTC.
  }, [whepIdentity]);

  if (whepUri && !webrtcFailed) {
    return (
      <WebRtcVideo
        whepUrl={whepUri}
        posterUri={props.posterUri}
        videoStyle={props.videoStyle}
        posterStyle={props.posterStyle}
        emptyTextStyle={props.emptyTextStyle}
        onStatusChange={props.onStatusChange}
        muted={props.muted}
        contentFit={props.contentFit}
        onAudioAvailable={props.onAudioAvailable}
        onNeedRefresh={props.onNeedRefresh}
        onFailover={() => setWebrtcFailed(true)}
      />
    );
  }

  return <HlsLiveVideo {...props} />;
}

function HlsLiveVideo({
  uri,
  posterUri,
  videoStyle,
  emptyStyle,
  posterStyle,
  emptyTitleStyle,
  emptyTextStyle,
  onStatusChange,
  muted = false,
  contentFit = 'contain',
  onNeedRefresh,
}: LiveVideoProps) {
  // Player criado uma única vez. A troca de câmera/reconexão usa player.replace(),
  // sem recriar a instância — recriar a cada render causaria piscar e vazamento.
  const player = useVideoPlayer(null, (instance) => {
    // loop=false: stream AO VIVO não deve reproduzir em laço (o código antigo usava
    // loop=true, o que reapresentava segmentos antigos e atrapalhava o "ao vivo").
    instance.loop = false;
    instance.muted = false;
    instance.timeUpdateEventInterval = 1;
  });

  const [status, setStatus] = useState<LiveStatus>('idle');
  const statusRef = useRef<LiveStatus>('idle');
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  const onNeedRefreshRef = useRef(onNeedRefresh);
  onNeedRefreshRef.current = onNeedRefresh;

  const applyStatus = useCallback((next: LiveStatus) => {
    if (statusRef.current === next) return;
    statusRef.current = next;
    setStatus(next);
    onStatusChangeRef.current?.(next);
  }, []);

  // Mudo/áudio sob demanda (botão "Áudio" do ao vivo).
  useEffect(() => {
    try {
      player.muted = muted;
    } catch {
      // ignore
    }
  }, [muted, player]);

  useEffect(() => {
    if (!uri) {
      applyStatus('offline');
      try {
        player.pause();
        player.replace(null);
      } catch {
        // ignore
      }
      return;
    }

    let cancelled = false;
    let attempt = 0;
    let startedAt = Date.now();
    let lastProgressAt = Date.now();
    let lastTime = 0;
    let lastLive = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let appActive = AppState.currentState === 'active';

    const buildSource = (): VideoSource => {
      const sep = uri.includes('?') ? '&' : '?';
      // Cache-buster por tentativa: garante que o player puxe o manifesto fresco em
      // vez de reusar segmentos velhos de uma sessão que congelou.
      return { uri: `${uri}${sep}_r=${attempt}` } as VideoSource;
    };

    const load = () => {
      if (cancelled || !appActive) return;
      startedAt = Date.now();
      lastProgressAt = Date.now();
      lastTime = 0;
      lastLive = 0;
      try {
        player.replace(buildSource());
        player.play();
      } catch {
        // ignore
      }
    };

    const reconnect = () => {
      if (cancelled || !appActive || reconnectTimer) return;
      applyStatus('reconnecting');
      onNeedRefreshRef.current?.();
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.max(1, 2 ** attempt));
      attempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        load();
      }, delay);
    };

    const markProgress = (t: number, live: number) => {
      const advancedTime = Number.isFinite(t) && t > lastTime + 0.05;
      const advancedLive = Number.isFinite(live) && live > lastLive + 0.05;
      if (advancedTime) lastTime = t;
      if (advancedLive) lastLive = live;
      if (advancedTime || advancedLive) {
        lastProgressAt = Date.now();
        attempt = 0;
        applyStatus('live');
      }
    };

    applyStatus('connecting');
    load();

    const statusSub = player.addListener('statusChange', (payload: { status?: string }) => {
      if (cancelled || !appActive) return;
      const s = payload?.status;
      if (s === 'readyToPlay') {
        // Reproduzindo: marca ao vivo já (badge imediato). O watchdog abaixo ainda
        // detecta e reconecta se a imagem congelar de fato depois disso.
        attempt = 0;
        lastProgressAt = Date.now();
        applyStatus('live');
        try {
          if (!player.playing) player.play();
        } catch {
          // ignore
        }
      } else if (s === 'error') {
        reconnect();
      } else if (s === 'loading' && statusRef.current !== 'live') {
        applyStatus(statusRef.current === 'reconnecting' ? 'reconnecting' : 'connecting');
      }
    });

    const timeSub = player.addListener(
      'timeUpdate',
      (payload: { currentTime?: number; currentLiveTimestamp?: number | null }) => {
        if (cancelled || !appActive) return;
        const t = typeof payload?.currentTime === 'number' ? payload.currentTime : player.currentTime;
        const live = typeof payload?.currentLiveTimestamp === 'number' ? payload.currentLiveTimestamp : 0;
        markProgress(t, live);
      },
    );

    const watchdog = setInterval(() => {
      if (cancelled || !appActive) return;
      const now = Date.now();
      if (player.status === 'error') {
        reconnect();
        return;
      }
      // Ainda sem nenhum frame: trata como cold start e só reconecta após a janela
      // de tolerância (deixa o FFmpeg do path esquentar antes de desistir).
      if (lastTime <= 0 && lastLive <= 0) {
        if (now - startedAt > FIRST_FRAME_GRACE_MS) reconnect();
        return;
      }
      // Já estava progredindo e congelou.
      if (now - lastProgressAt > STALL_RECONNECT_MS) reconnect();
    }, WATCHDOG_INTERVAL_MS);

    // Background/foreground: pausa quando sai do app (economiza CPU/banda) e, ao
    // voltar, retoma — reconectando se a sessão tiver expirado/congelado enquanto fora.
    const appSub = AppState.addEventListener('change', (next) => {
      if (cancelled) return;
      if (next === 'active') {
        appActive = true;
        onNeedRefreshRef.current?.();
        load();
      } else {
        appActive = false;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        try {
          player.pause();
        } catch {
          // ignore
        }
      }
    });

    return () => {
      cancelled = true;
      statusSub.remove();
      timeSub.remove();
      appSub.remove();
      clearInterval(watchdog);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        player.pause();
      } catch {
        // ignore
      }
    };
  }, [uri, player, applyStatus]);

  const showPoster = status !== 'live' && Boolean(posterUri);
  const showSpinner = status === 'connecting' || status === 'reconnecting';

  return (
    <View style={[videoStyle, local.container]}>
      {uri ? (
        <VideoView player={player} style={StyleSheet.absoluteFill} nativeControls={false} contentFit={contentFit} />
      ) : null}

      {showPoster ? (
        <Image source={{ uri: posterUri ?? undefined }} style={[StyleSheet.absoluteFill, posterStyle]} />
      ) : null}

      {showSpinner ? (
        <View style={[StyleSheet.absoluteFill, local.overlay]}>
          <ActivityIndicator color="#ffffff" />
          <Text style={[emptyTextStyle, local.overlayText]}>
            {status === 'reconnecting' ? 'Reconectando…' : 'Conectando…'}
          </Text>
        </View>
      ) : null}

      {status === 'offline' ? (
        <View style={[StyleSheet.absoluteFill, emptyStyle, local.overlay]}>
          <Text style={emptyTitleStyle}>Transmissão indisponível</Text>
          <Text style={emptyTextStyle}>
            A câmera pode estar offline, sem permissão ou sem resposta do servidor.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const PLAYBACK_RATES = [1, 1.5, 2, 0.5];

/**
 * Player de reprodução com controles PRÓPRIOS (não usa os nativos do sistema):
 * play/pause central, avançar/retroceder 10s, barra de progresso arrastável
 * (scrubbing), velocidade e tempo. Toque mostra/esconde; auto-esconde tocando.
 */
export function PlaybackVideo({ uri, posterUri, style, onRetry, initialPositionSeconds, onNaoDecodificou, onProgresso }: {
  uri: string;
  posterUri?: string | null;
  style: StyleProp<ViewStyle>;
  onRetry?: () => void;
  /** Seek inicial (s) aplicado assim que a gravação fica pronta — usado pela
   *  Revisão para abrir o vídeo NO INSTANTE do evento (recordingId+offset). */
  initialPositionSeconds?: number | null;
  /** O player não conseguiu decodificar o arquivo original: o dono pode pedir
   *  a versão compatível (transcodada). Devolve true se houve degrau. */
  onNaoDecodificou?: () => boolean;
  /** Posição corrente, para o dono retomar o ponto ao trocar a URL (renovação
   *  de token ou degrau de codec). */
  onProgresso?: (segundos: number) => void;
}) {
  const { theme } = useTheme();
  const player = useVideoPlayer(null, (instance) => {
    instance.loop = false;
    instance.timeUpdateEventInterval = 0.25;
    instance.play();
  });

  const [playing, setPlaying] = useState(true);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffering, setBuffering] = useState(true);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [rate, setRate] = useState(1);
  const [playbackError, setPlaybackError] = useState(false);
  const [barWidth, setBarWidth] = useState(1);
  const [scrubPos, setScrubPos] = useState(0);

  const scrubbingRef = useRef(false);
  const barWidthRef = useRef(1);
  const durationRef = useRef(0);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resumeAfterForegroundRef = useRef(false);
  // Seek pendente do "abrir no instante": aplicado uma única vez quando a
  // gravação fica pronta (o currentTime só "pega" depois do readyToPlay).
  const pendingSeekRef = useRef<number | null>(null);
  // ── 503 "PREPARANDO" NÃO É FALHA ────────────────────────────────────────
  // Quando a versão compatível ainda não está em cache, o servidor responde
  // 503 { preparing: true } com Retry-After e transcodifica em segundo plano.
  // O player mostrava "Não foi possível reproduzir" e deixava o usuário
  // tocando "Tentar novamente" às cegas por até 5 minutos.
  const [preparando, setPreparando] = useState(false);
  const tentativaDePreparoRef = useRef(0);
  const timerDePreparoRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const degrauTentadoRef = useRef(false);
  // Watchdog de buffering: diferente do live, a reprodução não tinha timeout —
  // conexão que morria no meio virava spinner infinito, sem saída.
  const bufferingDesdeRef = useRef<number | null>(null);

  // ── POR QUE O VÍDEO NÃO ABRIU ───────────────────────────────────────────
  //
  // O player só informa "error", sem status nem corpo. Uma sonda HTTP leve
  // (Range de 1 byte) distingue os três casos que exigem reações OPOSTAS:
  //
  //   503 preparing → o transcode está rodando: esperar e tentar sozinho;
  //   401/403       → token venceu: o dono reemite (retry devolve token novo);
  //   qualquer outro (ou decodificação) → degrau para a versão compatível.
  const diagnosticarFalha = useCallback(async () => {
    if (uri.startsWith('file:')) { setPlaybackError(true); return; }
    let status: number | null = null;
    let retryAfter: string | null = null;
    try {
      const resposta = await fetch(uri, { method: 'GET', headers: { Range: 'bytes=0-0' } });
      status = resposta.status;
      retryAfter = resposta.headers.get('Retry-After');
    } catch {
      status = null; // rede: trata como erro comum
    }

    if (ehPreparoEmAndamento(status)) {
      // Nada quebrou: o servidor está transcodificando. Avisa e reagenda.
      setPlaybackError(false);
      setPreparando(true);
      const tentativa = tentativaDePreparoRef.current++;
      // Teto de tentativas: o transcode leva até ~5 min; passando disso, algo
      // está errado de verdade e insistir só esconde o problema.
      if (tentativa > 40) { setPreparando(false); setPlaybackError(true); return; }
      const espera = esperaAteRetentar(retryAfter, tentativa) * 1000;
      if (timerDePreparoRef.current) clearTimeout(timerDePreparoRef.current);
      timerDePreparoRef.current = setTimeout(() => {
        try { player.replace({ uri }); player.play(); } catch { /* ignore */ }
      }, espera);
      return;
    }

    // Não é preparo: talvez o aparelho não decodifique este arquivo. UMA
    // tentativa de degrau (o dono decide se existe fonte compatível).
    if (!degrauTentadoRef.current && onNaoDecodificou) {
      degrauTentadoRef.current = true;
      if (onNaoDecodificou()) { setPreparando(true); return; }
    }
    setPreparando(false);
    setPlaybackError(true);
  }, [uri, player, onNaoDecodificou]);

  // Watchdog: buffering que não sai do lugar vira erro com saída, em vez de
  // spinner eterno (o live já tinha isto; a reprodução não).
  useEffect(() => {
    const timer = setInterval(() => {
      if (!bufferingDesdeRef.current || playbackError || preparando) return;
      if (Date.now() - bufferingDesdeRef.current > 25_000) {
        bufferingDesdeRef.current = null;
        void diagnosticarFalha();
      }
    }, 5_000);
    return () => clearInterval(timer);
  }, [diagnosticarFalha, playbackError, preparando]);

  useEffect(() => () => { if (timerDePreparoRef.current) clearTimeout(timerDePreparoRef.current); }, []);

  // Troca de gravação: a tela reusa este componente, então ao mudar a uri
  // recarregamos a fonte (sem recriar o player) e resetamos o estado.
  useEffect(() => {
    try {
      setBuffering(true);
      setPosition(0);
      setDuration(0);
      durationRef.current = 0;
      setPlaying(true);
      setRate(1);
      setPlaybackError(false);
      // Nova gravação → arma (ou limpa) o seek inicial para esta uri.
      pendingSeekRef.current = typeof initialPositionSeconds === 'number' && initialPositionSeconds > 0 ? initialPositionSeconds : null;
      setPreparando(false);
      tentativaDePreparoRef.current = 0;
      degrauTentadoRef.current = false;
      bufferingDesdeRef.current = Date.now();
      if (timerDePreparoRef.current) { clearTimeout(timerDePreparoRef.current); timerDePreparoRef.current = null; }
      player.replace({ uri });
      player.playbackRate = 1;
      player.play();
    } catch {
      // ignore
    }
  }, [uri, player, initialPositionSeconds]);

  useEffect(() => {
    const timeSub = player.addListener('timeUpdate', (p: { currentTime?: number }) => {
      if (scrubbingRef.current) return;
      const cur = typeof p?.currentTime === 'number' ? p.currentTime : player.currentTime;
      if (Number.isFinite(cur)) { setPosition(cur); onProgresso?.(cur); }
      bufferingDesdeRef.current = null;
      const d = player.duration;
      if (Number.isFinite(d) && d > 0) { durationRef.current = d; setDuration(d); }
    });
    const statusSub = player.addListener('statusChange', (p: { status?: string }) => {
      const carregando = p?.status === 'loading';
      setBuffering(carregando);
      if (carregando && bufferingDesdeRef.current == null) bufferingDesdeRef.current = Date.now();
      if (!carregando) bufferingDesdeRef.current = null;
      if (p?.status === 'error') void diagnosticarFalha();
      if (p?.status === 'readyToPlay') {
        setPlaybackError(false);
        const d = player.duration;
        if (Number.isFinite(d) && d > 0) { durationRef.current = d; setDuration(d); }
        // Abrir no instante: aplica o seek pendente uma única vez, limitado à
        // duração conhecida (evita seek além do fim da gravação).
        if (pendingSeekRef.current != null) {
          const target = d > 0 ? Math.min(pendingSeekRef.current, Math.max(0, d - 0.5)) : pendingSeekRef.current;
          pendingSeekRef.current = null;
          try { player.currentTime = target; setPosition(target); } catch { /* ignore */ }
        }
      }
    });
    const playSub = player.addListener('playingChange', (p: { isPlaying?: boolean }) => {
      setPlaying(typeof p?.isPlaying === 'boolean' ? p.isPlaying : player.playing);
    });
    return () => { timeSub.remove(); statusSub.remove(); playSub.remove(); };
  }, [player]);

  // Evita decodificação/banda em segundo plano. Só retoma automaticamente se o
  // vídeo estava tocando quando o app perdeu o foco.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      try {
        if (next === 'active') {
          if (resumeAfterForegroundRef.current) player.play();
          resumeAfterForegroundRef.current = false;
        } else {
          resumeAfterForegroundRef.current = player.playing;
          player.pause();
        }
      } catch { /* player pode estar sendo desmontado */ }
    });
    return () => sub.remove();
  }, [player]);

  const scheduleHide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControlsVisible(false), 3800);
  }, []);
  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (player.playing) scheduleHide();
  }, [player, scheduleHide]);

  useEffect(() => {
    if (controlsVisible && playing) scheduleHide();
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current); };
  }, [controlsVisible, playing, scheduleHide]);

  const togglePlay = useCallback(() => {
    try { if (player.playing) player.pause(); else player.play(); } catch { /* ignore */ }
    showControls();
  }, [player, showControls]);

  const seekBy = useCallback((delta: number) => {
    try {
      const d = durationRef.current || player.duration || 0;
      const next = Math.max(0, Math.min(d > 0 ? d : Number.MAX_SAFE_INTEGER, (player.currentTime || 0) + delta));
      player.currentTime = next;
      setPosition(next);
    } catch { /* ignore */ }
    showControls();
  }, [player, showControls]);

  const cycleRate = useCallback(() => {
    setRate((r) => {
      const next = PLAYBACK_RATES[(PLAYBACK_RATES.indexOf(r) + 1) % PLAYBACK_RATES.length];
      try { player.playbackRate = next; } catch { /* ignore */ }
      return next;
    });
    showControls();
  }, [player, showControls]);

  const posFromX = useCallback((x: number) => {
    const w = barWidthRef.current || 1;
    const ratio = Math.max(0, Math.min(1, x / w));
    return ratio * (durationRef.current || 0);
  }, []);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        scrubbingRef.current = true;
        if (hideTimer.current) clearTimeout(hideTimer.current);
        setControlsVisible(true);
        setScrubPos(posFromX(e.nativeEvent.locationX));
      },
      onPanResponderMove: (e) => setScrubPos(posFromX(e.nativeEvent.locationX)),
      onPanResponderRelease: (e) => {
        const t = posFromX(e.nativeEvent.locationX);
        try { player.currentTime = t; } catch { /* ignore */ }
        setPosition(t);
        scrubbingRef.current = false;
        showControls();
      },
      onPanResponderTerminate: () => { scrubbingRef.current = false; showControls(); },
    }),
  ).current;

  const shownPos = scrubbingRef.current ? scrubPos : position;
  const progress = duration > 0 ? Math.max(0, Math.min(1, shownPos / duration)) : 0;

  return (
    <View style={[style, playerLocal.root]}>
      <VideoView player={player} style={StyleSheet.absoluteFill} nativeControls={false} contentFit="contain" />

      {buffering && posterUri ? (
        <Image source={{ uri: posterUri }} style={StyleSheet.absoluteFill} resizeMode="contain" />
      ) : null}

      {/* Camada de toque: mostra/esconde os controles (fica ATRÁS dos botões). */}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={() => (controlsVisible ? setControlsVisible(false) : showControls())}
      />

      {buffering ? (
        <View style={[StyleSheet.absoluteFill, playerLocal.center]} pointerEvents="none">
          <ActivityIndicator color="#fff" size="large" />
        </View>
      ) : null}

      {preparando && !playbackError ? (
        <View style={[StyleSheet.absoluteFill, playerLocal.error]}>
          <ActivityIndicator color="#fff" />
          <Text style={[playerLocal.errorText, { marginTop: 10 }]}>Preparando o vídeo…</Text>
          <Text style={[playerLocal.errorText, { fontSize: 11, opacity: 0.75, marginTop: 4 }]}>
            O servidor está convertendo esta gravação. Começa sozinho quando ficar pronta.
          </Text>
        </View>
      ) : null}

      {playbackError ? (
        <View style={[StyleSheet.absoluteFill, playerLocal.error]}>
          <Text style={playerLocal.errorText}>Não foi possível reproduzir.</Text>
          {onRetry ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Tentar reproduzir novamente" style={playerLocal.retry} onPress={onRetry}>
              <Text style={playerLocal.retryText}>Tentar novamente</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {controlsVisible ? (
        <>
          {/* Velocidade (canto superior esquerdo — o X de fechar fica na direita). */}
          <LinearGradient colors={['rgba(0,0,0,0.45)', 'transparent']} style={playerLocal.topScrim} pointerEvents="box-none">
            <Pressable accessibilityRole="button" accessibilityLabel={`Velocidade ${rate} vezes`} style={playerLocal.speedPill} onPress={cycleRate} hitSlop={8}>
              <Text style={playerLocal.speedText}>{rate}×</Text>
            </Pressable>
          </LinearGradient>

          {/* Transporte central: -10s · play/pause · +10s */}
          <View style={[StyleSheet.absoluteFill, playerLocal.center]} pointerEvents="box-none">
            <View style={playerLocal.transport}>
              <Pressable accessibilityRole="button" accessibilityLabel="Voltar 10 segundos" onPress={() => seekBy(-10)} hitSlop={10} style={playerLocal.sideBtn}>
                <Icon name="rewind" size={24} color="#fff" />
                <Text style={playerLocal.sideBtnLabel}>10</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel={playing ? 'Pausar' : 'Reproduzir'} onPress={togglePlay} hitSlop={12} style={[playerLocal.playBtn, { backgroundColor: theme.accent }]}>
                <Icon name={playing && !buffering ? 'pause' : 'play'} size={30} color={theme.textOnAccent} fill={!(playing && !buffering)} />
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Avançar 10 segundos" onPress={() => seekBy(10)} hitSlop={10} style={playerLocal.sideBtn}>
                <Icon name="forward" size={24} color="#fff" />
                <Text style={playerLocal.sideBtnLabel}>10</Text>
              </Pressable>
            </View>
          </View>

          {/* Barra de progresso arrastável + tempos */}
          <LinearGradient colors={['transparent', 'rgba(0,0,0,0.7)']} style={playerLocal.bottomScrim} pointerEvents="box-none">
            <View style={playerLocal.timeRow}>
              <Text style={playerLocal.timeText}>{formatTime(shownPos)}</Text>
              <Text style={[playerLocal.timeText, playerLocal.timeMuted]}>{formatTime(duration)}</Text>
            </View>
            <View
              style={playerLocal.barHit}
              onLayout={(ev) => { const w = ev.nativeEvent.layout.width; barWidthRef.current = w; setBarWidth(w); }}
              {...panResponder.panHandlers}
            >
              <View style={playerLocal.barTrack}>
                <View style={[playerLocal.barFill, { width: `${progress * 100}%`, backgroundColor: theme.accent }]} />
              </View>
              <View style={[playerLocal.thumb, { left: Math.max(0, Math.min(barWidth - 16, progress * barWidth - 8)), backgroundColor: theme.accent }]} />
            </View>
          </LinearGradient>
        </>
      ) : null}
    </View>
  );
}

const playerLocal = StyleSheet.create({
  root: { overflow: 'hidden', backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center' },
  topScrim: { position: 'absolute', top: 0, left: 0, right: 0, height: 64, paddingTop: 10, paddingHorizontal: 12, alignItems: 'flex-start' },
  speedPill: { backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5, borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)' },
  speedText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  transport: { flexDirection: 'row', alignItems: 'center', gap: 30 },
  sideBtn: { alignItems: 'center', justifyContent: 'center', width: 52, height: 52 },
  sideBtnLabel: { color: '#fff', fontSize: 10, fontWeight: '700', marginTop: -3 },
  playBtn: { width: 62, height: 62, borderRadius: 31, alignItems: 'center', justifyContent: 'center', elevation: 4, shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } },
  bottomScrim: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 14, paddingBottom: 12, paddingTop: 26 },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  timeText: { color: '#fff', fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
  timeMuted: { opacity: 0.7 },
  barHit: { height: 26, justifyContent: 'center' },
  barTrack: { height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.28)', overflow: 'hidden' },
  barFill: { height: 4, borderRadius: 2 },
  thumb: { position: 'absolute', width: 16, height: 16, borderRadius: 8, top: 5, borderWidth: 2, borderColor: '#fff' },
  error: { alignItems: 'center', justifyContent: 'center', gap: 12, backgroundColor: 'rgba(0,0,0,0.78)' },
  errorText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  retry: { borderRadius: 10, paddingHorizontal: 14, paddingVertical: 9, backgroundColor: 'rgba(255,255,255,0.16)' },
  retryText: { color: '#fff', fontSize: 12, fontWeight: '800' },
});

const local = StyleSheet.create({
  container: {
    overflow: 'hidden',
    position: 'relative',
  },
  overlay: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  overlayText: {
    marginTop: 4,
  },
});
