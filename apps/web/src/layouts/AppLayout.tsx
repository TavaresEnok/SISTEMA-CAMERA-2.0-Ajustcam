import { useState, useEffect, useMemo } from 'react';
import { useLocation } from 'wouter';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, RefreshCw, Sun, Moon } from 'lucide-react';
import { Sidebar } from '../components/Sidebar';
import { StatusStrip } from '../components/StatusStrip';
import { CommandPalette } from '../components/CommandPalette';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/kbd';
import { useThemeStore } from '../store/themeStore';
import { useVmsDataStore } from '../store/vmsDataStore';
import { useAuthStore } from '../store/authStore';
import { PRODUCT_NAME } from '../lib/product-brand';

const PAGE_TITLES: Record<string, string> = {
  '/live':          'Ao Vivo',
  '/playback':      'Reprodução',
  '/review':        'Revisão',
  '/alarms':        'Alertas',
  '/cameras':       'Câmeras',
  '/map':           'Mapa / Planta',
  '/ptz':           'Controle PTZ',
  '/investigation': 'Investigação',
  '/storage':       'Armazenamento',
  '/settings':      'Configurações',
  '/users':         'Usuários',
  '/roles':         'Funções e Permissões',
  '/groups':        'Grupos',
  '/wall':          'Modo Mural',
};

function resolvePageTitle(location: string) {
  if (PAGE_TITLES[location]) return PAGE_TITLES[location];
  if (location.startsWith('/cameras/')) return 'Detalhe da Câmera';
  const base = '/' + (location.split('/')[1] ?? '');
  return PAGE_TITLES[base] ?? PRODUCT_NAME;
}

type ShortcutRole = 'viewer' | 'operator' | 'admin';
const SHORTCUT_ROLE_WEIGHT: Record<ShortcutRole, number> = { viewer: 1, operator: 2, admin: 3 };
const SHORTCUTS: Array<{ key: string; description: string; minRole?: ShortcutRole }> = [
  { key: 'Ctrl + K', description: 'Abrir paleta de comandos' },
  { key: 'Alt + 1',  description: 'Ao Vivo' },
  { key: 'Alt + 2',  description: 'Reprodução' },
  { key: 'Alt + 3',  description: 'Câmeras', minRole: 'operator' },
  { key: 'Alt + 4',  description: 'Armazenamento', minRole: 'operator' },
  { key: 'Alt + 5',  description: 'Usuários', minRole: 'operator' },
  { key: 'Alt + 6',  description: 'Configurações', minRole: 'admin' },
  { key: 'Esc',      description: 'Fechar painel / diálogo' },
  { key: '?',        description: 'Mostrar atalhos' },
];

interface AppLayoutProps { children: React.ReactNode }

export function AppLayout({ children }: AppLayoutProps) {
  const [location, setLocation] = useLocation();
  const [cmdOpen, setCmdOpen] = useState(false);
  const [shortcutsOpen, setAtalhosOpen] = useState(false);
  const { theme, setTheme } = useThemeStore();
  const cameras = useVmsDataStore((state) => state.cameras);
  const stale = useVmsDataStore((state) => state.stale);
  const isRefreshing = useVmsDataStore((state) => state.isRefreshing);
  const lastUpdatedAt = useVmsDataStore((state) => state.lastUpdatedAt);
  const refreshOperational = useVmsDataStore((state) => state.refreshOperational);
  const resourceErrors = useVmsDataStore((state) => state.resourceErrors);
  const userRole = useAuthStore((state) => state.user?.role ?? 'viewer');
  const pagePaths = useMemo(() => [
    '/live',
    '/playback',
    SHORTCUT_ROLE_WEIGHT[userRole] >= SHORTCUT_ROLE_WEIGHT.operator ? '/cameras' : null,
    SHORTCUT_ROLE_WEIGHT[userRole] >= SHORTCUT_ROLE_WEIGHT.operator ? '/storage' : null,
    SHORTCUT_ROLE_WEIGHT[userRole] >= SHORTCUT_ROLE_WEIGHT.operator ? '/users' : null,
    SHORTCUT_ROLE_WEIGHT[userRole] >= SHORTCUT_ROLE_WEIGHT.admin ? '/settings' : null,
  ], [userRole]);
  const visibleShortcuts = useMemo(
    () => SHORTCUTS.filter((shortcut) => !shortcut.minRole || SHORTCUT_ROLE_WEIGHT[userRole] >= SHORTCUT_ROLE_WEIGHT[shortcut.minRole]),
    [userRole],
  );
  const isDark = theme === 'dark' || theme === 'dim';
  const pageTitle = resolvePageTitle(location);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault(); setCmdOpen(o => !o); return;
      }
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const tag = (e.target as HTMLElement).tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') { setAtalhosOpen(o => !o); return; }
      }
      if (e.altKey && e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key) - 1;
        const path = pagePaths[idx];
        if (path) { e.preventDefault(); setLocation(path); }
        return;
      }
      if (e.key === 'Escape') setCmdOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [pagePaths, setLocation]);

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden bg-background">
      <Sidebar
        onAtalhosOpen={() => setAtalhosOpen(true)}
        onSearchOpen={() => setCmdOpen(true)}
      />

      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {/* Header */}
        <header className="h-12 flex items-center px-5 border-b border-border bg-card/60 backdrop-blur-sm shrink-0">
          <div className="flex-1 min-w-0">
            <h1 className="text-[13px] font-semibold text-foreground leading-none">{pageTitle}</h1>
            <div className="text-[10px] text-[hsl(var(--muted-foreground)_/_0.68)] mt-0.5">
              {cameras.length} câmera{cameras.length === 1 ? '' : 's'} cadastrada{cameras.length === 1 ? '' : 's'}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setTheme(isDark ? 'light' : 'dark')}
              aria-label={isDark ? 'Alternar para modo claro' : 'Alternar para modo escuro'}
              className="flex items-center justify-center w-7 h-7 rounded border border-border/70 text-[hsl(var(--muted-foreground))] hover:text-foreground hover:border-border hover:bg-[hsl(var(--accent))] transition-all"
              data-testid="button-theme-toggle-header"
            >
              {isDark ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
            </button>
          </div>
        </header>

        {stale && (
          <div
            role="status"
            className="flex min-h-9 shrink-0 items-center gap-2 border-b border-[hsl(var(--status-warning)_/_0.35)] bg-[hsl(var(--status-warning)_/_0.10)] px-3 text-[11px] text-foreground sm:px-5"
          >
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--status-warning))]" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">
              Dados operacionais temporariamente desatualizados
              {lastUpdatedAt ? ` · última atualização ${new Date(lastUpdatedAt).toLocaleTimeString('pt-BR')}` : ''}
              {Object.keys(resourceErrors).length ? ` · falha em ${Object.keys(resourceErrors).join(', ')}` : ''}
            </span>
            <button
              type="button"
              onClick={() => void refreshOperational()}
              disabled={isRefreshing}
              className="inline-flex h-7 items-center gap-1.5 rounded border border-border bg-card px-2 font-medium hover:bg-accent disabled:opacity-60"
            >
              <RefreshCw className={`h-3 w-3 ${isRefreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span className="hidden sm:inline">Atualizar</span>
            </button>
          </div>
        )}

        <main className="flex-1 min-h-0 overflow-hidden">
          <AnimatePresence mode="wait">
            <motion.div
              key={location}
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -5 }}
              transition={{ duration: 0.13, ease: 'easeOut' }}
              className="h-full min-h-0 overflow-hidden"
            >
              {children}
            </motion.div>
          </AnimatePresence>
        </main>
        <StatusStrip />
      </div>
      <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} />

      {/* Keyboard shortcuts dialog */}
      <Dialog open={shortcutsOpen} onOpenChange={setAtalhosOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-[13px] font-semibold">Atalhos de Teclado</DialogTitle>
          </DialogHeader>
          <div className="space-y-px py-1">
            {visibleShortcuts.map(s => (
              <div key={s.key} className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-[hsl(var(--accent))] transition-colors">
                <span className="text-[12px] text-[hsl(var(--muted-foreground))]">{s.description}</span>
                <Kbd className="font-mono text-[9px] ml-4 shrink-0">{s.key}</Kbd>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
