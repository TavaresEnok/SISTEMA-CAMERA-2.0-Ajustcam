import { Module } from '@nestjs/common';
import { RecordingsModule } from '../recordings/recordings.module';
import { MetricsController } from './metrics.controller';

@Module({
  imports: [RecordingsModule],
  controllers: [MetricsController],
})
export class MetricsModule {}
