import { HttpException, Injectable } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { type AuthUser } from '../common/types/auth-user.type';

// `aiAdvanced` = OBJETO/FACE (pesadas). `aiMotion` = detecção de MOVIMENTO
// (MOG2), que arma a gravação por movimento e é tratada à parte de propósito:
// confundir as duas derrubava o MOG2 sempre que objeto/face estavam desligados,
// que é o estado normal e desejado.
// `aiObject` e `aiFace` são o desdobramento GRANULAR do antigo `aiAdvanced`.
// A Central já os enviava desde sempre; a instalação os DESCARTAVA em
// `parseRestrictions` (a lista de chaves conhecidas não os continha), então
// ligar "objeto" no painel mestre não tinha efeito nenhum aqui — só o
// legado `aiAdvanced`, que acende objeto e face juntos. `aiAdvanced` continua
// existindo como TETO dos dois, para não quebrar instalação antiga.
export type CommercialFeature = 'localLive' | 'localRecording' | 'localPlayback' | 'addCameras' | 'aiAdvanced' | 'aiMotion' | 'aiObject' | 'aiFace' | 'exports';
export type CommercialLicenseStatus = 'UNKNOWN' | 'ACTIVE' | 'GRACE' | 'RESTRICTED' | 'SUSPENDED';

type RestrictionMap = Record<CommercialFeature | 'adminAccess' | 'cloudSupport' | 'updates', boolean>;

const DEFAULT_RESTRICTIONS: RestrictionMap = {
  localLive: true,
  localRecording: true,
  localPlayback: true,
  addCameras: true,
  aiAdvanced: true,
  aiMotion: true,
  aiObject: true,
  aiFace: true,
  exports: true,
  adminAccess: true,
  cloudSupport: true,
  updates: true,
};

const STATUS_DEFAULTS: Record<CommercialLicenseStatus, RestrictionMap> = {
  UNKNOWN: DEFAULT_RESTRICTIONS,
  ACTIVE: DEFAULT_RESTRICTIONS,
  GRACE: DEFAULT_RESTRICTIONS,
  RESTRICTED: {
    ...DEFAULT_RESTRICTIONS,
    addCameras: false,
    aiAdvanced: false,
    updates: false,
  },
  SUSPENDED: {
    ...DEFAULT_RESTRICTIONS,
    localLive: false,
    localRecording: false,
    addCameras: false,
    aiAdvanced: false,
    cloudSupport: false,
    updates: false,
  },
};

const GENERIC_FEATURE_MESSAGES: Record<CommercialFeature, string> = {
  localLive: 'Transmissão temporariamente indisponível. Entre em contato com o administrador do sistema.',
  localRecording: 'Gravação temporariamente indisponível. Entre em contato com o administrador do sistema.',
  localPlayback: 'Playback temporariamente indisponível. Entre em contato com o administrador do sistema.',
  addCameras: 'Cadastro de novas câmeras temporariamente indisponível. Entre em contato com o administrador do sistema.',
  aiAdvanced: 'Análise inteligente temporariamente indisponível. Entre em contato com o administrador do sistema.',
  aiMotion: 'Detecção de movimento temporariamente indisponível. Entre em contato com o administrador do sistema.',
  aiObject: 'Detecção de objetos temporariamente indisponível. Entre em contato com o administrador do sistema.',
  aiFace: 'Reconhecimento facial temporariamente indisponível. Entre em contato com o administrador do sistema.',
  exports: 'Exportação temporariamente indisponível. Entre em contato com o administrador do sistema.',
};

@Injectable()
export class CommercialPolicyService {
  constructor(private readonly prisma: PrismaService) {}

  async getPolicy() {
    const rows = await this.prisma.systemSetting.findMany({
      where: {
        key: {
          in: ['cloud.licenseStatus', 'cloud.licenseMessage', 'cloud.restrictions', 'cloud.lastSyncAt', 'cloud.lastError'],
        },
      },
    });
    const settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    const licenseStatus = this.normalizeStatus(settings['cloud.licenseStatus']);
    const centralRestrictions = this.parseRestrictions(settings['cloud.restrictions']);

    const mergedRestrictions = {
      ...DEFAULT_RESTRICTIONS,
      ...centralRestrictions,
      ...this.statusCaps(licenseStatus),
    };

    return {
      licenseStatus,
      licenseMessage: settings['cloud.licenseMessage'] || null,
      lastSyncAt: settings['cloud.lastSyncAt'] || null,
      lastError: settings['cloud.lastError'] || null,
      restrictions: mergedRestrictions,
      // Fora de `restrictions` de propósito: aquele mapa é de BOOLEANOS, e o
      // filtro que o protege (`parseRestrictions`) descartaria uma lista.
      // Estas são as classes de objeto que a Central liberou — o "o quê" da
      // detecção, complementando o "se" que vive em `aiObject`.
      aiObjectClasses: mergedRestrictions.aiObject === false
        ? []
        : this.parseObjectClasses(settings['cloud.restrictions']),
    };
  }

  /**
   * Classes de objeto liberadas pela Central.
   *
   * Lista ausente/ilegível devolve VAZIO, nunca um catálogo padrão: passar a
   * detectar tudo justamente quando a permissão não chegou seria o pior erro
   * possível aqui — ampliaria sozinho o escopo do que foi vendido.
   */
  private parseObjectClasses(value: string | undefined): string[] {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      const bruto = parsed?.aiObjectClasses;
      if (!Array.isArray(bruto)) return [];
      return [...new Set(bruto.map((c: unknown) => String(c ?? '').trim().toLowerCase()).filter(Boolean))];
    } catch {
      return [];
    }
  }

  async isAllowed(feature: CommercialFeature) {
    const policy = await this.getPolicy();
    return policy.restrictions[feature] !== false;
  }

  async assertFeature(feature: CommercialFeature, user?: AuthUser) {
    const policy = await this.getPolicy();
    if (policy.restrictions[feature] !== false) return policy;

    const adminMessage = this.buildAdminMessage(feature, policy.licenseStatus, policy.licenseMessage);
    const userMessage =
      user?.role === UserRole.ADMIN || user?.role === UserRole.SUPER_ADMIN ? adminMessage : GENERIC_FEATURE_MESSAGES[feature];

    throw new HttpException(
      {
        error: 'commercial_restriction',
        code: `commercial_${feature}_restricted`,
        feature,
        licenseStatus: policy.licenseStatus,
        userMessage,
        adminMessage,
      },
      423,
    );
  }

  private normalizeStatus(value: string | undefined): CommercialLicenseStatus {
    if (value === 'ACTIVE' || value === 'GRACE' || value === 'RESTRICTED' || value === 'SUSPENDED') return value;
    return 'UNKNOWN';
  }

  private parseRestrictions(value: string | undefined): Partial<RestrictionMap> {
    if (!value) return {};
    try {
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== 'object') return {};
      const allowedKeys = new Set(Object.keys(DEFAULT_RESTRICTIONS));
      return Object.fromEntries(
        Object.entries(parsed).filter(([key, restriction]) => allowedKeys.has(key) && typeof restriction === 'boolean'),
      ) as Partial<RestrictionMap>;
    } catch {
      return {};
    }
  }

  private statusCaps(status: CommercialLicenseStatus): Partial<RestrictionMap> {
    if (status === 'SUSPENDED') return STATUS_DEFAULTS.SUSPENDED;
    if (status === 'RESTRICTED') return STATUS_DEFAULTS.RESTRICTED;
    return {};
  }

  private buildAdminMessage(feature: CommercialFeature, status: CommercialLicenseStatus, licenseMessage: string | null) {
    if (status === 'SUSPENDED') {
      return licenseMessage || `Instalação suspensa. O recurso ${feature} está temporariamente bloqueado pela política comercial.`;
    }
    if (status === 'RESTRICTED') {
      return licenseMessage || `Instalação em modo restrito. O recurso ${feature} está temporariamente bloqueado.`;
    }
    return licenseMessage || GENERIC_FEATURE_MESSAGES[feature];
  }
}
