import { Controller, Get, Optional } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { SandboxService } from '../agent/sandbox.service';

@Controller('health')
export class HealthController {
  constructor(@Optional() private readonly sandbox?: SandboxService) {}

  @Public()
  @Get()
  check() {
    return {
      status: 'ok',
      service: 'eva-core',
      ts: new Date().toISOString(),
      sandbox: this.sandbox?.warmUpStatus ?? 'unavailable',
      standby: this.sandbox?.standbyReady ?? false,
    };
  }
}
