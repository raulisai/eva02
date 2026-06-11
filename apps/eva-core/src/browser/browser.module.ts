import { Module } from '@nestjs/common';
import { PlaywrightBrowserRuntime } from '@eva/browser-runtime';
import { DatabaseModule } from '../database/database.module';
import { EventsModule } from '../events/events.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { ModelRouterModule } from '../model-router/model-router.module';
import { BrowserController } from './browser.controller';
import { BrowserRepository } from './browser.repository';
import { BrowserService } from './browser.service';
import { SmartNavigatorService } from './smart-navigator.service';
import { BROWSER_RUNTIME } from './browser.types';
import { GoogleWebController } from './google-web.controller';
import { WhatsAppWebController } from './whatsapp-web.controller';
import { UberWebController } from './uber-web.controller';
import { RappiWebController } from './rappi-web.controller';
import { GoogleWebLoginService } from '../integrations/google-web-login.service';
import { UberWebService } from '../integrations/uber-web.service';
import { WhatsAppWebService } from '../integrations/whatsapp-web.service';
import { RappiWebService } from '../integrations/rappi-web.service';

@Module({
  imports: [DatabaseModule, EventsModule, ApprovalsModule, IntegrationsModule, ModelRouterModule],
  controllers: [BrowserController, WhatsAppWebController, UberWebController, GoogleWebController, RappiWebController],
  providers: [
    BrowserRepository,
    BrowserService,
    SmartNavigatorService,
    WhatsAppWebService,
    GoogleWebLoginService,
    UberWebService,
    RappiWebService,
    {
      provide: BROWSER_RUNTIME,
      useFactory: () => new PlaywrightBrowserRuntime({
        headless: process.env.BROWSER_HEADLESS !== 'false',
        profilesRoot: process.env.BROWSER_PROFILES_DIR,
      }),
    },
  ],
  exports: [BrowserService, SmartNavigatorService, WhatsAppWebService, UberWebService, GoogleWebLoginService, RappiWebService],
})
export class BrowserModule {}
