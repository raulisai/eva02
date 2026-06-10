import { Module } from '@nestjs/common';
import { PlaywrightBrowserRuntime } from '@eva/browser-runtime';
import { DatabaseModule } from '../database/database.module';
import { EventsModule } from '../events/events.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { BrowserController } from './browser.controller';
import { BrowserRepository } from './browser.repository';
import { BrowserService } from './browser.service';
import { BROWSER_RUNTIME } from './browser.types';
import { WhatsAppWebController } from './whatsapp-web.controller';
import { WhatsAppWebService } from '../integrations/whatsapp-web.service';

@Module({
  imports: [DatabaseModule, EventsModule, ApprovalsModule, IntegrationsModule],
  controllers: [BrowserController, WhatsAppWebController],
  providers: [
    BrowserRepository,
    BrowserService,
    WhatsAppWebService,
    {
      provide: BROWSER_RUNTIME,
      useFactory: () => new PlaywrightBrowserRuntime({
        headless: process.env.BROWSER_HEADLESS !== 'false',
        profilesRoot: process.env.BROWSER_PROFILES_DIR,
      }),
    },
  ],
  exports: [BrowserService, WhatsAppWebService],
})
export class BrowserModule {}
