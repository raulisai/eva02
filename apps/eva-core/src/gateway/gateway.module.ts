import { Module } from '@nestjs/common';
import { AppGateway } from './app.gateway';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [EventsModule],
  providers: [AppGateway],
  exports: [AppGateway],
})
export class GatewayModule {}
