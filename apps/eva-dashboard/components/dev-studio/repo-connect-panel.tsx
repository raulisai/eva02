'use client';

import { useEffect, useState } from 'react';
import { Github, GitBranch, ExternalLink, Check, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { devStudioApi } from '@/lib/dev-studio-api';
import type { DevSession, GithubStatus } from '@/lib/dev-studio-types';

/**
 * Connect an existing GitHub repo (by URL) or create a new one, then bind it to
 * the session. Surfaces the org-level GitHub connection status and points the
 * user to Integrations › Credentials when no token is set.
 */
export function RepoConnectPanel({ session, onConnected }: { session: DevSession; onConnected?: () => void }) {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [mode, setMode] = useState<'existing' | 'create'>('existing');
  const [repoUrl, setRepoUrl] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    devStudioApi.githubStatus().then(setStatus).catch(() => setStatus({ connected: false }));
  }, []);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'existing') {
        await devStudioApi.connectRepo(session.id, { repoUrl: repoUrl.trim() });
      } else {
        await devStudioApi.connectRepo(session.id, { create: true, name: name.trim() || undefined, private: true });
      }
      onConnected?.();
    } catch (e) {
      setError((e as Error).message || 'No se pudo conectar el repo');
    } finally {
      setBusy(false);
    }
  }

  // Already connected to a repo → compact summary.
  if (session.repo_url) {
    return (
      <div className="rounded-md border border-white/5 bg-[#0b1224] px-3 py-2.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Github className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
          <a
            href={session.repo_url}
            target="_blank"
            rel="noreferrer"
            className="text-xs font-mono text-cyan-400 hover:underline truncate"
          >
            {session.repo_owner && session.repo_name ? `${session.repo_owner}/${session.repo_name}` : session.repo_url}
          </a>
          <ExternalLink className="h-3 w-3 text-zinc-600 shrink-0" />
        </div>
        <span className="flex items-center gap-1 text-[10px] font-mono text-zinc-500 shrink-0">
          <GitBranch className="h-3 w-3" />
          {session.base_branch} · {session.integration_branch ?? 'develop'}
        </span>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-3 space-y-2.5">
      <div className="flex items-center gap-2">
        <Github className="h-3.5 w-3.5 text-amber-400" />
        <span className="text-[10px] font-mono uppercase tracking-widest text-amber-400">Conectar repositorio</span>
      </div>

      {status && !status.connected && (
        <div className="flex items-start gap-2 rounded border border-amber-500/20 bg-amber-500/10 px-2 py-1.5">
          <AlertCircle className="h-3.5 w-3.5 text-amber-400 shrink-0 mt-0.5" />
          <p className="text-[11px] text-amber-200/80">
            No hay token de GitHub conectado. Agrégalo en{' '}
            <a href="/settings" className="underline">Integraciones › Credenciales › GitHub</a>{' '}
            (necesita permisos <span className="font-mono">contents:write</span> y{' '}
            <span className="font-mono">pull_requests:write</span>).
          </p>
        </div>
      )}
      {status?.connected && (
        <p className="flex items-center gap-1 text-[10px] font-mono text-emerald-400">
          <Check className="h-3 w-3" /> Conectado como {status.login}
        </p>
      )}

      <div className="flex gap-1">
        {(['existing', 'create'] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={cn(
              'flex-1 rounded px-2 py-1 text-[11px] font-mono transition-colors',
              mode === m ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30' : 'text-zinc-500 hover:text-zinc-300 border border-transparent',
            )}
          >
            {m === 'existing' ? 'Repo existente' : 'Crear nuevo'}
          </button>
        ))}
      </div>

      {mode === 'existing' ? (
        <input
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
          placeholder="https://github.com/owner/repo"
          className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs font-mono text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
        />
      ) : (
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="nombre-del-repo (opcional, se deriva del título)"
          className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs font-mono text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
        />
      )}

      {error && <p className="text-[11px] text-red-400">{error}</p>}

      <button
        onClick={connect}
        disabled={busy || (mode === 'existing' && !repoUrl.trim())}
        className="w-full rounded border border-cyan-500/30 bg-cyan-500/10 py-1.5 text-xs font-mono text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-40 transition-colors"
      >
        {busy ? 'Conectando…' : mode === 'existing' ? 'Conectar repo' : 'Crear y conectar repo'}
      </button>
    </div>
  );
}
