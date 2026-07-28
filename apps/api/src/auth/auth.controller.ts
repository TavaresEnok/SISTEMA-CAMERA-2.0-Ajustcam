import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import { type Request, type Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { AuditService } from '../audit/audit.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { RefreshSessionDto } from './dto/refresh-session.dto';
import { AuthService } from './auth.service';
import { type AuthUser } from '../common/types/auth-user.type';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly auditService: AuditService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      const cookieMode = this.isCookieMode(req);
      const result = await this.authService.login(
        dto.email,
        dto.password,
        cookieMode ? '15m' : undefined,
      );
      await this.auditService.log(result.user.id, 'auth.login.success', 'User', result.user.id, undefined, req);
      if (cookieMode) {
        this.setRefreshCookie(res, result.refreshToken, result.refreshExpiresAt);
        const { refreshToken: _secret, ...publicResult } = result;
        return publicResult;
      }
      return result;
    } catch (error) {
      await this.auditService.log(
        null,
        'auth.login.failed',
        'User',
        null,
        { email: dto.email.trim().toLowerCase() },
        req,
      );
      throw error;
    }
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Post('refresh')
  async refresh(
    @Body() dto: RefreshSessionDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const cookieToken = this.getCookie(req, 'vms_refresh_session');
    const cookieMode = this.isCookieMode(req) || Boolean(cookieToken);
    const refreshToken = cookieMode ? cookieToken : dto.refreshToken;
    if (!refreshToken) {
      // O service é a autoridade da mensagem/semântica de sessão inválida.
      return this.authService.refreshSession('', cookieMode ? '15m' : undefined);
    }
    const result = await this.authService.refreshSession(
      refreshToken,
      cookieMode ? '15m' : undefined,
    );
    if (cookieMode) {
      this.setRefreshCookie(res, result.refreshToken, result.refreshExpiresAt);
      const { refreshToken: _secret, ...publicResult } = result;
      return publicResult;
    }
    return result;
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('forgot-password')
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    await this.authService.forgotPassword(dto.email);
    await this.auditService.log(null, 'auth.password.forgot_requested', 'User', null, { email: dto.email.trim().toLowerCase() }, req);
    return { success: true };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('reset-password')
  async resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request) {
    await this.authService.resetPassword(dto.token, dto.newPassword);
    await this.auditService.log(null, 'auth.password.reset_completed', 'User', null, undefined, req);
    return { success: true };
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.authService.me(user.id);
  }

  @Post('logout')
  async logout(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.authService.logout(user.id);
    await this.auditService.log(user.id, 'auth.logout', 'User', user.id, undefined, req);
    res.clearCookie('vms_refresh_session', this.refreshCookieOptions());
    return { success: true };
  }

  private isCookieMode(req: Request) {
    return String(req.headers['x-drac-auth-mode'] ?? '').toLowerCase() === 'cookie';
  }

  private getCookie(req: Request, name: string) {
    const raw = String(req.headers.cookie ?? '');
    for (const part of raw.split(';')) {
      const separator = part.indexOf('=');
      if (separator === -1 || part.slice(0, separator).trim() !== name) continue;
      try {
        return decodeURIComponent(part.slice(separator + 1).trim());
      } catch {
        return '';
      }
    }
    return '';
  }

  private refreshCookieOptions() {
    const configured = process.env.COOKIE_SECURE;
    const secure = configured === undefined
      ? String(process.env.NODE_ENV ?? '').toLowerCase() === 'production'
      : configured.toLowerCase() === 'true';
    return {
      httpOnly: true,
      secure,
      sameSite: 'lax' as const,
      path: '/',
    };
  }

  private setRefreshCookie(res: Response, token: string, expiresAt: string) {
    const maxAge = Math.max(1, new Date(expiresAt).getTime() - Date.now());
    res.cookie('vms_refresh_session', token, {
      ...this.refreshCookieOptions(),
      maxAge,
    });
  }
}
