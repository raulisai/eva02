import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { AuthenticatedRequest } from '../common/types';
import { AgentFeedbackDto } from './dto/agent-feedback.dto';
import { SkillLibraryService } from './skill-library.service';

@Controller('agent')
export class AgentFeedbackController {
  constructor(private readonly skillLibrary: SkillLibraryService) {}

  @Post('feedback')
  @HttpCode(HttpStatus.ACCEPTED)
  recordFeedback(@Body() dto: AgentFeedbackDto, @Req() req: AuthenticatedRequest) {
    return this.skillLibrary.recordUserFeedback(req.user.orgId, {
      taskId: dto.taskId,
      userId: req.user.userId,
      reaction: dto.reaction,
      rating: dto.rating,
      comment: dto.comment,
    });
  }
}
