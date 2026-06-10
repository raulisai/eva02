import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { ModelRouterService } from './model-router.service';

@Module({
  imports:   [IntegrationsModule],
  providers: [ModelRouterService],
  exports:   [ModelRouterService],
})
export class ModelRouterModule {}
