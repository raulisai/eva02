import { Injectable, Logger } from '@nestjs/common';
import { IntegrationsService } from '../../integrations/integrations.service';

/**
 * Thin GitHub REST client for Dev Studio.
 *
 * Auth model (per product decision): a single org-level fine-grained PAT stored
 * in `org_integrations` (kind=`credential`, provider=`github`) — the same secret
 * the dashboard already lets users save. Per-agent attribution is achieved with
 * git author identity (name/email) on each commit, not separate GitHub accounts.
 *
 * The token is read on demand from IntegrationsService, never cached on the
 * instance and never logged. Errors are sanitized to strip any token-shaped
 * substring before they leave this service.
 */

const GITHUB_API = 'https://api.github.com';
const CREDENTIAL_KIND = 'credential' as const;
const CREDENTIAL_PROVIDER = 'github' as const;
const TOKEN_REDACT_RE = /\b(?:ghp_|github_pat_|gho_|ghs_)[A-Za-z0-9_]+/g;

export class GithubApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly path?: string,
  ) {
    super(`GitHub API ${status}${path ? ` (${path})` : ''}: ${message}`);
    this.name = 'GithubApiError';
  }
}

export class GithubNotConnectedError extends Error {
  readonly code = 'GITHUB_NOT_CONNECTED';
  constructor() {
    super('GITHUB_NOT_CONNECTED: la organización no tiene un token de GitHub configurado');
    this.name = 'GithubNotConnectedError';
  }
}

export interface GithubTokenInfo {
  connected: boolean;
  login?: string;
  scopes?: string[];
  error?: string;
}

export interface GithubRepoInfo {
  owner: string;
  repo: string;
  fullName: string;
  htmlUrl: string;
  defaultBranch: string;
  private: boolean;
}

export interface GithubPullRequest {
  number: number;
  url: string; // html_url
  state: string; // open | closed
  merged: boolean;
  mergeable: boolean | null;
  draft: boolean;
  title: string;
  head: { ref: string; sha: string };
  base: { ref: string };
}

export interface GithubMergeResult {
  merged: boolean;
  sha?: string;
  message?: string;
}

export interface GithubTreeEntry {
  path: string;
  type: 'blob' | 'tree';
  sha: string;
  size?: number;
}

export interface GithubContent {
  path: string;
  encoding: string;
  content: string; // decoded UTF-8 text
  sha: string;
  size: number;
  truncated: boolean;
  tooLarge: boolean;
}

export interface GithubPrFile {
  filename: string;
  status: string; // added | modified | removed | renamed
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

@Injectable()
export class GithubService {
  private readonly logger = new Logger(GithubService.name);

  constructor(private readonly integrations: IntegrationsService) {}

  /** Build a push/clone remote with the token embedded, for use inside agent containers. */
  static tokenizedRemote(repoUrl: string, token: string): string {
    const { owner, repo } = GithubService.parseRepoUrl(repoUrl);
    return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
  }

  /** Parse owner/repo from a github URL (https or git@), tolerating a trailing .git. */
  static parseRepoUrl(repoUrl: string): { owner: string; repo: string } {
    const cleaned = repoUrl.trim().replace(/\.git$/i, '');
    const https = /github\.com[/:]([^/]+)\/([^/]+?)(?:\/|$)/i.exec(cleaned);
    if (!https) throw new GithubApiError(400, `URL de repo no reconocida: ${repoUrl}`);
    return { owner: https[1], repo: https[2] };
  }

  // ── Token / connection ─────────────────────────────────────────────────────

  async hasToken(orgId: string): Promise<boolean> {
    return (await this.readToken(orgId)) !== null;
  }

  private async readToken(orgId: string): Promise<string | null> {
    const raw = await this.integrations
      .getSecret(orgId, CREDENTIAL_KIND, CREDENTIAL_PROVIDER)
      .catch(() => null);
    const token = raw?.trim();
    return token ? token : null;
  }

  /** Internal: decrypted token or throw GithubNotConnectedError. */
  async requireToken(orgId: string): Promise<string> {
    const token = await this.readToken(orgId);
    if (!token) throw new GithubNotConnectedError();
    return token;
  }

  /** Validate the org token and report login + scopes for the UI. */
  async validateToken(orgId: string): Promise<GithubTokenInfo> {
    const token = await this.readToken(orgId);
    if (!token) return { connected: false, error: 'GITHUB_NOT_CONNECTED' };
    try {
      const { res, json } = await this.fetchGithub(token, 'GET', '/user');
      if (!res.ok) {
        return { connected: false, error: this.sanitize(JSON.stringify(json)) };
      }
      const scopeHeader = res.headers.get('x-oauth-scopes') ?? '';
      const scopes = scopeHeader
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      return {
        connected: true,
        login: (json as { login?: string }).login,
        scopes,
      };
    } catch (err) {
      return { connected: false, error: this.sanitize((err as Error).message) };
    }
  }

  // ── Repos ───────────────────────────────────────────────────────────────────

  async getRepo(orgId: string, owner: string, repo: string): Promise<GithubRepoInfo> {
    const json = await this.request<Record<string, unknown>>(orgId, 'GET', `/repos/${owner}/${repo}`);
    return this.toRepoInfo(json);
  }

  /**
   * Create a repo. If `org` is provided, creates under that org; otherwise under
   * the authenticated user. `autoInit` seeds an initial commit so branches can be
   * created immediately.
   */
  async createRepo(
    orgId: string,
    input: { name: string; private?: boolean; org?: string; description?: string; autoInit?: boolean },
  ): Promise<GithubRepoInfo> {
    const path = input.org ? `/orgs/${input.org}/repos` : '/user/repos';
    const json = await this.request<Record<string, unknown>>(orgId, 'POST', path, {
      name: input.name,
      private: input.private ?? true,
      description: input.description,
      auto_init: input.autoInit ?? true,
    });
    return this.toRepoInfo(json);
  }

  private toRepoInfo(json: Record<string, unknown>): GithubRepoInfo {
    const ownerObj = (json.owner ?? {}) as { login?: string };
    return {
      owner: ownerObj.login ?? '',
      repo: (json.name as string) ?? '',
      fullName: (json.full_name as string) ?? '',
      htmlUrl: (json.html_url as string) ?? '',
      defaultBranch: (json.default_branch as string) ?? 'main',
      private: Boolean(json.private),
    };
  }

  // ── Branches ─────────────────────────────────────────────────────────────────

  /** SHA of a branch tip, or null if the branch doesn't exist. */
  async getBranchSha(orgId: string, owner: string, repo: string, branch: string): Promise<string | null> {
    try {
      const json = await this.request<{ object?: { sha?: string } }>(
        orgId,
        'GET',
        `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
      );
      return json.object?.sha ?? null;
    } catch (err) {
      if (err instanceof GithubApiError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * Ensure `branch` exists. If missing, create it from `fromBranch` (default
   * branch tip). Returns the branch tip SHA. Idempotent.
   */
  async ensureBranch(
    orgId: string,
    owner: string,
    repo: string,
    branch: string,
    fromBranch: string,
  ): Promise<string> {
    const existing = await this.getBranchSha(orgId, owner, repo, branch);
    if (existing) return existing;
    const baseSha = await this.getBranchSha(orgId, owner, repo, fromBranch);
    if (!baseSha) {
      throw new GithubApiError(404, `rama base "${fromBranch}" no existe en ${owner}/${repo}`);
    }
    try {
      const created = await this.request<{ object?: { sha?: string } }>(
        orgId,
        'POST',
        `/repos/${owner}/${repo}/git/refs`,
        { ref: `refs/heads/${branch}`, sha: baseSha },
      );
      return created.object?.sha ?? baseSha;
    } catch (err) {
      // 422 = ref already exists (created concurrently by a parallel wave). Re-read.
      if (err instanceof GithubApiError && err.status === 422) {
        const sha = await this.getBranchSha(orgId, owner, repo, branch);
        if (sha) return sha;
      }
      throw err;
    }
  }

  // ── Pull requests ────────────────────────────────────────────────────────────

  async createPullRequest(
    orgId: string,
    owner: string,
    repo: string,
    input: { head: string; base: string; title: string; body?: string; draft?: boolean },
  ): Promise<GithubPullRequest> {
    const json = await this.request<Record<string, unknown>>(orgId, 'POST', `/repos/${owner}/${repo}/pulls`, {
      head: input.head,
      base: input.base,
      title: input.title,
      body: input.body ?? '',
      draft: input.draft ?? false,
    });
    return this.toPullRequest(json);
  }

  async getPullRequest(orgId: string, owner: string, repo: string, number: number): Promise<GithubPullRequest> {
    const json = await this.request<Record<string, unknown>>(orgId, 'GET', `/repos/${owner}/${repo}/pulls/${number}`);
    return this.toPullRequest(json);
  }

  async listPullRequests(
    orgId: string,
    owner: string,
    repo: string,
    opts: { state?: 'open' | 'closed' | 'all'; base?: string } = {},
  ): Promise<GithubPullRequest[]> {
    const qs = new URLSearchParams({ state: opts.state ?? 'open', per_page: '50' });
    if (opts.base) qs.set('base', opts.base);
    const json = await this.request<Record<string, unknown>[]>(
      orgId,
      'GET',
      `/repos/${owner}/${repo}/pulls?${qs.toString()}`,
    );
    return (json ?? []).map((p) => this.toPullRequest(p));
  }

  /** Find an existing open PR for head→base, if any (avoid duplicate PRs on retry). */
  async findOpenPullRequest(
    orgId: string,
    owner: string,
    repo: string,
    head: string,
    base: string,
  ): Promise<GithubPullRequest | null> {
    const qs = new URLSearchParams({ state: 'open', base, head: `${owner}:${head}`, per_page: '1' });
    const json = await this.request<Record<string, unknown>[]>(
      orgId,
      'GET',
      `/repos/${owner}/${repo}/pulls?${qs.toString()}`,
    );
    const first = (json ?? [])[0];
    return first ? this.toPullRequest(first) : null;
  }

  async mergePullRequest(
    orgId: string,
    owner: string,
    repo: string,
    number: number,
    method: 'merge' | 'squash' | 'rebase' = 'squash',
    commitTitle?: string,
  ): Promise<GithubMergeResult> {
    try {
      const json = await this.request<{ merged?: boolean; sha?: string; message?: string }>(
        orgId,
        'PUT',
        `/repos/${owner}/${repo}/pulls/${number}/merge`,
        { merge_method: method, commit_title: commitTitle },
      );
      return { merged: Boolean(json.merged), sha: json.sha, message: json.message };
    } catch (err) {
      // 405 (not mergeable) / 409 (conflict) are expected, surfaced as a result.
      if (err instanceof GithubApiError && (err.status === 405 || err.status === 409)) {
        return { merged: false, message: err.message };
      }
      throw err;
    }
  }

  async closePullRequest(orgId: string, owner: string, repo: string, number: number): Promise<void> {
    await this.request(orgId, 'PATCH', `/repos/${owner}/${repo}/pulls/${number}`, { state: 'closed' });
  }

  async getPullRequestFiles(orgId: string, owner: string, repo: string, number: number): Promise<GithubPrFile[]> {
    const json = await this.request<Record<string, unknown>[]>(
      orgId,
      'GET',
      `/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`,
    );
    return (json ?? []).map((f) => ({
      filename: (f.filename as string) ?? '',
      status: (f.status as string) ?? '',
      additions: Number(f.additions ?? 0),
      deletions: Number(f.deletions ?? 0),
      changes: Number(f.changes ?? 0),
      patch: f.patch as string | undefined,
    }));
  }

  private toPullRequest(json: Record<string, unknown>): GithubPullRequest {
    const head = (json.head ?? {}) as { ref?: string; sha?: string };
    const base = (json.base ?? {}) as { ref?: string };
    return {
      number: Number(json.number ?? 0),
      url: (json.html_url as string) ?? '',
      state: (json.state as string) ?? 'open',
      merged: Boolean(json.merged ?? json.merged_at),
      mergeable: (json.mergeable as boolean | null) ?? null,
      draft: Boolean(json.draft),
      title: (json.title as string) ?? '',
      head: { ref: head.ref ?? '', sha: head.sha ?? '' },
      base: { ref: base.ref ?? '' },
    };
  }

  // ── Read-only viewer (tree + content) ─────────────────────────────────────────

  async getTree(
    orgId: string,
    owner: string,
    repo: string,
    ref: string,
    recursive = true,
  ): Promise<GithubTreeEntry[]> {
    const qs = recursive ? '?recursive=1' : '';
    const json = await this.request<{ tree?: Record<string, unknown>[] }>(
      orgId,
      'GET',
      `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}${qs}`,
    );
    return (json.tree ?? [])
      .filter((e) => e.type === 'blob' || e.type === 'tree')
      .map((e) => ({
        path: (e.path as string) ?? '',
        type: e.type as 'blob' | 'tree',
        sha: (e.sha as string) ?? '',
        size: e.size as number | undefined,
      }));
  }

  /** Decoded file content at a path for a ref. Large/binary files are flagged, not decoded. */
  async getContent(orgId: string, owner: string, repo: string, path: string, ref: string): Promise<GithubContent> {
    const qs = new URLSearchParams({ ref });
    const json = await this.request<Record<string, unknown>>(
      orgId,
      'GET',
      `/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?${qs.toString()}`,
    );
    const encoding = (json.encoding as string) ?? '';
    const size = Number(json.size ?? 0);
    const rawContent = (json.content as string) ?? '';
    const tooLarge = encoding !== 'base64' || size > 512 * 1024;
    let content = '';
    if (!tooLarge && rawContent) {
      content = Buffer.from(rawContent.replace(/\n/g, ''), 'base64').toString('utf-8');
    }
    return {
      path: (json.path as string) ?? path,
      encoding,
      content,
      sha: (json.sha as string) ?? '',
      size,
      truncated: Boolean(json.truncated),
      tooLarge,
    };
  }

  // ── Low-level HTTP ───────────────────────────────────────────────────────────

  private async request<T>(orgId: string, method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.requireToken(orgId);
    const { res, json } = await this.fetchGithub(token, method, path, body);
    if (!res.ok) {
      const message = this.sanitize(
        (json as { message?: string } | null)?.message ?? JSON.stringify(json ?? {}),
      );
      throw new GithubApiError(res.status, message, path);
    }
    return json as T;
  }

  private async fetchGithub(
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ res: Response; json: unknown }> {
    const res = await fetch(`${GITHUB_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'eva-dev-studio',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json: unknown = null;
    const text = await res.text().catch(() => '');
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { message: this.sanitize(text.slice(0, 300)) };
      }
    }
    return { res, json };
  }

  /** Strip any token-shaped substring so secrets never reach logs or clients. */
  private sanitize(text: string): string {
    return (text ?? '').replace(TOKEN_REDACT_RE, '[redacted]');
  }
}
