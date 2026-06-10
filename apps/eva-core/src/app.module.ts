import { Module } from '@nestjs/common';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './database/database.module';
import { EventsModule } from './events/events.module';
import { TasksModule } from './tasks/tasks.module';
import { GatewayModule } from './gateway/gateway.module';
import { HealthModule } from './health/health.module';
import { MemoryModule } from './memory/memory.module';
import { ModelRouterModule } from './model-router/model-router.module';
import { IntentRouterModule } from './intent-router/intent-router.module';
import { PlannerModule } from './planner/planner.module';
import { ToolRouterModule } from './tool-router/tool-router.module';
import { DevControlModule } from './dev-control/dev-control.module';
import { BrowserModule } from './browser/browser.module';
import { ApprovalsModule } from './approvals/approvals.module';
import { WearFastPathModule } from './wear-fast-path/wear-fast-path.module';
import { CommunicationModule } from './communication/communication.module';
import { IntegrationsModule } from './integrations/integrations.module';

@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        ttl: parseInt(process.env.THROTTLE_TTL ?? '60') * 1000,
        limit: parseInt(process.env.THROTTLE_LIMIT ?? '100'),
      },
    ]),
    DatabaseModule,
    AuthModule,
    EventsModule,
    TasksModule,
    GatewayModule,
    HealthModule,
    MemoryModule,
    ModelRouterModule,
    IntentRouterModule,
    PlannerModule,
    ToolRouterModule,
    DevControlModule,
    BrowserModule,
    CommunicationModule,
    IntegrationsModule,
    ApprovalsModule,
    WearFastPathModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
