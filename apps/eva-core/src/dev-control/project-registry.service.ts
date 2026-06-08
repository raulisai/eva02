import { Injectable } from '@nestjs/common';
import { DevControlRepository } from './dev-control.repository';
import { Project } from './dev-control.types';
import { CreateProjectDto } from './dto/create-project.dto';

@Injectable()
export class ProjectRegistryService {
  constructor(private readonly repo: DevControlRepository) {}

  create(dto: CreateProjectDto, orgId: string): Promise<Project> {
    return this.repo.createProject(dto, orgId);
  }

  get(projectId: string, orgId: string): Promise<Project> {
    return this.repo.findProjectOrThrow(projectId, orgId);
  }
}
