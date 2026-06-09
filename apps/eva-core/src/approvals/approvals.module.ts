import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { EventsModule } from '../events/events.module';
import { CommunicationModule } from '../communication/communication.module';
import { ApprovalClassifierService } from './approval-classifier.service';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsRepository } from './approvals.repository';
import { ApprovalsService } from './approvals.service';

@Module({
  imports: [DatabaseModule, EventsModule, CommunicationModule],
  controllers: [ApprovalsController],
  providers: [ApprovalsRepository, ApprovalClassifierService, ApprovalsService],
  exports: [ApprovalsService, ApprovalClassifierService],
})
export class ApprovalsModule {}
