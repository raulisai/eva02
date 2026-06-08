import { Module } from '@nestjs/common';
import { ToolRouterController } from './tool-router.controller';
import { ToolRouterService } from './tool-router.service';

@Module({
  controllers: [ToolRouterController],
  providers:   [ToolRouterService],
  exports:     [ToolRouterService],
})
export class ToolRouterModule {}
