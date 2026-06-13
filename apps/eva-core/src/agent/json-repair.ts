/**
 * Tolerant JSON extraction for LLM tool-call output.
 *
 * Models frequently emit *almost* valid JSON: wrapped in ```json fences, with a
 * trailing comma, an unterminated closing brace (truncated generation), or prose
 * before/after the object. A strict `JSON.parse` throws on all of these and
 * wastes a whole agent step. This mirrors the role of Agent Zero's `DirtyJson`
 * (helpers/dirty_json.py): get a usable object out of slightly-broken text.
 *
 * Scope is deliberately narrow — we only target the common, safe repairs. We do
 * NOT rewrite single quotes to double quotes (ambiguous inside string values)
 * or guess at missing values; those return null so the caller asks the model to
 * resend rather than acting on a misparse.
 */

/** Parse `raw` into an object, repairing the common LLM malformations. */
export function tryParseDirty(raw: string): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = stripFences(raw.trim());

  // 1. Already valid.
  const direct = asObject(safeJson(cleaned));
  if (direct) return direct;

  // 2. Extract the first balanced object, auto-closing if truncated.
  const extracted = extractFirstObject(cleaned);
  if (extracted) {
    const parsed =
      asObject(safeJson(extracted)) ?? asObject(safeJson(repair(extracted)));
    if (parsed) return parsed;
  }

  // 3. Last resort: repair the whole cleaned string.
  return asObject(safeJson(repair(cleaned)));
}

/** Strip a leading ```json / ``` fence and a trailing ``` fence, if present. */
function stripFences(text: string): string {
  let out = text;
  out = out.replace(/^```(?:json|javascript|js)?[ \t]*\r?\n?/i, '');
  out = out.replace(/\r?\n?```\s*$/i, '');
  return out.trim();
}

/**
 * Scan from the first `{` tracking string state, and return the substring of the
 * first balanced object. If generation was truncated (more `{`/`[` than closers),
 * append the missing closers so it can still parse.
 */
function extractFirstObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  const stack: string[] = [];

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      stack.push(ch === '{' ? '}' : ']');
      depth++;
    } else if (ch === '}' || ch === ']') {
      stack.pop();
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  // Truncated: close any still-open structures (and an unterminated string).
  let tail = text.slice(start);
  if (inString) tail += '"';
  while (stack.length) tail += stack.pop();
  return tail;
}

/** Remove trailing commas before a closing brace/bracket: `{"a":1,}` → `{"a":1}`. */
function repair(text: string): string {
  return text.replace(/,(\s*[}\]])/g, '$1');
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
