import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { AccessControlModule } from '../access-control/access-control.module';
import { RecordingsModule } from '../recordings/recordings.module';
import { ReviewController } from './review.controller';
import { ReviewService } from './review.service';

@Module({
  imports: [PrismaModule, AccessControlModule, RecordingsModule],
  controllers: [ReviewController],
  providers: [ReviewService],
})
export class ReviewModule {}
