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
