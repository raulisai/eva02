import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EventBusService } from '../../events/event-bus.service';
import { BuildTestRunnerService } from '../build-test-runner.service';
import { ClaudeCodeControllerService } from '../claude-code-controller.service';
import { DevControlRepository } from '../dev-control.repository';
import { DevTaskQueueService } from '../dev-task-queue.service';
import { ProgressReporterService } from '../progress-reporter.service';
import { ProjectRegistryService } from '../project-registry.service';

const ORG = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PROJECT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const DEV_TASK_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const SESSION_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

const now = new Date().toISOString();

const project = {
  id: PROJECT_ID,
  org_id: ORG,
  name: 'eva-core',
  repo_path: '/Users/djoker/code/eva02',
  node_id: null,
  stack: ['nestjs'],
  status: 'active',
  main_branch: 'main',
  dev_command: null,
  test_command: 'npm test',
  build_command: 'npm run build',
  metadata: {},
  created_at: now,
  updated_at: now,
};

const devTask = {
  id: DEV_TASK_ID,
  org_id: ORG,
  project_id: PROJECT_ID,
  title: 'Implement DCC',
  status: 'backlog' as const,
  prompt: 'Build the Development Control Center',
  diff_summary: null,
  metadata: {},
  created_by: USER,
  created_at: now,
  updated_at: now,
};

const session = {
  id: SESSION_ID,
  org_id: ORG,
  project_id: PROJECT_ID,
  dev_task_id: DEV_TASK_ID,
  node_id: null,
  status: 'starting' as const,
  transport: 'websocket' as const,
  output: '',
  metadata: {},
  started_at: now,
  updated_at: now,
};

describe('Development Control Center services', () => {
  let projects: ProjectRegistryService;
  let tasks: DevTaskQueueService;
  let claude: ClaudeCodeControllerService;
  let runner: BuildTestRunnerService;
  let progress: ProgressReporterService;
  let repo: jest.Mocked<DevControlRepository>;
  let events: jest.Mocked<EventBusService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectRegistryService,
        DevTaskQueueService,
        ClaudeCodeControllerService,
        BuildTestRunnerService,
        ProgressReporterService,
        {
          provide: DevControlRepository,
          useValue: {
            createProject: jest.fn(),
            findProjectOrThrow: jest.fn(),
            createDevTask: jest.fn(),
            findDevTaskOrThrow: jest.fn(),
            updateDevTaskStatus: jest.fn(),
            createClaudeSession: jest.fn(),
            findClaudeSessionOrThrow: jest.fn(),
            updateClaudeSession: jest.fn(),
            insertRun: jest.fn(),
          } satisfies Partial<DevControlRepository>,
        },
        {
          provide: EventBusService,
          useValue: {
            publish: jest.fn().mockResolvedValue('0-1'),
          } satisfies Partial<EventBusService>,
        },
      ],
    }).compile();

    projects = module.get(ProjectRegistryService);
    tasks = module.get(DevTaskQueueService);
    claude = module.get(ClaudeCodeControllerService);
    runner = module.get(BuildTestRunnerService);
    progress = module.get(ProgressReporterService);
    repo = module.get(DevControlRepository);
    events = module.get(EventBusService);
  });

  it('creates a project and dev_task with org scope', async () => {
    repo.createProject.mockResolvedValue(project);
    repo.createDevTask.mockResolvedValue(devTask);

    const createdProject = await projects.create({ name: 'eva-core' }, ORG);
    const createdTask = await tasks.create({ project_id: PROJECT_ID, title: 'Implement DCC' }, ORG, USER);

    expect(repo.createProject).toHaveBeenCalledWith({ name: 'eva-core' }, ORG);
    expect(repo.createDevTask).toHaveBeenCalledWith(
      { project_id: PROJECT_ID, title: 'Implement DCC' },
      ORG,
      USER,
    );
    expect(createdProject.org_id).toBe(ORG);
    expect(createdTask.org_id).toBe(ORG);
    expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'dev.task.created', orgId: ORG }));
  });

  it('enforces dev task state transitions from the doc', async () => {
    repo.findDevTaskOrThrow.mockResolvedValue(devTask);

    await expect(tasks.transition(DEV_TASK_ID, ORG, 'done')).rejects.toThrow(BadRequestException);
    expect(repo.updateDevTaskStatus).not.toHaveBeenCalled();
  });

  it('simulates a Claude Code session over WebSocket and blocks dangerous tasks without approval', async () => {
    repo.createClaudeSession.mockResolvedValue(session);
    repo.updateClaudeSession.mockImplementation(async (_id, _org, patch) => ({ ...session, ...patch }));
    repo.findClaudeSessionOrThrow.mockResolvedValue({ ...session, status: 'running', output: 'ready\n' });

    const started = await claude.startSession({ project_id: PROJECT_ID, dev_task_id: DEV_TASK_ID }, ORG);
    const blocked = await claude.sendTask(SESSION_ID, ORG, { prompt: 'run git reset --hard' });

    expect(started.status).toBe('running');
    expect(blocked.status).toBe('waiting_approval');
    expect(blocked.output).toContain('Approval Engine');
  });

  it('runs mocked build/test and records both runs', async () => {
    repo.findProjectOrThrow.mockResolvedValue(project);
    repo.findDevTaskOrThrow.mockResolvedValue(devTask);
    repo.insertRun.mockImplementation(async (table, input) => ({
      id: table === 'build_runs' ? 1 : 2,
      org_id: input.orgId,
      project_id: input.projectId,
      dev_task_id: input.devTaskId ?? null,
      command: input.command ?? null,
      ok: input.ok,
      output: input.output,
      created_at: now,
    }));

    const build = await runner.runBuild({ project_id: PROJECT_ID, dev_task_id: DEV_TASK_ID }, ORG);
    const test = await runner.runTest({ project_id: PROJECT_ID, dev_task_id: DEV_TASK_ID }, ORG);

    expect(build.ok).toBe(true);
    expect(build.output).toContain('mock build passed');
    expect(test.ok).toBe(true);
    expect(test.output).toContain('mock test passed');
  });

  it('reports dev task progress', async () => {
    repo.findDevTaskOrThrow.mockResolvedValue({ ...devTask, status: 'testing' });

    const report = await progress.reportDevTask(DEV_TASK_ID, ORG);

    expect(report).toEqual(expect.objectContaining({
      devTaskId: DEV_TASK_ID,
      projectId: PROJECT_ID,
      status: 'testing',
    }));
  });
});
