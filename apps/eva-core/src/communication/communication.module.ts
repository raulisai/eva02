import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { EventsModule } from '../events/events.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { TasksModule } from '../tasks/tasks.module';
import { CommunicationController } from './communication.controller';
import { CommunicationRepository } from './communication.repository';
import { CommunicationService } from './communication.service';
import { TelegramAdapter } from './telegram.adapter';

@Module({
  imports: [DatabaseModule, EventsModule, TasksModule, IntegrationsModule],
  controllers: [CommunicationController],
  providers: [CommunicationService, CommunicationRepository, TelegramAdapter],
  exports: [CommunicationService],
})
export class CommunicationModule {}
