import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { ModelRouterService } from './model-router.service';
import { ModelRouterController } from './model-router.controller';

@Module({
  imports:   [IntegrationsModule],
  controllers: [ModelRouterController],
  providers: [ModelRouterService],
  exports:   [ModelRouterService],
})
export class ModelRouterModule {}
