import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { AuthenticatedRequest } from '../common/types';
import { BrowserService } from './browser.service';
import { ExtractBrowserDto, OpenBrowserDto, PrepareBrowserActionDto, SelectorDto, TypeBrowserDto, WaitBrowserDto } from './dto/browser-action.dto';

@Controller('browser')
export class BrowserController {
  constructor(private readonly browser: BrowserService) {}

  @Post('open')
  @HttpCode(HttpStatus.CREATED)
  open(@Body() dto: OpenBrowserDto, @Req() req: AuthenticatedRequest) {
    return this.browser.open(dto, req.user.orgId);
  }

  @Post('sessions/:id/screenshot')
  screenshot(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.browser.screenshot(id, req.user.orgId);
  }

  @Post('sessions/:id/click')
  click(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SelectorDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.browser.prepareAction(id, req.user.orgId, req.user.userId, {
      task_id: dto.task_id,
      action_type: 'browser.click',
      payload: { selector: dto.selector },
    });
  }

  @Post('sessions/:id/type')
  type(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TypeBrowserDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.browser.prepareAction(id, req.user.orgId, req.user.userId, {
      task_id: dto.task_id,
      action_type: 'browser.type',
      payload: { selector: dto.selector, text: dto.text },
    });
  }

  @Post('sessions/:id/extract-text')
  extractText(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ExtractBrowserDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.browser.extractText(id, req.user.orgId, dto.selector);
  }

  @Post('sessions/:id/extract-table')
  extractTable(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ExtractBrowserDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.browser.extractTable(id, req.user.orgId, dto.selector);
  }

  @Post('sessions/:id/wait')
  wait(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: WaitBrowserDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.browser.wait(id, req.user.orgId, dto.ms);
  }

  @Post('sessions/:id/close')
  close(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.browser.close(id, req.user.orgId);
  }

  @Post('sessions/:id/prepare-action')
  prepareAction(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PrepareBrowserActionDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.browser.prepareAction(id, req.user.orgId, req.user.userId, dto);
  }

  @Get('sessions/:id/status')
  status(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.browser.wait(id, req.user.orgId, 1);
  }
}
