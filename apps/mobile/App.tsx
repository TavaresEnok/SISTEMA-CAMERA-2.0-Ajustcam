// PRIMEIRO import de propósito: o patch de tipografia precisa estar ativo antes de as
// telas rodarem seus StyleSheet.create (que acontecem no import delas).
import './src/theme/applyFonts';
import * as FileSystem from 'expo-file-system/legacy';
import * as ScreenCapture from 'expo-screen-capture';
import * as ScreenOrientation from 'expo-screen-orientation';
import { LinearGradient } from 'expo-linear-gradient';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, BackHandler, Image, SafeAreaView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { isRedesign } from './src/theme/redesign';
import { DEFAULT_API_URL, TOP_SAFE } from './src/config';
import { BottomTabs } from './src/components/BottomTabs';
import { AlarmsScreen } from './src/screens/AlarmsScreen';
import { CentralScreen } from './src/screens/CentralScreen';
import { HomeRedesign } from './src/screens/redesign/HomeRedesign';
import { CamerasRedesign } from './src/screens/redesign/CamerasRedesign';
import { EventsRedesign } from './src/screens/redesign/EventsRedesign';
import { SettingsRedesign } from './src/screens/redesign/SettingsRedesign';
import { BottomTabsRedesign } from './src/components/BottomTabsRedesign';
import { LiveScreen } from './src/screens/LiveScreen';
import { LiveScreenRedesign } from './src/screens/redesign/LiveScreenRedesign';
import { LoginScreen } from './src/screens/LoginScreen';
import { MosaicScreen } from './src/screens/MosaicScreen';
import { PlaybackScreen } from './src/screens/PlaybackScreen';
import { ReviewScreen, type ReviewPlayback } from './src/screens/ReviewScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { request, normalizeServerUrl, setTokenRefreshHandler, setUnauthorizedHandler } from './src/services/api';
import { authenticatedMediaUrl, isSecureMediaUrl } from './src/services/media-urls';
import { fetchBranding, isLightColor } from './src/services/branding';
import { clearStreamUrlsCache, requestCachedStreamUrls } from './src/services/stream-urls-cache';
import {
  saveToGallery, addClip, listClips, removeClip, createClipThumbnail,
  listPendingClips, savePendingClip, removePendingClip,
  type PendingClip, type SavedClip,
} from './src/services/clips';
import {
  cleanApiUrl, clearStoredSession, isBiometricLoginEnabled, loadStoredSession,
  saveStoredSession, setBiometricLoginEnabled,
} from './src/services/sessionStore';
import { authenticateWithBiometrics, getBiometricSupport } from './src/services/biometrics';
import { registerForPush, subscribeToNotificationTaps, unregisterFromPush } from './src/services/push';
import Constants from 'expo-constants';
import { ErrorBoundary } from './src/components/ErrorBoundary';
import { iniciarRelatorioDeTravamento, marcarInstalacao } from './src/services/crash-reporting';
import { useAlarms } from './src/hooks/useAlarms';
import { useLiveDetections } from './src/hooks/useLiveDetections';
import { ThemeProvider, useTheme } from './src/theme/ThemeProvider';
import { LibraryProvider, useLibrary } from './src/state/LibraryProvider';
import { localDateKey, localDayIsoRange, shiftDateKey } from './src/utils/format';
import { buildOperationalMessages } from './src/utils/operational';
import { cameraPosterUrl, clipDownloadUrl, recordingThumbnailUrl } from './src/utils/media-endpoints';
import { reviewFeedPath, reviewPlayUrl, reviewPlaybackTarget, type ReviewFilters, type ReviewFeedResponse, type ReviewItem } from './src/utils/review';
import type { ActivePlayback, Camera, Direction, MobileCapabilities, Recording, Session, StreamUrls, Tab, User } from './src/types';
import { montarUrlDeReproducao } from './src/utils/playback-source';

// O play-token vale 5 min no servidor; renovar aos 4 dá folga para a
// requisição e a troca de fonte acontecerem antes de vencer.
const PLAY_TOKEN_RENEW_MS = 4 * 60 * 1000;

const RECORDINGS_PAGE_SIZE = 50;

// Antes de qualquer render: um travamento na inicialização é justamente o que
// não se descobre por telefonema.
iniciarRelatorioDeTravamento();
marcarInstalacao(String(Constants.expoConfig?.extra?.client ?? 'default'));

export default function App() {
  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        <ThemeProvider>
          <LibraryProvider>
            <AppInner />
          </LibraryProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}

function AppInner() {
  const { theme, branding, applyBranding } = useTheme();
  const { setScope: setLibraryScope } = useLibrary();
  const { width: winWidth, height: winHeight } = useWindowDimensions();
  const [session, setSession] = useState<Session | null>(null);
  const [apiUrl, setApiUrl] = useState(DEFAULT_API_URL);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [restoringSession, setRestoringSession] = useState(true);
  const [pendingBiometricSession, setPendingBiometricSession] = useState<Session | null>(null);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricLabel, setBiometricLabel] = useState('Biometria');
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<Tab>('central');
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string | null>(null);
  const [liveCamera, setLiveCamera] = useState<Camera | null>(null);
  const [highlightedAlarmId, setHighlightedAlarmId] = useState<string | null>(null);
  // Câmera pedida por um push tocado antes da lista de câmeras carregar (cold start).
  const [pendingPushCameraId, setPendingPushCameraId] = useState<string | null>(null);
  const [notificationsMuted, setNotificationsMuted] = useState(false);
  const [canManageAlarms, setCanManageAlarms] = useState(false);
  const [streamUrls, setStreamUrls] = useState<Record<string, string | null>>({});
  const [streamWhep, setStreamWhep] = useState<Record<string, string | null>>({});
  const [streamPosters, setStreamPosters] = useState<Record<string, string | null>>({});
  // URL HLS de MÁXIMA QUALIDADE (passthrough H.265, sem transcode) da câmera ao
  // vivo aberta. Buscada sob demanda quando o usuário liga o modo HD.
  const [hdUrl, setHdUrl] = useState<string | null>(null);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [recordingsTotal, setRecordingsTotal] = useState(0);
  const [recordingsLoading, setRecordingsLoading] = useState(false);
  const [recordingsLoadingMore, setRecordingsLoadingMore] = useState(false);
  const [recordingsError, setRecordingsError] = useState<string | null>(null);
  const [activePlayback, setActivePlayback] = useState<ActivePlayback | null>(null);
  /** Gravação cujo play-token está sendo emitido — dá retorno ao toque. */
  const [abrindoGravacaoId, setAbrindoGravacaoId] = useState<string | null>(null);
  // Espelho para os timers lerem o playback VIGENTE sem stale closure.
  const activePlaybackRef = useRef<ActivePlayback | null>(null);
  useEffect(() => { activePlaybackRef.current = activePlayback; }, [activePlayback]);
  const [ptzActive, setPtzActive] = useState<Direction | null>(null);
  const [ptzFeedback, setPtzFeedback] = useState<string | null>(null);
  const [recordingActive, setRecordingActive] = useState(false);
  const [recordingBusy, setRecordingBusy] = useState(false);
  // Id do clipe em gravação no servidor (gravação "no celular": o servidor grava
  // o trecho EXATO start→stop e o app baixa o arquivo ao parar).
  const [clipId, setClipId] = useState<string | null>(null);
  // "Minhas gravações" — índice local dos clipes gravados pelo app.
  const [savedClips, setSavedClips] = useState<SavedClip[]>([]);
  const [recordingDate, setRecordingDate] = useState(() => localDateKey());
  const [lastSyncError, setLastSyncError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<MobileCapabilities>({ liveView: true, playback: true, exportEvidence: false, alarmAck: false });
  const [downloadingIds, setDownloadingIds] = useState<string[]>([]);
  // Revisão (item 2.7): fila de eventos + reprodução no instante em modal próprio.
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([]);
  const [reviewTotal, setReviewTotal] = useState(0);
  const [reviewLoadingMore, setReviewLoadingMore] = useState(false);
  const [reviewUnseenCount, setReviewUnseenCount] = useState(0);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewRefreshing, setReviewRefreshing] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewFilters, setReviewFilters] = useState<ReviewFilters>({ onlyConfirmed: true });
  const [reviewPlayback, setReviewPlayback] = useState<ReviewPlayback | null>(null);
  const selectedCamera = cameras.find((camera) => camera.id === selectedCameraId) ?? cameras[0] ?? null;
  const sessionScope = session ? `${session.apiUrl}|${session.user.id}` : 'anonymous';
  const sessionTokenRef = useRef<string | null>(null);
  const recordingDateRef = useRef(recordingDate);
  const recordingDateCameraRef = useRef<string | null>(null);
  const recordingsRef = useRef<Recording[]>([]);
  const clipPhaseRef = useRef<'idle' | 'starting' | 'recording' | 'stopping'>('idle');
  const clipIdRef = useRef<string | null>(null);
  const clipCameraRef = useRef<Camera | null>(null);
  const clipStartedAtRef = useRef<string | null>(null);
  const clipStartPromiseRef = useRef<Promise<void> | null>(null);
  const clipStopPromiseRef = useRef<Promise<void> | null>(null);
  const clipCancelRequestedRef = useRef(false);
  const clipFinalizeSilentRef = useRef(false);
  const recordingRequestRef = useRef(0);
  const playbackRequestRef = useRef(0);
  const reviewRequestRef = useRef(0);
  const reviewPlaybackRequestRef = useRef(0);
  const hdRequestRef = useRef(0);
  const brandingRequestRef = useRef(0);
  const posterRequestRef = useRef(0);
  const lastThumbnailRefreshRef = useRef(0);
  const camerasRequestRef = useRef(0);
  const streamRequestRef = useRef(new Map<string, number>());
  const downloadingRef = useRef(new Set<string>());
  const pendingClipDownloadsRef = useRef(new Set<string>());
  const appStateRef = useRef(AppState.currentState);
  const liveCameraIdRef = useRef<string | null>(null);
  const selectedCameraIdRef = useRef<string | null>(null);
  liveCameraIdRef.current = liveCamera?.id ?? null;
  selectedCameraIdRef.current = selectedCameraId;
  recordingDateRef.current = recordingDate;
  recordingsRef.current = recordings;

  const { alarms, openAlarmCount, reload: reloadAlarms, ack: ackAlarm, resolve: resolveAlarm, erro: alarmesErro, carregando: alarmesCarregando } = useAlarms(session);
  const liveDetections = useLiveDetections(session, liveCamera != null, liveCamera?.id ?? null);

  const operationalMessages = buildOperationalMessages(cameras, lastSyncError);
  const statusBarStyle = isLightColor(theme.bg) ? 'dark' : 'light';

  // Todo conteúdo após o login pode incluir vídeo, miniaturas, eventos ou dados
  // de uma instalação. O app já oferece snapshot/download auditáveis; captura
  // arbitrária da tela não é necessária e contornaria esses controles.
  useEffect(() => {
    const key = 'drac-authenticated-content';
    if (session) {
      void ScreenCapture.preventScreenCaptureAsync(key).catch(() => undefined);
      void ScreenCapture.enableAppSwitcherProtectionAsync(1).catch(() => undefined);
    } else {
      void ScreenCapture.allowScreenCaptureAsync(key).catch(() => undefined);
      void ScreenCapture.disableAppSwitcherProtectionAsync().catch(() => undefined);
    }
  }, [session?.user.id]);

  // Busca a marca (logo/nome/cores) do servidor e aplica no tema. Silencioso:
  // se falhar (offline, sem branding configurado), mantém o tema padrão.
  const loadBranding = (url: string) => {
    if (!url) return;
    const generation = ++brandingRequestRef.current;
    fetchBranding(url)
      .then((next) => {
        if (brandingRequestRef.current === generation) applyBranding(next);
      })
      .catch(() => undefined);
  };

  const activateSession = (next: Session) => {
    sessionTokenRef.current = next.token;
    setSession(next);
    setApiUrl(next.apiUrl);
    setEmail(next.user.email);
    setPendingBiometricSession(null);
    loadBranding(next.apiUrl);
  };

  const renewStoredSession = async (stored: Session): Promise<Session | null> => {
    if (!stored.refreshToken) return stored;
    try {
      const data = await request<{
        accessToken: string;
        refreshToken: string;
        refreshExpiresAt: string;
        user: User;
      }>(stored.apiUrl, '/auth/refresh', undefined, {
        method: 'POST',
        body: JSON.stringify({ refreshToken: stored.refreshToken }),
      });
      const renewed: Session = {
        apiUrl: stored.apiUrl,
        token: data.accessToken,
        refreshToken: data.refreshToken,
        refreshExpiresAt: data.refreshExpiresAt,
        user: data.user,
      };
      await saveStoredSession(renewed);
      return renewed;
    } catch (error) {
      // Falha de rede não elimina uma sessão ainda utilizável. Apenas uma recusa
      // explícita da API significa sete dias de inatividade/revogação.
      if ((error as { status?: number })?.status === 401) {
        await clearStoredSession();
        return null;
      }
      return stored;
    }
  };

  const unlockPendingSession = async () => {
    const stored = pendingBiometricSession;
    if (!stored) return;
    setLoading(true);
    try {
      if (!(await authenticateWithBiometrics('Confirme sua identidade para entrar'))) return;
      const renewed = await renewStoredSession(stored);
      if (renewed) activateSession(renewed);
      else Alert.alert('Sessão expirada', 'Sua conta ficou mais de sete dias sem acesso. Entre novamente com sua senha.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Em builds white-label o servidor já vem embutido: aplica a marca já no login.
    if (DEFAULT_API_URL) loadBranding(DEFAULT_API_URL);

    void (async () => {
      try {
        const [raw, enabled, support] = await Promise.all([
          loadStoredSession(),
          isBiometricLoginEnabled(),
          getBiometricSupport().catch(() => ({ available: false, label: 'Biometria' })),
        ]);
        setBiometricAvailable(support.available);
        setBiometricLabel(support.label);
        setBiometricEnabled(enabled);
        if (!raw) return;
        const stored = JSON.parse(raw) as Session;
        const normalized = { ...stored, apiUrl: cleanApiUrl(stored.apiUrl) };
        setApiUrl(normalized.apiUrl);
        setEmail(normalized.user.email);
        if (normalized.apiUrl !== stored.apiUrl) await saveStoredSession(normalized);

        if (enabled) {
          setPendingBiometricSession(normalized);
          if (!support.available) return;
          if (!(await authenticateWithBiometrics('Confirme sua identidade para entrar'))) return;
        }
        const renewed = await renewStoredSession(normalized);
        if (renewed) activateSession(renewed);
      } catch {
        // Mantém a tela de login utilizável mesmo se o armazenamento local falhar.
      } finally {
        setRestoringSession(false);
      }
    })();
  }, []);

  useEffect(() => {
    sessionTokenRef.current = session?.token ?? null;
    setLibraryScope(sessionScope);
    if (!session) {
      setSavedClips([]);
      return;
    }
    let cancelled = false;
    void listClips(sessionScope).then((items) => {
      if (!cancelled && sessionTokenRef.current === session.token) setSavedClips(items);
    });
    void resumePendingClips(session);
    return () => { cancelled = true; };
  }, [sessionScope, session?.token, setLibraryScope]);

  useEffect(() => {
    if (session) void loadAll();
  }, [session?.token]);

  useEffect(() => {
    if (!session?.refreshToken) {
      setTokenRefreshHandler(null);
      return;
    }
    setTokenRefreshHandler(async (expiredToken) => {
      // Outra requisição pode já ter renovado a sessão enquanto esta aguardava.
      if (expiredToken !== sessionTokenRef.current) return sessionTokenRef.current;
      try {
        const data = await request<{
          accessToken: string;
          refreshToken: string;
          refreshExpiresAt: string;
          user: User;
        }>(session.apiUrl, '/auth/refresh', undefined, {
          method: 'POST',
          body: JSON.stringify({ refreshToken: session.refreshToken }),
        });
        const renewed: Session = {
          ...session,
          token: data.accessToken,
          refreshToken: data.refreshToken,
          refreshExpiresAt: data.refreshExpiresAt,
          user: data.user,
        };
        await saveStoredSession(renewed);
        sessionTokenRef.current = renewed.token;
        setSession(renewed);
        return renewed.token;
      } catch {
        return null;
      }
    });
    return () => setTokenRefreshHandler(null);
  }, [session?.token, session?.refreshToken, session?.apiUrl]);

  useEffect(() => {
    if (!session) { setCanManageAlarms(false); return; }
    const token = session.token;
    void request<{ permissions?: Partial<MobileCapabilities> }>(session.apiUrl, '/role-permissions/me', token)
      .then((data) => {
        if (sessionTokenRef.current !== token) return;
        const next = {
          liveView: data.permissions?.liveView !== false,
          playback: data.permissions?.playback !== false,
          exportEvidence: data.permissions?.exportEvidence === true,
          alarmAck: data.permissions?.alarmAck === true,
        };
        setCapabilities(next);
        setCanManageAlarms(next.alarmAck);
      })
      .catch(() => {
        if (sessionTokenRef.current === token) {
          const fallback = { liveView: true, playback: true, exportEvidence: false, alarmAck: false };
          setCapabilities(fallback);
          setCanManageAlarms(false);
        }
      });
  }, [session?.token, session?.apiUrl]);

  // Push de alarmes + sessão expirada. Ao autenticar: registra o handler de 401
  // (logout gracioso quando o token morre) e o aparelho para push; ao tocar na
  // notificação, abre Alarmes e recarrega. Falha de push nunca quebra o app.
  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    let disposed = false;
    setUnauthorizedHandler((requestToken) => {
      if (requestToken === sessionTokenRef.current) void logout(false);
    });
    void registerForPush(session.apiUrl, session.token, controller.signal).then((expoToken) => {
      if (disposed && expoToken) void unregisterFromPush(session.apiUrl, session.token, expoToken);
    });
    const unsubscribe = subscribeToNotificationTaps((data) => {
      setHighlightedAlarmId(data.alarmId ?? null);
      setTab('alarmes');
      void reloadAlarms();
      // Deep link: push de uma câmera específica abre a câmera AO VIVO direto
      // (a lista pode ainda não ter carregado no cold start — fica pendente e
      // o efeito abaixo dispara quando as câmeras chegarem).
      if (data.cameraId) setPendingPushCameraId(data.cameraId);
    });
    return () => {
      disposed = true;
      controller.abort();
      setUnauthorizedHandler(null);
      unsubscribe();
    };
  }, [session?.token]);

  // Orientação: o app é retrato; SÓ a tela ao vivo libera paisagem (gira ao deitar
  // o aparelho) e volta a travar em retrato ao sair.
  useEffect(() => {
    if (liveCamera) {
      ScreenOrientation.unlockAsync().catch(() => undefined);
      void loadStream(liveCamera.id, 'selected', true);
      void loadNotificationMute(liveCamera.id);
    } else {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => undefined);
    }
  }, [liveCamera]);

  useEffect(() => {
    if (selectedCamera && session && capabilities.playback) {
      if (recordingDateCameraRef.current !== selectedCamera.id) {
        recordingDateCameraRef.current = selectedCamera.id;
        void loadLatestRecordingDate(selectedCamera.id);
      } else {
        void loadRecordings(selectedCamera.id, recordingDate);
      }
    } else if (!capabilities.playback) {
      recordingRequestRef.current += 1;
      setRecordings([]);
      setRecordingsTotal(0);
      setRecordingsLoading(false);
      setRecordingsLoadingMore(false);
      setRecordingsError('Você não possui permissão para visualizar gravações.');
      playbackRequestRef.current += 1;
      setActivePlayback(null);
    }
  }, [selectedCamera?.id, session?.token, recordingDate, capabilities.playback]);

  // Revisão: ao entrar na aba (ou trocar de sessão), carrega a fila com os
  // filtros atuais. As trocas de filtro recarregam via changeReviewFilters.
  useEffect(() => {
    if (tab !== 'revisao' || !session || !capabilities.playback) return;
    void loadReview(reviewFilters);
    void loadReviewUnseen();
  }, [tab, session?.token, capabilities.playback]);

  // A URL de máxima qualidade é por câmera; não vaza entre telas.
  useEffect(() => {
    setHdUrl(null);
  }, [liveCamera?.id]);

  // Máxima qualidade: busca o HLS passthrough (H.265) sob demanda.
  const loadHdStream = async (cameraId: string) => {
    if (!session) return;
    const token = session.token;
    const generation = ++hdRequestRef.current;
    try {
      const data = await requestCachedStreamUrls<StreamUrls>(session.apiUrl, cameraId, session.token, undefined, 'original');
      if (sessionTokenRef.current !== token || hdRequestRef.current !== generation || liveCameraIdRef.current !== cameraId) return;
      const hls = authenticatedMediaUrl(data.protocols?.hlsUrl, session.apiUrl, data.streamToken);
      if (!hls) throw new Error('sem HLS');
      setHdUrl(hls);
    } catch {
      if (sessionTokenRef.current !== token || hdRequestRef.current !== generation || liveCameraIdRef.current !== cameraId) return;
      setHdUrl(null);
      Alert.alert('Máxima qualidade', 'Não foi possível abrir a máxima qualidade desta câmera agora.');
    }
  };

  const login = async () => {
    setLoading(true);
    try {
      const nextApiUrl = cleanApiUrl(apiUrl);
      if (!nextApiUrl) throw new Error('Informe a URL da API no campo "Servidor".');
      const data = await request<{
        accessToken: string;
        refreshToken: string;
        refreshExpiresAt: string;
        user: User;
      }>(nextApiUrl, '/auth/login', undefined, {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      const nextSession: Session = {
        apiUrl: nextApiUrl,
        token: data.accessToken,
        refreshToken: data.refreshToken,
        refreshExpiresAt: data.refreshExpiresAt,
        user: data.user,
      };
      await saveStoredSession(nextSession);
      clearStreamUrlsCache();
      activateSession(nextSession);
      setPassword('');
      // Aplica a marca da instalação que acabou de logar (caso o servidor não
      // estivesse embutido no APK, ex.: app DRAC padrão apontando p/ um cliente).
      loadBranding(nextApiUrl);
      if (biometricAvailable && !biometricEnabled) {
        Alert.alert(
          'Ativar acesso por biometria?',
          `Nos próximos acessos, use ${biometricLabel.toLowerCase()} sem digitar a senha.`,
          [
            { text: 'Agora não', style: 'cancel' },
            {
              text: 'Ativar',
              onPress: () => {
                void (async () => {
                  if (!(await authenticateWithBiometrics('Confirme a biometria para ativar'))) return;
                  await setBiometricLoginEnabled(true);
                  setBiometricEnabled(true);
                })();
              },
            },
          ],
        );
      }
    } catch (error) {
      Alert.alert('Falha no login', error instanceof Error ? error.message : 'Não foi possível entrar.');
    } finally {
      setLoading(false);
    }
  };

  const forgotPassword = async () => {
    const targetEmail = email.trim();
    if (!targetEmail) {
      Alert.alert('Esqueci minha senha', 'Informe o e-mail da sua conta no campo acima e toque novamente.');
      return;
    }
    const nextApiUrl = cleanApiUrl(apiUrl);
    if (!nextApiUrl) {
      Alert.alert('Esqueci minha senha', 'Informe a URL do servidor antes de continuar.');
      return;
    }
    try {
      await request(nextApiUrl, '/auth/forgot-password', undefined, {
        method: 'POST',
        body: JSON.stringify({ email: targetEmail }),
      });
    } catch {
      // O backend responde igual existindo ou não a conta (evita enumeração de e-mails).
    }
    Alert.alert(
      'Verifique seu e-mail',
      `Se houver uma conta para ${targetEmail}, enviamos um link para redefinir a senha. Abra o link no navegador para concluir.`,
    );
  };

  const logout = async (revokeServer = true) => {
    const previous = session;
    void stopActiveClip(true);
    sessionTokenRef.current = null;
    setUnauthorizedHandler(null);
    setTokenRefreshHandler(null);
    clearStreamUrlsCache();
    setSession(null);
    setCameras([]);
    setSelectedCameraId(null);
    recordingDateCameraRef.current = null;
    setRecordings([]);
    setRecordingsTotal(0);
    setRecordingsLoading(false);
    setRecordingsLoadingMore(false);
    setRecordingsError(null);
    setStreamUrls({});
    setStreamWhep({});
    setStreamPosters({});
    setHdUrl(null);
    setActivePlayback(null);
    setNotificationsMuted(false);
    setCanManageAlarms(false);
    setCapabilities({ liveView: true, playback: true, exportEvidence: false, alarmAck: false });
    downloadingRef.current.clear();
    pendingClipDownloadsRef.current.clear();
    setDownloadingIds([]);
    recordingRequestRef.current += 1;
    playbackRequestRef.current += 1;
    hdRequestRef.current += 1;
    posterRequestRef.current += 1;
    camerasRequestRef.current += 1;
    streamRequestRef.current.clear();
    setHighlightedAlarmId(null);
    setLiveCamera(null);
    setTab('central');
    setRefreshing(false);
    setLastSyncError(null);
    await clearStoredSession();
    if (previous) {
      void unregisterFromPush(previous.apiUrl, previous.token);
      if (revokeServer) {
        void request(previous.apiUrl, '/auth/logout', previous.token, { method: 'POST' }).catch(() => undefined);
      }
    }
  };

  const changeBiometricPreference = async (enabled: boolean) => {
    if (!enabled) {
      await setBiometricLoginEnabled(false);
      setBiometricEnabled(false);
      return;
    }
    const support = await getBiometricSupport().catch(() => ({ available: false, label: 'Biometria' }));
    setBiometricAvailable(support.available);
    setBiometricLabel(support.label);
    if (!support.available) {
      Alert.alert('Biometria indisponível', 'Cadastre uma impressão digital ou reconhecimento facial nos ajustes do aparelho.');
      return;
    }
    if (!(await authenticateWithBiometrics('Confirme a biometria para ativar'))) return;
    await setBiometricLoginEnabled(true);
    setBiometricEnabled(true);
  };

  const loadAll = async (quiet = false) => {
    if (!session) return;
    const token = session.token;
    const generation = ++camerasRequestRef.current;
    if (!quiet) setRefreshing(true);
    try {
      const raw = await request<Camera[]>(session.apiUrl, '/cameras', session.token);
      if (sessionTokenRef.current !== token || camerasRequestRef.current !== generation) return;
      // Câmeras DESATIVADAS no sistema não aparecem no app (o servidor também
      // recusa o stream delas; some da lista para não virar "câmera quebrada").
      const data = raw.filter((camera) => camera.enabled !== false);
      setCameras(data);
      setLastSyncError(null);
      setSelectedCameraId((current) => (current && data.some((camera) => camera.id === current) ? current : data[0]?.id ?? null));
      void reloadAlarms();
      void loadReviewUnseen();
      // Status sonda a cada 30s; posters têm renovação própria (3,5 min) para
      // não forçar dezenas de frames a cada ciclo silencioso.
      if (!quiet) void loadAllPosters(data);
    } catch (error) {
      if (sessionTokenRef.current !== token || camerasRequestRef.current !== generation) return;
      const status = (error as { status?: number })?.status;
      const message = error instanceof Error ? error.message : 'Não foi possível carregar câmeras.';
      const isAuthError = status === 401 || /\b401\b|unauthorized|não autorizado/i.test(message);
      setLastSyncError(isAuthError ? 'Sessão expirada. Entre novamente.' : `Servidor indisponível: ${message}`);
      if (isAuthError) {
        await logout(false);
        Alert.alert('Sessão expirada', 'Sua sessão expirou. Entre novamente para continuar.');
      } else if (!quiet) {
        Alert.alert('Falha ao carregar', message);
      }
    } finally {
      if (!quiet && sessionTokenRef.current === token && camerasRequestRef.current === generation) setRefreshing(false);
    }
  };

  const loadStream = async (cameraId: string, viewMode: 'selected' | 'grid' = 'selected', force = false) => {
    if (!session) return;
    const token = session.token;
    const generation = (streamRequestRef.current.get(cameraId) ?? 0) + 1;
    streamRequestRef.current.set(cameraId, generation);
    try {
      if (force) clearStreamUrlsCache(cameraId);
      const data = await requestCachedStreamUrls<StreamUrls>(session.apiUrl, cameraId, session.token, undefined, viewMode);
      if (sessionTokenRef.current !== token || streamRequestRef.current.get(cameraId) !== generation) return;
      const hlsUrl = authenticatedMediaUrl(data.protocols?.hlsUrl, session.apiUrl, data.streamToken);
      const whepRaw =
        data.protocols?.whepUrl
        ?? (data.protocols?.webrtcUrl ? `${data.protocols.webrtcUrl.replace(/\/+$/, '')}/whep` : null);
      const whepUrl = authenticatedMediaUrl(whepRaw, session.apiUrl, data.streamToken);
      // Poster montado a partir do session.apiUrl (alcançável pelo celular), não
      // do host que a API devolve (pode ser interno do Docker atrás do nginx).
      const posterUrl = data.streamToken ? cameraPosterUrl(session.apiUrl, cameraId, data.streamToken) : null;
      setStreamUrls((current) => ({ ...current, [cameraId]: hlsUrl }));
      setStreamWhep((current) => ({ ...current, [cameraId]: whepUrl }));
      setStreamPosters((current) => ({ ...current, [cameraId]: posterUrl }));
      if (session.apiUrl.startsWith('https://') && ((hlsUrl && !isSecureMediaUrl(hlsUrl)) || (whepUrl && !isSecureMediaUrl(whepUrl)))) {
        setLastSyncError('A mídia ao vivo precisa ser publicada por HTTPS nesta instalação.');
      }
    } catch {
      if (sessionTokenRef.current !== token || streamRequestRef.current.get(cameraId) !== generation) return;
      setStreamUrls((current) => ({ ...current, [cameraId]: null }));
      setStreamWhep((current) => ({ ...current, [cameraId]: null }));
      setStreamPosters((current) => ({ ...current, [cameraId]: null }));
    }
  };

  // Snapshot (poster) em TODOS os tiles, não só nos que abrem o stream. Usa o
  // endpoint em lote /camera-stream/poster-tokens (só emite token, NÃO inicia
  // restream) e publica os posters em lotes escalonados para não disparar muitos
  // frames ffmpeg de uma vez no servidor. Best-effort: falha = tiles com gradiente.
  const loadAllPosters = async (cams: Camera[]) => {
    if (!session || cams.length === 0) return;
    const onlineCameras = cams.filter((camera) => camera.status?.toUpperCase() === 'ONLINE');
    const onlineIds = new Set(onlineCameras.map((camera) => camera.id));
    setStreamPosters((current) => {
      const next = { ...current };
      for (const camera of cams) {
        if (!onlineIds.has(camera.id)) next[camera.id] = null;
      }
      return next;
    });
    if (!onlineCameras.length) return;
    const token = session.token;
    const generation = ++posterRequestRef.current;
    try {
      const { items } = await request<{ items: { cameraId: string; streamToken: string }[] }>(
        session.apiUrl,
        '/camera-stream/poster-tokens',
        session.token,
        { method: 'POST', body: JSON.stringify({ cameraIds: onlineCameras.map((c) => c.id) }) },
      );
      // Monta a URL do poster a partir do session.apiUrl (SEMPRE alcançável pelo
      // celular). NÃO usa o host que a API devolve — atrás do nginx/Docker ele
      // pode vir interno (ex.: vms-api:3000), que o celular não acessa → tile preto.
      let cursor = 0;
      const worker = async () => {
        while (cursor < items.length) {
          const item = items[cursor++];
          if (sessionTokenRef.current !== token || posterRequestRef.current !== generation) return;
          const url = cameraPosterUrl(session.apiUrl, item.cameraId, item.streamToken);
          try { await Image.prefetch(url); } catch { /* CameraTile oferece retry/token novo. */ }
          if (sessionTokenRef.current !== token || posterRequestRef.current !== generation) return;
          setStreamPosters((current) => ({ ...current, [item.cameraId]: url }));
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, items.length) }, () => worker()));
    } catch {
      // sem posters: os tiles caem no gradiente placeholder.
    }
  };

  const refreshPoster = async (cameraId: string): Promise<string | null> => {
    if (!session) return null;
    const token = session.token;
    try {
      const { items } = await request<{ items: { cameraId: string; streamToken: string }[] }>(
        session.apiUrl,
        '/camera-stream/poster-tokens',
        token,
        { method: 'POST', body: JSON.stringify({ cameraIds: [cameraId] }) },
      );
      if (sessionTokenRef.current !== token) return null;
      const item = items[0];
      if (!item) return null;
      const url = cameraPosterUrl(session.apiUrl, cameraId, item.streamToken);
      try { await Image.prefetch(url); } catch { /* o componente ainda fará retry */ }
      if (sessionTokenRef.current === token) {
        setStreamPosters((current) => ({ ...current, [cameraId]: url }));
        return url;
      }
      return null;
    } catch { return null; }
  };

  const applyThumbnailTokens = async (items: Recording[], generation?: number) => {
    if (!session || !items.length) return;
    const token = session.token;
    const thumbnailTokens = await request<Record<string, string>>(
      session.apiUrl,
      '/recordings/thumbnail-tokens',
      token,
      { method: 'POST', body: JSON.stringify({ recordingIds: items.map((item) => item.id) }) },
    );
    if (sessionTokenRef.current !== token || (generation != null && recordingRequestRef.current !== generation)) return;
    setRecordings((current) => current.map((item) => {
      const thumbnailToken = thumbnailTokens[item.id];
      return thumbnailToken ? {
        ...item,
        thumbnailUrl: recordingThumbnailUrl(session.apiUrl, item.id, thumbnailToken),
      } : item;
    }));
  };

  const refreshExpiredThumbnails = () => {
    const now = Date.now();
    if (now - lastThumbnailRefreshRef.current < 5_000) return;
    lastThumbnailRefreshRef.current = now;
    if (recordingsRef.current.length) {
      void applyThumbnailTokens(recordingsRef.current).catch(() => undefined);
    }
  };

  const loadRecordings = async (cameraId: string, date = recordingDate, append = false) => {
    if (!session) return;
    const token = session.token;
    const generation = ++recordingRequestRef.current;
    const offset = append ? recordingsRef.current.length : 0;
    if (append) setRecordingsLoadingMore(true);
    else {
      setRecordingsLoading(true);
      setRecordingsError(null);
      setRecordings([]);
      setRecordingsTotal(0);
    }
    try {
      const { from, to } = localDayIsoRange(date);
      const data = await request<{ items: Recording[]; total?: number }>(
        session.apiUrl,
        `/recordings?cameraId=${encodeURIComponent(cameraId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=${RECORDINGS_PAGE_SIZE}&offset=${offset}&sort=desc`,
        token,
      );
      if (
        sessionTokenRef.current !== token
        || recordingRequestRef.current !== generation
        || selectedCameraIdRef.current !== cameraId
        || recordingDateRef.current !== date
      ) return;
      const items = Array.isArray(data.items) ? data.items.map((item) => ({ ...item, thumbnailUrl: null })) : [];
      setRecordings((current) => append
        ? [...current, ...items.filter((item) => !current.some((existing) => existing.id === item.id))]
        : items);
      setRecordingsTotal(Number.isFinite(data.total)
        ? Number(data.total)
        : offset + items.length + (items.length === RECORDINGS_PAGE_SIZE ? 1 : 0));
      setRecordingsError(null);
      if (!append) setActivePlayback(null);
      try { await applyThumbnailTokens(items, generation); } catch { /* lista permanece funcional */ }
    } catch (error) {
      if (sessionTokenRef.current !== token || recordingRequestRef.current !== generation) return;
      const status = (error as { status?: number })?.status;
      setRecordingsError(status === 403
        ? 'Você não possui permissão para visualizar estas gravações.'
        : error instanceof Error ? error.message : 'Não foi possível carregar as gravações.');
    } finally {
      if (recordingRequestRef.current === generation) {
        setRecordingsLoading(false);
        setRecordingsLoadingMore(false);
      }
    }
  };

  const loadMoreRecordings = () => {
    if (!selectedCamera || recordingsLoading || recordingsLoadingMore || recordingsRef.current.length >= recordingsTotal) return;
    void loadRecordings(selectedCamera.id, recordingDateRef.current, true);
  };

  const loadLatestRecordingDate = async (cameraId: string) => {
    if (!session) return;
    const token = session.token;
    const generation = ++recordingRequestRef.current;
    setRecordingsLoading(true);
    setRecordingsError(null);
    setRecordings([]);
    setRecordingsTotal(0);
    setActivePlayback(null);
    try {
      const data = await request<{ items: Recording[] }>(
        session.apiUrl,
        `/recordings?cameraId=${encodeURIComponent(cameraId)}&limit=1&sort=desc`,
        session.token,
      );
      if (sessionTokenRef.current !== token || recordingRequestRef.current !== generation || recordingDateCameraRef.current !== cameraId) return;
      const latest = Array.isArray(data.items) ? data.items[0] : null;
      const latestDate = latest?.startedAt ? localDateKey(new Date(latest.startedAt)) : localDateKey();
      if (recordingDateRef.current === latestDate) {
        await loadRecordings(cameraId, latestDate);
      } else {
        setRecordingDate(latestDate);
      }
    } catch (error) {
      if (sessionTokenRef.current !== token || recordingRequestRef.current !== generation || recordingDateCameraRef.current !== cameraId) return;
      const status = (error as { status?: number })?.status;
      setRecordingsError(status === 403
        ? 'Você não possui permissão para visualizar estas gravações.'
        : error instanceof Error ? error.message : 'Não foi possível localizar a gravação mais recente.');
    } finally {
      if (recordingRequestRef.current === generation) setRecordingsLoading(false);
    }
  };

  // Silenciamento de notificações por câmera (por usuário). Busca o estado ao
  // abrir a câmera e alterna com o botão "Alertas".
  const loadNotificationMute = async (cameraId: string) => {
    if (!session) return;
    const token = session.token;
    try {
      const r = await request<{ muted: boolean }>(session.apiUrl, `/notifications/camera/${cameraId}/mute`, session.token);
      if (sessionTokenRef.current !== token || liveCameraIdRef.current !== cameraId) return;
      setNotificationsMuted(Boolean(r?.muted));
    } catch {
      if (sessionTokenRef.current !== token || liveCameraIdRef.current !== cameraId) return;
      setNotificationsMuted(false);
    }
  };

  const toggleNotifications = async (camera: Camera) => {
    if (!session) return;
    const next = !notificationsMuted;
    setNotificationsMuted(next); // otimista
    try {
      await request(session.apiUrl, `/notifications/camera/${camera.id}/mute`, session.token, {
        method: 'POST',
        body: JSON.stringify({ muted: next }),
      });
    } catch {
      if (liveCameraIdRef.current === camera.id) setNotificationsMuted(!next); // reverte em erro
    }
  };

  const shiftRecordingDate = (days: number) => {
    playbackRequestRef.current += 1;
    setRecordingDate((current) => shiftDateKey(current, days));
    setActivePlayback(null);
    setRecordings([]);
    setRecordingsError(null);
  };

  const sendPtz = async (direction: Direction) => {
    const target = liveCamera;
    if (!session || !target?.canControl) return;
    setPtzActive(direction);
    setPtzFeedback(direction);
    // Mensagem SEMPRE limpa (nunca o erro técnico cru): o PTZ falha tanto com
    // HTTP 200 { status:'error' } (câmera recusa) quanto lançando exceção
    // (ONVIF indisponível). Nos dois casos o usuário só precisa saber isto:
    const ptzFail = () => {
      setPtzFeedback(null);
      Alert.alert('PTZ', 'Não foi possível movimentar. Esta câmera pode não ter suporte a PTZ.');
    };
    try {
      const data = await request<{ status?: string; message?: string }>(
        session.apiUrl,
        `/ptz/${target.id}/move`,
        session.token,
        { method: 'POST', body: JSON.stringify({ action: 'step', direction, durationMs: 450, speed: 5 }) },
      );
      if (data?.status === 'error') { ptzFail(); return; }
      setTimeout(() => setPtzFeedback(null), 650);
    } catch {
      ptzFail();
    } finally {
      setTimeout(() => setPtzActive(null), 220);
    }
  };

  const resetClipState = () => {
    clipPhaseRef.current = 'idle';
    clipIdRef.current = null;
    clipCameraRef.current = null;
    clipStartedAtRef.current = null;
    clipCancelRequestedRef.current = false;
    clipFinalizeSilentRef.current = false;
    setClipId(null);
    setRecordingActive(false);
    setRecordingBusy(false);
  };

  /**
   * Baixa um clipe já encerrado e persistido na fila local. O arquivo usa nome
   * determinístico para que retries não criem órfãos ou cópias duplicadas.
   */
  const downloadPendingClip = async (currentSession: Session, pending: PendingClip, silent = false): Promise<boolean> => {
    if (pendingClipDownloadsRef.current.has(pending.id)) return false;
    pendingClipDownloadsRef.current.add(pending.id);
    const scope = `${currentSession.apiUrl}|${currentSession.user.id}`;
    const safeId = pending.id.replace(/[^a-zA-Z0-9_-]/g, '-');
    const target = `${FileSystem.documentDirectory}clip-${safeId}.mp4`;
    try {
      await FileSystem.deleteAsync(target, { idempotent: true }).catch(() => undefined);
      const url = clipDownloadUrl(currentSession.apiUrl, pending.id);
      const result = await FileSystem.downloadAsync(url, target, {
        headers: { Authorization: `Bearer ${currentSession.token}` },
      });
      if (result.status && result.status >= 400) throw new Error(`Falha ao baixar o clipe (HTTP ${result.status}).`);
      const thumbnailUri = await createClipThumbnail(result.uri, safeId);
      let savedToGallery = false;
      try { savedToGallery = await saveToGallery(result.uri); } catch { /* o clipe local continua válido */ }
      const next = await addClip(scope, {
        id: pending.id,
        cameraId: pending.cameraId,
        cameraName: pending.cameraName,
        uri: result.uri,
        thumbnailUri,
        createdAt: pending.createdAt,
      });
      await removePendingClip(scope, pending.id);
      if (sessionTokenRef.current === currentSession.token) setSavedClips(next);
      if (!silent && sessionTokenRef.current === currentSession.token) {
        Alert.alert('Gravação salva', savedToGallery
          ? 'Clipe salvo na galeria e em "Minhas gravações".'
          : 'Clipe salvo em "Minhas gravações". A galeria não concedeu permissão.');
      }
      return true;
    } catch (error) {
      await FileSystem.deleteAsync(target, { idempotent: true }).catch(() => undefined);
      if (!silent && sessionTokenRef.current === currentSession.token) {
        Alert.alert(
          'Gravação pendente',
          `${error instanceof Error ? error.message : 'Não foi possível baixar o clipe.'}\nO app tentará novamente quando voltar ao primeiro plano.`,
        );
      }
      return false;
    } finally {
      pendingClipDownloadsRef.current.delete(pending.id);
    }
  };

  const resumePendingClips = async (currentSession: Session) => {
    if (AppState.currentState !== 'active') return;
    const scope = `${currentSession.apiUrl}|${currentSession.user.id}`;
    const pending = await listPendingClips(scope);
    for (const item of pending) {
      if (AppState.currentState !== 'active' || sessionTokenRef.current !== currentSession.token) return;
      if (item.id === clipIdRef.current && clipStopPromiseRef.current) {
        await clipStopPromiseRef.current;
        continue;
      }
      let ready = item;
      if (item.status === 'recording') {
        try {
          await request(currentSession.apiUrl, `/camera-stream/clip/${encodeURIComponent(item.id)}/stop`, currentSession.token, {
            method: 'POST', body: JSON.stringify({}),
          });
          ready = { ...item, status: 'stopped' };
          await savePendingClip(scope, ready);
        } catch {
          // Mantém como recording para a próxima retomada; não tenta baixar um
          // arquivo que o servidor ainda pode estar escrevendo.
          continue;
        }
      }
      await downloadPendingClip(currentSession, ready, true);
    }
  };

  /** Encerra, persiste e indexa um clipe. A Promise compartilhada impede stop duplo. */
  const finalizeClip = async (camera: Camera, id: string, silent = false) => {
    if (clipStopPromiseRef.current) return clipStopPromiseRef.current;
    if (!session) { resetClipState(); return; }
    const currentSession = session;
    const scope = `${currentSession.apiUrl}|${currentSession.user.id}`;
    clipPhaseRef.current = 'stopping';
    setRecordingBusy(true);
    setRecordingActive(false);

    const run = (async () => {
      try {
        await request(currentSession.apiUrl, `/camera-stream/clip/${id}/stop`, currentSession.token, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const pending: PendingClip = {
          id,
          cameraId: camera.id,
          cameraName: camera.name,
          createdAt: clipStartedAtRef.current ?? new Date().toISOString(),
          status: 'stopped',
        };
        await savePendingClip(scope, pending);
        // Em background/logout, termina o processo do servidor e deixa a etapa
        // pesada de download/thumbnail para o próximo foreground.
        if (AppState.currentState === 'active' && sessionTokenRef.current === currentSession.token) {
          await downloadPendingClip(currentSession, pending, silent);
        }
      } catch (error) {
        if (!silent) Alert.alert('Gravação', error instanceof Error ? error.message : 'Não foi possível salvar o clipe.');
      } finally {
        clipStopPromiseRef.current = null;
        resetClipState();
      }
    })();
    clipStopPromiseRef.current = run;
    return run;
  };

  const startClip = async (camera: Camera) => {
    if (!session || clipPhaseRef.current !== 'idle') return;
    const currentSession = session;
    clipPhaseRef.current = 'starting';
    clipCameraRef.current = camera;
    clipCancelRequestedRef.current = false;
    setRecordingBusy(true);

    const run = (async () => {
      try {
        const data = await request<{ clipId: string }>(
          currentSession.apiUrl,
          `/camera-stream/${camera.id}/clip/start`,
          currentSession.token,
          { method: 'POST', body: JSON.stringify({}) },
        );
        clipIdRef.current = data.clipId;
        const startedAt = new Date().toISOString();
        clipStartedAtRef.current = startedAt;
        setClipId(data.clipId);
        try {
          await savePendingClip(`${currentSession.apiUrl}|${currentSession.user.id}`, {
            id: data.clipId,
            cameraId: camera.id,
            cameraName: camera.name,
            createdAt: startedAt,
            status: 'recording',
          });
        } catch {
          await request(currentSession.apiUrl, `/camera-stream/clip/${encodeURIComponent(data.clipId)}/stop`, currentSession.token, {
            method: 'POST', body: JSON.stringify({}),
          }).catch(() => undefined);
          throw new Error('Não foi possível preparar o armazenamento local da gravação.');
        }
        if (clipCancelRequestedRef.current || sessionTokenRef.current !== currentSession.token) {
          await finalizeClip(camera, data.clipId, clipFinalizeSilentRef.current);
          return;
        }
        clipPhaseRef.current = 'recording';
        setRecordingActive(true);
        setRecordingBusy(false);
      } catch (error) {
        const shouldNotify = sessionTokenRef.current === currentSession.token && !clipFinalizeSilentRef.current;
        resetClipState();
        if (shouldNotify) {
          Alert.alert('Gravação', error instanceof Error ? error.message : 'Não foi possível iniciar a gravação.');
        }
      } finally {
        clipStartPromiseRef.current = null;
      }
    })();
    clipStartPromiseRef.current = run;
    return run;
  };

  const stopActiveClip = async (silent = false) => {
    if (clipPhaseRef.current === 'idle') return;
    clipCancelRequestedRef.current = true;
    clipFinalizeSilentRef.current = silent;
    if (clipStartPromiseRef.current) await clipStartPromiseRef.current;
    if (clipStopPromiseRef.current) return clipStopPromiseRef.current;
    const camera = clipCameraRef.current;
    const id = clipIdRef.current;
    if (camera && id) return finalizeClip(camera, id, silent);
    resetClipState();
  };

  // Botão Gravar (SÓ celular): grava no servidor o trecho EXATO start→stop e,
  // ao parar, baixa o arquivo pro aparelho. Transições são bloqueadas para evitar
  // starts/stops concorrentes e clipes sem referência.
  const toggleRecording = async (camera: Camera) => {
    if (!session || recordingBusy) return;
    if (clipPhaseRef.current === 'recording') await finalizeClip(camera, clipIdRef.current!, false);
    else if (clipPhaseRef.current === 'idle') await startClip(camera);
  };

  const leaveLive = (afterLeave?: () => void) => {
    const finish = () => {
      playbackRequestRef.current += 1;
      setActivePlayback(null);
      setLiveCamera(null);
      afterLeave?.();
    };
    if (clipPhaseRef.current === 'idle') { finish(); return; }
    Alert.alert(
      'Gravação em andamento',
      'Deseja parar e salvar o clipe antes de sair da câmera?',
      [
        { text: 'Continuar gravando', style: 'cancel' },
        { text: 'Parar e sair', onPress: () => { void stopActiveClip(false).then(finish); } },
      ],
    );
  };

  // Reproduz um clipe local ("Minhas gravações") no mesmo player, sem servidor.
  const playLocalClip = (clip: SavedClip) => {
    playbackRequestRef.current += 1;
    setActivePlayback({
      recording: { id: clip.id, cameraId: clip.cameraId, startedAt: clip.createdAt, thumbnailUrl: clip.thumbnailUri },
      url: clip.uri,
      // Arquivo local: não passa pelo servidor, então não há fonte a negociar
      // nem token a renovar (o efeito de renovação ignora URLs `file:`).
      fonte: 'direta',
    });
  };

  const deleteLocalClip = async (clip: SavedClip) => {
    if (activePlayback?.recording.id === clip.id) {
      playbackRequestRef.current += 1;
      setActivePlayback(null);
    }
    setSavedClips(await removeClip(sessionScope, clip.id));
  };

  // Abre a reprodução pedindo a fonte DIRETA (arquivo original, pass-through).
  // `fonte` e `retomarEm` existem para o degrau de codec e para a renovação do
  // play-token, que trocam a URL sem o usuário perder o ponto do vídeo.
  const openPlayback = async (
    recording: Recording,
    opcoes: { fonte?: 'direta' | 'compativel'; retomarEm?: number; silencioso?: boolean } = {},
  ) => {
    if (!session || !capabilities.playback) return;
    const fonte = opcoes.fonte ?? 'direta';
    const token = session.token;
    const generation = ++playbackRequestRef.current;
    // Feedback IMEDIATO: o POST do play-token levava 2–4s em 3G e nada mudava
    // na tela nesse intervalo — o operador tocava de novo achando que falhou.
    if (!opcoes.silencioso) setAbrindoGravacaoId(recording.id);
    try {
      const data = await request<{ playToken: string }>(session.apiUrl, `/recordings/${recording.id}/play-token`, session.token, { method: 'POST' });
      const url = normalizeServerUrl(
        montarUrlDeReproducao(session.apiUrl, recording.id, data.playToken, fonte),
        session.apiUrl,
      );
      if (!url) throw new Error('URL de reprodução indisponível.');
      if (
        sessionTokenRef.current !== token
        || playbackRequestRef.current !== generation
        || selectedCameraIdRef.current !== recording.cameraId
      ) return;
      setActivePlayback({ recording, url, fonte, retomarEm: opcoes.retomarEm });
    } catch (error) {
      if (sessionTokenRef.current !== token || playbackRequestRef.current !== generation) return;
      // Renovação silenciosa não pode virar alerta: o vídeo está tocando.
      if (opcoes.silencioso) return;
      Alert.alert('Reprodução', error instanceof Error ? error.message : 'Não foi possível abrir a gravação.');
    } finally {
      if (playbackRequestRef.current === generation) setAbrindoGravacaoId(null);
    }
  };

  // ── RENOVAÇÃO DO PLAY-TOKEN DURANTE A REPRODUÇÃO ──────────────────────────
  //
  // O token de reprodução vale 5 minutos e era emitido UMA vez, congelado na
  // URL. Pausar o vídeo (ou esgotar o buffer) por mais que isso e dar play/seek
  // levava 401 → "Não foi possível reproduzir". O web renova a cada 15s; aqui
  // basta reemitir antes de vencer, preservando o ponto em que o usuário está.
  const posicaoDoPlaybackRef = useRef(0);
  useEffect(() => {
    if (!activePlayback || activePlayback.url.startsWith('file:')) return;
    const timer = setInterval(() => {
      const atual = activePlaybackRef.current;
      if (!atual || atual.url.startsWith('file:')) return;
      void openPlayback(atual.recording, {
        fonte: atual.fonte,
        retomarEm: posicaoDoPlaybackRef.current,
        silencioso: true,
      });
    }, PLAY_TOKEN_RENEW_MS);
    return () => clearInterval(timer);
  }, [activePlayback?.recording.id, activePlayback?.fonte]);

  // Degrau de codec: o player não conseguiu decodificar o arquivo original
  // (codec exótico, ou aparelho sem HEVC por hardware). Aí sim vale pagar o
  // transcode — e só nesse caso.
  const tentarFonteCompativel = () => {
    const atual = activePlaybackRef.current;
    if (!atual || atual.fonte !== 'direta') return false;
    void openPlayback(atual.recording, {
      fonte: 'compativel',
      retomarEm: posicaoDoPlaybackRef.current,
    });
    return true;
  };

  const closePlayback = () => {
    playbackRequestRef.current += 1;
    setActivePlayback(null);
  };

  const retryPlayback = () => {
    const current = activePlayback;
    if (!current) return;
    if (current.url.startsWith('file:')) {
      closePlayback();
      const clip = savedClips.find((item) => item.id === current.recording.id);
      if (clip) setTimeout(() => playLocalClip(clip), 0);
      return;
    }
    // Ao repetir manualmente, volta para a fonte direta: se o problema era
    // token vencido, não há motivo para pagar transcode.
    void openPlayback(current.recording, { fonte: current.fonte, retomarEm: posicaoDoPlaybackRef.current });
  };

  // ─── Revisão (item 2.7) ────────────────────────────────────────────────────
  // Carrega a fila de eventos com os filtros atuais. O backend já exclui câmera
  // privada (getAccessibleCameraIds), então nada além do feed chega aqui.
  const loadReview = async (filters: ReviewFilters, mode: 'initial' | 'refresh' = 'initial') => {
    if (!session || !capabilities.playback) return;
    const token = session.token;
    const generation = ++reviewRequestRef.current;
    if (mode === 'refresh') setReviewRefreshing(true); else setReviewLoading(true);
    setReviewError(null);
    try {
      const data = await request<ReviewFeedResponse>(session.apiUrl, reviewFeedPath(filters), token);
      if (sessionTokenRef.current !== token || reviewRequestRef.current !== generation) return;
      setReviewItems(Array.isArray(data.items) ? data.items : []);
      setReviewTotal(Number.isFinite(data.total) ? Number(data.total) : 0);
    } catch (error) {
      if (sessionTokenRef.current !== token || reviewRequestRef.current !== generation) return;
      const status = (error as { status?: number })?.status;
      setReviewItems([]);
      setReviewError(status === 403
        ? 'Você não possui permissão para revisar eventos.'
        : error instanceof Error ? error.message : 'Não foi possível carregar os eventos.');
    } finally {
      if (reviewRequestRef.current === generation) { setReviewLoading(false); setReviewRefreshing(false); }
    }
  };

  /** Próxima página da Revisão: ANEXA ao que já está na tela (offset = itens
   *  atuais). Sem isto só os primeiros `limit` eventos eram alcançáveis. */
  const loadMoreReview = async () => {
    if (!session || !capabilities.playback) return;
    if (reviewLoading || reviewRefreshing || reviewLoadingMore) return;
    if (reviewItems.length >= reviewTotal) return;
    const token = session.token;
    const generation = reviewRequestRef.current; // não invalida a página em curso
    setReviewLoadingMore(true);
    try {
      const data = await request<ReviewFeedResponse>(
        session.apiUrl,
        reviewFeedPath({ ...reviewFilters, offset: reviewItems.length }),
        token,
      );
      // Descarta se a sessão mudou ou se um refresh/filtro reiniciou a lista.
      if (sessionTokenRef.current !== token || reviewRequestRef.current !== generation) return;
      const next = Array.isArray(data.items) ? data.items : [];
      setReviewItems((current) => {
        const known = new Set(current.map((it) => it.id));
        return [...current, ...next.filter((it) => !known.has(it.id))];
      });
      if (Number.isFinite(data.total)) setReviewTotal(Number(data.total));
    } catch {
      // Falha ao paginar não derruba o que já está na tela — o usuário pode rolar
      // de novo para tentar. Erro de página inteira segue sendo o do loadReview.
    } finally {
      setReviewLoadingMore(false);
    }
  };

  const loadReviewUnseen = async () => {
    if (!session || !capabilities.playback) { setReviewUnseenCount(0); return; }
    const token = session.token;
    try {
      const data = await request<{ count: number }>(session.apiUrl, '/review/unseen-count', token);
      if (sessionTokenRef.current !== token) return;
      setReviewUnseenCount(Number.isFinite(data?.count) ? Number(data.count) : 0);
    } catch {
      // Badge é secundário: falha transitória mantém o valor atual.
    }
  };

  const changeReviewFilters = (next: ReviewFilters) => {
    setReviewFilters(next);
    void loadReview(next);
  };

  // Marca visto/não-visto por USUÁRIO (POST /review/:id/seen). Update otimista
  // com reconciliação do badge; reverte a lista em falha.
  const markReviewSeen = async (item: ReviewItem, seen: boolean) => {
    if (!session) return;
    const token = session.token;
    setReviewItems((current) => current.map((it) => (it.id === item.id ? { ...it, reviewed: seen } : it)));
    setReviewUnseenCount((c) => Math.max(0, c + (seen ? -1 : 1)));
    try {
      await request(session.apiUrl, `/review/${item.id}/seen`, token, { method: 'POST', body: JSON.stringify({ seen }) });
    } catch {
      if (sessionTokenRef.current !== token) return;
      setReviewItems((current) => current.map((it) => (it.id === item.id ? { ...it, reviewed: !seen } : it)));
      setReviewUnseenCount((c) => Math.max(0, c + (seen ? 1 : -1)));
    }
  };

  // Abre a reprodução NO INSTANTE do evento: busca o play-token da gravação e
  // reproduz num modal próprio já posicionado em offsetSeconds (reusa 1.3),
  // sem passar pela máquina de estado da aba Reprodução (evita corrida).
  const openReviewItem = async (item: ReviewItem) => {
    if (!session || !capabilities.playback) return;
    const target = reviewPlaybackTarget(item);
    if (!target) {
      Alert.alert('Revisão', 'Este evento não tem gravação disponível para reprodução.');
      return;
    }
    if (!item.reviewed) void markReviewSeen(item, true);
    const token = session.token;
    const generation = ++reviewPlaybackRequestRef.current;
    try {
      const data = await request<{ playToken: string }>(session.apiUrl, `/recordings/${target.recordingId}/play-token`, token, { method: 'POST' });
      const url = normalizeServerUrl(reviewPlayUrl(session.apiUrl, target.recordingId, data.playToken), session.apiUrl);
      if (!url) throw new Error('URL de reprodução indisponível.');
      if (sessionTokenRef.current !== token || reviewPlaybackRequestRef.current !== generation) return;
      const posterUri = normalizeServerUrl(streamPosters[item.cameraId] ?? null, session.apiUrl);
      setReviewPlayback({ url, posterUri, offsetSeconds: target.offsetSeconds });
    } catch (error) {
      if (sessionTokenRef.current !== token || reviewPlaybackRequestRef.current !== generation) return;
      Alert.alert('Revisão', error instanceof Error ? error.message : 'Não foi possível abrir a gravação.');
    }
  };

  const closeReviewPlayback = () => {
    reviewPlaybackRequestRef.current += 1;
    setReviewPlayback(null);
  };

  const downloadRecording = async (recording: Recording) => {
    if (!session || !capabilities.exportEvidence || downloadingRef.current.has(recording.id)) return;
    const currentSession = session;
    downloadingRef.current.add(recording.id);
    setDownloadingIds(Array.from(downloadingRef.current));
    const safeId = recording.id.replace(/[^a-zA-Z0-9_-]/g, '-');
    const target = `${FileSystem.cacheDirectory ?? FileSystem.documentDirectory}download-${safeId}-${Date.now()}.mp4`;
    try {
      const url = normalizeServerUrl(`${currentSession.apiUrl}/recordings/${recording.id}/download`, currentSession.apiUrl);
      if (!url) throw new Error('URL de download indisponível.');
      const result = await FileSystem.downloadAsync(url, target, {
        headers: { Authorization: `Bearer ${currentSession.token}` },
      });
      if (result.status && result.status >= 400) throw new Error(`Falha no download (HTTP ${result.status}).`);
      const ok = await saveToGallery(result.uri);
      if (sessionTokenRef.current === currentSession.token) {
        Alert.alert('Download', ok ? 'Gravação salva na galeria.' : 'Não foi possível salvar (permissão de galeria negada).');
      }
    } catch (error) {
      if (sessionTokenRef.current === currentSession.token) {
        Alert.alert('Download', error instanceof Error ? error.message : 'Não foi possível baixar.');
      }
    } finally {
      await FileSystem.deleteAsync(target, { idempotent: true }).catch(() => undefined);
      downloadingRef.current.delete(recording.id);
      if (sessionTokenRef.current === currentSession.token) setDownloadingIds(Array.from(downloadingRef.current));
    }
  };

  const takeSnapshot = async (camera: Camera) => {
    if (!session) return;
    const currentSession = session;
    // Emite token novo e pede ao endpoint um frame fresco; não reutiliza o
    // snapshot que pode estar há minutos visível no tile.
    const poster = await refreshPoster(camera.id) ?? streamPosters[camera.id];
    if (!poster) {
      Alert.alert('Foto', 'Imagem ainda indisponível. Aguarde a transmissão carregar e tente novamente.');
      return;
    }
    const target = `${FileSystem.cacheDirectory ?? FileSystem.documentDirectory}snapshot-${camera.id.replace(/[^a-zA-Z0-9_-]/g, '-')}-${Date.now()}.jpg`;
    try {
      // O poster já carrega o token na query — baixa direto, sem header de auth.
      const fresh = `${poster}${poster.includes('?') ? '&' : '?'}fresh=1&snap=${Date.now()}`;
      const result = await FileSystem.downloadAsync(fresh, target);
      if (result.status && result.status >= 400) throw new Error(`Falha ao capturar a imagem (HTTP ${result.status}).`);
      const ok = await saveToGallery(result.uri);
      if (sessionTokenRef.current === currentSession.token) {
        Alert.alert('Foto', ok ? 'Foto salva na galeria.' : 'Não foi possível salvar (permissão de galeria negada).');
      }
    } catch (error) {
      if (sessionTokenRef.current === currentSession.token) {
        Alert.alert('Foto', error instanceof Error ? error.message : 'Não foi possível capturar a imagem.');
      }
    } finally {
      await FileSystem.deleteAsync(target, { idempotent: true }).catch(() => undefined);
    }
  };

  const openLive = (camera: Camera) => {
    if (!capabilities.liveView) {
      Alert.alert('Ao vivo', 'Você não possui permissão para visualizar câmeras ao vivo.');
      return;
    }
    closePlayback();
    setSelectedCameraId(camera.id);
    setLiveCamera(camera);
  };

  // Deep link do push: quando as câmeras estiverem carregadas, abre AO VIVO a
  // câmera do alarme tocado (funciona também no cold start pelo push).
  useEffect(() => {
    if (!pendingPushCameraId || cameras.length === 0) return;
    const target = cameras.find((camera) => camera.id === pendingPushCameraId);
    setPendingPushCameraId(null);
    if (target && target.enabled !== false) openLive(target);
  }, [pendingPushCameraId, cameras]);

  // Rede de segurança da orientação: fora da câmera aberta o app é SEMPRE
  // retrato. A tela cheia trava paisagem; se qualquer caminho de saída pular o
  // destravamento (back físico, crash da tela, troca de aba), aqui conserta.
  useEffect(() => {
    if (!isRedesign || liveCamera) return;
    void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => undefined);
  }, [liveCamera?.id]);

  // Voltar físico respeita a confirmação de gravação em vez de encerrar o app.
  useEffect(() => {
    if (!liveCamera) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      leaveLive();
      return true;
    });
    return () => sub.remove();
  }, [liveCamera?.id]);

  // Se o app perde o primeiro plano, finaliza o clipe para não deixar FFmpeg
  // rodando no servidor sem feedback no aparelho.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      appStateRef.current = state;
      if (state === 'active') {
        if (session && !refreshing) void loadAll(true);
        if (cameras.length) void loadAllPosters(cameras);
        if (session) void resumePendingClips(session);
        if (capabilities.playback && recordingsRef.current.length) {
          void applyThumbnailTokens(recordingsRef.current).catch(() => undefined);
        }
      } else if (clipPhaseRef.current !== 'idle') {
        void stopActiveClip(true);
      }
    });
    return () => sub.remove();
  }, [session?.token, refreshing, capabilities.playback, cameras]);

  // Atualiza estados ONLINE/OFFLINE sem exigir pull-to-refresh. Timers ficam
  // suspensos no background para poupar bateria e evitar requests inúteis.
  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => {
      if (appStateRef.current === 'active' && !refreshing) void loadAll(true);
    }, 30_000);
    return () => clearInterval(timer);
  }, [session?.token, refreshing]);

  // O token de poster dura 5 minutos. Renova antes disso para que um tile
  // remontado nunca tente carregar uma URL já expirada.
  useEffect(() => {
    if (!session || !cameras.length) return;
    const timer = setInterval(() => {
      if (appStateRef.current === 'active') void loadAllPosters(cameras);
    }, 3.5 * 60 * 1000);
    return () => clearInterval(timer);
  }, [session?.token, cameras]);

  // Tokens das miniaturas também expiram. Renova apenas quando alguma tela que
  // mostra gravações está ativa.
  useEffect(() => {
    if (!session || !capabilities.playback || (!liveCamera && tab !== 'reproducao')) return;
    const timer = setInterval(() => {
      if (appStateRef.current === 'active' && recordingsRef.current.length) {
        void applyThumbnailTokens(recordingsRef.current).catch(() => undefined);
      }
    }, 3.5 * 60 * 1000);
    return () => clearInterval(timer);
  }, [session?.token, capabilities.playback, liveCamera?.id, tab]);

  if (restoringSession) {
    return (
      <SafeAreaView style={[styles.screen, styles.restoring, { backgroundColor: theme.bg }]}>
        <StatusBar style={statusBarStyle} />
        <ActivityIndicator size="large" color={theme.accent} />
      </SafeAreaView>
    );
  }

  if (!session) {
    return (
      <SafeAreaView style={[styles.screen, { backgroundColor: theme.bg }]}>
        <StatusBar style={statusBarStyle} />
        <LoginScreen
          apiUrl={apiUrl}
          email={email}
          password={password}
          loading={loading}
          onApiUrlChange={setApiUrl}
          onEmailChange={setEmail}
          onPasswordChange={setPassword}
          onSubmit={login}
          onForgotPassword={forgotPassword}
          biometricLabel={biometricLabel}
          biometricAvailable={Boolean(pendingBiometricSession && biometricEnabled && biometricAvailable)}
          onBiometric={() => { void unlockPendingSession(); }}
        />
      </SafeAreaView>
    );
  }

  // Ao vivo: overlay em tela cheia, sem BottomTabs.
  if (liveCamera) {
    const live = cameras.find((c) => c.id === liveCamera.id) ?? liveCamera;
    return (
      <SafeAreaView style={[styles.screen, { backgroundColor: '#070809' }]}>
        <StatusBar style="light" />
        {isRedesign ? (
          <LiveScreenRedesign
            camera={live}
            topInset={TOP_SAFE}
            streamUrl={streamUrls[live.id] ?? null}
            whepUrl={streamWhep[live.id] ?? null}
            posterUrl={streamPosters[live.id] ?? null}
            hdUrl={hdUrl}
            onRequestHd={() => loadHdStream(live.id)}
            onExitHd={() => setHdUrl(null)}
            recordings={recordings}
            recordingsLoading={recordingsLoading}
            recordingsLoadingMore={recordingsLoadingMore}
            recordingsError={recordingsError}
            recordingsTotal={recordingsTotal}
            recordingDate={recordingDate}
            activePlayback={activePlayback}
            recordingActive={recordingActive}
            recordingBusy={recordingBusy}
            ptzActive={ptzActive}
            ptzFeedback={ptzFeedback}
            detections={liveDetections}
            canPlayback={capabilities.playback}
            canDownload={capabilities.exportEvidence}
            downloadingIds={downloadingIds}
            myRecordings={savedClips.filter((c) => c.cameraId === live.id)}
            notificationsMuted={notificationsMuted}
            onToggleNotifications={toggleNotifications}
            onBack={() => leaveLive()}
            onSendPtz={sendPtz}
            onToggleRecording={toggleRecording}
            onSnapshot={takeSnapshot}
            onOpenPlayback={openPlayback}
            onClosePlayback={closePlayback}
            onRetryPlayback={retryPlayback}
            onNaoDecodificou={tentarFonteCompativel}
            onProgressoPlayback={(segundos: number) => { posicaoDoPlaybackRef.current = segundos; }}
            onPreviousDate={() => shiftRecordingDate(-1)}
            onNextDate={() => shiftRecordingDate(1)}
            onSelectDate={(key) => setRecordingDate(key)}
            onDownloadRecording={downloadRecording}
            onLoadMoreRecordings={loadMoreRecordings}
            onRetryRecordings={() => { if (selectedCamera) void loadRecordings(selectedCamera.id, recordingDateRef.current); }}
            onThumbnailError={refreshExpiredThumbnails}
            onPlayLocal={playLocalClip}
            onDeleteLocal={deleteLocalClip}
            onRefreshStream={() => { void loadStream(live.id, 'selected', true); }}
            abrindoGravacaoId={abrindoGravacaoId}
          />
        ) : (
        <LiveScreen
          camera={live}
          topInset={TOP_SAFE}
          streamUrl={streamUrls[live.id] ?? null}
          whepUrl={streamWhep[live.id] ?? null}
          posterUrl={streamPosters[live.id] ?? null}
          hdUrl={hdUrl}
          onRequestHd={() => loadHdStream(live.id)}
          onExitHd={() => setHdUrl(null)}
          detections={liveDetections}
          ptzActive={ptzActive}
          ptzFeedback={ptzFeedback}
          recordings={recordings}
          recordingsTotal={recordingsTotal}
          recordingsLoading={recordingsLoading}
          recordingsLoadingMore={recordingsLoadingMore}
          recordingsError={recordingsError}
          myRecordings={savedClips.filter((c) => c.cameraId === live.id)}
          onPlayLocal={playLocalClip}
          onDeleteLocal={deleteLocalClip}
          recordingDate={recordingDate}
          activePlayback={activePlayback}
          recordingActive={recordingActive}
          recordingBusy={recordingBusy}
          onBack={() => leaveLive()}
          onSendPtz={sendPtz}
          onToggleRecording={toggleRecording}
          onSnapshot={takeSnapshot}
          onOpenPlayback={openPlayback}
          onClosePlayback={closePlayback}
          onRetryPlayback={retryPlayback}
          onNaoDecodificou={tentarFonteCompativel}
          onProgressoPlayback={(segundos: number) => { posicaoDoPlaybackRef.current = segundos; }}
          onDownloadRecording={downloadRecording}
          onPreviousDate={() => shiftRecordingDate(-1)}
          onNextDate={() => shiftRecordingDate(1)}
          onLoadMoreRecordings={loadMoreRecordings}
          onRetryRecordings={() => { if (selectedCamera) void loadRecordings(selectedCamera.id, recordingDateRef.current); }}
          onThumbnailError={refreshExpiredThumbnails}
          onRefreshStream={() => { void loadStream(live.id, 'selected', true); }}
          canPlayback={capabilities.playback}
          canDownload={capabilities.exportEvidence}
          downloadingIds={downloadingIds}
          notificationsMuted={notificationsMuted}
          onToggleNotifications={toggleNotifications}
          abrindoGravacaoId={abrindoGravacaoId}
          />
        )}
        {/* Menu inferior também na câmera aberta — tocar numa aba sai do vídeo e
            vai pra ela. Escondido em paisagem (vídeo em tela cheia usa a área).
            No redesign a tela da câmera é cheia (tem o próprio "voltar"). */}
        {!isRedesign && winWidth <= winHeight ? (
          <BottomTabs
            active={tab}
            alarmCount={openAlarmCount}
            reviewCount={reviewUnseenCount}
            onChange={(next) => leaveLive(() => setTab(next))}
          />
        ) : null}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: theme.bg }]}>
      <StatusBar style={statusBarStyle} />
      {/* Fundo em GRADIENTE quando o branding define 2 cores (bg != bg2); senão
          o backgroundColor sólido do SafeAreaView aparece. As telas são
          transparentes, então o gradiente é visível atrás delas. */}
      {theme.bg2 !== theme.bg ? (
        <LinearGradient colors={[theme.bg, theme.bg2]} style={StyleSheet.absoluteFill} pointerEvents="none" />
      ) : null}
      {/* BARREIRA POR ABA. Havia só a da raiz: um crash de render em qualquer
          tela levava o app inteiro para a tela de recuperação — um bug num card
          da Revisão derrubava a live que o operador estava assistindo. Com a
          `resetKey` na aba, trocar de aba já limpa o erro da anterior. */}
      <View style={[styles.body, { paddingTop: TOP_SAFE }]}>
        <ErrorBoundary resetKey={tab}>
        {tab === 'central' && (
          isRedesign ? (
            <HomeRedesign
              cameras={cameras}
              user={session.user}
              streamPosters={streamPosters}
              alarms={alarms}
              alarmCount={openAlarmCount}
              refreshing={refreshing}
              onRefresh={loadAll}
              onOpenCamera={openLive}
              onOpenAlarms={() => setTab('alarmes')}
              onOpenMosaic={() => setTab('mosaico')}
              onOpenPlayback={() => setTab('reproducao')}
              operationalMessages={operationalMessages}
              onPosterError={(cameraId) => { void refreshPoster(cameraId); }}
            />
          ) : (
          <CentralScreen
            cameras={cameras}
            user={session.user}
            streamPosters={streamPosters}
            operationalMessages={operationalMessages}
            alarms={alarms}
            alarmCount={openAlarmCount}
            refreshing={refreshing}
            onRefresh={loadAll}
            onOpenCamera={openLive}
            onOpenAlarms={() => setTab('alarmes')}
            onOpenMosaic={() => setTab('mosaico')}
            onOpenPlayback={() => setTab('reproducao')}
            onPosterError={(cameraId) => { void refreshPoster(cameraId); }}
          />
          )
        )}

        {tab === 'mosaico' && (
          isRedesign ? (
            <CamerasRedesign
              cameras={cameras}
              streamPosters={streamPosters}
              streamUrls={streamUrls}
              streamWhep={streamWhep}
              refreshing={refreshing}
              onRefresh={loadAll}
              onOpenCamera={openLive}
              onRequestStreams={(cameraIds) => { void Promise.all(cameraIds.map((id) => loadStream(id, 'grid'))); }}
              onRefreshStream={(cameraId) => { void loadStream(cameraId, 'grid', true); }}
            />
          ) : (
          <MosaicScreen
            cameras={cameras}
            streamUrls={streamUrls}
            streamWhep={streamWhep}
            streamPosters={streamPosters}
            refreshing={refreshing}
            canLiveView={capabilities.liveView}
            onRefresh={loadAll}
            onOpenCamera={openLive}
            onRequestStreams={(cameraIds) => { void Promise.all(cameraIds.map((id) => loadStream(id, 'grid'))); }}
            onRefreshStream={(cameraId) => { void loadStream(cameraId, 'grid', true); }}
            onPosterError={(cameraId) => { void refreshPoster(cameraId); }}
          />
          )
        )}

        {tab === 'reproducao' && (
          <PlaybackScreen
            cameras={cameras}
            selectedCamera={selectedCamera}
            recordings={recordings}
            recordingsTotal={recordingsTotal}
            loading={recordingsLoading}
            loadingMore={recordingsLoadingMore}
            error={recordingsError}
            activePlayback={activePlayback}
            recordingDate={recordingDate}
            canPlayback={capabilities.playback}
            canDownload={capabilities.exportEvidence}
            downloadingIds={downloadingIds}
            onSelectCamera={(cameraId) => { setSelectedCameraId(cameraId); closePlayback(); }}
            onOpenPlayback={openPlayback}
            onClosePlayback={closePlayback}
            onRetryPlayback={retryPlayback}
            onNaoDecodificou={tentarFonteCompativel}
            onProgressoPlayback={(segundos: number) => { posicaoDoPlaybackRef.current = segundos; }}
            onDownloadRecording={downloadRecording}
            onPreviousDate={() => shiftRecordingDate(-1)}
            onNextDate={() => shiftRecordingDate(1)}
            onLoadMore={loadMoreRecordings}
            onRetry={() => { if (selectedCamera) void loadRecordings(selectedCamera.id, recordingDateRef.current); }}
            onThumbnailError={refreshExpiredThumbnails}
            abrindoGravacaoId={abrindoGravacaoId}
          />
        )}

        {tab === 'revisao' && (
          <ReviewScreen
            items={reviewItems}
            total={reviewTotal}
            unseenCount={reviewUnseenCount}
            loading={reviewLoading}
            refreshing={reviewRefreshing}
            error={reviewError}
            filters={reviewFilters}
            cameras={cameras}
            apiUrl={session.apiUrl}
            token={session.token}
            canPlayback={capabilities.playback}
            reviewPlayback={reviewPlayback}
            onChangeFilters={changeReviewFilters}
            onRefresh={() => { void loadReview(reviewFilters, 'refresh'); void loadReviewUnseen(); }}
            loadingMore={reviewLoadingMore}
            onLoadMore={() => { void loadMoreReview(); }}
            onOpenItem={(item) => { void openReviewItem(item); }}
            onCloseReviewPlayback={closeReviewPlayback}
            onMarkSeen={(item, seen) => { void markReviewSeen(item, seen); }}
          />
        )}

        {tab === 'alarmes' && (
          isRedesign ? (
            <EventsRedesign
              alarms={alarms}
              cameras={cameras}
              streamPosters={streamPosters}
              highlightedAlarmId={highlightedAlarmId}
              refreshing={refreshing}
              onRefresh={() => { void reloadAlarms(); }}
              onOpenCamera={(cameraId) => { const c = cameras.find((x) => x.id === cameraId); if (c) openLive(c); }}
              canManage={canManageAlarms}
              onAck={(alarm) => { void ackAlarm(alarm); }}
              onResolve={(alarm) => { void resolveAlarm(alarm); }}
              erro={alarmesErro}
            />
          ) : (
          <AlarmsScreen
            alarms={alarms}
            highlightedAlarmId={highlightedAlarmId}
            canManage={canManageAlarms}
            refreshing={alarmesCarregando}
            onRefresh={() => { void reloadAlarms(); }}
            erro={alarmesErro}
            onAck={ackAlarm}
            onResolve={resolveAlarm}
            onOpenCamera={(cameraId) => {
              const camera = cameras.find((c) => c.id === cameraId);
              if (camera) openLive(camera);
            }}
          />
          )
        )}

        {tab === 'ajustes' && (
          isRedesign ? (
            <SettingsRedesign
              user={session.user}
              apiUrl={session.apiUrl}
              token={session.token}
              connected={!lastSyncError}
              biometricAvailable={biometricAvailable}
              biometricEnabled={biometricEnabled}
              biometricLabel={biometricLabel}
              onBiometricChange={(enabled) => { void changeBiometricPreference(enabled); }}
              onLogout={() => { void logout(); }}
              onCamerasChanged={() => { void loadAll(true); }}
              facilityName={branding.facilityName}
            />
          ) : (
          <SettingsScreen
            user={session.user}
            apiUrl={session.apiUrl}
            token={session.token}
            connected={!lastSyncError}
            biometricAvailable={biometricAvailable}
            biometricEnabled={biometricEnabled}
            biometricLabel={biometricLabel}
            onBiometricChange={(enabled) => { void changeBiometricPreference(enabled); }}
            onLogout={() => { void logout(); }}
            onCamerasChanged={() => { void loadAll(true); }}
          />
          )
        )}
        </ErrorBoundary>
      </View>

      {isRedesign ? (
        <BottomTabsRedesign
          active={tab}
          onChange={(next) => { if (next !== 'reproducao') closePlayback(); if (next !== 'revisao') closeReviewPlayback(); setTab(next); }}
          alarmCount={openAlarmCount}
          reviewCount={reviewUnseenCount}
        />
      ) : (
      <BottomTabs
        active={tab}
        onChange={(next) => {
          if (next !== 'reproducao') closePlayback();
          if (next !== 'revisao') closeReviewPlayback();
          setTab(next);
        }}
        alarmCount={openAlarmCount}
        reviewCount={reviewUnseenCount}
      />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  restoring: { alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1 },
});
