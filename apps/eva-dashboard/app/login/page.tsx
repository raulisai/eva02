'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const supabase = createClient();
      const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
      if (authError) { setError(authError.message); return; }
      router.replace('/tasks');
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950 px-4">
      {/* Background grid */}
      <div
        className="fixed inset-0 opacity-[0.03] pointer-events-none"
        style={{ backgroundImage: 'linear-gradient(#22d3ee 1px,transparent 1px),linear-gradient(90deg,#22d3ee 1px,transparent 1px)', backgroundSize: '40px 40px' }}
      />

      <div className="relative w-full max-w-sm">
        {/* Logo */}
        <div className="mb-10 text-center">
          <div className="inline-flex items-center gap-2 mb-3">
            <div className="w-8 h-8 rounded bg-cyan-500/20 border border-cyan-500/40 flex items-center justify-center">
              <span className="text-cyan-400 text-sm font-bold font-mono">E</span>
            </div>
            <span className="text-xl font-semibold tracking-wide text-zinc-100">EVA</span>
          </div>
          <p className="text-xs text-zinc-500 font-mono tracking-widest uppercase">Command Center</p>
        </div>

        {/* Form */}
        <form
          onSubmit={handleSubmit}
          className="panel p-6 space-y-4"
          data-testid="login-form"
        >
          <div className="space-y-1">
            <label htmlFor="email" className="block text-xs font-medium text-zinc-400 uppercase tracking-wider">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoComplete="email"
              className="w-full bg-zinc-950 border border-zinc-700 rounded-sm px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-cyan-500/60 focus:ring-1 focus:ring-cyan-500/20 transition-colors font-mono"
              placeholder="operator@eva.io"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="password" className="block text-xs font-medium text-zinc-400 uppercase tracking-wider">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              className="w-full bg-zinc-950 border border-zinc-700 rounded-sm px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-cyan-500/60 focus:ring-1 focus:ring-cyan-500/20 transition-colors font-mono"
              placeholder="••••••••"
            />
          </div>

          {error && (
            <p className="text-xs text-red-400 font-mono border border-red-500/20 bg-red-500/5 rounded-sm px-3 py-2" role="alert">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2 px-4 rounded-sm text-sm font-medium bg-cyan-500/20 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/30 hover:border-cyan-500/60 disabled:opacity-50 disabled:cursor-not-allowed transition-all focus:outline-none focus:ring-2 focus:ring-cyan-500/30"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-3 h-3 border border-cyan-400/40 border-t-cyan-400 rounded-full animate-spin" />
                Authenticating…
              </span>
            ) : 'Sign in'}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-zinc-600 font-mono">
          EVA v0.1 · Restricted access
        </p>
      </div>
    </div>
  );
}
