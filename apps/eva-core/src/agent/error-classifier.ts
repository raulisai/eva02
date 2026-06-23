/**
 * Classifies error messages to distinguish transient (retry-able) from permanent errors.
 * Used by the agent loop and pipeline runner to decide whether to retry immediately
 * or spend a pivot step.
 */

export type ErrorCategory = 'transient' | 'auth' | 'bad_args' | 'permanent';

export interface ErrorClassification {
  category: ErrorCategory;
  /** Whether the operation is safe to retry (idempotent or recoverable). */
  retryable: boolean;
  /** Suggested initial backoff delay in ms before first retry. */
  backoffMs: number;
}

const TRANSIENT_PATTERNS = [
  /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|ECONNABORTED/i,
  /timeout|timed.?out/i,
  /\b50[23479]\b/,                         // 502/503/504/507/509 server errors
  /rate.?limit|too many requests|\b429\b/i,
  /cold.?start|container.*not.*ready/i,
  /spawn\s*ENOMEM|ENOMEM/i,               // OOM during Docker spawn
  /ENOENT.*\/work\//i,                    // sandbox workspace not yet mounted
  /docker.*(failed to start|not available|cannot connect)/i,
];

const AUTH_PATTERNS = [
  /\b40[13]\b/,
  /unauthorized|forbidden|not authorized/i,
  /invalid.*(token|credential|api.?key)/i,
  /token.*expired|jwt.*expired/i,
  /authentication.*failed|auth.*error/i,
];

const BAD_ARGS_PATTERNS = [
  /\b400\b/,
  /invalid.*(argument|param|input|field)/i,
  /missing.*required|required.*missing/i,
  /TypeError:|ValueError:|SyntaxError:/,
  /validation.*failed|schema.*invalid/i,
];

/**
 * Classify an error message string.
 * Returns `permanent` when no specific pattern matches.
 */
export function classifyError(errorText: string): ErrorClassification {
  if (TRANSIENT_PATTERNS.some((p) => p.test(errorText))) {
    return { category: 'transient', retryable: true, backoffMs: 1200 };
  }
  if (AUTH_PATTERNS.some((p) => p.test(errorText))) {
    return { category: 'auth', retryable: false, backoffMs: 0 };
  }
  if (BAD_ARGS_PATTERNS.some((p) => p.test(errorText))) {
    return { category: 'bad_args', retryable: false, backoffMs: 0 };
  }
  return { category: 'permanent', retryable: false, backoffMs: 0 };
}

/**
 * Tags an `ERROR: <message>` observation with its category.
 * `ERROR: foo` → `ERROR[transient]: foo`
 * Non-error strings are returned unchanged.
 */
export function tagObservationError(observation: string): string {
  if (!observation.startsWith('ERROR:')) return observation;
  const msg = observation.slice(6).trim();
  const { category } = classifyError(msg);
  return `ERROR[${category}]: ${msg}`;
}
