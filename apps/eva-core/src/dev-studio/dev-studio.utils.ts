/**
 * Extract and repair JSON from a potentially noisy / truncated LLM response.
 * Handles: markdown fences, leading prose, trailing prose, truncated JSON.
 *
 * Shared by DevArchitectService and DevProjectManagerService so the repair
 * logic stays in one place.
 */
export function extractJson<T>(text: string): T {
  let s = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '');

  try { return JSON.parse(s) as T; } catch { /* continue */ }

  const objStart = s.indexOf('{');
  const arrStart = s.indexOf('[');
  let start = -1;
  if (objStart === -1) start = arrStart;
  else if (arrStart === -1) start = objStart;
  else start = Math.min(objStart, arrStart);
  if (start !== -1) s = s.slice(start);

  s = s.replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(s) as T; } catch { /* continue */ }

  // Repair truncated JSON: track structure depth and open/close containers.
  const opens: string[] = [];
  let inStr = false;
  let escape = false;
  let strStart = -1;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inStr) { escape = true; continue; }
    if (ch === '"') {
      if (!inStr) { inStr = true; strStart = i; }
      else { inStr = false; strStart = -1; }
      continue;
    }
    if (inStr) continue;
    if (ch === '{') opens.push('}');
    else if (ch === '[') opens.push(']');
    else if (ch === '}' || ch === ']') opens.pop();
  }

  let candidate: string;
  if (inStr) {
    candidate = s.slice(0, strStart);
    candidate = candidate.replace(/[,]?\s*"[^"]*"\s*:\s*$/, '').trimEnd();
    candidate = candidate.replace(/[,]?\s*$/, '');
  } else {
    candidate = s;
    candidate = candidate.replace(/,\s*"[^"]*"\s*:\s*$/, '').trimEnd();
    candidate = candidate.replace(/,\s*$/, '');
  }

  candidate += opens.reverse().join('');

  try { return JSON.parse(candidate) as T; } catch (e) {
    throw new Error(`extractJson failed: ${(e as Error).message}\nInput (first 300): ${text.slice(0, 300)}`);
  }
}

/**
 * URL/branch-safe slug: lowercase, ASCII, hyphen-separated, bounded length.
 * Strips diacritics so "Diseño Inicial" → "diseno-inicial".
 */
export function slugify(input: string, maxLen = 40): string {
  const base = (input ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/g, '');
  return base || 'task';
}

/**
 * Branch name for an agent's task. Carries the agent's NAME (not just role) so
 * every branch and its commits are attributable to who did the work:
 *   agent/<name-slug>/iter-<N>-<task-slug>
 */
export function agentBranchName(agentName: string, taskTitle: string, iteration: number): string {
  const who = slugify(agentName || 'agent', 24);
  const what = slugify(taskTitle || 'task', 32);
  const n = Number.isFinite(iteration) && iteration > 0 ? iteration : 1;
  return `agent/${who}/iter-${n}-${what}`;
}

/**
 * Stable git author identity for an agent. The commit author shows who did the
 * change in GitHub history; the email is a non-routable noreply address keyed by
 * the agent id so it stays unique per agent within the org.
 */
export function agentGitIdentity(agent: { id: string; name: string; role: string }): {
  name: string;
  email: string;
} {
  const id8 = (agent.id ?? '').replace(/-/g, '').slice(0, 8) || 'agent';
  const roleSlug = slugify(agent.role || 'agent', 16);
  const name = agent.name?.trim() || `EVA ${agent.role}`;
  return { name, email: `${roleSlug}+${id8}@eva-agents.local` };
}
