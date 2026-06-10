import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { CapabilityGateService } from './capability-gate.service';

@Module({
  imports: [IntegrationsModule],
  providers: [CapabilityGateService],
  exports: [CapabilityGateService],
})
export class CapabilityGateModule {}
