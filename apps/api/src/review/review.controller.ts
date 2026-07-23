import { Body, Controller, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { type Request, type Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../role-permissions/require-permission.decorator';
import { type AuthUser } from '../common/types/auth-user.type';
import { ReviewService } from './review.service';

@Controller('review')
export class ReviewController {
  constructor(private readonly reviewService: ReviewService) {}

  @Roles(UserRole.VIEWER)
  @RequirePermission('playback')
  @Get('feed')
  async feed(
    @CurrentUser() user: AuthUser,
    @Query('cameraId') cameraId?: string,
    @Query('label') label?: string,
    @Query('onlyConfirmed') onlyConfirmed?: string,
    @Query('unseenOnly') unseenOnly?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.reviewService.feed(user, {
      cameraId,
      label,
      onlyConfirmed: onlyConfirmed === 'true' || onlyConfirmed === '1',
      unseenOnly: unseenOnly === 'true' || unseenOnly === '1',
      from,
      to,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  @Roles(UserRole.VIEWER)
  @RequirePermission('playback')
  @Get('unseen-count')
  async unseenCount(@CurrentUser() user: AuthUser) {
    return this.reviewService.unseenCount(user);
  }

  @Roles(UserRole.VIEWER)
  @RequirePermission('playback')
  @Post(':eventId/seen')
  async markSeen(
    @CurrentUser() user: AuthUser,
    @Param('eventId') eventId: string,
    @Body() body: { seen?: boolean },
  ) {
    return this.reviewService.markSeen(user, eventId, body?.seen !== false);
  }

  @Roles(UserRole.VIEWER)
  @RequirePermission('playback')
  @Get(':eventId/thumbnail')
  async thumbnail(
    @CurrentUser() user: AuthUser,
    @Param('eventId') eventId: string,
    @Req() _req: Request,
    @Res() res: Response,
  ) {
    return this.reviewService.streamThumbnail(user, eventId, res);
  }
}
