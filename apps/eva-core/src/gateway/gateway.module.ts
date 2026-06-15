import { Module } from '@nestjs/common';
import { AppGateway } from './app.gateway';
import { EventsBridgeService } from './events-bridge.service';
import { EventsModule } from '../events/events.module';
import { DatabaseModule } from '../database/database.module';
import { AgentModule } from '../agent/agent.module';

@Module({
  imports: [EventsModule, DatabaseModule, AgentModule],
  providers: [AppGateway, EventsBridgeService],
  exports: [AppGateway],
})
export class GatewayModule {}
