import { BadRequestException, Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DevControlRepository } from './dev-control.repository';

const execFileAsync = promisify(execFile);

@Injectable()
export class RepoManagerService {
  constructor(private readonly repo: DevControlRepository) {}

  async status(projectId: string, orgId: string) {
    return this.git(projectId, orgId, ['status', '--short', '--branch']);
  }

  async diff(projectId: string, orgId: string) {
    return this.git(projectId, orgId, ['diff', '--stat']);
  }

  async log(projectId: string, orgId: string, limit = 10) {
    return this.git(projectId, orgId, ['log', `-${Math.min(Math.max(limit, 1), 50)}`, '--oneline']);
  }

  private async git(projectId: string, orgId: string, args: string[]) {
    const project = await this.repo.findProjectOrThrow(projectId, orgId);
    if (!project.repo_path) throw new BadRequestException('Project has no repo_path');

    const { stdout, stderr } = await execFileAsync('git', ['-C', project.repo_path, ...args], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });

    return { projectId, command: ['git', ...args].join(' '), stdout, stderr };
  }
}
