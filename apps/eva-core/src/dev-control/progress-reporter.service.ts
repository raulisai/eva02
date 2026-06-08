import { Injectable } from '@nestjs/common';
import { DevControlRepository } from './dev-control.repository';

@Injectable()
export class ProgressReporterService {
  constructor(private readonly repo: DevControlRepository) {}

  async reportDevTask(devTaskId: string, orgId: string) {
    const task = await this.repo.findDevTaskOrThrow(devTaskId, orgId);
    return {
      devTaskId: task.id,
      projectId: task.project_id,
      status: task.status,
      title: task.title,
      diff_summary: task.diff_summary,
      updated_at: task.updated_at,
    };
  }
}
