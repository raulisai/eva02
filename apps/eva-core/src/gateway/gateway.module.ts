import { Module } from '@nestjs/common';
import { AppGateway } from './app.gateway';
import { EventsBridgeService } from './events-bridge.service';
import { EventsModule } from '../events/events.module';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [EventsModule, DatabaseModule],
  providers: [AppGateway, EventsBridgeService],
  exports: [AppGateway],
})
export class GatewayModule {}
