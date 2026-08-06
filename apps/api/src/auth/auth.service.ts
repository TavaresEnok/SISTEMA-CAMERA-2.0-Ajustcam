import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { User, UserRole } from '@prisma/client';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'node:crypto';
import nodemailer from 'nodemailer';
import { PrismaService } from '../common/prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { AuthUser, DownloadZipTokenPayload, JwtAuthPayload, PlayTokenPayload, StreamTokenPayload } from '../common/types/auth-user.type';

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
const DEFAULT_REFRESH_INACTIVITY_DAYS = 7;

type LoginAttempt = { count: number; lockedUntil: number };

@Injectable()
export class AuthService {
  private static readonly LOCKOUT_MS = 15 * 60 * 1000;
  private readonly loginAttempts = new Map<string, LoginAttempt>();
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly settingsService: SettingsService,
  ) {}

  private registerFailedAttempt(email: string, maxAttempts: number) {
    const current = this.loginAttempts.get(email) ?? { count: 0, lockedUntil: 0 };
    current.count += 1;
    if (current.count >= maxAttempts) {
      current.lockedUntil = Date.now() + AuthService.LOCKOUT_MS;
      current.count = 0;
    }
    this.loginAttempts.set(email, current);
  }

  private sanitizeUser(user: User): AuthUser {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    };
  }

  private refreshInactivityMs() {
    const configured = Number(process.env.AUTH_REFRESH_INACTIVITY_DAYS ?? DEFAULT_REFRESH_INACTIVITY_DAYS);
    const days = Number.isFinite(configured) ? Math.max(1, Math.min(30, configured)) : DEFAULT_REFRESH_INACTIVITY_DAYS;
    return days * 24 * 60 * 60 * 1000;
  }

  private refreshTokenHash(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private async signAccessToken(user: User, expiresInOverride?: string) {
    const payload: JwtAuthPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      ver: user.authVersion,
      type: 'access',
    };
    const sessionMinutes = await this.settingsService.getSessionTimeoutMinutes().catch(() => 0);
    const expiresIn = expiresInOverride
      ?? (sessionMinutes > 0 ? `${sessionMinutes}m` : (this.configService.get<string>('jwtExpiresIn') ?? '8h'));
    return this.jwtService.signAsync(payload, { expiresIn });
  }

  private async createRefreshSession(user: User) {
    const refreshToken = randomBytes(48).toString('base64url');
    const refreshExpiresAt = new Date(Date.now() + this.refreshInactivityMs());
    await this.prisma.authSession.create({
      data: {
        userId: user.id,
        tokenHash: this.refreshTokenHash(refreshToken),
        authVersion: user.authVersion,
        expiresAt: refreshExpiresAt,
      },
    });
    return { refreshToken, refreshExpiresAt: refreshExpiresAt.toISOString() };
  }

  private async assertPasswordStrength(password: string) {
    if (!(await this.settingsService.isStrongPasswordRequired().catch(() => false))) return;
    const strong = password.length >= 12 && /[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password);
    if (!strong) {
      throw new BadRequestException('Senha fraca: exige no mínimo 12 caracteres, com maiúscula, minúscula e número.');
    }
  }

  async login(email: string, password: string, accessExpiresIn?: string) {
    const normalizedEmail = email.trim().toLowerCase();

    const lock = this.loginAttempts.get(normalizedEmail);
    if (lock && lock.lockedUntil > Date.now()) {
      const remainingMin = Math.ceil((lock.lockedUntil - Date.now()) / 60000);
      throw new UnauthorizedException(`Conta temporariamente bloqueada por excesso de tentativas. Tente novamente em ${remainingMin} min.`);
    }

    const maxAttempts = await this.settingsService.getMaxLoginAttempts().catch(() => 5);
    const user = await this.prisma.user.findUnique({ where: { email: normalizedEmail } });

    if (!user || !user.isActive) {
      this.registerFailedAttempt(normalizedEmail, maxAttempts);
      throw new UnauthorizedException('Credenciais inválidas.');
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      this.registerFailedAttempt(normalizedEmail, maxAttempts);
      throw new UnauthorizedException('Credenciais inválidas.');
    }

    this.loginAttempts.delete(normalizedEmail);

    const accessToken = await this.signAccessToken(user, accessExpiresIn);
    const refresh = await this.createRefreshSession(user);

    // Limpa apenas sessões antigas deste usuário; dispositivos válidos seguem conectados.
    void this.prisma.authSession.deleteMany({
      where: {
        userId: user.id,
        OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { not: null } }],
      },
    }).catch(() => undefined);

    return {
      accessToken,
      ...refresh,
      user: this.sanitizeUser(user),
    };
  }

  async refreshSession(refreshToken: string, accessExpiresIn?: string) {
    const tokenHash = this.refreshTokenHash(refreshToken);
    const now = new Date();
    const session = await this.prisma.authSession.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (
      !session || session.revokedAt || session.expiresAt.getTime() <= now.getTime() ||
      !session.user.isActive || session.authVersion !== session.user.authVersion
    ) {
      throw new UnauthorizedException('Sessão expirada. Entre novamente.');
    }

    // A rotação atômica impede reutilização do token anterior.
    const nextRefreshToken = randomBytes(48).toString('base64url');
    const nextRefreshExpiresAt = new Date(now.getTime() + this.refreshInactivityMs());
    const rotated = await this.prisma.authSession.updateMany({
      where: {
        id: session.id,
        tokenHash,
        revokedAt: null,
        expiresAt: { gt: now },
        authVersion: session.user.authVersion,
      },
      data: {
        tokenHash: this.refreshTokenHash(nextRefreshToken),
        expiresAt: nextRefreshExpiresAt,
        lastUsedAt: now,
      },
    });
    if (rotated.count !== 1) {
      throw new UnauthorizedException('Sessão já renovada ou expirada.');
    }

    return {
      accessToken: await this.signAccessToken(session.user, accessExpiresIn),
      refreshToken: nextRefreshToken,
      refreshExpiresAt: nextRefreshExpiresAt.toISOString(),
      user: this.sanitizeUser(session.user),
    };
  }

  async validateAccessPayload(payload: JwtAuthPayload): Promise<AuthUser> {
    if (payload.type !== 'access') {
      throw new UnauthorizedException('Token inválido.');
    }

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.isActive || payload.ver !== user.authVersion) {
      throw new UnauthorizedException('Usuário inativo ou inexistente.');
    }

    return this.sanitizeUser(user);
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Usuário inativo ou inexistente.');
    }
    return this.sanitizeUser(user);
  }

  async createStreamToken(userId: string, cameraId: string) {
    const expiresIn = this.configService.get<string>('streamTokenExpiresIn') ?? '5m';
    const payload: StreamTokenPayload = {
      sub: userId,
      cameraId,
      type: 'stream',
    };
    const streamToken = await this.jwtService.signAsync(payload, { expiresIn });
    const decoded = this.jwtService.decode(streamToken) as { exp?: number } | null;
    return {
      streamToken,
      expiresAt: decoded?.exp ? new Date(decoded.exp * 1000).toISOString() : null,
    };
  }

  async createPlaybackToken(userId: string, recordingId: string) {
    const expiresIn = this.configService.get<string>('streamTokenExpiresIn') ?? '5m';
    const payload: PlayTokenPayload = {
      sub: userId,
      recordingId,
      type: 'play',
    };
    const playToken = await this.jwtService.signAsync(payload, { expiresIn });
    const decoded = this.jwtService.decode(playToken) as { exp?: number } | null;
    return {
      playToken,
      expiresAt: decoded?.exp ? new Date(decoded.exp * 1000).toISOString() : null,
    };
  }

  async verifyStreamToken(token: string): Promise<StreamTokenPayload> {
    // Token expirado/adulterado lança TokenExpiredError/JsonWebTokenError — que
    // NÃO é HttpException, então o filtro global o transformava em 500
    // "Internal server error". Para o player, 401 é "renove o token e siga";
    // 500 é "a API quebrou". Um token de 5 min expira em QUALQUER pausa mais
    // longa — cada retomada de vídeo virava um falso alarme de servidor.
    let payload: StreamTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<StreamTokenPayload>(token);
    } catch {
      throw new UnauthorizedException('Token de stream expirado ou inválido.');
    }
    if (payload.type !== 'stream') {
      throw new UnauthorizedException('Token de stream inválido.');
    }
    return payload;
  }

  async verifyPlaybackToken(token: string): Promise<PlayTokenPayload> {
    // Token expirado/adulterado lança TokenExpiredError/JsonWebTokenError — que
    // NÃO é HttpException, então o filtro global o transformava em 500
    // "Internal server error". Para o player, 401 é "renove o token e siga";
    // 500 é "a API quebrou". Um token de 5 min expira em QUALQUER pausa mais
    // longa — cada retomada de vídeo virava um falso alarme de servidor.
    let payload: PlayTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<PlayTokenPayload>(token);
    } catch {
      throw new UnauthorizedException('Token de playback expirado ou inválido.');
    }
    if (payload.type !== 'play') {
      throw new UnauthorizedException('Token de playback inválido.');
    }
    return payload;
  }

  // Token de curta duração que autoriza o download em lote (ZIP) das gravações
  // listadas. Emitido apenas para quem passou pelo gate OPERATOR+exportEvidence;
  // permite ao navegador baixar via link direto (streaming nativo, com progresso)
  // sem carregar o arquivo inteiro em memória via XHR.
  async createDownloadZipToken(userId: string, recordingIds: string[]) {
    const payload: DownloadZipTokenPayload = {
      sub: userId,
      recordingIds,
      type: 'download-zip',
    };
    const downloadToken = await this.jwtService.signAsync(payload, { expiresIn: '15m' });
    const decoded = this.jwtService.decode(downloadToken) as { exp?: number } | null;
    return {
      downloadToken,
      expiresAt: decoded?.exp ? new Date(decoded.exp * 1000).toISOString() : null,
    };
  }

  async verifyDownloadZipToken(token: string): Promise<DownloadZipTokenPayload> {
    // Token expirado/adulterado lança TokenExpiredError/JsonWebTokenError — que
    // NÃO é HttpException, então o filtro global o transformava em 500
    // "Internal server error". Para o player, 401 é "renove o token e siga";
    // 500 é "a API quebrou". Um token de 5 min expira em QUALQUER pausa mais
    // longa — cada retomada de vídeo virava um falso alarme de servidor.
    let payload: DownloadZipTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<DownloadZipTokenPayload>(token);
    } catch {
      throw new UnauthorizedException('Token de download expirado ou inválido.');
    }
    if (payload.type !== 'download-zip' || !Array.isArray(payload.recordingIds)) {
      throw new UnauthorizedException('Token de download inválido.');
    }
    return payload;
  }

  async forgotPassword(email: string): Promise<void> {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email: normalizedEmail } });
    // Resposta idêntica para e-mail inexistente/inativo evita enumeração de contas.
    if (!user || !user.isActive) return;

    const rawToken = randomBytes(32).toString('hex');
    const resetTokenHash = createHash('sha256').update(rawToken).digest('hex');
    const resetTokenExpiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { resetTokenHash, resetTokenExpiresAt },
    });

    await this.sendResetPasswordEmail(user.email, rawToken);
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const resetTokenHash = createHash('sha256').update(token).digest('hex');
    const user = await this.prisma.user.findFirst({ where: { resetTokenHash } });

    if (!user || !user.resetTokenExpiresAt || user.resetTokenExpiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Token de redefinição inválido ou expirado.');
    }

    await this.assertPasswordStrength(newPassword);
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        resetTokenHash: null,
        resetTokenExpiresAt: null,
        authVersion: { increment: 1 },
      },
    });
  }

  async logout(userId: string): Promise<void> {
    const now = new Date();
    await this.prisma.user.update({
      where: { id: userId },
      data: { authVersion: { increment: 1 } },
    });
    await this.prisma.authSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  private async sendResetPasswordEmail(email: string, rawToken: string): Promise<void> {
    const host = this.configService.get<string>('smtpHost') ?? '';
    const port = Number(this.configService.get<number>('smtpPort') ?? 587);
    const secure = Boolean(this.configService.get<boolean>('smtpSecure') ?? false);
    const user = this.configService.get<string>('smtpUser') ?? '';
    const pass = this.configService.get<string>('smtpPass') ?? '';
    const from = this.configService.get<string>('alarmEmailFrom') ?? user;

    if (!host || !from || !user || !pass) {
      this.logger.warn(`SMTP não configurado: não foi possível enviar e-mail de redefinição de senha para ${email}.`);
      return;
    }

    const publicAppUrl = (this.configService.get<string>('publicAppUrl') ?? '').replace(/\/$/, '');
    const resetLink = publicAppUrl
      ? `${publicAppUrl}/reset-password?token=${rawToken}`
      : null;

    const transporter = nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
    await transporter.sendMail({
      from,
      to: email,
      subject: 'DRAC VMS - Redefinição de senha',
      text: [
        'Foi solicitada a redefinição de senha da sua conta no DRAC VMS.',
        '',
        resetLink ? `Acesse o link para definir uma nova senha: ${resetLink}` : `Use o código a seguir na tela de redefinição de senha: ${rawToken}`,
        '',
        'Este link/código expira em 30 minutos.',
        'Se você não solicitou esta ação, ignore este e-mail.',
      ].join('\n'),
    });
  }

  canAssignRole(actorRole: UserRole, targetRole: UserRole): boolean {
    if (actorRole === UserRole.SUPER_ADMIN) return true;
    if (actorRole === UserRole.ADMIN) return targetRole !== UserRole.SUPER_ADMIN;
    return false;
  }
}
