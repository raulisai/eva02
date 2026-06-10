import { Module } from '@nestjs/common';
import { AppGateway } from './app.gateway';
import { EventsModule } from '../events/events.module';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [EventsModule, DatabaseModule],
  providers: [AppGateway],
  exports: [AppGateway],
})
export class GatewayModule {}
