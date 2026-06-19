import { ClaudeCodeRunnerService } from '../claude-code-runner.service';

/**
 * Unit-test the image-resolution policy without touching Docker by pre-seeding
 * the private imageCache (the same map imageAvailable() consults).
 */
describe('ClaudeCodeRunnerService.resolveImage', () => {
  function withCache(entries: Record<string, boolean>): ClaudeCodeRunnerService {
    const svc = new ClaudeCodeRunnerService();
    const cache = (svc as unknown as { imageCache: Map<string, boolean> }).imageCache;
    for (const [k, v] of Object.entries(entries)) cache.set(k, v);
    return svc;
  }

  it('picks the role-specific image when it exists', async () => {
    const svc = withCache({ 'eva-agent-backend': true, 'eva-agent-base': true });
    expect(await svc.resolveImage('backend')).toBe('eva-agent-backend');
  });

  it('falls back to the base image when the role image is missing', async () => {
    const svc = withCache({ 'eva-agent-backend': false, 'eva-agent-base': true });
    expect(await svc.resolveImage('backend')).toBe('eva-agent-base');
  });

  it('falls back to the legacy image when role and base are both missing', async () => {
    const svc = withCache({
      'eva-agent-frontend': false,
      'eva-agent-base': false,
      'eva-claude-sandbox': true,
    });
    expect(await svc.resolveImage('frontend')).toBe('eva-claude-sandbox');
  });

  it('returns null when no candidate image is built', async () => {
    const svc = withCache({
      'eva-agent-testing': false,
      'eva-agent-base': false,
      'eva-claude-sandbox': false,
    });
    expect(await svc.resolveImage('testing')).toBeNull();
  });

  it('reports no live machine for an unknown key', () => {
    const svc = withCache({});
    expect(svc.machineInfo('nope')).toBeNull();
    expect(svc.hasContainer('nope')).toBe(false);
  });
});
