import type { InputHTMLAttributes, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import {
  Bell,
  Camera as CameraIcon,
  Check,
  Cpu,
  Database,
  HardDrive,
  Home,
  LayoutGrid,
  LoaderCircle,
  Lock,
  Moon,
  Palette,
  Play,
  Save,
  Server,
  Settings as SettingsIcon,
  Shield,
  Sun,
  Trash2,
  Upload,
  Users,
  VideoOff,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Slider } from '@/components/ui/slider';
import { useThemeStore } from '../store/themeStore';
import { useVmsDataStore } from '../store/vmsDataStore';
import { useAuthStore } from '../store/authStore';
import { getApiBaseUrl } from '../lib/api-base';
import { toast } from '../hooks/use-toast';
import { GpuAccelerationPanel } from '../components/GpuAccelerationPanel';
import { useBrandingStore } from '../store/brandingStore';
import { contrastRatio } from '../lib/web-operational';

const API_URL = getApiBaseUrl();

const SECTIONS = [
  { id: 'general', label: 'Geral', description: 'Identidade e tema', icon: Shield },
  { id: 'branding', label: 'Aparência', description: 'Logo e cores do app móvel', icon: Palette },
  { id: 'users', label: 'Usuários', description: 'Contas e acesso', icon: Users },
  { id: 'storage', label: 'Retenção', description: 'Retenção e disco', icon: Database },
  { id: 'gpu', label: 'GPU / Aceleração', description: 'Placa de vídeo', icon: Cpu },
  { id: 'security', label: 'Segurança', description: 'Sessão e senha', icon: Lock },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

type SystemSettings = {
  facilityName: string;
  defaultRetentionDays: number;
  autoCleanupEnabled: boolean;
  sessionTimeoutMinutes: number;
  maxLoginAttempts: number;
  requireStrongPassword: boolean;
  alarmAudioEnabled: boolean;
  brandLogoDataUrl: string;
  brandUseDefaultColors: boolean;
  brandPrimaryColor: string;
  brandBackgroundColor: string;
  brandBackgroundColor2: string;
  brandSecondaryColor: string;
  brandPrimaryTextColor: string;
  brandSecondaryTextColor: string;
  brandBackgroundTextColor: string;
  brandMenuColor: string;
  brandMenuTextColor: string;
  brandButtonTextColor: string;
  brandBorderColor: string;
  brandSuccessColor: string;
  brandWarningColor: string;
  brandDangerColor: string;
  brandLightPrimaryColor: string;
  brandLightBackgroundColor: string;
  brandLightBackgroundColor2: string;
  brandLightSecondaryColor: string;
  brandLightPrimaryTextColor: string;
  brandLightSecondaryTextColor: string;
  brandLightBackgroundTextColor: string;
  brandLightMenuColor: string;
  brandLightMenuTextColor: string;
  brandLightButtonTextColor: string;
  brandLightBorderColor: string;
  brandLightSuccessColor: string;
  brandLightWarningColor: string;
  brandLightDangerColor: string;
};

type BrandingEditorTheme = 'dark' | 'light';
type BrandingColorKey = Exclude<keyof SystemSettings,
  | 'facilityName'
  | 'defaultRetentionDays'
  | 'autoCleanupEnabled'
  | 'sessionTimeoutMinutes'
  | 'maxLoginAttempts'
  | 'requireStrongPassword'
  | 'alarmAudioEnabled'
  | 'brandLogoDataUrl'
  | 'brandUseDefaultColors'
>;

const BRANDING_KEYS = {
  dark: {
    primary: 'brandPrimaryColor', buttonText: 'brandButtonTextColor',
    background: 'brandBackgroundColor', background2: 'brandBackgroundColor2', backgroundText: 'brandBackgroundTextColor',
    surface: 'brandSecondaryColor', text: 'brandPrimaryTextColor', textSub: 'brandSecondaryTextColor',
    menu: 'brandMenuColor', menuText: 'brandMenuTextColor', border: 'brandBorderColor',
    success: 'brandSuccessColor', warning: 'brandWarningColor', danger: 'brandDangerColor',
  },
  light: {
    primary: 'brandLightPrimaryColor', buttonText: 'brandLightButtonTextColor',
    background: 'brandLightBackgroundColor', background2: 'brandLightBackgroundColor2', backgroundText: 'brandLightBackgroundTextColor',
    surface: 'brandLightSecondaryColor', text: 'brandLightPrimaryTextColor', textSub: 'brandLightSecondaryTextColor',
    menu: 'brandLightMenuColor', menuText: 'brandLightMenuTextColor', border: 'brandLightBorderColor',
    success: 'brandLightSuccessColor', warning: 'brandLightWarningColor', danger: 'brandLightDangerColor',
  },
} as const satisfies Record<BrandingEditorTheme, Record<string, BrandingColorKey>>;

const BRANDING_FALLBACKS = {
  dark: {
    primary: '#3b82f6', buttonText: '#ffffff', background: '#0b0d12', background2: '#0b0d12', backgroundText: '#f4f6fa',
    surface: '#15181f', text: '#f4f6fa', textSub: '#9aa3af', menu: '#15181f', menuText: '#6b7484', border: '#2a2f3a',
    success: '#22c55e', warning: '#f59e0b', danger: '#ef4444',
  },
  light: {
    primary: '#2563eb', buttonText: '#ffffff', background: '#f5f7fb', background2: '#ffffff', backgroundText: '#111827',
    surface: '#ffffff', text: '#111827', textSub: '#4b5563', menu: '#ffffff', menuText: '#64748b', border: '#94a3b8',
    success: '#15803d', warning: '#b45309', danger: '#dc2626',
  },
} as const;

// ~400 KB de imagem (base64 fica ~33% maior). Acima disso o upload é recusado.
const MAX_LOGO_BYTES = 400 * 1024;

function formatBytes(value?: number | null) {
  if (!value || value <= 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(unitIndex < 2 ? 0 : 1)} ${units[unitIndex]}`;
}

function SectionTitle({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{eyebrow}</p>
      <h2 className="mt-1 text-xl font-semibold tracking-tight text-foreground">{title}</h2>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-border/70 bg-card/85 shadow-sm shadow-black/5 ${className}`}>{children}</div>;
}

function MetricCard({ icon: Icon, label, value, detail }: { icon: LucideIcon; label: string; value: string; detail: string }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
        </div>
        <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-background/70 text-muted-foreground">
          <Icon className="h-4 w-4" />
        </div>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">{detail}</p>
    </Card>
  );
}

function SettingRow({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
  return (
    <div className="grid gap-3 border-b border-border/70 px-4 py-4 last:border-0 md:grid-cols-[1fr_auto] md:items-center">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {description ? <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p> : null}
      </div>
      <div className="min-w-0 md:min-w-[220px] md:justify-self-end">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange, label = 'Alternar opção' }: { checked: boolean; onChange: (value: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`inline-flex h-7 w-12 shrink-0 items-center rounded-full border p-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--primary)_/_0.45)] focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
        checked
          ? 'border-[hsl(var(--status-online)_/_0.55)] bg-[hsl(var(--status-online))]'
          : 'border-border bg-muted'
      }`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
    >
      <span
        aria-hidden="true"
        className={`block h-5 w-5 rounded-full bg-white shadow-md transition-transform duration-200 ease-out ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`h-10 w-full rounded-xl border border-border bg-background/70 px-3 text-sm outline-none transition focus:border-[hsl(var(--primary)_/_0.6)] focus:ring-2 focus:ring-[hsl(var(--primary)_/_0.1)] ${props.className ?? ''}`}
    />
  );
}

// Seletor de cor COMPACTO: swatch pequeno + hex editável + limpar. Vários cabem
// numa linha (grid), diferente do ColorField grande de 1 por linha.
function CompactColor({ label, value, onChange, fallback }: { label: string; value: string; onChange: (value: string) => void; fallback: string }) {
  const isSet = /^#[0-9a-fA-F]{6}$/.test(value);
  const swatch = isSet ? value : fallback;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] leading-tight text-muted-foreground">{label}</span>
      <div className="flex h-9 items-center gap-1.5 rounded-lg border border-border bg-background/70 px-1.5">
        <label className="relative h-5 w-5 shrink-0 cursor-pointer overflow-hidden rounded border border-border" style={{ background: swatch }} title="Escolher cor">
          <input type="color" value={swatch} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
        </label>
        <input
          type="text"
          value={value}
          placeholder="auto"
          onChange={(e) => onChange(e.target.value.trim())}
          className="w-full min-w-0 bg-transparent font-mono text-[11px] uppercase text-foreground outline-none placeholder:normal-case placeholder:text-muted-foreground"
        />
        {isSet ? (
          <button type="button" onClick={() => onChange('')} className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground" title="Usar padrão do tema">✕</button>
        ) : null}
      </div>
    </div>
  );
}

// Agrupa cores de uma mesma SUPERFÍCIE (ex.: card = cor + textos) num bloco.
function ColorGroup({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/40 p-3">
      <div className="mb-2">
        <p className="text-xs font-semibold text-foreground">{title}</p>
        {hint ? <p className="text-[10.5px] leading-tight text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{children}</div>
    </div>
  );
}

/**
 * Prévia FIEL da tela Início do app móvel (CentralScreen). Renderizada em tamanho
 * REAL de celular (375px) usando os MESMOS valores do StyleSheet do app — fontes,
 * paddings, radius e cores — e depois apenas reduzida com transform:scale().
 * Assim a prévia é o layout do app de verdade, não uma imitação apertada.
 */
type PreviewColorKey = keyof (typeof BRANDING_KEYS)['dark'];
function AppHomePreview({ color }: { color: (key: PreviewColorKey) => string }) {
  const S = 0.75;               // escala de exibição
  const W = 375;                // largura real do "celular"
  const H = 700;                // altura do frame (conteúdo + bezel)
  const accent = color('primary');
  const onAccent = color('buttonText');
  const heroGrad = `linear-gradient(135deg, ${accent}, color-mix(in srgb, ${accent} 70%, #000))`;
  const tabs = [
    { Icon: Home, label: 'Central', active: true },
    { Icon: LayoutGrid, label: 'Mosaico' },
    { Icon: Play, label: 'Reprodução' },
    { Icon: Bell, label: 'Alarmes', badge: true },
    { Icon: SettingsIcon, label: 'Ajustes' },
  ];
  return (
    <div style={{ width: W * S, height: H * S }}>
      <div style={{ width: W, transformOrigin: 'top left', transform: `scale(${S})` }}>
        {/* Moldura do aparelho */}
        <div className="rounded-[38px] p-[9px] shadow-2xl" style={{ backgroundColor: '#0a0c11', boxShadow: '0 18px 44px -18px rgba(0,0,0,0.6)' }}>
          <div
            className="relative flex flex-col overflow-hidden rounded-[30px]"
            style={{ height: H - 18, background: `linear-gradient(165deg, ${color('background')}, ${color('background2')})` }}
          >
            {/* Conteúdo (paddingHorizontal: 20 como no app) */}
            <div className="flex-1 overflow-hidden" style={{ padding: '14px 20px 0' }}>
              {/* Cabeçalho: data + nome | sino + avatar (42x42, r14) */}
              <div className="flex items-center justify-between gap-3" style={{ marginTop: 10 }}>
                <div className="min-w-0">
                  <p style={{ color: color('textSub'), fontSize: 12, fontWeight: 600, textTransform: 'capitalize' }}>sexta, 18 de julho</p>
                  <p className="truncate" style={{ color: color('backgroundText'), fontSize: 25, fontWeight: 800, letterSpacing: -0.5, marginTop: 1 }}>Grupo Flash</p>
                </div>
                <div className="flex shrink-0 items-center" style={{ gap: 10 }}>
                  <span className="relative flex items-center justify-center border" style={{ width: 42, height: 42, borderRadius: 14, backgroundColor: color('surface'), borderColor: color('border') }}>
                    <Bell style={{ width: 19, height: 19, color: color('text') }} />
                    <span className="absolute flex items-center justify-center" style={{ top: -6, right: -6, minWidth: 19, height: 19, borderRadius: 10, backgroundColor: color('danger'), border: `1.5px solid ${color('surface')}` }}>
                      <span style={{ color: '#fff', fontSize: 10, fontWeight: 800 }}>2</span>
                    </span>
                  </span>
                  <span className="flex items-center justify-center" style={{ width: 42, height: 42, borderRadius: 14, backgroundColor: accent }}>
                    <span style={{ color: onAccent, fontSize: 15, fontWeight: 800 }}>GF</span>
                  </span>
                </div>
              </div>

              {/* Hero (r22, p18, gradiente do accent) */}
              <div style={{ marginTop: 15, borderRadius: 22, padding: 18, paddingBottom: 16, background: heroGrad }}>
                <div className="flex items-center justify-between" style={{ gap: 12 }}>
                  <div className="min-w-0">
                    <p style={{ color: 'rgba(255,255,255,0.72)', fontSize: 9.5, fontWeight: 800, letterSpacing: 1.2, whiteSpace: 'nowrap' }}>SISTEMA DE MONITORAMENTO</p>
                    <p className="truncate" style={{ color: '#fff', fontSize: 18.5, fontWeight: 800, letterSpacing: -0.3, marginTop: 2 }}>Grupo Flash</p>
                  </div>
                  <span className="flex shrink-0 items-center" style={{ gap: 6, backgroundColor: 'rgba(255,255,255,0.16)', borderRadius: 999, padding: '6px 11px' }}>
                    <span style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: '#4ade80' }} />
                    <span style={{ color: '#fff', fontSize: 11, fontWeight: 800 }}>Operacional</span>
                  </span>
                </div>
                <div style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.25)', margin: '14px 0' }} />
                <div className="flex items-stretch">
                  {[{ Icon: CameraIcon, v: 2, l: 'Online' }, { Icon: VideoOff, v: 1, l: 'Offline' }, { Icon: LayoutGrid, v: 3, l: 'Total' }].map(({ Icon, v, l }) => (
                    <div key={l} className="flex flex-1 flex-col items-center" style={{ gap: 3 }}>
                      <span className="flex items-center justify-center" style={{ width: 30, height: 30, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.18)', marginBottom: 3 }}>
                        <Icon style={{ width: 15, height: 15, color: '#fff' }} />
                      </span>
                      <span style={{ color: '#fff', fontSize: 21, fontWeight: 800, letterSpacing: -0.5, lineHeight: 1 }}>{v}</span>
                      <span style={{ color: 'rgba(255,255,255,0.75)', fontSize: 10.5, fontWeight: 700 }}>{l}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Ações rápidas (minHeight 75, r17) */}
              <div className="flex" style={{ gap: 9, marginTop: 15 }}>
                {[{ Icon: LayoutGrid, l: 'Mosaico' }, { Icon: Play, l: 'Gravações' }, { Icon: Bell, l: 'Alarmes' }].map(({ Icon, l }) => (
                  <div key={l} className="flex flex-1 flex-col items-center justify-center border" style={{ minHeight: 75, borderRadius: 17, gap: 6, backgroundColor: color('surface'), borderColor: color('border') }}>
                    <span className="flex items-center justify-center" style={{ width: 34, height: 34, borderRadius: 11, backgroundColor: `color-mix(in srgb, ${accent} 15%, transparent)` }}>
                      <Icon style={{ width: 17, height: 17, color: accent }} />
                    </span>
                    <span style={{ color: color('text'), fontSize: 10.5, fontWeight: 800 }}>{l}</span>
                  </div>
                ))}
              </div>

              {/* Favoritas: título + chip de contagem */}
              <div className="flex items-center justify-between" style={{ marginTop: 19 }}>
                <span style={{ color: color('backgroundText'), fontSize: 16, fontWeight: 800, letterSpacing: -0.2 }}>Favoritas</span>
                <span className="border" style={{ borderRadius: 999, padding: '3px 10px', borderColor: color('border'), backgroundColor: color('surface') }}>
                  <span style={{ color: color('textSub'), fontSize: 11.5, fontWeight: 800 }}>3</span>
                </span>
              </div>

              {/* CameraTile destaque (height 198, r18) */}
              <div className="relative overflow-hidden border" style={{ marginTop: 12, height: 198, borderRadius: 18, borderColor: color('border'), background: 'linear-gradient(180deg, #1a2230 0%, #0c111a 60%, #05080e 100%)' }}>
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="flex items-center justify-center" style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.18)', border: '1px solid rgba(255,255,255,0.25)' }}>
                    <Play style={{ width: 16, height: 16, color: '#fff', marginLeft: 2 }} />
                  </span>
                </div>
                <span className="absolute flex items-center" style={{ top: 10, left: 10, gap: 5, backgroundColor: 'rgba(239,68,68,0.92)', padding: '3px 7px', borderRadius: 7 }}>
                  <span style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: '#fff' }} />
                  <span style={{ color: '#fff', fontSize: 8.5, fontWeight: 800, letterSpacing: 0.5 }}>AO VIVO</span>
                </span>
                <span className="absolute flex items-center justify-center" style={{ top: 6, right: 6, width: 27, height: 27, borderRadius: 14, backgroundColor: 'rgba(0,0,0,0.4)' }}>
                  <span style={{ color: '#facc15', fontSize: 13, lineHeight: 1 }}>★</span>
                </span>
                <div className="absolute" style={{ left: 13, right: 13, bottom: 13 }}>
                  <p style={{ color: '#fff', fontSize: 16, fontWeight: 800, textShadow: '0 1px 4px rgba(0,0,0,0.6)' }}>Entrada principal</p>
                  <p style={{ color: 'rgba(255,255,255,0.8)', fontSize: 11.5, fontWeight: 600, marginTop: 1, textShadow: '0 1px 4px rgba(0,0,0,0.6)' }}>Grupo Flash · 1080p · AO VIVO</p>
                </div>
              </div>
            </div>

            {/* Menu inferior (5 abas reais, labels 9.5/800) */}
            <div className="flex items-start justify-around" style={{ padding: '11px 12px 16px', borderTop: `1px solid ${color('border')}`, backgroundColor: color('menu') }}>
              {tabs.map(({ Icon, label, active, badge }) => (
                <div key={label} className="relative flex flex-1 flex-col items-center" style={{ gap: 5 }}>
                  <span className="relative flex items-center justify-center" style={{ height: 24 }}>
                    <Icon style={{ width: 21, height: 21, color: active ? accent : color('menuText') }} />
                    {badge ? (
                      <span className="absolute flex items-center justify-center" style={{ top: -5, right: -9, minWidth: 16, height: 16, borderRadius: 8, backgroundColor: color('danger'), border: `1.5px solid ${color('menu')}` }}>
                        <span style={{ color: '#fff', fontSize: 9, fontWeight: 800 }}>2</span>
                      </span>
                    ) : null}
                  </span>
                  <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: 0.2, color: active ? accent : color('menuText') }}>{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function BrandingPaletteEditor({
  mode, settings, useDefaultColors, onChange,
}: {
  mode: BrandingEditorTheme;
  settings: SystemSettings;
  useDefaultColors: boolean;
  onChange: (key: BrandingColorKey, value: string) => void;
}) {
  const keys = BRANDING_KEYS[mode];
  const fallback = BRANDING_FALLBACKS[mode];
  const color = (key: keyof typeof keys) => useDefaultColors ? fallback[key] : settings[keys[key]] || fallback[key];
  const contrastChecks = [
    { label: 'Botão', ratio: contrastRatio(color('buttonText'), color('primary')) },
    { label: 'Fundo', ratio: contrastRatio(color('backgroundText'), color('background')) },
    { label: 'Card', ratio: contrastRatio(color('text'), color('surface')) },
    { label: 'Subtexto', ratio: contrastRatio(color('textSub'), color('surface')) },
    { label: 'Menu', ratio: contrastRatio(color('menuText'), color('menu')) },
  ];
  const hasContrastWarning = contrastChecks.some((check) => check.ratio < 4.5);

  return (
    <fieldset disabled={useDefaultColors} className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="space-y-3">
        <ColorGroup title="Destaque" hint="Botões, links e ícones ativos.">
          <CompactColor label="Cor principal" value={settings[keys.primary]} onChange={(v) => onChange(keys.primary, v)} fallback={fallback.primary} />
          <CompactColor label="Texto do botão" value={settings[keys.buttonText]} onChange={(v) => onChange(keys.buttonText, v)} fallback={fallback.buttonText} />
        </ColorGroup>
        <ColorGroup title="Fundo da tela" hint="Fundo e textos fora de cards. A segunda cor cria o gradiente.">
          <CompactColor label="Cor de fundo" value={settings[keys.background]} onChange={(v) => onChange(keys.background, v)} fallback={fallback.background} />
          <CompactColor label="Fundo 2 (gradiente)" value={settings[keys.background2]} onChange={(v) => onChange(keys.background2, v)} fallback={fallback.background2} />
          <CompactColor label="Texto do fundo" value={settings[keys.backgroundText]} onChange={(v) => onChange(keys.backgroundText, v)} fallback={fallback.backgroundText} />
        </ColorGroup>
        <ColorGroup title="Card / bloco" hint="Cards, painéis, campos e os textos sobre eles.">
          <CompactColor label="Cor do card" value={settings[keys.surface]} onChange={(v) => onChange(keys.surface, v)} fallback={fallback.surface} />
          <CompactColor label="Texto do card" value={settings[keys.text]} onChange={(v) => onChange(keys.text, v)} fallback={fallback.text} />
          <CompactColor label="Subtexto do card" value={settings[keys.textSub]} onChange={(v) => onChange(keys.textSub, v)} fallback={fallback.textSub} />
        </ColorGroup>
        <ColorGroup title="Menu inferior" hint="Barra de navegação e itens inativos.">
          <CompactColor label="Cor do menu" value={settings[keys.menu]} onChange={(v) => onChange(keys.menu, v)} fallback={fallback.menu} />
          <CompactColor label="Texto do menu" value={settings[keys.menuText]} onChange={(v) => onChange(keys.menuText, v)} fallback={fallback.menuText} />
        </ColorGroup>
        <ColorGroup title="Bordas e status" hint="Linhas, sucesso, alerta e erro.">
          <CompactColor label="Borda" value={settings[keys.border]} onChange={(v) => onChange(keys.border, v)} fallback={fallback.border} />
          <CompactColor label="Sucesso" value={settings[keys.success]} onChange={(v) => onChange(keys.success, v)} fallback={fallback.success} />
          <CompactColor label="Alerta" value={settings[keys.warning]} onChange={(v) => onChange(keys.warning, v)} fallback={fallback.warning} />
          <CompactColor label="Erro" value={settings[keys.danger]} onChange={(v) => onChange(keys.danger, v)} fallback={fallback.danger} />
        </ColorGroup>
      </div>

      <div>
        <p className="mb-2 text-[11px] font-semibold text-muted-foreground">PRÉVIA DO APP</p>
        <AppHomePreview color={color} />
        <div className={`mt-3 rounded-lg border p-2.5 ${hasContrastWarning ? 'border-[hsl(var(--status-warning)_/_0.4)] bg-[hsl(var(--status-warning)_/_0.08)]' : 'border-[hsl(var(--status-online)_/_0.35)] bg-[hsl(var(--status-online)_/_0.08)]'}`}>
          <div className="mb-1.5 text-[10px] font-semibold text-foreground">
            {hasContrastWarning ? 'Contraste a revisar' : 'Contraste aprovado'}
          </div>
          <div className="grid grid-cols-2 gap-1">
            {contrastChecks.map((check) => (
              <div key={check.label} className="flex items-center justify-between gap-2 text-[9px] text-muted-foreground">
                <span>{check.label}</span>
                <span className={`font-mono font-semibold ${check.ratio >= 4.5 ? 'text-[hsl(var(--status-online))]' : 'text-[hsl(var(--status-warning))]'}`}>
                  {check.ratio ? `${check.ratio.toFixed(1)}:1` : 'inválido'}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-[9px] leading-snug text-muted-foreground">Meta mínima: 4,5:1 para textos pequenos.</p>
        </div>
      </div>
    </fieldset>
  );
}

function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'danger' | 'success' | 'warning' }) {
  const toneClass = {
    neutral: 'border-border bg-background text-muted-foreground',
    danger: 'border-[hsl(var(--destructive)_/_0.25)] bg-[hsl(var(--destructive)_/_0.1)] text-[hsl(var(--destructive))]',
    success: 'border-[hsl(var(--status-online)_/_0.25)] bg-[hsl(var(--status-online)_/_0.1)] text-[hsl(var(--status-online))]',
    warning: 'border-[hsl(var(--status-warning)_/_0.25)] bg-[hsl(var(--status-warning)_/_0.1)] text-[hsl(var(--status-warning))]',
  }[tone];
  return <span className={`rounded-md border px-2 py-1 text-[10px] font-semibold ${toneClass}`}>{children}</span>;
}

export default function ConfiguracoesPage() {
  const { theme, setTheme } = useThemeStore();
  const users = useVmsDataStore((state) => state.users);
  const system = useVmsDataStore((state) => state.system);
  const cameras = useVmsDataStore((state) => state.cameras);
  const accessToken = useAuthStore((state) => state.accessToken);
  const reloadBranding = useBrandingStore((state) => state.load);

  const [activeSection, setActiveSection] = useState<SectionId>('general');
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [brandingEditorTheme, setBrandingEditorTheme] = useState<BrandingEditorTheme>('dark');

  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${accessToken}` }), [accessToken]);

  const loadSettings = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    try {
      const { data } = await axios.get<SystemSettings>(`${API_URL}/settings`, { headers: authHeaders });
      setSettings(data);
      await reloadBranding();
    } catch (error) {
      toast({
        title: 'Falha ao carregar configurações',
        description: error instanceof Error ? error.message : 'Não foi possível carregar.',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }, [accessToken, authHeaders, reloadBranding]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const update = <K extends keyof SystemSettings>(key: K, value: SystemSettings[K]) => {
    setSettings((current) => (current ? { ...current, [key]: value } : current));
  };

  const handleLogoFile = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast({ title: 'Arquivo inválido', description: 'Selecione uma imagem (PNG, JPG ou SVG).', variant: 'destructive' });
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      toast({ title: 'Imagem muito grande', description: 'O logo deve ter no máximo 400 KB.', variant: 'destructive' });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') return;
      // Converte o logo para PNG real via canvas. O build do APK (AAPT) recusa
      // JPEG/WebP com extensão .png; padronizando em PNG, qualquer upload funciona.
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || 256;
        canvas.height = img.naturalHeight || 256;
        const ctx = canvas.getContext('2d');
        if (!ctx) { update('brandLogoDataUrl', reader.result as string); return; }
        ctx.drawImage(img, 0, 0);
        try {
          update('brandLogoDataUrl', canvas.toDataURL('image/png'));
        } catch {
          update('brandLogoDataUrl', reader.result as string);
        }
      };
      img.onerror = () => update('brandLogoDataUrl', reader.result as string);
      img.src = reader.result;
    };
    reader.onerror = () => toast({ title: 'Falha ao ler a imagem', variant: 'destructive' });
    reader.readAsDataURL(file);
  };

  const metrics = useMemo(() => {
    const online = cameras.filter((camera) => camera.isOnline).length;
    const activeUsers = users.filter((user) => user.active).length;
    const usage = system?.disk.usagePercent ?? 0;
    return {
      online: `${online}/${cameras.length || 0}`,
      activeUsers: `${activeUsers}/${users.length || 0}`,
      disk: usage ? `${Math.round(usage)}%` : '-',
      recordings: String(system?.recordings.count ?? 0),
    };
  }, [cameras, system, users]);

  const saveSettings = async (payload: SystemSettings, successDescription: string) => {
    setSaving(true);
    try {
      const { data } = await axios.patch<SystemSettings>(`${API_URL}/settings`, payload, { headers: authHeaders });
      setSettings(data);
      await reloadBranding();
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
      toast({ title: 'Configurações salvas', description: successDescription });
    } catch (error) {
      toast({
        title: 'Falha ao salvar',
        description: error instanceof Error ? error.message : 'Não foi possível salvar as configurações.',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    if (!settings) return;
    await saveSettings(settings, 'As alterações foram aplicadas no servidor.');
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-6 py-3 border-b border-border shrink-0 flex items-center justify-end">
        <button
          onClick={() => void handleSave()}
          disabled={saving || loading || !settings}
          className={`btn btn-sm ${saved ? 'border-[hsl(var(--status-online))] text-[hsl(var(--status-online))] bg-[hsl(var(--status-online)_/_0.1)]' : 'btn-primary'}`}
          data-testid="button-save-settings"
        >
          {saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}
          {saved ? 'Salvo' : 'Salvar alterações'}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 p-4 md:p-6">

        <section className="grid gap-3 md:grid-cols-4">
          <MetricCard icon={Server} label="Câmeras online" value={metrics.online} detail="Dispositivos respondendo agora" />
          <MetricCard icon={Users} label="Usuários ativos" value={metrics.activeUsers} detail="Contas liberadas para acesso" />
          <MetricCard icon={HardDrive} label="Uso do disco" value={metrics.disk} detail={`${formatBytes(system?.disk.freeBytes)} livres`} />
          <MetricCard icon={Database} label="Gravações" value={metrics.recordings} detail={`${formatBytes(system?.recordings.totalBytes)} indexados`} />
        </section>

        <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
          <aside className="h-fit rounded-lg border border-border/70 bg-card/80 p-2 shadow-sm">
            {SECTIONS.map((section) => (
              <button
                key={section.id}
                onClick={() => setActiveSection(section.id)}
                className={`group flex w-full items-center gap-3 rounded-md px-3 py-3 text-left transition ${
                  activeSection === section.id ? 'bg-foreground text-background shadow-sm' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                }`}
              >
                <span className={`flex h-10 w-10 items-center justify-center rounded-xl border ${activeSection === section.id ? 'border-white/20 bg-white/10' : 'border-border bg-background/60 group-hover:bg-background'}`}>
                  <section.icon className="h-4 w-4" />
                </span>
                <span>
                  <span className="block text-sm font-semibold">{section.label}</span>
                  <span className={`block text-xs ${activeSection === section.id ? 'text-background/70' : 'text-muted-foreground'}`}>{section.description}</span>
                </span>
              </button>
            ))}
          </aside>

          <main className="space-y-6">
            {loading ? (
              <Card className="flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground">
                <LoaderCircle className="h-4 w-4 animate-spin" /> Carregando configurações...
              </Card>
            ) : !settings ? (
              <Card className="flex flex-col items-center justify-center gap-3 p-10 text-center text-sm text-muted-foreground">
                <p>Não foi possível carregar as configurações. Verifique sua conexão e permissões.</p>
                <button
                  onClick={() => void loadSettings()}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-border px-4 text-xs hover:bg-accent"
                >
                  <LoaderCircle className="h-3.5 w-3.5" /> Tentar novamente
                </button>
              </Card>
            ) : (
              <>
                {activeSection === 'general' && (
                  <>
                    <SectionTitle eyebrow="Geral" title="Identidade e experiência" description="Nome da instalação (persistido) e tema da interface (preferência local do navegador)." />
                    <Card className="overflow-hidden">
                      <SettingRow label="Nome da instalação" description="Identifica este servidor. Persistido no banco de dados.">
                        <TextInput value={settings.facilityName} onChange={(event) => update('facilityName', event.target.value)} />
                      </SettingRow>
                      <SettingRow label="Tema da interface" description="Preferência visual deste navegador.">
                        <div className="grid grid-cols-2 gap-2 rounded-xl border border-border bg-background/60 p-1">
                          {[
                            { id: 'dark', label: 'Escuro', icon: Moon },
                            { id: 'light', label: 'Claro', icon: Sun },
                          ].map((item) => (
                            <button
                              key={item.id}
                              onClick={() => setTheme(item.id as 'dark' | 'light')}
                              className={`flex h-9 items-center justify-center gap-2 rounded-lg text-xs font-semibold transition ${theme === item.id ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                            >
                              <item.icon className="h-3.5 w-3.5" />
                              {item.label}
                            </button>
                          ))}
                        </div>
                      </SettingRow>
                    </Card>
                  </>
                )}

                {activeSection === 'branding' && (
                  <>
                    <SectionTitle eyebrow="Aparência" title="Identidade visual do aplicativo" description="Configure aqui a marca exclusiva do aplicativo móvel. O painel web mantém a identidade visual do AjustCam." />
                    <Card className="overflow-hidden">
                      <SettingRow label="Logo do app" description="PNG, JPG ou SVG até 400 KB. Aparece no login e na identidade do aplicativo; não altera o painel web.">
                        <div className="flex items-center gap-3 md:justify-end">
                          <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-background/70">
                            {settings.brandLogoDataUrl ? (
                              <img src={settings.brandLogoDataUrl} alt="Logo" className="h-full w-full object-contain p-1" />
                            ) : (
                              <Shield className="h-5 w-5 text-muted-foreground" />
                            )}
                          </div>
                          <div className="flex flex-col gap-1.5">
                            <label className="btn btn-sm btn-primary cursor-pointer">
                              <Upload className="h-3.5 w-3.5" /> Enviar
                              <input
                                type="file"
                                accept="image/png,image/jpeg,image/svg+xml,image/webp"
                                className="hidden"
                                onChange={(e) => { handleLogoFile(e.target.files?.[0]); e.target.value = ''; }}
                              />
                            </label>
                            {settings.brandLogoDataUrl ? (
                              <button
                                type="button"
                                onClick={() => update('brandLogoDataUrl', '')}
                                className="btn btn-sm inline-flex items-center gap-1.5 text-[hsl(var(--destructive))]"
                              >
                                <Trash2 className="h-3.5 w-3.5" /> Remover
                              </button>
                            ) : null}
                          </div>
                        </div>
                      </SettingRow>
                    </Card>
                    <Card className="space-y-4 p-3">
                      <div className="flex flex-col gap-3 rounded-xl border border-border bg-background/50 p-4 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-semibold text-foreground">Cores padrão do app</p>
                            <Pill tone={settings.brandUseDefaultColors ? 'success' : 'neutral'}>
                              {settings.brandUseDefaultColors ? 'Padrão ativo' : 'Personalização ativa'}
                            </Pill>
                          </div>
                          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                            Ative para usar a paleta original do aplicativo. Desative para aplicar as cores personalizadas abaixo; elas permanecem salvas ao alternar.
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-3 self-end sm:self-auto">
                          <span className="text-xs font-medium text-muted-foreground">
                            {settings.brandUseDefaultColors ? 'Ativado' : 'Desativado'}
                          </span>
                          <Toggle
                            checked={settings.brandUseDefaultColors}
                            onChange={(value) => update('brandUseDefaultColors', value)}
                            label="Usar cores padrão do app"
                          />
                        </div>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">
                          Configure as duas aparências separadamente. Cada pessoa escolhe no aplicativo qual deseja usar.
                        </p>
                        <div className="mt-3 grid grid-cols-2 gap-2 rounded-xl border border-border bg-background/60 p-1">
                          {[
                            { id: 'dark' as const, label: 'Tema escuro', icon: Moon },
                            { id: 'light' as const, label: 'Tema claro', icon: Sun },
                          ].map((item) => (
                            <button
                              key={item.id}
                              type="button"
                              onClick={() => setBrandingEditorTheme(item.id)}
                              aria-pressed={brandingEditorTheme === item.id}
                              className={`flex h-10 items-center justify-center gap-2 rounded-lg text-xs font-semibold transition ${
                                brandingEditorTheme === item.id ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                              }`}
                            >
                              <item.icon className="h-3.5 w-3.5" />
                              {item.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className={settings.brandUseDefaultColors ? 'opacity-55' : ''}>
                        <BrandingPaletteEditor
                          mode={brandingEditorTheme}
                          settings={settings}
                          useDefaultColors={settings.brandUseDefaultColors}
                          onChange={(key, value) => update(key, value)}
                        />
                      </div>
                    </Card>
                    <p className="px-1 text-xs text-muted-foreground">
                      Estas configurações valem para o <strong>aplicativo móvel</strong>. A escolha Claro/Escuro é pessoal e fica salva no aparelho de cada usuário.
                    </p>
                  </>
                )}

                {activeSection === 'users' && (
                  <>
                    <SectionTitle eyebrow="Acesso" title="Usuários" description="Visão somente leitura. Gestão completa na página de Usuários; perfis em Perfis e Permissões." />
                    <Card className="overflow-hidden">
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[640px] text-sm">
                          <thead className="bg-muted/40 text-xs text-muted-foreground">
                            <tr>
                              {['Nome', 'Perfil', 'E-mail', 'Status'].map((header) => <th key={header} className="px-4 py-3 text-left font-semibold">{header}</th>)}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border/70">
                            {users.map((user) => (
                              <tr key={user.id} className="hover:bg-accent/50">
                                <td className="px-4 py-3 font-medium">{user.name}</td>
                                <td className="px-4 py-3"><Pill tone={user.role === 'admin' ? 'danger' : 'neutral'}>{user.role === 'admin' ? 'Administrador' : user.role === 'operator' ? 'Operador' : 'Visualizador'}</Pill></td>
                                <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{user.email}</td>
                                <td className="px-4 py-3"><Pill tone={user.active ? 'success' : 'neutral'}>{user.active ? 'Ativo' : 'Inativo'}</Pill></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </Card>
                  </>
                )}

                {activeSection === 'storage' && (
                  <>
                    <SectionTitle eyebrow="Retenção" title="Retenção e disco" description="A retenção padrão é aplicada pela rotina de limpeza; câmeras podem ter override individual." />
                    <Card className="overflow-hidden">
                      <SettingRow label="Retenção padrão" description="Dias para manter gravações sem override por câmera.">
                        <div className="flex items-center gap-3">
                          <Slider value={[settings.defaultRetentionDays]} onValueChange={(v) => update('defaultRetentionDays', v[0])} min={1} max={365} />
                          <span className="w-20 text-right font-mono text-xs">{settings.defaultRetentionDays} dias</span>
                        </div>
                      </SettingRow>
                      <SettingRow label="Limpeza automática" description="Quando o disco passa de 90%, remove as gravações mais antigas automaticamente.">
                        <Toggle checked={settings.autoCleanupEnabled} onChange={(v) => update('autoCleanupEnabled', v)} />
                      </SettingRow>
                      <SettingRow label="Volume de gravações" description={system?.recordingsRoot ?? 'Diretório ainda não informado.'}>
                        <div className="text-right text-xs text-muted-foreground">
                          <p>{formatBytes(system?.disk.usedBytes)} usados</p>
                          <p>{formatBytes(system?.disk.freeBytes)} livres</p>
                        </div>
                      </SettingRow>
                    </Card>
                  </>
                )}

                {activeSection === 'gpu' && (
                  <>
                    <SectionTitle eyebrow="Aceleração" title="GPU / Placa de vídeo" description="Detecta a GPU, ativa o transcode acelerado (NVENC), roda um auto-teste e mostra o uso ao vivo. O transcode em CPU continua sendo o padrão até você ativar." />
                    <GpuAccelerationPanel />
                  </>
                )}

                {activeSection === 'security' && (
                  <>
                    <SectionTitle eyebrow="Segurança" title="Sessão e senha" description="Regras aplicadas no login e na criação/edição de usuários." />
                    <Card className="overflow-hidden">
                      <SettingRow label="Tempo de sessão" description="Validade do token de acesso (aplicada no próximo login).">
                        <div className="flex items-center gap-3">
                          <Slider value={[settings.sessionTimeoutMinutes]} onValueChange={(v) => update('sessionTimeoutMinutes', v[0])} min={5} max={1440} />
                          <span className="w-16 text-right font-mono text-xs">{settings.sessionTimeoutMinutes} min</span>
                        </div>
                      </SettingRow>
                      <SettingRow label="Máx. tentativas de login" description="Bloqueia a conta por 15 min após este número de falhas consecutivas.">
                        <div className="flex items-center gap-3">
                          <Slider value={[settings.maxLoginAttempts]} onValueChange={(v) => update('maxLoginAttempts', v[0])} min={3} max={20} />
                          <span className="w-10 text-right font-mono text-xs">{settings.maxLoginAttempts}</span>
                        </div>
                      </SettingRow>
                      <SettingRow label="Exigir senha forte" description="Exige no mínimo 12 caracteres com maiúscula, minúscula e número ao criar/editar usuários.">
                        <Toggle checked={settings.requireStrongPassword} onChange={(v) => update('requireStrongPassword', v)} />
                      </SettingRow>
                    </Card>
                  </>
                )}
              </>
            )}
          </main>
        </div>
      </div>
      </div>
    </div>
  );
}
