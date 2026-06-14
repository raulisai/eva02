import { EventBusService } from '../../events/event-bus.service';
import { TasksService } from '../../tasks/tasks.service';
import { CoreFallbackManager } from '../core-fallback.manager';

const ORG = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TASK = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

describe('CoreFallbackManager', () => {
  it('normalizes Wear location metadata onto core task metadata', async () => {
    const tasks = {
      createTask: jest.fn().mockResolvedValue({ id: TASK, title: 'Wear fallback: uber' }),
    } as unknown as jest.Mocked<TasksService>;
    const events = {
      publish: jest.fn().mockResolvedValue('0-1'),
    } as unknown as jest.Mocked<EventBusService>;
    const manager = new CoreFallbackManager(tasks, events);

    await manager.forward({
      orgId: ORG,
      userId: USER,
      deviceId: 'watch-1',
      requestType: 'uber',
      text: 'pideme un uber al trabajo',
      reason: 'request_type_or_text_disallowed',
      metadata: {
        lat: 19.4326,
        lng: -99.1332,
        accuracy_m: 12,
      },
    });

    expect(tasks.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          source: 'wear_fast_path',
          device_location: expect.objectContaining({
            latitude: 19.4326,
            longitude: -99.1332,
            accuracy: 12,
            source: 'wear_os',
          }),
          request_context: expect.objectContaining({
            source: 'wear_os',
            device_id: 'watch-1',
            request_type: 'uber',
            location: expect.objectContaining({
              source: 'wear_os',
              latitude: 19.4326,
              longitude: -99.1332,
              accuracy_m: 12,
            }),
          }),
        }),
      }),
      USER,
      ORG,
    );
    expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'wear.fast_path.fallback',
      orgId: ORG,
      taskId: TASK,
    }));
  });
});
