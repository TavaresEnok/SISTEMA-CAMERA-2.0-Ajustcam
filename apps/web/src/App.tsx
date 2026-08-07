import { Component, Suspense, lazy, useEffect, type ComponentType, type ErrorInfo, type ReactNode } from 'react';
import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from 'wouter';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/toaster';
import { MotionConfig } from 'framer-motion';

import { AppLayout } from './layouts/AppLayout';

import { useAuthStore } from './store/authStore';
import { useThemeStore } from './store/themeStore';
import { useVmsDataStore } from './store/vmsDataStore';
import { useBrandingStore } from './store/brandingStore';
import { productPageTitle, PRODUCT_NAME } from './lib/product-brand';

const queryClient = new QueryClient();

const CHUNK_RELOAD_KEY = 'drac:chunkReloaded';

/**
 * lazy() com recuperação de chunk obsoleto. Após um deploy novo, abas já abertas
 * referenciam arquivos JS com hash antigo que não existem mais no servidor; ao
 * navegar, o import dinâmico falha (ChunkLoadError) e a tela fica preta. Aqui,
 * na primeira falha recarregamos a página uma vez (puxa o index.html novo);
 * num carregamento bem-sucedido limpamos o marcador.
 */
function lazyWithReload<T extends ComponentType<unknown>>(factory: () => Promise<{ default: T }>) {
  return lazy(async () => {
    try {
      const mod = await factory();
      try { sessionStorage.removeItem(CHUNK_RELOAD_KEY); } catch { /* ignore */ }
      return mod;
    } catch (err) {
      let alreadyReloaded = false;
      try { alreadyReloaded = sessionStorage.getItem(CHUNK_RELOAD_KEY) === '1'; } catch { /* ignore */ }
      if (!alreadyReloaded) {
        try { sessionStorage.setItem(CHUNK_RELOAD_KEY, '1'); } catch { /* ignore */ }
        window.location.reload();
        // Trava o render enquanto a página recarrega.
        return new Promise<{ default: T }>(() => {});
      }
      throw err;
    }
  });
}

const LoginPage       = lazyWithReload(() => import('./pages/LoginPage'));
const ResetPasswordPage = lazyWithReload(() => import('./pages/ResetPasswordPage'));
const LiveViewPage    = lazyWithReload(() => import('./pages/LiveViewPage'));
const PlaybackPage    = lazyWithReload(() => import('./pages/PlaybackPage'));
const ReviewPage      = lazyWithReload(() => import('./pages/ReviewPage'));
const AlarmsPage      = lazyWithReload(() => import('./pages/AlarmsPage'));
const CamerasPage     = lazyWithReload(() => import('./pages/CamerasPage'));
const MapPage         = lazyWithReload(() => import('./pages/MapPage'));
const PTZPage         = lazyWithReload(() => import('./pages/PTZPage'));
const InvestigationPage = lazyWithReload(() => import('./pages/InvestigationPage'));
const StoragePage     = lazyWithReload(() => import('./pages/StoragePage'));
const SettingsPage    = lazyWithReload(() => import('./pages/SettingsPage'));
const CameraDetailPage = lazyWithReload(() => import('./pages/CameraDetailPage'));
const WallModePage    = lazyWithReload(() => import('./pages/WallModePage'));
const UsersPage       = lazyWithReload(() => import('./pages/UsersPage'));
const GroupsPage      = lazyWithReload(() => import('./pages/GroupsPage'));
const RolesPage       = lazyWithReload(() => import('./pages/RolesPage'));
const AppBuilderPage  = lazyWithReload(() => import('./pages/AppBuilderPage'));
const ProfilePage     = lazyWithReload(() => import('./pages/ProfilePage'));
const NotFound        = lazyWithReload(() => import('./pages/not-found'));

function AppFallback() {
  return (
    <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">
      Carregando {PRODUCT_NAME}...
    </div>
  );
}

/** Loading leve, só na área de conteúdo (mantém a sidebar/header fixos). */
function ContentFallback() {
  return (
    <div className="flex h-full min-h-0 flex-1 items-center justify-center">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-[hsl(var(--border))] border-t-[hsl(var(--primary))]" />
    </div>
  );
}

class PageErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[DRAC] Falha ao renderizar página', error, info.componentStack);
  }

  componentDidUpdate(prevProps: { resetKey: string }) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex min-h-full items-center justify-center p-6">
        <div className="w-full max-w-md rounded-lg border border-border bg-card p-5 text-center shadow-sm">
          <div className="text-sm font-semibold text-foreground">Esta página não conseguiu carregar</div>
          <div className="mt-2 text-xs text-muted-foreground">
            {this.state.error.message || 'Erro inesperado ao abrir a tela.'}
          </div>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="mt-4 inline-flex h-9 items-center justify-center rounded-md border border-border px-4 text-xs font-medium hover:bg-accent"
          >
            Tentar novamente
          </button>
        </div>
      </div>
    );
  }
}

// Hierarquia de roles: viewer < operator < admin
// Cada rota declara o `minRole` mínimo necessário; quem não atingir é
// redirecionado para /live (já autenticado) ou /login (não autenticado).
type UiRole = 'viewer' | 'operator' | 'admin';
const ROLE_WEIGHT: Record<UiRole, number> = { viewer: 1, operator: 2, admin: 3 };

function ProtectedRoute({
  component: Page,
  minRole = 'viewer',
}: {
  component: React.ComponentType;
  minRole?: UiRole;
}) {
  const { isAuthenticated, isBootstrapped, isLoading, user } = useAuthStore();
  const [, setLocation] = useLocation();

  const userWeight = ROLE_WEIGHT[(user?.role as UiRole) ?? 'viewer'] ?? 1;
  const hasAccess = userWeight >= ROLE_WEIGHT[minRole];

  useEffect(() => {
    if (isBootstrapped && !isAuthenticated) setLocation('/login');
    if (isBootstrapped && isAuthenticated && !hasAccess) setLocation('/live');
  }, [hasAccess, isAuthenticated, isBootstrapped, setLocation]);

  if (!isBootstrapped || isLoading) return <AppFallback />;
  if (!isAuthenticated) return null;
  if (!hasAccess) return null;

  return (
    <AppLayout>
      <PageErrorBoundary resetKey={window.location.pathname}>
        <Suspense fallback={<ContentFallback />}>
          <Page />
        </Suspense>
      </PageErrorBoundary>
    </AppLayout>
  );
}

function RootRedirect() {
  const { isAuthenticated } = useAuthStore();
  return isAuthenticated ? <Redirect to="/live" /> : <Redirect to="/login" />;
}

function ThemeSync() {
  const { theme } = useThemeStore();

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark' || theme === 'dim') {
      root.classList.add('dark');
      root.style.colorScheme = 'dark';
    } else {
      root.classList.remove('dark');
      root.style.colorScheme = 'light';
    }
  }, [theme]);

  return null;
}

function BrandingSync() {
  const facilityName = useBrandingStore((state) => state.facilityName);
  const loadBranding = useBrandingStore((state) => state.load);

  useEffect(() => {
    void loadBranding();
  }, [loadBranding]);

  useEffect(() => {
    document.title = productPageTitle(facilityName);
  }, [facilityName]);

  return null;
}

function AppRoutes() {
  return (
    <Switch>
      <Route path="/login" component={LoginPage} />
      <Route path="/reset-password" component={ResetPasswordPage} />

      {/* ── Rotas acessíveis a todos os usuários autenticados (viewer+) ── */}
      <Route path="/live">
        {() => <ProtectedRoute component={LiveViewPage} />}
      </Route>
      <Route path="/playback">
        {() => <ProtectedRoute component={PlaybackPage} />}
      </Route>
      <Route path="/review">
        {() => <ProtectedRoute component={ReviewPage} />}
      </Route>
      <Route path="/ptz">
        {() => <ProtectedRoute component={PTZPage} />}
      </Route>
      <Route path="/wall">
        {() => <ProtectedRoute component={WallModePage} />}
      </Route>
      {/* Página de perfil: para viewer mostra seus grupos + criação de usuários
          se for group admin; para admin/operator mostra o mesmo + link para /users */}
      <Route path="/profile">
        {() => <ProtectedRoute component={ProfilePage} />}
      </Route>

      {/* ── Rotas exclusivas de operadores e admins ── */}
      <Route path="/cameras/:id">
        {() => <ProtectedRoute component={CameraDetailPage} minRole="operator" />}
      </Route>
      <Route path="/cameras">
        {() => <ProtectedRoute component={CamerasPage} minRole="operator" />}
      </Route>
      <Route path="/alarms">
        {() => <ProtectedRoute component={AlarmsPage} minRole="operator" />}
      </Route>
      <Route path="/map">
        {() => <ProtectedRoute component={MapPage} minRole="operator" />}
      </Route>
      <Route path="/investigation">
        {() => <ProtectedRoute component={InvestigationPage} minRole="operator" />}
      </Route>
      <Route path="/storage">
        {() => <ProtectedRoute component={StoragePage} minRole="operator" />}
      </Route>
      <Route path="/users">
        {() => <ProtectedRoute component={UsersPage} minRole="operator" />}
      </Route>

      {/* ── Rotas exclusivas de admins ── */}
      <Route path="/settings">
        {() => <ProtectedRoute component={SettingsPage} minRole="admin" />}
      </Route>
      <Route path="/groups">
        {() => <ProtectedRoute component={GroupsPage} minRole="admin" />}
      </Route>
      <Route path="/roles">
        {() => <ProtectedRoute component={RolesPage} minRole="admin" />}
      </Route>
      <Route path="/app-builder">
        {() => <ProtectedRoute component={AppBuilderPage} minRole="admin" />}
      </Route>

      <Route path="/" component={RootRedirect} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  const bootstrap = useAuthStore((state) => state.bootstrap);
  const revalidate = useAuthStore((state) => state.revalidate);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const loadData = useVmsDataStore((state) => state.load);
  const refreshOperational = useVmsDataStore((state) => state.refreshOperational);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // Revalida o token da sessão periodicamente (a cada 5 min). Se o token expirou
  // com a aba aberta, isso detecta e redireciona para o login automaticamente.
  //
  // IMPORTANTE: usa `revalidate`, NÃO `bootstrap`. O `bootstrap` seta
  // `isLoading: true`, e o `ProtectedRoute` troca toda a árvore por <AppFallback/>
  // quando isLoading é true — desmontando todos os <LiveStreamPlayer/> e derrubando
  // as conexões WebRTC de TODAS as câmeras ao mesmo tempo (imagem piscando em lote
  // a cada 5 min). `revalidate` faz a checagem em segundo plano sem tocar isLoading.
  useEffect(() => {
    const interval = window.setInterval(() => {
      void revalidate();
    }, 5 * 60 * 1000);
    return () => window.clearInterval(interval);
  }, [revalidate]);

  useEffect(() => {
    // Autenticado: carrega tudo. Desautenticado: cancela retentativas pendentes
    // e remove da memória os dados pertencentes à sessão anterior.
    void loadData();
  }, [isAuthenticated, loadData]);

  // A API ainda não expõe SSE/WebSocket para o estado operacional. Atualizamos
  // apenas os recursos leves em segundo plano, sem desmontar players ao vivo.
  useEffect(() => {
    if (!isAuthenticated) return;

    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void refreshOperational();
    };
    const interval = window.setInterval(refreshWhenVisible, 12_000);
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [isAuthenticated, refreshOperational]);

  return (
    <MotionConfig reducedMotion="user">
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
            <ThemeSync />
            <BrandingSync />
            <Suspense fallback={<AppFallback />}>
              <AppRoutes />
            </Suspense>
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </MotionConfig>
  );
}

export default App;
