import { Injectable } from '@nestjs/common';
import { DevControlRepository } from './dev-control.repository';
import { RunRecord } from './dev-control.types';
import { RunCommandDto } from './dto/run-command.dto';

@Injectable()
export class BuildTestRunnerService {
  constructor(private readonly repo: DevControlRepository) {}

  async runBuild(dto: RunCommandDto, orgId: string): Promise<RunRecord> {
    const project = await this.repo.findProjectOrThrow(dto.project_id, orgId);
    const command = dto.command ?? project.build_command ?? 'npm run build';
    return this.repo.insertRun('build_runs', {
      orgId,
      projectId: dto.project_id,
      devTaskId: dto.dev_task_id,
      command,
      ok: true,
      output: `mock build passed: ${command}`,
    });
  }

  async runTest(dto: RunCommandDto, orgId: string): Promise<RunRecord> {
    const project = await this.repo.findProjectOrThrow(dto.project_id, orgId);
    const command = dto.command ?? project.test_command ?? 'npm test';
    return this.repo.insertRun('test_runs', {
      orgId,
      projectId: dto.project_id,
      devTaskId: dto.dev_task_id,
      command,
      ok: true,
      output: `mock test passed: ${command}`,
    });
  }
}
