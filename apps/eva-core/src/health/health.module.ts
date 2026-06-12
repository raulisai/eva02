import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { HealthController } from './health.controller';

@Module({
  imports: [AgentModule],
  controllers: [HealthController],
})
export class HealthModule {}
