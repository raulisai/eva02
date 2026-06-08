import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { AppGateway } from '../gateway/app.gateway';
import { DevControlRepository } from './dev-control.repository';
import { ClaudeCodeSession } from './dev-control.types';
import { SendClaudeTaskDto, StartClaudeSessionDto } from './dto/claude-code.dto';

const DANGEROUS_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+push\b/i,
  /\bsupabase\s+db\s+(push|reset)\b/i,
  /\bdocker\s+compose\s+down\s+-v\b/i,
  /\bdeploy\b/i,
  /\bproduction\b/i,
  /\bdelete\b/i,
  /\bdrop\s+table\b/i,
];

@Injectable()
export class ClaudeCodeControllerService {
  constructor(
    private readonly repo: DevControlRepository,
    @Optional() private readonly gateway?: AppGateway,
  ) {}

  async startSession(dto: StartClaudeSessionDto, orgId: string): Promise<ClaudeCodeSession> {
    const session = await this.repo.createClaudeSession({
      orgId,
      projectId: dto.project_id,
      devTaskId: dto.dev_task_id,
      nodeId: dto.node_id,
      metadata: dto.metadata,
    });
    this.gateway?.emitNodeCommand(orgId, {
      command: 'claude_code.start_session',
      nodeId: dto.node_id ?? null,
      sessionId: session.id,
      projectId: dto.project_id,
      devTaskId: dto.dev_task_id ?? null,
    });

    return this.repo.updateClaudeSession(session.id, orgId, {
      status: 'running',
      output: 'Claude Code session requested over node WebSocket.\n',
      metadata: {
        ...session.metadata,
        websocket: {
          node_id: dto.node_id ?? null,
          command: 'start_session',
          mock: true,
        },
      },
    });
  }

  async sendTask(sessionId: string, orgId: string, dto: SendClaudeTaskDto): Promise<ClaudeCodeSession> {
    const session = await this.repo.findClaudeSessionOrThrow(sessionId, orgId);
    if (this.requiresApproval(dto.prompt) && !dto.approval_id) {
      return this.repo.updateClaudeSession(sessionId, orgId, {
        status: 'waiting_approval',
        output: `${session.output}Blocked pending Approval Engine: dangerous command pattern detected.\n`,
      });
    }
    this.gateway?.emitNodeCommand(orgId, {
      command: 'claude_code.send_task',
      nodeId: session.node_id,
      sessionId,
      projectId: session.project_id,
      devTaskId: session.dev_task_id,
      prompt: dto.prompt,
      approvalId: dto.approval_id ?? null,
    });

    return this.repo.updateClaudeSession(sessionId, orgId, {
      status: 'running',
      output: `${session.output}send_task dispatched over node WebSocket: ${dto.prompt}\n`,
      metadata: {
        ...session.metadata,
        last_approval_id: dto.approval_id ?? null,
        last_command: 'send_task',
      },
    });
  }

  async readOutput(sessionId: string, orgId: string) {
    const session = await this.repo.findClaudeSessionOrThrow(sessionId, orgId);
    return { sessionId, output: session.output };
  }

  async getStatus(sessionId: string, orgId: string) {
    const session = await this.repo.findClaudeSessionOrThrow(sessionId, orgId);
    return { sessionId, status: session.status, updated_at: session.updated_at };
  }

  private requiresApproval(prompt: string): boolean {
    if (!prompt.trim()) throw new BadRequestException('prompt cannot be empty');
    return DANGEROUS_PATTERNS.some((pattern) => pattern.test(prompt));
  }
}
