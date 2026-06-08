import { Injectable } from '@nestjs/common';
import { DevControlRepository } from './dev-control.repository';

@Injectable()
export class RoadmapAgentService {
  constructor(private readonly repo: DevControlRepository) {}

  async suggestNext(projectId: string, orgId: string) {
    const project = await this.repo.findProjectOrThrow(projectId, orgId);
    return this.repo.createRoadmapItem({
      orgId,
      projectId,
      title: `Stabilize ${project.name}: run build, tests, and review pending dev tasks`,
      priority: 10,
      metadata: { agent: 'basic-roadmap-agent', reason: 'phase-6-default' },
    });
  }
}
