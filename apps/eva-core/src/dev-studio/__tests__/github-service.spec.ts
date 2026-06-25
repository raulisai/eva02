import { GithubService, GithubNotConnectedError } from '../github/github.service';

function makeService(token: string | null) {
  const integrations = {
    getSecret: jest.fn().mockResolvedValue(token),
  } as any;
  return new GithubService(integrations);
}

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

describe('GithubService static helpers', () => {
  it('parseRepoUrl handles https, .git suffix, and git@ form', () => {
    expect(GithubService.parseRepoUrl('https://github.com/acme/widget')).toEqual({ owner: 'acme', repo: 'widget' });
    expect(GithubService.parseRepoUrl('https://github.com/acme/widget.git')).toEqual({ owner: 'acme', repo: 'widget' });
    expect(GithubService.parseRepoUrl('git@github.com:acme/widget.git')).toEqual({ owner: 'acme', repo: 'widget' });
  });

  it('tokenizedRemote embeds the token in an x-access-token remote', () => {
    const remote = GithubService.tokenizedRemote('https://github.com/acme/widget', 'ghp_secret');
    expect(remote).toBe('https://x-access-token:ghp_secret@github.com/acme/widget.git');
  });
});

describe('GithubService.validateToken', () => {
  it('reports not connected when the org has no token', async () => {
    const svc = makeService(null);
    const info = await svc.validateToken('org1');
    expect(info).toEqual({ connected: false, error: 'GITHUB_NOT_CONNECTED' });
  });

  it('returns login and scopes from the /user response', async () => {
    const svc = makeService('ghp_abc');
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse({ login: 'octo' }, { headers: { 'x-oauth-scopes': 'repo, workflow' } }),
    ) as any;
    const info = await svc.validateToken('org1');
    expect(info.connected).toBe(true);
    expect(info.login).toBe('octo');
    expect(info.scopes).toEqual(['repo', 'workflow']);
  });
});

describe('GithubService.requireToken', () => {
  it('throws GithubNotConnectedError when no token', async () => {
    const svc = makeService(null);
    await expect(svc.requireToken('org1')).rejects.toBeInstanceOf(GithubNotConnectedError);
  });
});

describe('GithubService PR + branch operations', () => {
  it('createPullRequest maps GitHub fields to the domain shape', async () => {
    const svc = makeService('ghp_abc');
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse({
        number: 42,
        html_url: 'https://github.com/acme/widget/pull/42',
        state: 'open',
        title: 'Add endpoint',
        head: { ref: 'agent/ada/iter-1-x', sha: 'deadbeef' },
        base: { ref: 'develop' },
      }),
    ) as any;
    const pr = await svc.createPullRequest('org1', 'acme', 'widget', {
      head: 'agent/ada/iter-1-x',
      base: 'develop',
      title: 'Add endpoint',
    });
    expect(pr.number).toBe(42);
    expect(pr.url).toBe('https://github.com/acme/widget/pull/42');
    expect(pr.head.sha).toBe('deadbeef');
    expect(pr.base.ref).toBe('develop');
  });

  it('mergePullRequest returns merged:false on 405 (not mergeable) instead of throwing', async () => {
    const svc = makeService('ghp_abc');
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse({ message: 'Pull Request is not mergeable' }, { status: 405 }),
    ) as any;
    const result = await svc.mergePullRequest('org1', 'acme', 'widget', 42);
    expect(result.merged).toBe(false);
    expect(result.message).toContain('not mergeable');
  });

  it('ensureBranch creates the ref from the base tip when the branch is missing', async () => {
    const svc = makeService('ghp_abc');
    const calls: Array<{ method: string; url: string; body?: any }> = [];
    global.fetch = jest.fn().mockImplementation(async (url: string, init: any) => {
      calls.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
      if (url.includes('/git/ref/heads/develop')) {
        return jsonResponse({ object: { sha: 'basesha' } });
      }
      if (url.includes('/git/ref/heads/feature') && init.method === 'GET') {
        return jsonResponse({ message: 'Not Found' }, { status: 404 });
      }
      if (url.endsWith('/git/refs') && init.method === 'POST') {
        return jsonResponse({ object: { sha: 'newsha' } });
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    }) as any;

    const sha = await svc.ensureBranch('org1', 'acme', 'widget', 'feature', 'develop');
    expect(sha).toBe('newsha');
    const createCall = calls.find((c) => c.url.endsWith('/git/refs'));
    expect(createCall?.body).toEqual({ ref: 'refs/heads/feature', sha: 'basesha' });
  });
});

describe('GithubService.getContent', () => {
  it('decodes base64 file content to UTF-8', async () => {
    const svc = makeService('ghp_abc');
    const text = 'export const x = 1;\n';
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse({
        path: 'src/x.ts',
        encoding: 'base64',
        content: Buffer.from(text, 'utf-8').toString('base64'),
        sha: 'abc',
        size: text.length,
      }),
    ) as any;
    const content = await svc.getContent('org1', 'acme', 'widget', 'src/x.ts', 'develop');
    expect(content.content).toBe(text);
    expect(content.tooLarge).toBe(false);
  });

  it('flags oversized files without decoding', async () => {
    const svc = makeService('ghp_abc');
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse({ path: 'big.bin', encoding: 'base64', content: '', sha: 'abc', size: 2 * 1024 * 1024 }),
    ) as any;
    const content = await svc.getContent('org1', 'acme', 'widget', 'big.bin', 'develop');
    expect(content.tooLarge).toBe(true);
    expect(content.content).toBe('');
  });
});

describe('GithubService error sanitization', () => {
  it('redacts token-shaped substrings from API error messages', async () => {
    const svc = makeService('ghp_abc');
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse({ message: 'bad credentials for ghp_supersecrettoken12345' }, { status: 401 }),
    ) as any;
    await expect(svc.getRepo('org1', 'acme', 'widget')).rejects.toThrow(/\[redacted\]/);
  });
});
