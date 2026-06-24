'use client';

import { createClient } from '@/lib/supabase/client';

/**
 * Authenticated fetch against eva-core. Secrets are only ever SENT here —
 * reads come back masked (secret_hint / has_secret).
 */
export async function coreFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('Missing session');

  const base = process.env.NEXT_PUBLIC_EVA_CORE_URL ?? 'http://localhost:3000';
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(body || `Request failed: ${res.status}`);
  }

  // Successful mutations may legitimately return 204 or an empty body. Calling
  // Response.json() in those cases throws "Unexpected end of JSON input" and
  // turns a successful backend action into a dashboard runtime error.
  if (res.status === 204 || res.headers.get('content-length') === '0') {
    return undefined as T;
  }

  const body = await res.text();
  if (!body.trim()) return undefined as T;

  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`Invalid JSON response from EVA Core (${res.status})`);
  }
}
