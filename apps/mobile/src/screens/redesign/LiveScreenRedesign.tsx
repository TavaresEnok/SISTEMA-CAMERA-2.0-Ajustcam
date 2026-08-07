/**
 * Câmera ao vivo (redesign) — réplica da tela "Câmera" do mockup, REUSANDO os componentes
 * de vídeo reais (LiveVideo/PlaybackVideo) e os callbacks do App (PTZ, gravar, snapshot,
 * playback). Layout do handoff: header + player 16:10 + segmented Ao vivo/Gravações +
 * barra de ações redonda + pad PTZ + lista de gravações.
 */
import * as ScreenOrientation from 'expo-screen-orientation';
import * as Sharing from 'expo-sharing';
import { useEffect, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DetectionOverlay } from '../../components/DetectionOverlay';
import { LiveVideo, PlaybackVideo, type LiveStatus } from '../../components/VideoPlayers';
import { useTheme } from '../../theme/ThemeProvider';
import { Icon, type IconName } from '../../components/Icon';
import type { SavedClip } from '../../services/clips';
import type { ActivePlayback, Camera, Direction, LiveDetection, Recording } from '../../types';

const TITLE = 'Sora';
const UI = 'InstrumentSans';
const MONO = 'JetBrainsMono';

interface Props {
  camera: Camera;
  topInset: number;
  streamUrl: string | null;
  whepUrl: string | null;
  posterUrl: string | null;
  /** Máxima qualidade (HLS passthrough), sob demanda. */
  hdUrl: string | null;
  onRequestHd: () => void;
  onExitHd: () => void;
  recordings: Recording[];
  recordingsLoading: boolean;
  recordingsLoadingMore: boolean;
  recordingsError: string | null;
  recordingsTotal: number;
  recordingDate: string;
  activePlayback: ActivePlayback | null;
  recordingActive: boolean;
  recordingBusy: boolean;
  ptzActive: Direction | null;
  ptzFeedback: string | null;
  /** Caixas da IA sobre o vivo (desenhadas na tela cheia, onde o fit é exato). */
  detections: LiveDetection[];
  canPlayback: boolean;
  canDownload: boolean;
  downloadingIds: string[];
  myRecordings: SavedClip[];
  notificationsMuted: boolean;
  onToggleNotifications: (c: Camera) => void;
  onBack: () => void;
  onSendPtz: (d: Direction) => void;
  onToggleRecording: (c: Camera) => void;
  onSnapshot: (c: Camera) => void;
  onOpenPlayback: (r: Recording) => void;
  onClosePlayback: () => void;
  onRetryPlayback: () => void;
  /** Degrau de codec: pede a versão compatível quando o original não decodifica. */
  onNaoDecodificou: () => boolean;
  /** Posição corrente, para retomar o ponto ao trocar a URL. */
  onProgressoPlayback: (segundos: number) => void;
  onPreviousDate: () => void;
  onNextDate: () => void;
  onSelectDate: (dateKey: string) => void;
  onDownloadRecording: (r: Recording) => void;
  onLoadMoreRecordings: () => void;
  onRetryRecordings: () => void;
  onThumbnailError: () => void;
  onPlayLocal: (c: SavedClip) => void;
  onDeleteLocal: (c: SavedClip) => void;
  onRefreshStream: () => void;
}

/** Relógio isolado num componente próprio: só ELE re-renderiza a cada segundo,
 * evitando derrubar a superfície do player de vídeo (WebRTC "No surface"). */
function ClockBadge({ style, textStyle }: { style: any; textStyle: any }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const clock = new Date(now).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  return <View style={style}><Text style={textStyle}>{clock}</Text></View>;
}

export function LiveScreenRedesign(props: Props) {
  const { camera, topInset, streamUrl, whepUrl, posterUrl, hdUrl, onRequestHd, onExitHd, detections,
    recordings, recordingsLoading, recordingDate, activePlayback, recordingActive, ptzActive, ptzFeedback,
    canPlayback, canDownload, myRecordings, notificationsMuted, onToggleNotifications, onBack, onSendPtz, onToggleRecording,
    onSnapshot, onOpenPlayback, onClosePlayback, onSelectDate, onDownloadRecording, onPlayLocal, onDeleteLocal } = props;
  const { theme } = useTheme();
  const s = makeStyles(theme);
  // Em paisagem a barra de navegação do Android ocupa uma lateral — os controles
  // da tela cheia respeitam os insets para não ficarem atrás dela.
  const insets = useSafeAreaInsets();

  const [mode, setMode] = useState<'live' | 'rec'>('live');
  const [ptzOpen, setPtzOpen] = useState(false);
  const [muted, setMuted] = useState(true);
  // null = ainda não sabemos (conectando/HLS); false = stream sem faixa de áudio.
  const [audioAvailable, setAudioAvailable] = useState<boolean | null>(null);
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const [fullscreen, setFullscreen] = useState(false);
  const [fsSize, setFsSize] = useState({ width: 0, height: 0 });
  // Tela cheia gira para PAISAGEM (vídeo de câmera é horizontal); ao sair — ou
  // fechar a câmera — volta para retrato. Best-effort: emulador/aparelhos sem
  // sensor apenas ignoram.
  useEffect(() => {
    void ScreenOrientation.lockAsync(
      fullscreen ? ScreenOrientation.OrientationLock.LANDSCAPE : ScreenOrientation.OrientationLock.PORTRAIT_UP,
    ).catch(() => undefined);
    return () => {
      void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => undefined);
    };
  }, [fullscreen]);
  // Máxima qualidade (HLS H.265 passthrough), como no app atual. Reseta ao trocar de câmera.
  const [hdMode, setHdMode] = useState(false);
  const hdActive = hdMode && !!hdUrl;
  useEffect(() => { setHdMode(false); }, [camera.id]);
  const toggleHd = () => {
    if (hdMode) { setHdMode(false); onExitHd(); }
    else { setHdMode(true); onRequestHd(); }
  };
  const canPtz = camera.ptzCapable !== false && camera.canControl !== false;

  // Aspecto REAL da câmera (igual ao app antigo): o container do vídeo tem a
  // MESMA proporção do stream, então `contain` preenche sem cortar e sem tarjas.
  // NUNCA usar 'cover' em câmera de segurança: cortar as laterais esconde parte
  // da cena do usuário — é falha de segurança, não escolha estética.
  const aspect = camera.detectedWidth && camera.detectedHeight && camera.detectedWidth > 0 && camera.detectedHeight > 0
    ? camera.detectedWidth / camera.detectedHeight
    : 16 / 9;

  const isPlaying = !!activePlayback;
  const resLabel = camera.detectedHeight ? `${camera.detectedHeight}p` : '1080p';
  const fpsLabel = camera.detectedFps ? `${Math.round(camera.detectedFps)} fps` : '30 fps';

  // Elemento de vídeo compartilhado pelos dois layouts (normal e tela cheia).
  // Entrar/sair da tela cheia remonta o player (o stream reconecta em ~1s),
  // mesmo custo de trocar de câmera — aceitável e simples.
  const video = isPlaying ? (
    <PlaybackVideo uri={activePlayback!.url} posterUri={activePlayback!.recording.thumbnailUrl} onRetry={props.onRetryPlayback} onNaoDecodificou={props.onNaoDecodificou} onProgresso={props.onProgressoPlayback} initialPositionSeconds={activePlayback!.retomarEm ?? null} style={s.videoFill} />
  ) : (
    <LiveVideo
      uri={hdActive ? hdUrl : streamUrl}
      whepUri={hdActive ? null : whepUrl}
      posterUri={posterUrl}
      // IGUAL AO APP ANTIGO (LiveScreen): videoStyle = flex:1 (NÃO absoluteFill).
      // O wrapper interno do player força position:relative; com absoluteFill os
      // offsets são ignorados e o container colapsa p/ altura 0 → vídeo preto.
      // flex:1 preenche o pai (playerLive flex:1 / playerRec aspectRatio) de verdade.
      videoStyle={s.videoFill}
      muted={muted}
      // SEMPRE 'contain': campo de visão COMPLETO da câmera, sem cortar nada.
      contentFit="contain"
      emptyStyle={s.videoEmpty}
      posterStyle={StyleSheet.absoluteFill}
      emptyTitleStyle={s.videoEmptyTitle}
      emptyTextStyle={s.videoEmptyText}
      onStatusChange={setStatus}
      onAudioAvailable={setAudioAvailable}
      onNeedRefresh={hdActive ? onRequestHd : props.onRefreshStream}
    />
  );

  // ── Tela cheia (réplica da tela FULLSCREEN do mockup) ──
  if (fullscreen) {
    return (
      <View style={s.fsRoot} onLayout={(e) => setFsSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}>
        {video}
        {!isPlaying && fsSize.width > 0 ? (
          <DetectionOverlay
            detections={detections}
            containerWidth={fsSize.width}
            containerHeight={fsSize.height}
            fallbackWidth={camera.detectedWidth}
            fallbackHeight={camera.detectedHeight}
          />
        ) : null}
        <View style={[s.fsTop, { top: Math.max(topInset, insets.top) + 10, left: 16 + insets.left, right: 16 + insets.right }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9, flex: 1 }}>
            {!isPlaying ? (
              <View style={s.liveBadge}><View style={s.liveDot} /><Text style={s.liveText}>AO VIVO</Text></View>
            ) : null}
            <Text style={s.fsName} numberOfLines={1}>{camera.name}</Text>
          </View>
          <ClockBadge style={s.fsClock} textStyle={s.clockText} />
          <TouchableOpacity style={s.fsClose} onPress={() => setFullscreen(false)} activeOpacity={0.8}>
            <Icon name="close" size={18} color="#fff" />
          </TouchableOpacity>
        </View>
        {ptzOpen && canPtz && !isPlaying ? (
          <View style={s.fsPtzPad}>
            <PtzBtn s={s} theme={theme} icon="arrowUp" dir="Up" pos={{ top: 2, alignSelf: 'center' }} active={ptzActive === 'Up'} onPress={onSendPtz} disabled={!canPtz} />
            <PtzBtn s={s} theme={theme} icon="arrowDown" dir="Down" pos={{ bottom: 2, alignSelf: 'center' }} active={ptzActive === 'Down'} onPress={onSendPtz} disabled={!canPtz} />
            <PtzBtn s={s} theme={theme} icon="arrowLeft" dir="Left" pos={{ left: 2, top: '50%', marginTop: -21 }} active={ptzActive === 'Left'} onPress={onSendPtz} disabled={!canPtz} />
            <PtzBtn s={s} theme={theme} icon="arrowRight" dir="Right" pos={{ right: 2, top: '50%', marginTop: -21 }} active={ptzActive === 'Right'} onPress={onSendPtz} disabled={!canPtz} />
            <View style={s.joyHome}><Icon name="aperture" size={16} color={theme.accent} /></View>
          </View>
        ) : null}
        {!isPlaying ? (
          <View style={[s.fsBottom, { bottom: 40 + insets.bottom, left: insets.left, right: insets.right }]}>
            <TouchableOpacity style={[s.fsBtn, !muted && audioAvailable !== false && s.fsBtnOn]} disabled={audioAvailable === false} onPress={() => setMuted((m) => !m)} activeOpacity={0.8}>
              <Icon name="mic" size={20} color={audioAvailable === false ? 'rgba(255,255,255,0.4)' : '#fff'} />
            </TouchableOpacity>
            <TouchableOpacity style={s.fsBtn} onPress={() => onSnapshot(camera)} activeOpacity={0.8}>
              <Icon name="camera" size={20} color="#fff" />
            </TouchableOpacity>
            <TouchableOpacity style={[s.fsBtn, recordingActive && s.fsBtnRec]} onPress={() => onToggleRecording(camera)} activeOpacity={0.8}>
              <View style={[s.fsRecDot, recordingActive && { borderRadius: 4 }]} />
            </TouchableOpacity>
            {canPtz ? (
              <TouchableOpacity style={[s.fsBtn, ptzOpen && s.fsBtnOn]} onPress={() => setPtzOpen((p) => !p)} activeOpacity={0.8}>
                <Icon name="crosshair" size={20} color="#fff" />
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <View style={[s.root, { paddingTop: topInset }]}>
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity style={s.backBtn} onPress={() => (isPlaying ? onClosePlayback() : onBack())} activeOpacity={0.8}>
          <Icon name="close" size={18} color={theme.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.name} numberOfLines={1}>{camera.name}</Text>
          <Text style={s.meta} numberOfLines={1}>{(camera.group?.name ?? 'Câmera')} · {resLabel} · {fpsLabel}</Text>
        </View>
        {isPlaying ? (
          <View style={s.dateBadge}><Text style={s.dateText}>{new Date(activePlayback!.recording.startedAt).toLocaleDateString('pt-BR')}</Text></View>
        ) : (
          <View style={s.liveBadge}><View style={s.liveDot} /><Text style={s.liveText}>AO VIVO</Text></View>
        )}
      </View>

      {/* Player: no Ao vivo PREENCHE todo o espaço (como o app antigo); nas
          Gravações fica compacto no topo para a lista respirar. Flush, sem
          borda arredondada — vídeo de câmera ocupa a tela, sem moldura. */}
      <View style={[mode === 'live' ? s.playerLive : s.playerRec, { aspectRatio: aspect }]}>
        {video}
        {!isPlaying ? (
          <>
            <ClockBadge style={s.clockBadge} textStyle={s.clockText} />
            {recordingActive ? (
              <View style={s.recBadge}><View style={s.recDot} /><Text style={s.recText}>REC</Text></View>
            ) : null}
            {hdActive ? (
              <View style={s.hdBadge}><Text style={s.hdBadgeText}>HD</Text></View>
            ) : null}
            {status !== 'live' ? (
              <View style={s.statusPill}><Text style={s.statusText}>{status === 'connecting' ? 'Conectando…' : status === 'reconnecting' ? 'Reconectando…' : status === 'offline' ? 'Offline' : ''}</Text></View>
            ) : null}
          </>
        ) : null}
      </View>

      {/* Segmented Ao vivo / Gravações */}
      <View style={s.segmented}>
        <TouchableOpacity style={[s.segBtn, mode === 'live' && s.segOn]} onPress={() => { setMode('live'); if (isPlaying) onClosePlayback(); }}>
          <Text style={[s.segText, mode === 'live' && s.segTextOn]}>Ao vivo</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.segBtn, mode === 'rec' && s.segOn]} onPress={() => setMode('rec')}>
          <Text style={[s.segText, mode === 'rec' && s.segTextOn]}>Gravações</Text>
        </TouchableOpacity>
      </View>

      {mode === 'live' ? (
        <View style={{ flex: 1, paddingBottom: 10 + insets.bottom }}>
          {/* Barra de ações */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.actionsRow} contentContainerStyle={s.actions}>
            <ActionBtn s={s} theme={theme} icon="mic" label={audioAvailable === false ? 'Sem áudio' : 'Áudio'} active={!muted && audioAvailable !== false} disabled={audioAvailable === false} onPress={() => setMuted((m) => !m)} />
            <ActionBtn s={s} theme={theme} icon="camera" label="Capturar" onPress={() => onSnapshot(camera)} />
            <ActionBtn s={s} theme={theme} icon={recordingActive ? 'pause' : 'aperture'} label="Gravar" active={recordingActive} danger={recordingActive} onPress={() => onToggleRecording(camera)} />
            <ActionBtn s={s} theme={theme} icon="maximize" label="HD" active={hdActive} onPress={toggleHd} />
            <ActionBtn s={s} theme={theme} icon="crosshair" label="PTZ" active={ptzOpen} disabled={!canPtz} onPress={() => setPtzOpen((p) => !p)} />
            <ActionBtn s={s} theme={theme} icon="bell" label={notificationsMuted ? 'Silenciada' : 'Notificar'} active={!notificationsMuted} onPress={() => onToggleNotifications(camera)} />
            <ActionBtn s={s} theme={theme} icon="expand" label="Tela" onPress={() => setFullscreen(true)} />
          </ScrollView>

          {/* Feedback do PTZ (ex.: "Movendo para a direita…") */}
          {ptzFeedback ? (
            <View style={s.ptzFeedback}>
              <Icon name="crosshair" size={14} color={theme.accent} />
              <Text style={s.ptzFeedbackText}>{ptzFeedback}</Text>
            </View>
          ) : null}

          {/* Pad PTZ */}
          {ptzOpen ? (
            <View style={s.ptzPanel}>
              <View style={s.joystick}>
                <PtzBtn s={s} theme={theme} icon="arrowUp" dir="Up" pos={{ top: 6, alignSelf: 'center' }} active={ptzActive === 'Up'} onPress={onSendPtz} disabled={!canPtz} />
                <PtzBtn s={s} theme={theme} icon="arrowDown" dir="Down" pos={{ bottom: 6, alignSelf: 'center' }} active={ptzActive === 'Down'} onPress={onSendPtz} disabled={!canPtz} />
                <PtzBtn s={s} theme={theme} icon="arrowLeft" dir="Left" pos={{ left: 6, top: '50%', marginTop: -21 }} active={ptzActive === 'Left'} onPress={onSendPtz} disabled={!canPtz} />
                <PtzBtn s={s} theme={theme} icon="arrowRight" dir="Right" pos={{ right: 6, top: '50%', marginTop: -21 }} active={ptzActive === 'Right'} onPress={onSendPtz} disabled={!canPtz} />
                <View style={s.joyHome}><Icon name="aperture" size={18} color={theme.accent} /></View>
              </View>
              <View style={s.zoomCol}>
                <TouchableOpacity style={s.zoomBtn} disabled={!canPtz} onPress={() => onSendPtz('ZoomIn')}><Icon name="plus" size={20} color={theme.text} /></TouchableOpacity>
                <Text style={s.zoomLabel}>Zoom</Text>
                <TouchableOpacity style={s.zoomBtn} disabled={!canPtz} onPress={() => onSendPtz('ZoomOut')}><Icon name="minus" size={20} color={theme.text} /></TouchableOpacity>
              </View>
            </View>
          ) : null}
          {ptzOpen && !canPtz ? <Text style={s.ptzNote}>Esta câmera não suporta PTZ ou você não tem permissão.</Text> : null}

          {/* Espaço restante preenchido com CONTEÚDO ÚTIL (como o painel inferior
              do app antigo): as gravações do dia desta câmera, prontas p/ tocar.
              Assim o vídeo nunca precisa ser cortado só para "encher a tela". */}
          {!ptzOpen ? (
            <View style={s.liveRecs}>
              <View style={s.liveRecsHead}>
                <Text style={s.liveRecsTitle}>Gravações de hoje</Text>
                {recordings.length ? (
                  <TouchableOpacity onPress={() => setMode('rec')} activeOpacity={0.7}>
                    <Text style={s.liveRecsLink}>Ver todas</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
              {recordingsLoading ? (
                <Text style={s.empty}>Carregando…</Text>
              ) : recordings.length === 0 ? (
                <View style={s.liveRecsEmpty}>
                  <Icon name="clock" size={20} color={theme.textMuted} />
                  <Text style={s.emptyBoxText}>Nenhuma gravação hoje</Text>
                  <Text style={s.emptyBoxSub}>As gravações desta câmera aparecem aqui.</Text>
                </View>
              ) : (
                <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 9, paddingBottom: 8 }}>
                  {recordings.slice(0, 12).map((r) => (
                    <TouchableOpacity key={r.id} style={s.recRow} activeOpacity={0.85} disabled={!canPlayback} onPress={() => { setMode('rec'); onOpenPlayback(r); }}>
                      <View style={s.recThumb}>
                        {r.thumbnailUrl ? <Image source={{ uri: r.thumbnailUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" onError={props.onThumbnailError} /> : <View style={[StyleSheet.absoluteFill, s.recThumbEmpty]}><Icon name="play" size={14} color={theme.textMuted} /></View>}
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={s.recRowTitle}>{new Date(r.startedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}{r.endedAt ? ` – ${new Date(r.endedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : ''}</Text>
                        <Text style={s.recRowSub}>{(r.triggerMode ?? '').toLowerCase() === 'motion' ? 'Movimento' : 'Contínua'}{r.durationSeconds ? ` · ${Math.round(r.durationSeconds)}s` : ''}</Text>
                      </View>
                      <Icon name="play" size={18} color={theme.accent} />
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              )}
            </View>
          ) : null}
        </View>
      ) : (
        <RecMode
          s={s} theme={theme}
          recordings={recordings} recordingsLoading={recordingsLoading} recordingDate={recordingDate}
          recordingsLoadingMore={props.recordingsLoadingMore} recordingsError={props.recordingsError}
          recordingsTotal={props.recordingsTotal} downloadingIds={props.downloadingIds}
          myRecordings={myRecordings} activePlayback={activePlayback}
          canPlayback={canPlayback} canDownload={canDownload}
          onOpenPlayback={onOpenPlayback} onSelectDate={onSelectDate}
          onDownloadRecording={onDownloadRecording} onLoadMoreRecordings={props.onLoadMoreRecordings}
          onRetryRecordings={props.onRetryRecordings} onThumbnailError={props.onThumbnailError}
          onPlayLocal={onPlayLocal} onDeleteLocal={onDeleteLocal}
        />
      )}
    </View>
  );
}

/** Modo "Gravações" (réplica do modeRec do mockup): fonte Servidor/Neste aparelho,
 * chips de data, linha do tempo 24h, download do trecho, e clipes locais. */
function RecMode({ s, theme, recordings, recordingsLoading, recordingsLoadingMore, recordingsError, recordingsTotal,
  downloadingIds, recordingDate, myRecordings, activePlayback,
  canPlayback, canDownload, onOpenPlayback, onSelectDate, onDownloadRecording, onLoadMoreRecordings,
  onRetryRecordings, onThumbnailError, onPlayLocal, onDeleteLocal }: {
  s: any; theme: any; recordings: Recording[]; recordingsLoading: boolean; recordingsLoadingMore: boolean;
  recordingsError: string | null; recordingsTotal: number; downloadingIds: string[]; recordingDate: string;
  myRecordings: SavedClip[]; activePlayback: { recording: Recording; url: string } | null;
  canPlayback: boolean; canDownload: boolean;
  onOpenPlayback: (r: Recording) => void; onSelectDate: (d: string) => void;
  onDownloadRecording: (r: Recording) => void; onLoadMoreRecordings: () => void;
  onRetryRecordings: () => void; onThumbnailError: () => void;
  onPlayLocal: (c: SavedClip) => void; onDeleteLocal: (c: SavedClip) => void;
}) {
  const [source, setSource] = useState<'server' | 'local'>('server');
  const [trackWidth, setTrackWidth] = useState(0);
  const chips = recentDateChips(recordingDate);

  // Segmentos da linha do tempo 24h a partir das gravações do dia.
  const segs = recordings.map((r) => {
    const st = new Date(r.startedAt);
    const startSec = st.getHours() * 3600 + st.getMinutes() * 60 + st.getSeconds();
    const durSec = r.durationSeconds && r.durationSeconds > 0
      ? r.durationSeconds
      : r.endedAt ? Math.max(1, (new Date(r.endedAt).getTime() - st.getTime()) / 1000) : 60;
    return {
      id: r.id,
      startSec,
      durSec,
      recording: r,
      left: Math.max(0, Math.min(100, (startSec / 86400) * 100)),
      width: Math.max(0.6, Math.min(100, (durSec / 86400) * 100)),
      motion: (r.triggerMode ?? '').toLowerCase() === 'motion',
    };
  });

  // Toque na linha do tempo: abre a gravação que COBRE aquele horário; se cair
  // num buraco, vai para a gravação mais próxima do ponto tocado.
  const seekTimeline = (x: number) => {
    if (!canPlayback || !trackWidth || segs.length === 0) return;
    const daySec = Math.max(0, Math.min(1, x / trackWidth)) * 86400;
    const hit = segs.find((sg) => daySec >= sg.startSec && daySec <= sg.startSec + Math.max(sg.durSec, 60));
    const nearest = hit ?? [...segs].sort((a, b) => {
      const da = Math.min(Math.abs(a.startSec - daySec), Math.abs(a.startSec + a.durSec - daySec));
      const db = Math.min(Math.abs(b.startSec - daySec), Math.abs(b.startSec + b.durSec - daySec));
      return da - db;
    })[0];
    if (nearest) onOpenPlayback(nearest.recording);
  };
  const isToday = recordingDate === new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD local
  const nowPct = isToday ? ((new Date().getHours() * 3600 + new Date().getMinutes() * 60) / 86400) * 100 : null;

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40, paddingHorizontal: 14 }}>
      {/* Fonte: Servidor / Neste aparelho */}
      <View style={s.srcToggle}>
        <TouchableOpacity style={[s.srcBtn, source === 'server' && s.srcBtnOn]} activeOpacity={0.85} onPress={() => setSource('server')}>
          <Icon name="cloud" size={16} color={source === 'server' ? theme.accent : theme.textSub} />
          <Text style={[s.srcTitle, source === 'server' && { color: theme.accent }]}>Servidor</Text>
          <Text style={s.srcSub}>Gravação 24h na nuvem</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.srcBtn, source === 'local' && s.srcBtnOn]} activeOpacity={0.85} onPress={() => setSource('local')}>
          <Icon name="smartphone" size={16} color={source === 'local' ? theme.accent : theme.textSub} />
          <Text style={[s.srcTitle, source === 'local' && { color: theme.accent }]}>Neste aparelho</Text>
          <Text style={s.srcSub}>{myRecordings.length ? `${myRecordings.length} trecho${myRecordings.length > 1 ? 's' : ''} salvo${myRecordings.length > 1 ? 's' : ''}` : 'Nenhum trecho salvo'}</Text>
        </TouchableOpacity>
      </View>

      {source === 'server' ? (
        <>
          {/* Chips de data */}
          <View style={s.dateChips}>
            {chips.map((c) => {
              const on = c.key === recordingDate;
              return (
                <TouchableOpacity key={c.key} style={[s.dateChip, on && s.dateChipOn]} activeOpacity={0.85} onPress={() => onSelectDate(c.key)}>
                  <Text style={[s.dateChipDow, on && { color: theme.textOnAccent ?? '#fff' }]}>{c.dow}</Text>
                  <Text style={[s.dateChipNum, on && { color: theme.textOnAccent ?? '#fff' }]}>{c.num}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Linha do tempo 24h */}
          <View style={s.tlCard}>
            <View style={s.tlHead}>
              <Text style={s.tlTitle}>Linha do tempo</Text>
              <View style={{ flexDirection: 'row', gap: 12 }}>
                <View style={s.tlLegend}><View style={[s.tlDot, { backgroundColor: 'rgba(62,139,255,0.75)' }]} /><Text style={s.tlLegendText}>Contínua</Text></View>
                <View style={s.tlLegend}><View style={[s.tlDot, { backgroundColor: theme.warning }]} /><Text style={s.tlLegendText}>Movimento</Text></View>
              </View>
            </View>
            <Pressable
              style={s.tlTrack}
              onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
              onPress={(e) => seekTimeline(e.nativeEvent.locationX)}
            >
              {segs.map((sg) => (
                <View key={sg.id} style={[s.tlSeg, { left: `${sg.left}%`, width: `${sg.width}%`, backgroundColor: sg.motion ? theme.warning : 'rgba(62,139,255,0.75)' }]} />
              ))}
              {activePlayback ? (
                <View style={[s.tlActiveMark, { left: `${Math.min(100, ((new Date(activePlayback.recording.startedAt).getHours() * 3600 + new Date(activePlayback.recording.startedAt).getMinutes() * 60) / 86400) * 100)}%`, backgroundColor: theme.accent }]} />
              ) : null}
              {nowPct != null ? <View style={[s.tlPlayhead, { left: `${nowPct}%` }]} /> : null}
            </Pressable>
            <View style={s.tlAxis}>
              {['00h', '06h', '12h', '18h', '24h'].map((h) => <Text key={h} style={s.tlAxisText}>{h}</Text>)}
            </View>
            <Text style={s.tlHint}>Toque na linha do tempo para abrir o horário</Text>
          </View>

          {/* Baixar trecho atual */}
          {activePlayback && canDownload ? (
            <TouchableOpacity style={s.downloadBtn} activeOpacity={0.85} onPress={() => onDownloadRecording(activePlayback.recording)}>
              <Icon name="download" size={17} color={theme.textSub} />
              <Text style={s.downloadText}>Baixar este trecho</Text>
            </TouchableOpacity>
          ) : null}

          {/* Lista de gravações do dia */}
          {recordingsError ? (
            <View style={s.errBox}>
              <Icon name="alert" size={18} color={theme.danger} />
              <Text style={s.errText} numberOfLines={2}>{recordingsError}</Text>
              <TouchableOpacity style={s.errRetry} activeOpacity={0.8} onPress={onRetryRecordings}>
                <Text style={s.errRetryText}>Tentar de novo</Text>
              </TouchableOpacity>
            </View>
          ) : recordingsLoading ? (
            <Text style={s.empty}>Carregando…</Text>
          ) : recordings.length === 0 ? (
            <View style={s.emptyBox}><Icon name="clock" size={22} color={theme.textMuted} /><Text style={s.emptyBoxText}>Nenhuma gravação neste dia.</Text></View>
          ) : (
            <View style={{ gap: 9, marginTop: 16 }}>
              {recordings.map((r) => {
                const downloading = downloadingIds.includes(r.id);
                return (
                  <TouchableOpacity key={r.id} style={s.recRow} activeOpacity={0.85} disabled={!canPlayback} onPress={() => onOpenPlayback(r)}>
                    <View style={s.recThumb}>
                      {r.thumbnailUrl ? <Image source={{ uri: r.thumbnailUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" onError={onThumbnailError} /> : <View style={[StyleSheet.absoluteFill, s.recThumbEmpty]}><Icon name="play" size={14} color={theme.textMuted} /></View>}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={s.recRowTitle}>{new Date(r.startedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}{r.endedAt ? ` – ${new Date(r.endedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : ''}</Text>
                      <Text style={s.recRowSub}>{(r.triggerMode ?? '').toLowerCase() === 'motion' ? 'Movimento' : 'Contínua'}{r.durationSeconds ? ` · ${Math.round(r.durationSeconds)}s` : ''}</Text>
                    </View>
                    {canDownload ? (
                      <TouchableOpacity style={s.recDl} activeOpacity={0.8} disabled={downloading} onPress={() => onDownloadRecording(r)} hitSlop={6}>
                        <Icon name="download" size={16} color={downloading ? theme.textMuted : theme.textSub} />
                      </TouchableOpacity>
                    ) : null}
                    <Icon name="play" size={18} color={theme.accent} />
                  </TouchableOpacity>
                );
              })}
              {recordings.length < recordingsTotal ? (
                <TouchableOpacity style={s.loadMore} activeOpacity={0.85} disabled={recordingsLoadingMore} onPress={onLoadMoreRecordings}>
                  <Text style={s.loadMoreText}>{recordingsLoadingMore ? 'Carregando…' : `Carregar mais (${recordings.length} de ${recordingsTotal})`}</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          )}
        </>
      ) : (
        <>
          <View style={s.localBanner}>
            <Icon name="info" size={16} color={theme.accent} />
            <Text style={s.localBannerText}>Trechos gravados pelo app direto no seu celular. Ficam salvos mesmo sem internet.</Text>
          </View>
          {myRecordings.length === 0 ? (
            <View style={s.emptyBox}><Icon name="smartphone" size={22} color={theme.textMuted} /><Text style={s.emptyBoxText}>Nenhuma gravação local</Text><Text style={s.emptyBoxSub}>Use “Gravar” na tela ao vivo para salvar trechos aqui.</Text></View>
          ) : (
            <View style={{ gap: 10 }}>
              {myRecordings.map((c) => (
                <View key={c.id} style={s.recRow}>
                  <TouchableOpacity style={s.localThumb} activeOpacity={0.85} onPress={() => onPlayLocal(c)}>
                    {c.thumbnailUri ? <Image source={{ uri: c.thumbnailUri }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : <View style={[StyleSheet.absoluteFill, s.recThumbEmpty]} />}
                    <View style={s.localPlayBadge}><Icon name="play" size={12} color="#0A0D13" /></View>
                  </TouchableOpacity>
                  <TouchableOpacity style={{ flex: 1 }} activeOpacity={0.85} onPress={() => onPlayLocal(c)}>
                    <Text style={s.recRowTitle} numberOfLines={1}>{c.cameraName}</Text>
                    <Text style={s.recRowSub}>{new Date(c.createdAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={s.localDelBtn}
                    activeOpacity={0.8}
                    onPress={() => { void Sharing.shareAsync(c.uri, { mimeType: 'video/mp4', dialogTitle: c.cameraName }).catch(() => undefined); }}
                  >
                    <Icon name="share" size={15} color={theme.accent} />
                  </TouchableOpacity>
                  <TouchableOpacity style={s.localDelBtn} activeOpacity={0.8} onPress={() => onDeleteLocal(c)}>
                    <Icon name="trash" size={15} color={theme.danger} />
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}

/** 5 dias mais recentes terminando na data selecionada (ou hoje se for futuro). */
function recentDateChips(selected: string): Array<{ key: string; dow: string; num: string }> {
  const base = new Date(`${selected}T12:00:00`);
  const out: Array<{ key: string; dow: string; num: string }> = [];
  for (let i = 4; i >= 0; i--) {
    const d = new Date(base);
    d.setDate(d.getDate() - i);
    out.push({
      key: d.toLocaleDateString('en-CA'),
      dow: d.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '').toUpperCase().slice(0, 3),
      num: String(d.getDate()).padStart(2, '0'),
    });
  }
  return out;
}

function ActionBtn({ s, theme, icon, label, active, danger, disabled, onPress }: { s: any; theme: any; icon: IconName; label: string; active?: boolean; danger?: boolean; disabled?: boolean; onPress: () => void }) {
  const color = danger ? theme.danger : active ? theme.accent : theme.text;
  return (
    <TouchableOpacity style={[s.actionBtn, active && { backgroundColor: theme.accentBg, borderColor: theme.accent }, disabled && { opacity: 0.4 }]} disabled={disabled} onPress={onPress} activeOpacity={0.8}>
      <Icon name={icon} size={20} color={color} />
      <Text style={[s.actionLabel, { color: active ? theme.accent : theme.textSub }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function PtzBtn({ s, theme, icon, dir, pos, active, onPress, disabled }: { s: any; theme: any; icon: IconName; dir: Direction; pos: any; active?: boolean; onPress: (d: Direction) => void; disabled?: boolean }) {
  return (
    <TouchableOpacity style={[s.joyBtn, pos, active && { backgroundColor: theme.accent }]} disabled={disabled} onPress={() => onPress(dir)} activeOpacity={0.7}>
      <Icon name={icon} size={20} color={active ? '#fff' : theme.text} />
    </TouchableOpacity>
  );
}

function makeStyles(t: any) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: t.bg },
    header: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12, marginTop: 6, paddingHorizontal: 14 },
    backBtn: { width: 36, height: 36, borderRadius: 12, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, alignItems: 'center', justifyContent: 'center' },
    name: { fontFamily: TITLE, fontSize: 15, fontWeight: '700', color: t.text },
    meta: { fontFamily: MONO, fontSize: 10.5, color: t.textSub, marginTop: 1 },
    liveBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(214,55,48,0.95)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999 },
    liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#fff' },
    liveText: { color: '#fff', fontFamily: UI, fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
    dateBadge: { backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, paddingHorizontal: 11, paddingVertical: 6, borderRadius: 999 },
    dateText: { fontFamily: MONO, fontSize: 11, color: t.text },

    playerLive: { width: '100%', backgroundColor: '#05080e' },
    playerRec: { width: '100%', backgroundColor: '#05080e' },
    videoFill: { flex: 1, backgroundColor: '#000' },
    videoEmpty: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0b0f16' },
    videoEmptyTitle: { fontFamily: TITLE, fontSize: 15, fontWeight: '700', color: '#e8ecf3', marginTop: 8 },
    videoEmptyText: { fontFamily: UI, fontSize: 12.5, color: '#8b95a6', marginTop: 4, textAlign: 'center', paddingHorizontal: 20 },
    clockBadge: { position: 'absolute', top: 10, right: 10, backgroundColor: 'rgba(5,8,14,0.55)', paddingHorizontal: 9, paddingVertical: 4, borderRadius: 8 },
    clockText: { color: 'rgba(255,255,255,0.92)', fontFamily: MONO, fontSize: 11 },
    recBadge: { position: 'absolute', top: 10, left: 10, flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(214,55,48,0.95)', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
    recDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#fff' },
    recText: { color: '#fff', fontFamily: UI, fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
    statusPill: { position: 'absolute', bottom: 10, alignSelf: 'center', backgroundColor: 'rgba(5,8,14,0.7)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999 },
    statusText: { color: '#fff', fontFamily: UI, fontSize: 12, fontWeight: '600' },
    hdBadge: { position: 'absolute', bottom: 10, left: 10, backgroundColor: 'rgba(62,139,255,0.92)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 7 },
    hdBadgeText: { color: '#fff', fontFamily: MONO, fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },

    // Tela cheia (mockup FULLSCREEN)
    fsRoot: { flex: 1, backgroundColor: '#000' },
    fsTop: { position: 'absolute', flexDirection: 'row', alignItems: 'center', gap: 8 },
    fsName: { color: '#fff', fontFamily: TITLE, fontSize: 15, fontWeight: '700', flexShrink: 1 },
    fsClock: { backgroundColor: 'rgba(4,7,13,0.5)', paddingHorizontal: 9, paddingVertical: 4, borderRadius: 8 },
    fsClose: { width: 36, height: 36, borderRadius: 11, backgroundColor: 'rgba(4,7,13,0.5)', alignItems: 'center', justifyContent: 'center' },
    fsBottom: { position: 'absolute', left: 0, right: 0, bottom: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 16 },
    fsBtn: { width: 50, height: 50, borderRadius: 16, backgroundColor: 'rgba(8,12,20,0.5)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', alignItems: 'center', justifyContent: 'center' },
    fsBtnOn: { backgroundColor: 'rgba(62,139,255,0.55)' },
    fsBtnRec: { backgroundColor: 'rgba(214,55,48,0.4)' },
    fsRecDot: { width: 17, height: 17, borderRadius: 9, backgroundColor: '#F05B52' },
    fsPtzPad: { position: 'absolute', left: 20, top: '50%', marginTop: -59, width: 118, height: 118, borderRadius: 59, backgroundColor: 'rgba(8,12,20,0.5)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)' },

    liveRecs: { flex: 1, paddingHorizontal: 14, marginTop: 14 },
    liveRecsHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
    liveRecsTitle: { fontFamily: TITLE, fontSize: 15, fontWeight: '700', color: t.text },
    liveRecsLink: { fontFamily: UI, fontSize: 13, fontWeight: '600', color: t.accent },
    liveRecsEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 7, paddingBottom: 20 },
    ptzFeedback: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, alignSelf: 'center', marginTop: 12, backgroundColor: t.accentBg, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 7 },
    ptzFeedbackText: { fontFamily: UI, fontSize: 12.5, fontWeight: '600', color: t.accent },

    segmented: { flexDirection: 'row', backgroundColor: t.surfaceAlt, borderRadius: 13, padding: 4, marginVertical: 12, marginHorizontal: 14 },
    segBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 9, borderRadius: 10 },
    segOn: { backgroundColor: t.accent },
    segText: { fontFamily: UI, fontSize: 12.5, fontWeight: '700', color: t.textSub },
    segTextOn: { color: '#fff' },

    // flexGrow:0 — sem isso o ScrollView horizontal ESTICA na vertical dentro do
    // container flex-column e empurra o conteúdo de baixo, criando um buraco.
    actionsRow: { flexGrow: 0 },
    actions: { gap: 9, paddingHorizontal: 14, paddingVertical: 2 },
    actionBtn: { width: 66, height: 62, borderRadius: 19, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, alignItems: 'center', justifyContent: 'center', gap: 5 },
    actionLabel: { fontFamily: MONO, fontSize: 9, fontWeight: '500' },

    ptzPanel: { flexDirection: 'row', gap: 16, marginTop: 16, alignItems: 'center', justifyContent: 'center' },
    joystick: { width: 150, height: 150, borderRadius: 75, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, position: 'relative' },
    joyBtn: { position: 'absolute', width: 42, height: 42, borderRadius: 21, backgroundColor: t.surfaceAlt, alignItems: 'center', justifyContent: 'center' },
    joyHome: { position: 'absolute', top: '50%', left: '50%', width: 44, height: 44, borderRadius: 22, marginLeft: -22, marginTop: -22, backgroundColor: t.accentBg, alignItems: 'center', justifyContent: 'center' },
    zoomCol: { alignItems: 'center', gap: 8 },
    zoomBtn: { width: 52, height: 52, borderRadius: 16, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, alignItems: 'center', justifyContent: 'center' },
    zoomLabel: { fontFamily: MONO, fontSize: 10, color: t.textSub },
    ptzNote: { fontFamily: UI, fontSize: 11.5, color: t.textMuted, textAlign: 'center', marginTop: 8, paddingHorizontal: 20 },

    // Fonte Servidor / Neste aparelho
    srcToggle: { flexDirection: 'row', gap: 4, backgroundColor: t.surfaceAlt, borderWidth: 1, borderColor: t.border, borderRadius: 14, padding: 4, marginBottom: 16 },
    srcBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2, paddingVertical: 8, borderRadius: 11 },
    srcBtnOn: { backgroundColor: t.surface, borderWidth: 1, borderColor: t.border },
    srcTitle: { fontFamily: UI, fontSize: 12.5, fontWeight: '700', color: t.textSub },
    srcSub: { fontFamily: UI, fontSize: 9.5, color: t.textMuted, fontWeight: '500' },

    // Chips de data
    dateChips: { flexDirection: 'row', gap: 8, marginBottom: 14 },
    dateChip: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 14, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border },
    dateChipOn: { backgroundColor: t.accent, borderColor: t.accent },
    dateChipDow: { fontFamily: UI, fontSize: 10, fontWeight: '700', letterSpacing: 0.5, color: t.textSub },
    dateChipNum: { fontFamily: TITLE, fontSize: 16, fontWeight: '700', color: t.text, marginTop: 1 },

    // Linha do tempo 24h
    tlCard: { backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 18, padding: 14 },
    tlHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
    tlTitle: { fontFamily: TITLE, fontSize: 13, fontWeight: '700', color: t.text },
    tlLegend: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    tlDot: { width: 8, height: 8, borderRadius: 3 },
    tlLegendText: { fontFamily: UI, fontSize: 10.5, fontWeight: '600', color: t.textSub },
    tlTrack: { position: 'relative', height: 34, borderRadius: 10, backgroundColor: t.surfaceAlt, overflow: 'hidden' },
    tlSeg: { position: 'absolute', top: 0, bottom: 0, borderRadius: 4 },
    tlPlayhead: { position: 'absolute', top: 0, bottom: 0, width: 2.5, marginLeft: -1.25, backgroundColor: t.danger },
    tlActiveMark: { position: 'absolute', top: 0, bottom: 0, width: 3, marginLeft: -1.5, borderRadius: 2 },
    tlHint: { fontFamily: UI, fontSize: 10.5, color: t.textMuted, textAlign: 'center', marginTop: 8 },
    tlAxis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8, paddingHorizontal: 2 },
    tlAxisText: { fontFamily: MONO, fontSize: 9.5, fontWeight: '500', color: t.textMuted },

    downloadBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, marginTop: 16, height: 48, borderRadius: 15, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border },
    downloadText: { fontFamily: UI, fontSize: 13.5, fontWeight: '600', color: t.textSub },

    // Clipes locais
    localBanner: { flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: t.accentBg, borderWidth: 1, borderColor: t.accent, borderRadius: 14, padding: 12, marginBottom: 14 },
    localBannerText: { flex: 1, fontFamily: UI, fontSize: 12, fontWeight: '500', color: t.textSub, lineHeight: 17 },
    localThumb: { width: 92, height: 60, borderRadius: 12, overflow: 'hidden', backgroundColor: '#0d1118' },
    localPlayBadge: { position: 'absolute', top: '50%', left: '50%', width: 26, height: 26, marginLeft: -13, marginTop: -13, borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.92)', alignItems: 'center', justifyContent: 'center' },
    localDelBtn: { width: 34, height: 34, borderRadius: 10, backgroundColor: t.surfaceAlt, borderWidth: 1, borderColor: t.border, alignItems: 'center', justifyContent: 'center' },

    recRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 14, padding: 9 },
    recThumb: { width: 68, height: 46, borderRadius: 9, overflow: 'hidden', backgroundColor: '#0d1118' },
    recThumbEmpty: { alignItems: 'center', justifyContent: 'center', backgroundColor: t.surfaceAlt },
    recRowTitle: { fontFamily: MONO, fontSize: 13, fontWeight: '600', color: t.text },
    recRowSub: { fontFamily: UI, fontSize: 11.5, color: t.textSub, marginTop: 2 },
    recDl: { width: 32, height: 32, borderRadius: 10, backgroundColor: t.surfaceAlt, alignItems: 'center', justifyContent: 'center' },
    loadMore: { height: 46, borderRadius: 14, borderWidth: 1, borderColor: t.border, backgroundColor: t.surface, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
    loadMoreText: { fontFamily: UI, fontSize: 13, fontWeight: '600', color: t.textSub },
    errBox: { marginTop: 16, borderRadius: 16, borderWidth: 1, borderColor: t.dangerBg, backgroundColor: t.dangerBg, alignItems: 'center', gap: 8, paddingVertical: 22, paddingHorizontal: 18 },
    errText: { fontFamily: UI, fontSize: 13, color: t.text, textAlign: 'center' },
    errRetry: { marginTop: 4, borderRadius: 999, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, paddingHorizontal: 16, paddingVertical: 8 },
    errRetryText: { fontFamily: UI, fontSize: 12.5, fontWeight: '700', color: t.text },

    empty: { fontFamily: UI, fontSize: 14, color: t.textMuted, textAlign: 'center', paddingVertical: 30 },
    emptyBox: { marginTop: 8, borderRadius: 16, borderWidth: 1, borderColor: t.border, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 40, paddingHorizontal: 20 },
    emptyBoxText: { fontFamily: UI, fontSize: 13.5, fontWeight: '600', color: t.textSub },
    emptyBoxSub: { fontFamily: UI, fontSize: 12, color: t.textMuted, textAlign: 'center' },
  });
}
