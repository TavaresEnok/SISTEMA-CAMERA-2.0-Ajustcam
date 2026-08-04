import axios from 'axios';
import { create } from 'zustand';
import { getApiBaseUrl } from '../lib/api-base';

type UiRole = 'viewer' | 'operator' | 'admin';

export interface AuthUser {
  id: string;
  name: string;
  role: UiRole;
  email: string;
  badge: string;
  lastLogin: string;
  shift: 'morning' | 'afternoon' | 'night';
  active: boolean;
}

interface LoginResponse {
  accessToken: string;
  user: {
    id: string;
    name: string;
    email: string;
    role: 'SUPER_ADMIN' | 'ADMIN' | 'OPERATOR' | 'VIEWER';
  };
}

interface AuthState {
  user: AuthUser | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  isBootstrapped: boolean;
  bootstrap: () => Promise<void>;
  revalidate: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const TOKEN_STORAGE_KEY = 'vms.auth.token';
const USER_STORAGE_KEY = 'nexusguard.auth.user';
const API_URL = getApiBaseUrl();
const SESSION_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000] as const;
let sessionRetryTimer: ReturnType<typeof setTimeout> | null = null;
let sessionRetryAttempt = 0;

function clearSessionRetry() {
  if (sessionRetryTimer) clearTimeout(sessionRetryTimer);
  sessionRetryTimer = null;
  sessionRetryAttempt = 0;
}

function scheduleSessionRetry() {
  if (sessionRetryTimer) return;
  const delay = SESSION_RETRY_DELAYS_MS[Math.min(sessionRetryAttempt, SESSION_RETRY_DELAYS_MS.length - 1)];
  sessionRetryAttempt += 1;
  sessionRetryTimer = setTimeout(() => {
    sessionRetryTimer = null;
    const state = useAuthStore.getState();
    void (state.isAuthenticated ? state.revalidate() : state.bootstrap());
  }, delay);
}

function mapRole(role: LoginResponse['user']['role']): UiRole {
  if (role === 'SUPER_ADMIN' || role === 'ADMIN') return 'admin';
  if (role === 'OPERATOR') return 'operator';
  return 'viewer'; // VIEWER → acesso restrito a Ao Vivo, PTZ e Reprodução
}

function mapUser(user: LoginResponse['user']): AuthUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: mapRole(user.role),
    badge: `SEC-${user.id.slice(0, 6).toUpperCase()}`,
    lastLogin: new Date().toISOString(),
    shift: 'morning',
    active: true,
  };
}

function getStoredUser(): AuthUser | null {
  if (typeof window === 'undefined') return null;

  const raw = window.localStorage.getItem(USER_STORAGE_KEY) ?? window.sessionStorage.getItem(USER_STORAGE_KEY);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as AuthUser;
  } catch {
    window.localStorage.removeItem(USER_STORAGE_KEY);
    window.sessionStorage.removeItem(USER_STORAGE_KEY);
    return null;
  }
}

function removeLegacyBrowserToken() {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
}

function persistUser(user: AuthUser | null) {
  if (typeof window === 'undefined') return;
  removeLegacyBrowserToken();

  if (user) {
    window.localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
    window.sessionStorage.removeItem(USER_STORAGE_KEY);
  } else {
    window.localStorage.removeItem(USER_STORAGE_KEY);
    window.sessionStorage.removeItem(USER_STORAGE_KEY);
  }
}

async function refreshWebSession() {
  const { data } = await axios.post<LoginResponse>(
    `${API_URL}/auth/refresh`,
    {},
    {
      withCredentials: true,
      headers: { 'X-DRAC-Auth-Mode': 'cookie' },
      timeout: 15_000,
    },
  );
  return { accessToken: data.accessToken, user: mapUser(data.user) };
}

function isAuthenticationRejection(error: unknown) {
  return axios.isAxiosError(error) && (error.response?.status === 401 || error.response?.status === 403);
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: getStoredUser(),
  // O access token vive somente na memória e expira em 15 minutos no modo web.
  // A sessão durável é um refresh token HttpOnly, inacessível ao JavaScript.
  accessToken: null,
  isAuthenticated: false,
  isLoading: false,
  isBootstrapped: false,
  bootstrap: async () => {
    set({ isLoading: true });
    removeLegacyBrowserToken();

    try {
      const session = await refreshWebSession();
      persistUser(session.user);
      set({
        user: session.user,
        accessToken: session.accessToken,
        isAuthenticated: true,
        isLoading: false,
        isBootstrapped: true,
      });
      clearSessionRetry();
    } catch (error) {
      if (isAuthenticationRejection(error)) {
        persistUser(null);
        set({
          user: null,
          accessToken: null,
          isAuthenticated: false,
          isLoading: false,
          isBootstrapped: true,
        });
        clearSessionRetry();
        return;
      }

      // Sem um token em memória não é seguro considerar a UI autenticada apenas
      // por uma identidade em cache. O cookie permanece intacto para nova tentativa.
      set({
        user: get().user ?? getStoredUser(),
        accessToken: null,
        isAuthenticated: false,
        isLoading: false,
        isBootstrapped: true,
      });
      // O cookie HttpOnly continua intacto. Uma queda breve durante deploy não
      // deve transformar a sessão válida em uma tela sem dados até o usuário
      // recarregar manualmente.
      scheduleSessionRetry();
    }
  },
  revalidate: async () => {
    // Revalidação periódica da sessão (a cada poucos minutos), executada com a UI
    // já MONTADA e visível. Diferente de `bootstrap`, este caminho NUNCA seta
    // `isLoading: true`: o `ProtectedRoute` renderiza <AppFallback/> (tela cheia
    // "Carregando...") sempre que isLoading é true, o que desmontaria toda a árvore
    // de páginas — e com ela TODOS os <LiveStreamPlayer/>. Isso derrubava as
    // conexões WebRTC de todas as câmeras ao mesmo tempo a cada ciclo, fazendo a
    // imagem "piscar"/reiniciar em lote. Aqui só atualizamos o usuário em segundo
    // plano e, em caso de token expirado/inválido, encerramos a sessão.
    try {
      // Rotacionar pelo cookie a cada revalidação renova a sessão ativa e entrega
      // um access token curto antes que o anterior expire.
      const session = await refreshWebSession();
      persistUser(session.user);
      set({
        user: session.user,
        accessToken: session.accessToken,
        isAuthenticated: true,
        isBootstrapped: true,
      });
      clearSessionRetry();
    } catch (error) {
      if (isAuthenticationRejection(error)) {
        persistUser(null);
        set({
          user: null,
          accessToken: null,
          isAuthenticated: false,
          isBootstrapped: true,
        });
        clearSessionRetry();
      } else {
        scheduleSessionRetry();
      }
    }
  },
  login: async (email, password) => {
    clearSessionRetry();
    set({ isLoading: true });

    try {
      const { data } = await axios.post<LoginResponse>(
        `${API_URL}/auth/login`,
        { email, password },
        {
          withCredentials: true,
          headers: { 'X-DRAC-Auth-Mode': 'cookie' },
        },
      );
      const user = mapUser(data.user);

      persistUser(user);
      set({
        user,
        accessToken: data.accessToken,
        isAuthenticated: true,
        isLoading: false,
        isBootstrapped: true,
      });
      clearSessionRetry();
    } catch (error) {
      persistUser(null);
      set({
        user: null,
        accessToken: null,
        isAuthenticated: false,
        isLoading: false,
        isBootstrapped: true,
      });
      throw error;
    }
  },
  logout: async () => {
    clearSessionRetry();
    const accessToken = get().accessToken;
    persistUser(null);
    set({
      user: null,
      accessToken: null,
      isAuthenticated: false,
      isLoading: false,
      isBootstrapped: true,
    });
    if (accessToken) {
      await axios.post(
        `${API_URL}/auth/logout`,
        {},
        {
          withCredentials: true,
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      ).catch(() => undefined);
    }
  },
}));

// Migração defensiva: versões anteriores deixavam o JWT de oito horas em
// localStorage. Ele é apagado assim que o bundle novo carrega.
removeLegacyBrowserToken();
