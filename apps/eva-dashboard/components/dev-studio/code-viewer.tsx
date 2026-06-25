'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileCode, GitPullRequest, Folder, Loader2, GitBranch } from 'lucide-react';
import { cn } from '@/lib/utils';
import { devStudioApi } from '@/lib/dev-studio-api';
import type { DevSession, DevMergeProposal, GithubTreeEntry, GithubContent, GithubPrFile } from '@/lib/dev-studio-types';

/**
 * Read-only code viewer: browse the repo file tree per branch and view file
 * contents, plus per-PR diffs. The agents write the code; this is for reviewing.
 */
export function CodeViewer({ session, proposals }: { session: DevSession; proposals: DevMergeProposal[] }) {
  const [view, setView] = useState<'files' | 'diff'>('files');

  const branchOptions = useMemo(() => {
    const set = new Set<string>();
    if (session.integration_branch) set.add(session.integration_branch);
    if (session.base_branch) set.add(session.base_branch);
    proposals.forEach((p) => p.source_branch && set.add(p.source_branch));
    return Array.from(set);
  }, [session, proposals]);

  const [ref, setRef] = useState(session.integration_branch || session.base_branch || 'develop');

  if (!session.repo_url) {
    return (
      <div className="rounded-md border border-white/5 bg-[#0b1224] px-3 py-6 text-center">
        <p className="text-xs text-zinc-600">Conecta un repositorio para ver el código.</p>
      </div>
    );
  }

  const prProposals = proposals.filter((p) => p.pr_number);

  return (
    <div className="rounded-md border border-white/5 bg-[#0b1224] overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-white/5 px-3 py-2">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setView('files')}
            className={cn('flex items-center gap-1 rounded px-2 py-1 text-[11px] font-mono transition-colors',
              view === 'files' ? 'bg-cyan-500/15 text-cyan-300' : 'text-zinc-500 hover:text-zinc-300')}
          >
            <FileCode className="h-3 w-3" /> Archivos
          </button>
          <button
            onClick={() => setView('diff')}
            className={cn('flex items-center gap-1 rounded px-2 py-1 text-[11px] font-mono transition-colors',
              view === 'diff' ? 'bg-cyan-500/15 text-cyan-300' : 'text-zinc-500 hover:text-zinc-300')}
          >
            <GitPullRequest className="h-3 w-3" /> Diffs PR ({prProposals.length})
          </button>
        </div>
        {view === 'files' && (
          <label className="flex items-center gap-1 text-[10px] font-mono text-zinc-500">
            <GitBranch className="h-3 w-3" />
            <select
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              className="bg-zinc-950 border border-zinc-800 rounded px-1.5 py-0.5 text-[11px] text-zinc-300 focus:outline-none"
            >
              {branchOptions.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </label>
        )}
      </div>

      {view === 'files'
        ? <FileBrowser sessionId={session.id} gitRef={ref} />
        : <DiffBrowser proposals={prProposals} />}
    </div>
  );
}

function FileBrowser({ sessionId, gitRef }: { sessionId: string; gitRef: string }) {
  const [tree, setTree] = useState<GithubTreeEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<GithubContent | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setSelected(null);
    setFile(null);
    devStudioApi.repoTree(sessionId, gitRef)
      .then((t) => { if (active) setTree(t); })
      .catch((e) => { if (active) setError((e as Error).message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [sessionId, gitRef]);

  const openFile = useCallback((path: string) => {
    setSelected(path);
    setFileLoading(true);
    setFile(null);
    devStudioApi.repoFile(sessionId, path, gitRef)
      .then(setFile)
      .catch((e) => setFile({ path, encoding: '', content: `// Error: ${(e as Error).message}`, sha: '', size: 0, truncated: false, tooLarge: false }))
      .finally(() => setFileLoading(false));
  }, [sessionId, gitRef]);

  const blobs = useMemo(
    () => tree.filter((e) => e.type === 'blob').sort((a, b) => a.path.localeCompare(b.path)),
    [tree],
  );

  return (
    <div className="grid grid-cols-[minmax(0,11rem)_1fr] h-[22rem]">
      <div className="border-r border-white/5 overflow-auto p-1">
        {loading && <div className="flex items-center gap-1 p-2 text-[11px] text-zinc-600"><Loader2 className="h-3 w-3 animate-spin" /> cargando…</div>}
        {error && <p className="p-2 text-[11px] text-red-400">{error}</p>}
        {!loading && !error && blobs.length === 0 && <p className="p-2 text-[11px] text-zinc-600">Rama vacía.</p>}
        {blobs.map((entry) => {
          const slash = entry.path.lastIndexOf('/');
          const dir = slash >= 0 ? entry.path.slice(0, slash + 1) : '';
          const name = slash >= 0 ? entry.path.slice(slash + 1) : entry.path;
          return (
            <button
              key={entry.path}
              onClick={() => openFile(entry.path)}
              title={entry.path}
              className={cn('flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-[11px] font-mono truncate transition-colors',
                selected === entry.path ? 'bg-cyan-500/15 text-cyan-300' : 'text-zinc-400 hover:bg-white/5')}
            >
              {dir
                ? <span className="text-zinc-700 truncate">{dir}<span className="text-zinc-300">{name}</span></span>
                : <span className="text-zinc-300 truncate">{name}</span>}
            </button>
          );
        })}
      </div>

      <div className="overflow-auto">
        {!selected && <div className="flex h-full items-center justify-center"><p className="text-[11px] text-zinc-600">Selecciona un archivo</p></div>}
        {fileLoading && <div className="flex items-center gap-1 p-3 text-[11px] text-zinc-600"><Loader2 className="h-3 w-3 animate-spin" /> cargando archivo…</div>}
        {file && !fileLoading && (
          file.tooLarge
            ? <p className="p-3 text-[11px] text-zinc-600">Archivo demasiado grande o binario ({file.size} bytes) — no se muestra.</p>
            : <CodeBlock content={file.content} />
        )}
      </div>
    </div>
  );
}

function CodeBlock({ content }: { content: string }) {
  const lines = content.split('\n');
  return (
    <pre className="text-[11px] leading-relaxed font-mono text-zinc-300 p-2 min-w-full">
      {lines.map((line, i) => (
        <div key={i} className="flex">
          <span className="select-none text-right pr-3 text-zinc-700 w-10 shrink-0">{i + 1}</span>
          <span className="whitespace-pre-wrap break-all">{line || ' '}</span>
        </div>
      ))}
    </pre>
  );
}

function DiffBrowser({ proposals }: { proposals: DevMergeProposal[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(proposals[0]?.id ?? null);
  const [files, setFiles] = useState<GithubPrFile[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    setLoading(true);
    setFiles([]);
    devStudioApi.mergeProposalFiles(selectedId)
      .then((f) => { if (active) setFiles(f); })
      .catch(() => { if (active) setFiles([]); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [selectedId]);

  if (proposals.length === 0) {
    return <div className="flex h-[22rem] items-center justify-center"><p className="text-[11px] text-zinc-600">Aún no hay Pull Requests.</p></div>;
  }

  return (
    <div className="grid grid-cols-[minmax(0,12rem)_1fr] h-[22rem]">
      <div className="border-r border-white/5 overflow-auto p-1">
        {proposals.map((p) => (
          <button
            key={p.id}
            onClick={() => setSelectedId(p.id)}
            className={cn('flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left transition-colors',
              selectedId === p.id ? 'bg-cyan-500/15' : 'hover:bg-white/5')}
          >
            <span className="text-[11px] font-mono text-zinc-300">PR #{p.pr_number}{p.kind === 'release' ? ' · release' : ''}</span>
            <span className="text-[10px] font-mono text-zinc-600 truncate max-w-full">{p.source_branch} → {p.target_branch}</span>
            <span className={cn('text-[9px] font-mono',
              p.status === 'merged' ? 'text-emerald-400' : p.status === 'rejected' ? 'text-red-400' : 'text-amber-400')}>{p.status}</span>
          </button>
        ))}
      </div>
      <div className="overflow-auto">
        {loading && <div className="flex items-center gap-1 p-3 text-[11px] text-zinc-600"><Loader2 className="h-3 w-3 animate-spin" /> cargando diff…</div>}
        {!loading && files.length === 0 && <div className="flex h-full items-center justify-center"><p className="text-[11px] text-zinc-600">Sin archivos en el diff.</p></div>}
        {!loading && files.map((f) => (
          <div key={f.filename} className="border-b border-white/5">
            <div className="flex items-center gap-2 px-2 py-1 bg-white/[0.02] sticky top-0">
              <Folder className="h-3 w-3 text-zinc-600 shrink-0" />
              <span className="text-[11px] font-mono text-zinc-300 truncate">{f.filename}</span>
              <span className="text-[10px] font-mono text-emerald-400 ml-auto shrink-0">+{f.additions}</span>
              <span className="text-[10px] font-mono text-red-400 shrink-0">-{f.deletions}</span>
            </div>
            {f.patch && <Patch patch={f.patch} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function Patch({ patch }: { patch: string }) {
  return (
    <pre className="text-[10.5px] leading-relaxed font-mono p-1 overflow-x-auto">
      {patch.split('\n').map((line, i) => {
        const c = line[0];
        const color = c === '+' ? 'text-emerald-400 bg-emerald-500/5'
          : c === '-' ? 'text-red-400 bg-red-500/5'
          : c === '@' ? 'text-cyan-400' : 'text-zinc-500';
        return <div key={i} className={cn('whitespace-pre-wrap break-all px-1', color)}>{line || ' '}</div>;
      })}
    </pre>
  );
}
