import { EventBusService } from '../event-bus.service';

const TASK = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

describe('EventBusService steer queue', () => {
  let service: EventBusService;
  let redis: {
    lpush: jest.Mock;
    expire: jest.Mock;
    multi: jest.Mock;
    lrange: jest.Mock;
    del: jest.Mock;
    exec: jest.Mock;
  };

  beforeEach(() => {
    redis = {
      lpush: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      lrange: jest.fn().mockReturnThis(),
      del: jest.fn().mockReturnThis(),
      exec: jest.fn(),
      multi: jest.fn(),
    };
    redis.multi.mockReturnValue(redis); // chain .lrange().del().exec()

    service = new EventBusService({} as never);
    (service as unknown as { publisher: unknown }).publisher = redis;
  });

  describe('pushSteer', () => {
    it('LPUSHes the trimmed message and sets a TTL', async () => {
      await service.pushSteer(TASK, '  enfócate en X  ');
      expect(redis.lpush).toHaveBeenCalledWith(`eva:steer:${TASK}`, 'enfócate en X');
      expect(redis.expire).toHaveBeenCalledWith(`eva:steer:${TASK}`, 6 * 60 * 60);
    });

    it('ignores empty messages', async () => {
      await service.pushSteer(TASK, '   ');
      expect(redis.lpush).not.toHaveBeenCalled();
    });
  });

  describe('drainSteer', () => {
    it('reads + clears atomically and returns messages in chronological order', async () => {
      // LPUSH prepends, so Redis stores newest-first — drain must reverse.
      redis.exec.mockResolvedValue([[null, ['tercero', 'segundo', 'primero']], [null, 1]]);

      const messages = await service.drainSteer(TASK);

      expect(redis.lrange).toHaveBeenCalledWith(`eva:steer:${TASK}`, 0, -1);
      expect(redis.del).toHaveBeenCalledWith(`eva:steer:${TASK}`);
      expect(messages).toEqual(['primero', 'segundo', 'tercero']);
    });

    it('returns an empty array when the queue is empty', async () => {
      redis.exec.mockResolvedValue([[null, null], [null, 0]]);
      expect(await service.drainSteer(TASK)).toEqual([]);
    });

    it('returns an empty array (never throws) when Redis is unavailable', async () => {
      (service as unknown as { publisher: unknown }).publisher = undefined;
      expect(await service.drainSteer(TASK)).toEqual([]);
    });
  });
});
