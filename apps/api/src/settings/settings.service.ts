import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';

type SettingType = 'string' | 'number' | 'boolean' | 'color' | 'image';

type SettingSpec = {
  type: SettingType;
  default: string | number | boolean;
  min?: number;
  max?: number;
};

// Tamanho máximo do logo em base64 (~400 KB de imagem). Logos de login/topo são
// pequenos; este teto evita estourar o payload e o banco.
const MAX_IMAGE_CHARS = 550_000;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

// Chaves de marca (branding) expostas publicamente — a tela de login precisa
// lê-las antes de autenticar.
const BRANDING_KEYS = [
  'facilityName',
  'brandLogoDataUrl',
  'brandUseDefaultColors',
  'brandPrimaryColor',
  'brandBackgroundColor',
  'brandSecondaryColor',
  'brandPrimaryTextColor',
  'brandSecondaryTextColor',
  // Pacote completo por superfície + bordas/status (app móvel).
  'brandBackgroundColor2',
  'brandBackgroundTextColor',
  'brandMenuColor',
  'brandMenuTextColor',
  'brandButtonTextColor',
  'brandBorderColor',
  'brandSuccessColor',
  'brandWarningColor',
  'brandDangerColor',
  // Paleta clara. As chaves sem prefixo continuam sendo a paleta escura para
  // manter compatibilidade com instalações e versões antigas do aplicativo.
  'brandLightPrimaryColor',
  'brandLightBackgroundColor',
  'brandLightSecondaryColor',
  'brandLightPrimaryTextColor',
  'brandLightSecondaryTextColor',
  'brandLightBackgroundColor2',
  'brandLightBackgroundTextColor',
  'brandLightMenuColor',
  'brandLightMenuTextColor',
  'brandLightButtonTextColor',
  'brandLightBorderColor',
  'brandLightSuccessColor',
  'brandLightWarningColor',
  'brandLightDangerColor',
] as const;

// Apenas configurações que produzem efeito real no sistema são expostas aqui.
// Cada chave abaixo é lida por algum subsistema (ver SettingsService.* getters).
const SETTING_SPECS: Record<string, SettingSpec> = {
  facilityName: { type: 'string', default: 'AjustCam' },
  defaultRetentionDays: { type: 'number', default: 7, min: 1, max: 365 },
  autoCleanupEnabled: { type: 'boolean', default: true },
  sessionTimeoutMinutes: { type: 'number', default: 480, min: 5, max: 1440 },
  maxLoginAttempts: { type: 'number', default: 5, min: 3, max: 20 },
  requireStrongPassword: { type: 'boolean', default: true },
  alarmAudioEnabled: { type: 'boolean', default: true },
  // Aceleração por GPU do transcode de vídeo (ffmpeg NVENC). Default OFF: só é
  // ligado pelo módulo de GPU em Configurações depois que o auto-teste passa.
  gpuAccelerationEnabled: { type: 'boolean', default: false },
  // Liga a feature de IA no sistema (página + módulo de IA). Default OFF: enquanto
  // false, a IA e os controles de aceleração de IA ficam dormentes na interface.
  aiFeatureEnabled: { type: 'boolean', default: false },
  // Aceleração por GPU da IA (onnxruntime CUDA). Só tem efeito quando aiFeatureEnabled
  // estiver true E a infraestrutura de GPU para IA estiver provisionada. Default OFF.
  gpuAiAccelerationEnabled: { type: 'boolean', default: false },
  // ── Marca (branding) do app web — aplicado em runtime na interface ──────────
  // Logo em data URL (base64). Vazio = usa o logo padrão DRAC.
  brandLogoDataUrl: { type: 'image', default: '' },
  // true = o app usa sua paleta original. As cores personalizadas continuam
  // armazenadas para voltarem imediatamente quando o administrador desativar.
  brandUseDefaultColors: { type: 'boolean', default: true },
  // Cor principal (#RRGGBB). Vazio = usa a cor do tema.
  brandPrimaryColor: { type: 'color', default: '' },
  // Cor de fundo (#RRGGBB). Vazio = usa a cor do tema.
  brandBackgroundColor: { type: 'color', default: '' },
  // 2ª cor de fundo (#RRGGBB) — se definida, o fundo vira GRADIENTE (cor1→cor2);
  // vazio = fundo sólido (brandBackgroundColor).
  brandBackgroundColor2: { type: 'color', default: '' },
  // Cor do card/bloco (#RRGGBB) — superfície de cards, campos e painéis. Vazio = tema.
  brandSecondaryColor: { type: 'color', default: '' },
  // Cor do texto do card (#RRGGBB) — títulos/labels SOBRE cards. Vazio = tema.
  brandPrimaryTextColor: { type: 'color', default: '' },
  // Cor do subtexto do card (#RRGGBB) — descrições SOBRE cards. Vazio = tema.
  brandSecondaryTextColor: { type: 'color', default: '' },
  // Cor do texto sobre o FUNDO da tela (#RRGGBB) — cabeçalhos fora de cards. Vazio = tema.
  brandBackgroundTextColor: { type: 'color', default: '' },
  // Cor do menu inferior (#RRGGBB). Vazio = usa a cor do card.
  brandMenuColor: { type: 'color', default: '' },
  // Cor do texto/ícones do menu inferior (itens inativos) (#RRGGBB). Vazio = tema.
  brandMenuTextColor: { type: 'color', default: '' },
  // Cor do texto SOBRE botões de destaque (#RRGGBB). Vazio = branco/tema.
  brandButtonTextColor: { type: 'color', default: '' },
  // Cor das bordas (#RRGGBB). Vazio = tema.
  brandBorderColor: { type: 'color', default: '' },
  // Cores de status (#RRGGBB). Vazio = tema.
  brandSuccessColor: { type: 'color', default: '' },
  brandWarningColor: { type: 'color', default: '' },
  brandDangerColor: { type: 'color', default: '' },
  // Tema claro: possui defaults próprios para que uma instalação antiga passe
  // a oferecer a opção imediatamente, mesmo antes de o administrador editar.
  brandLightPrimaryColor: { type: 'color', default: '#2563eb' },
  brandLightBackgroundColor: { type: 'color', default: '#f5f7fb' },
  brandLightBackgroundColor2: { type: 'color', default: '#ffffff' },
  brandLightSecondaryColor: { type: 'color', default: '#ffffff' },
  brandLightPrimaryTextColor: { type: 'color', default: '#111827' },
  brandLightSecondaryTextColor: { type: 'color', default: '#4b5563' },
  brandLightBackgroundTextColor: { type: 'color', default: '#111827' },
  brandLightMenuColor: { type: 'color', default: '#ffffff' },
  brandLightMenuTextColor: { type: 'color', default: '#64748b' },
  brandLightButtonTextColor: { type: 'color', default: '#ffffff' },
  brandLightBorderColor: { type: 'color', default: '#94a3b8' },
  brandLightSuccessColor: { type: 'color', default: '#15803d' },
  brandLightWarningColor: { type: 'color', default: '#b45309' },
  brandLightDangerColor: { type: 'color', default: '#dc2626' },
};

export type SettingsMap = Record<string, string | number | boolean>;

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private cache: SettingsMap | null = null;
  private cacheAt = 0;
  private static readonly CACHE_TTL_MS = 15_000;

  constructor(private readonly prisma: PrismaService) {}

  private coerce(spec: SettingSpec, raw: string): string | number | boolean {
    if (spec.type === 'number') {
      const n = Number(raw);
      return Number.isFinite(n) ? n : Number(spec.default);
    }
    if (spec.type === 'boolean') return raw === 'true' || raw === '1';
    // 'color' e 'image' são armazenados/lidos como string crua.
    return raw;
  }

  private async loadAll(): Promise<SettingsMap> {
    if (this.cache && Date.now() - this.cacheAt < SettingsService.CACHE_TTL_MS) {
      return this.cache;
    }
    const rows = await this.prisma.systemSetting.findMany();
    const byKey = new Map(rows.map((r) => [r.key, r.value] as const));
    const merged: SettingsMap = {};
    for (const [key, spec] of Object.entries(SETTING_SPECS)) {
      const stored = byKey.get(key);
      merged[key] = stored != null ? this.coerce(spec, stored) : spec.default;
    }
    this.cache = merged;
    this.cacheAt = Date.now();
    return merged;
  }

  async getAll(): Promise<SettingsMap> {
    return { ...(await this.loadAll()) };
  }

  // Subconjunto público de marca, lido pela tela de login antes da autenticação.
  async getBranding(): Promise<SettingsMap> {
    const all = await this.loadAll();
    const branding: SettingsMap = {};
    for (const key of BRANDING_KEYS) branding[key] = all[key];
    return branding;
  }

  async patch(values: Record<string, unknown>, userId?: string): Promise<SettingsMap> {
    const entries = Object.entries(values).filter(([key]) => key in SETTING_SPECS);
    if (entries.length === 0) {
      throw new BadRequestException('Nenhuma configuração válida informada.');
    }

    for (const [key, value] of entries) {
      const spec = SETTING_SPECS[key];
      let serialized: string;
      if (spec.type === 'number') {
        const n = Number(value);
        if (!Number.isFinite(n)) throw new BadRequestException(`Valor inválido para ${key}.`);
        const clamped = Math.min(spec.max ?? n, Math.max(spec.min ?? n, Math.round(n)));
        serialized = String(clamped);
      } else if (spec.type === 'boolean') {
        serialized = value === true || value === 'true' || value === 1 || value === '1' ? 'true' : 'false';
      } else if (spec.type === 'color') {
        const s = String(value ?? '').trim();
        // Vazio é válido: significa "voltar ao padrão do tema".
        if (s && !HEX_COLOR.test(s)) throw new BadRequestException(`Cor inválida para ${key} (use #RRGGBB).`);
        serialized = s.toLowerCase();
      } else if (spec.type === 'image') {
        const s = String(value ?? '').trim();
        // Vazio é válido: remove o logo personalizado.
        if (s) {
          if (!s.startsWith('data:image/')) throw new BadRequestException(`Imagem inválida para ${key}.`);
          if (s.length > MAX_IMAGE_CHARS) throw new BadRequestException(`Imagem muito grande para ${key} (máx. ~400 KB).`);
        }
        serialized = s;
      } else {
        const s = String(value ?? '').trim().slice(0, 200);
        if (!s) throw new BadRequestException(`Valor inválido para ${key}.`);
        serialized = s;
      }
      await this.prisma.systemSetting.upsert({
        where: { key },
        create: { key, value: serialized, updatedByUserId: userId ?? null },
        update: { value: serialized, updatedByUserId: userId ?? null },
      });
    }

    this.cache = null;
    this.logger.log(`Configurações atualizadas (${entries.map(([k]) => k).join(', ')}).`);
    return this.getAll();
  }

  // ── Acessores tipados usados pelos subsistemas ────────────────────────────
  async getSessionTimeoutMinutes(): Promise<number> {
    return Number((await this.loadAll()).sessionTimeoutMinutes);
  }

  async getDefaultRetentionDays(): Promise<number> {
    return Number((await this.loadAll()).defaultRetentionDays);
  }

  async isAutoCleanupEnabled(): Promise<boolean> {
    return Boolean((await this.loadAll()).autoCleanupEnabled);
  }

  async getMaxLoginAttempts(): Promise<number> {
    return Number((await this.loadAll()).maxLoginAttempts);
  }

  async isStrongPasswordRequired(): Promise<boolean> {
    return Boolean((await this.loadAll()).requireStrongPassword);
  }

  async isGpuAccelerationEnabled(): Promise<boolean> {
    return Boolean((await this.loadAll()).gpuAccelerationEnabled);
  }

  async isAiFeatureEnabled(): Promise<boolean> {
    return Boolean((await this.loadAll()).aiFeatureEnabled);
  }

  async isGpuAiAccelerationEnabled(): Promise<boolean> {
    return Boolean((await this.loadAll()).gpuAiAccelerationEnabled);
  }
}
