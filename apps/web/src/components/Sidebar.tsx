import { Link, useLocation } from 'wouter';
import { motion } from 'framer-motion';
import {
  Monitor, PlaySquare, Sparkles,
  Camera, Settings,
  ChevronLeft, ChevronRight, LogOut, Keyboard, Shield,
  Server, Users, Radar, FolderKey, ShieldCheck, Search, Sun, Moon,
  Bell, Crosshair, HardDrive, UserCircle, Smartphone,
  CircleHelp, Map, LayoutGrid, Activity, FileSearch, FileArchive, FileText, ScrollText,
  type LucideIcon,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSidebarStore } from '../store/sidebarStore';
import { useAuthStore } from '../store/authStore';
import { useThemeStore } from '../store/themeStore';
import { useIsMobile } from '../hooks/use-mobile';
import { useBrandingStore } from '../store/brandingStore';
import { PRODUCT_NAME } from '../lib/product-brand';

type NavItem = {
  path: string;
  label: string;
  icon: LucideIcon;
  roles?: string[];
};

type NavSection = {
  label: string;
  icon: LucideIcon;
  items: NavItem[];
};

const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Monitoramento',
    icon: Radar,
    items: [
      { path: '/live',     label: 'Ao Vivo',       icon: Monitor },
      { path: '/playback', label: 'Reprodução',     icon: PlaySquare },
      { path: '/review',   label: 'Revisão',        icon: Sparkles },
      // Alertas requerem operador ou superior (viewers não têm acesso)
      { path: '/alarms',   label: 'Alertas',        icon: Bell,     roles: ['admin', 'operator'] },
      { path: '/ptz',      label: 'Controle PTZ',   icon: Crosshair },
      // Mapa entra no menu agora que a responsividade e o acesso por teclado
      // foram corrigidos. /wall, /investigation, /events e /reports seguem
      // fora até deixarem de ser casca (ver plano, Fase 4b).
      { path: '/map',      label: 'Mapa / Planta',  icon: Map,       roles: ['admin', 'operator'] },
    ],
  },
  {
    label: 'Infraestrutura',
    icon: Server,
    items: [
      // Câmeras e Armazenamento são exclusivos de admin/operador
      { path: '/cameras', label: 'Câmeras',       icon: Camera,   roles: ['admin', 'operator'] },
      { path: '/storage', label: 'Armazenamento', icon: HardDrive, roles: ['admin', 'operator'] },
      { path: '/performance', label: 'Desempenho', icon: Activity,  roles: ['admin', 'operator'] },
    ],
  },
  {
    label: 'Investigação',
    icon: FileSearch,
    items: [
      { path: '/evidence', label: 'Evidências', icon: FileArchive, roles: ['admin', 'operator'] },
    ],
  },
  {
    label: 'Administração',
    icon: Users,
    items: [
      // Viewer vê "Minha conta" (perfil + gestão do próprio grupo se for group admin)
      { path: '/profile', label: 'Minha conta', icon: UserCircle },
      { path: '/users',   label: 'Usuários',    icon: Users,       roles: ['admin', 'operator'] },
      // Grupos: apenas admin global (Ajust Consulting gerencia grupos)
      { path: '/groups',  label: 'Grupos',      icon: FolderKey,   roles: ['admin'] },
      { path: '/roles',   label: 'Funções',     icon: ShieldCheck, roles: ['admin'] },
      { path: '/settings',label: 'Configurações',icon: Settings,   roles: ['admin'] },
      { path: '/audit-logs', label: 'Auditoria', icon: ScrollText,  roles: ['admin'] },
      { path: '/app-builder', label: 'Apps white-label', icon: Smartphone, roles: ['admin'] },
      // Geração de APK foi movida para a DRAC Central (painel mestre). Mantemos a
      // rota /app-builder acessível por URL, mas fora do menu de cada instalação.
    ],
  },
];

/* Role accent — no red for admin; steel blue hierarchy */
const ROLE_COLOR: Record<string, string> = {
  admin:    'text-[hsl(var(--primary))]',
  operator: 'text-[hsl(var(--chart-2))]',
  viewer:   'text-[hsl(var(--muted-foreground))]',
};

export function Sidebar({
  onAtalhosOpen,
  onSearchOpen,
}: {
  onAtalhosOpen?: () => void;
  onSearchOpen?: () => void;
}) {
  const { isExpanded: storedExpanded, toggle } = useSidebarStore();
  const isMobile = useIsMobile();
  const isExpanded = storedExpanded && !isMobile;
  const { user, logout } = useAuthStore();
  const { theme, setTheme } = useThemeStore();
  const [location] = useLocation();
  const isDark = theme === 'dark' || theme === 'dim';
  const role = user?.role ?? 'operator';
  const facilityName = useBrandingStore((state) => state.facilityName);
  const logoDataUrl = useBrandingStore((state) => state.logoDataUrl);

  const roleColor = ROLE_COLOR[user?.role ?? 'operator'] ?? ROLE_COLOR.operator;
  const visibleSections = NAV_SECTIONS
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => !item.roles || item.roles.includes(role)),
    }))
    .filter((section) => section.items.length > 0);

  return (
    <motion.aside
      animate={{ width: isExpanded ? 240 : 56 }}
      transition={{ type: 'spring', stiffness: 320, damping: 32 }}
      className="sidebar-shell relative flex flex-col h-full overflow-hidden shrink-0"
      style={{ minWidth: isExpanded ? 240 : 56 }}
    >
      {/* ── Brand header ── */}
      <div className="sidebar-brand flex items-center h-14 px-3 shrink-0">
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <div className="sidebar-mark shrink-0 w-8 h-8 rounded-xl flex items-center justify-center overflow-hidden">
            {logoDataUrl ? <img src={logoDataUrl} alt={facilityName} className="w-full h-full object-contain" /> : <Shield className="w-3.5 h-3.5 text-[hsl(var(--primary))]" />}
          </div>
          {isExpanded && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.08 }}
              className="min-w-0"
            >
              <div className="max-w-[150px] truncate text-[13px] font-semibold text-sidebar-foreground leading-tight tracking-tight" title={facilityName}>{facilityName}</div>
              <div className="text-[10px] text-[hsl(var(--muted-foreground))]">{PRODUCT_NAME}</div>
            </motion.div>
          )}
        </div>
        <button
          onClick={toggle}
          aria-label={isExpanded ? 'Recolher menu lateral' : 'Expandir menu lateral'}
          className="sidebar-toggle shrink-0 w-7 h-7 hidden md:flex items-center justify-center rounded-xl transition-colors"
          data-testid="button-sidebar-toggle"
        >
          {isExpanded ? <ChevronLeft className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>
      </div>

      {/* ── Navigation ── */}
      <nav className="flex-1 overflow-y-auto px-2 py-4 space-y-5">
        {visibleSections.map(section => (
          <div key={section.label} className="space-y-1.5">
            {isExpanded && (
              <div className="flex items-center gap-2 px-3 pt-1 text-[9px] font-mono uppercase tracking-[0.18em] text-[hsl(var(--muted-foreground)_/_0.7)]">
                <section.icon className="w-3 h-3" />
                <span>{section.label}</span>
              </div>
            )}
            <div className="space-y-1.5">
              {section.items.map(({ path, label, icon: Icon }) => {
                const isActive = location === path || (path !== '/live' && location.startsWith(path));
                return isExpanded ? (
                  <Link key={path} href={path} aria-current={isActive ? 'page' : undefined}>
                    <div
                      data-testid={`nav-${label.toLowerCase().replace(/[^a-z]/g, '-')}`}
                      className={`sidebar-item relative flex items-center gap-3 h-10 px-3 rounded-lg cursor-pointer transition-colors duration-150 group
                        ${isActive
                          ? 'sidebar-item-active text-foreground bg-[hsl(var(--accent))]'
                          : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-foreground'
                        }`}
                    >
                      <Icon className="w-4 h-4 shrink-0" />
                      <span className="text-[12.5px] font-medium flex-1 truncate">{label}</span>
                    </div>
                  </Link>
                ) : (
                  <Tooltip key={path} delayDuration={0}>
                    <TooltipTrigger asChild>
                      <Link href={path} aria-label={label} aria-current={isActive ? 'page' : undefined}>
                        <div
                          className={`relative flex items-center justify-center h-10 w-10 rounded-lg cursor-pointer transition-colors duration-150 mx-auto
                            ${isActive
                              ? 'sidebar-item-active text-foreground bg-[hsl(var(--accent))]'
                              : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-foreground'
                            }`}
                        >
                          <Icon className="w-4 h-4 shrink-0" />
                        </div>
                      </Link>
                    </TooltipTrigger>
                    <TooltipContent side="right" className="text-xs">{label}</TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* ── Bottom controls ── */}
      <div className="sidebar-footer px-2 py-2 shrink-0 space-y-2">
        <div className={`grid gap-1.5 ${isExpanded ? 'grid-cols-2' : 'grid-cols-1'}`}>
          <button
            onClick={onSearchOpen}
            className="sidebar-footer-btn flex h-9 items-center justify-center gap-2 rounded-lg text-[hsl(var(--muted-foreground))] transition-colors hover:text-sidebar-foreground"
            title="Buscar"
            data-testid="button-command-palette"
          >
            <Search className="h-3.5 w-3.5 shrink-0" />
            {isExpanded && <span className="text-[11px]">Buscar</span>}
          </button>
          <button
            onClick={() => setTheme(isDark ? 'light' : 'dark')}
            className="sidebar-footer-btn flex h-9 items-center justify-center gap-2 rounded-lg text-[hsl(var(--muted-foreground))] transition-colors hover:text-sidebar-foreground"
            title={isDark ? 'Modo claro' : 'Modo escuro'}
          >
            {isDark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            {isExpanded && <span className="text-[11px]">Tema</span>}
          </button>
        </div>
        {isExpanded && (
          <button
            onClick={onAtalhosOpen}
            className="sidebar-footer-btn flex h-8 w-full items-center gap-2 rounded-lg px-3 text-[hsl(var(--muted-foreground))] transition-colors hover:text-sidebar-foreground"
          >
            <Keyboard className="h-3.5 w-3.5 shrink-0" />
            <span className="text-[11px]">Atalhos</span>
            <span className="ml-auto font-mono text-[9px] opacity-60">?</span>
          </button>
        )}

        <a
          href="/ajuda/"
          target="_blank"
          rel="noreferrer"
          aria-label="Abrir a Central de Ajuda"
          title="Central de Ajuda"
          className={`sidebar-footer-btn flex h-8 items-center gap-2 rounded-lg text-[hsl(var(--muted-foreground))] transition-colors hover:text-sidebar-foreground ${isExpanded ? 'w-full px-3' : 'w-9 mx-auto justify-center'}`}
        >
          <CircleHelp className="h-3.5 w-3.5 shrink-0" />
          {isExpanded && <span className="text-[11px]">Central de Ajuda</span>}
        </a>

        {/* User row */}
        {user && (
          <div className={`sidebar-user flex items-center gap-2.5 h-12 px-2.5 rounded-lg ${isExpanded ? 'pr-2' : 'justify-center'}`}>
            <div className="shrink-0 w-8 h-8 rounded-xl bg-[hsl(var(--primary)_/_0.12)] border border-[hsl(var(--primary)_/_0.18)] flex items-center justify-center">
              <span className="text-[10px] font-bold text-[hsl(var(--primary))]">
                {user.name.split(' ').map(n => n[0]).join('').slice(0, 2)}
              </span>
            </div>
            {isExpanded && (
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] font-medium text-sidebar-foreground truncate leading-tight">{user.name}</div>
                <div className={`text-[9px] font-mono capitalize tracking-[0.12em] ${roleColor}`}>{user.role}</div>
              </div>
            )}
            {isExpanded && (
              <button
                onClick={logout}
                aria-label="Sair da conta"
                className="shrink-0 w-7 h-7 flex items-center justify-center rounded-xl text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive)_/_0.08)] transition-colors"
                data-testid="button-logout"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}
        {user && !isExpanded && (
          <button
            type="button"
            onClick={logout}
            aria-label="Sair da conta"
            title="Sair"
            className="sidebar-footer-btn flex h-9 w-9 mx-auto items-center justify-center rounded-lg text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--destructive))]"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </motion.aside>
  );
}
