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
  return res.json() as Promise<T>;
}
