import { Controller, Post, Get, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ToolRouterService } from './tool-router.service';
import { RouteToolDto } from './dto/route-tool.dto';

@Controller('tool-router')
export class ToolRouterController {
  constructor(private readonly toolRouter: ToolRouterService) {}

  @Post('route')
  @HttpCode(HttpStatus.OK)
  route(@Body() dto: RouteToolDto) {
    return this.toolRouter.route(dto.capability, {
      budget:       dto.budget,
      maxLatencyMs: dto.maxLatencyMs,
      excludeTools: dto.excludeTools,
    });
  }

  @Get('tools')
  listAll() {
    return this.toolRouter.listAll();
  }
}
