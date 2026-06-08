import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { EventsModule } from '../events/events.module';
import { ApprovalClassifierService } from './approval-classifier.service';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsRepository } from './approvals.repository';
import { ApprovalsService } from './approvals.service';

@Module({
  imports: [DatabaseModule, EventsModule],
  controllers: [ApprovalsController],
  providers: [ApprovalsRepository, ApprovalClassifierService, ApprovalsService],
  exports: [ApprovalsService, ApprovalClassifierService],
})
export class ApprovalsModule {}
