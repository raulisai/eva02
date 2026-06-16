import { Module } from '@nestjs/common';
import { AppGateway } from './app.gateway';
import { EventsBridgeService } from './events-bridge.service';
import { EventsModule } from '../events/events.module';
import { DatabaseModule } from '../database/database.module';
import { AgentModule } from '../agent/agent.module';
import { DevStudioModule } from '../dev-studio/dev-studio.module';

@Module({
  imports: [EventsModule, DatabaseModule, AgentModule, DevStudioModule],
  providers: [AppGateway, EventsBridgeService],
  exports: [AppGateway],
})
export class GatewayModule {}
