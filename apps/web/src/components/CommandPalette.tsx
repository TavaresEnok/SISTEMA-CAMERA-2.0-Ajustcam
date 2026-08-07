import { useState } from 'react';
import { useLocation } from 'wouter';
import {
  Monitor, PlaySquare,
  Camera, Settings,
  LogOut, Sun, Moon, Shield, Clock, Users, FolderKey, ShieldCheck,
  Bell, Crosshair, HardDrive, UserCircle,
  type LucideIcon,
} from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command';
import { useAuthStore } from '../store/authStore';
import { useThemeStore } from '../store/themeStore';
import { useVmsDataStore } from '../store/vmsDataStore';
import { PRODUCT_NAME } from '../lib/product-brand';

type PalettePage = {
  label: string;
  path: string;
  icon: LucideIcon;
  description: string;
  roles?: string[];
};

const PAGES: PalettePage[] = [
  // viewer+
  { label: 'Ao Vivo',       path: '/live',       icon: Monitor,     description: 'Grade de câmeras e controles' },
  { label: 'Reprodução',    path: '/playback',   icon: PlaySquare,  description: 'Revisar gravações' },
  { label: 'Controle PTZ',  path: '/ptz',        icon: Crosshair,   description: 'Movimentação e presets PTZ' },
  { label: 'Minha conta',   path: '/profile',    icon: UserCircle,  description: 'Seu perfil e gestão do grupo' },
  // operator+
  { label: 'Alertas',       path: '/alarms',     icon: Bell,        description: 'Tratamento e regras de alarme',       roles: ['admin', 'operator'] },
  { label: 'Câmeras',       path: '/cameras',    icon: Camera,      description: 'Gestão e configuração de câmeras',    roles: ['admin', 'operator'] },
  { label: 'Armazenamento', path: '/storage',    icon: HardDrive,   description: 'Disco, retenção e saúde operacional', roles: ['admin', 'operator'] },
  { label: 'Usuários',      path: '/users',      icon: Users,       description: 'Gestão de usuários',                 roles: ['admin', 'operator'] },
  // admin only
  { label: 'Grupos',        path: '/groups',     icon: FolderKey,   description: 'Câmeras e acessos por grupo',         roles: ['admin'] },
  { label: 'Funções',       path: '/roles',      icon: ShieldCheck, description: 'Perfis e permissões',                 roles: ['admin'] },
  { label: 'Configurações', path: '/settings',   icon: Settings,    description: 'Configuração do sistema',             roles: ['admin'] },
];

interface Props {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: Props) {
  const [, setLocation] = useLocation();
  const { logout, user } = useAuthStore();
  const { theme, setTheme } = useThemeStore();
  const cameras = useVmsDataStore((state) => state.cameras);
  const role = user?.role ?? 'operator';
  const visiblePages = PAGES.filter((page) => {
    return !page.roles || page.roles.includes(role);
  });

  const recent = [
    cameras[0] ? { label: `Ao Vivo — ${cameras[0].name}`, path: '/live', icon: Clock } : null,
    { label: 'Reprodução', path: '/playback', icon: Clock },
  ].filter(Boolean) as Array<{ label: string; path: string; icon: typeof Clock }>;

  const navigate = (path: string) => {
    setLocation(path);
    onClose();
  };

  const handleAction = (action: string) => {
    if (action === 'logout') { logout(); setLocation('/login'); onClose(); }
    if (action === 'theme') { setTheme(theme === 'dark' ? 'light' : 'dark'); onClose(); }
  };

  if (!open) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
        style={{ backdropFilter: 'blur(4px)', backgroundColor: 'rgba(0,0,0,0.6)' }}
        onClick={onClose}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: -8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: -8 }}
          transition={{ type: 'spring', stiffness: 400, damping: 30 }}
          className="w-full max-w-lg rounded-lg border border-border overflow-hidden shadow-lg"
          style={{ background: 'hsl(var(--card))' }}
          onClick={e => e.stopPropagation()}
        >
          <Command className="bg-transparent">
            <div className="border-b border-border px-1">
              <CommandInput
                placeholder="Buscar páginas, câmeras, ações..."
                className="h-12 text-sm border-none bg-transparent focus:ring-0"
                autoFocus
              />
            </div>
            <CommandList className="max-h-80">
              <CommandEmpty>
                <div className="py-6 text-center text-sm text-[hsl(var(--muted-foreground))]">Nenhum resultado encontrado</div>
              </CommandEmpty>

              <CommandGroup heading="Recentes">
                {recent.map(item => (
                  <CommandItem key={item.label} onSelect={() => navigate(item.path)} className="gap-3 py-2.5 cursor-pointer">
                    <item.icon className="w-4 h-4 shrink-0 text-[hsl(var(--muted-foreground))]" />
                    <span className="text-sm">{item.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>

              <CommandSeparator />

              <CommandGroup heading="Navegar">
                {visiblePages.map(page => (
                  <CommandItem key={page.path} onSelect={() => navigate(page.path)} className="gap-3 py-2.5 cursor-pointer">
                    <page.icon className="w-4 h-4 shrink-0 text-[hsl(var(--primary))]" />
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium">{page.label}</span>
                      <span className="ml-2 text-xs text-[hsl(var(--muted-foreground))]">{page.description}</span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>

              <CommandSeparator />

              <CommandGroup heading="Ações">
                <CommandItem onSelect={() => handleAction('theme')} className="gap-3 py-2.5 cursor-pointer">
                  {theme === 'dark' ? <Sun className="w-4 h-4 shrink-0" /> : <Moon className="w-4 h-4 shrink-0" />}
                  <span className="text-sm">Alternar para modo {theme === 'dark' ? 'claro' : 'escuro'}</span>
                </CommandItem>
                <CommandItem onSelect={() => handleAction('logout')} className="gap-3 py-2.5 cursor-pointer">
                  <LogOut className="w-4 h-4 shrink-0 text-[hsl(var(--destructive))]" />
                  <span className="text-sm text-[hsl(var(--destructive))]">Sair</span>
                </CommandItem>
              </CommandGroup>
            </CommandList>

            <div className="border-t border-border px-3 py-2 flex items-center gap-4" style={{ fontSize: '11px' }}>
              <span className="font-mono text-[hsl(var(--muted-foreground))]">↑↓ navegar</span>
              <span className="font-mono text-[hsl(var(--muted-foreground))]">↵ selecionar</span>
              <span className="font-mono text-[hsl(var(--muted-foreground))]">esc fechar</span>
              <span className="ml-auto font-mono text-[hsl(var(--muted-foreground))]">
                <Shield className="w-3 h-3 inline mr-1" />{PRODUCT_NAME}
              </span>
            </div>
          </Command>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
