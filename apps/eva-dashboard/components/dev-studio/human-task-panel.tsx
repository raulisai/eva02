'use client';

import { useState } from 'react';
import { AlertTriangle, CheckCircle, Eye, EyeOff, ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DevHumanTask } from '@/lib/dev-studio-types';
import { devStudioApi } from '@/lib/dev-studio-api';
import { ClaudeCodeAuthPanel } from './claude-code-auth-panel';

interface HumanTaskPanelProps {
  tasks: DevHumanTask[];
  onUpdated?: () => void;
}

export function HumanTaskPanel({ tasks, onUpdated }: HumanTaskPanelProps) {
  if (tasks.length === 0) return null;
  const pending = tasks.filter((t) => ['pending', 'waiting_user'].includes(t.status));
  const submitted = tasks.filter((t) => t.status === 'submitted');

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-3.5 w-3.5 text-orange-400" />
        <span className="text-[10px] font-mono uppercase tracking-widest text-orange-400">
          Tareas pendientes ({pending.length + submitted.length})
        </span>
      </div>
      {[...pending, ...submitted].map((task) =>
        task.instructions?.kind === 'claude_code_auth' ? (
          <ClaudeCodeAuthPanel key={task.id} task={task} onUpdated={onUpdated} />
        ) : (
          <HumanTaskCard key={task.id} task={task} onUpdated={onUpdated} />
        ),
      )}
    </div>
  );
}

function HumanTaskCard({ task, onUpdated }: { task: DevHumanTask; onUpdated?: () => void }) {
  const [expanded, setExpanded] = useState(true);
  const [result, setResult] = useState('');
  const [showSensitive, setShowSensitive] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit() {
    if (!result.trim()) return;
    setLoading(true);
    try {
      await devStudioApi.submitHumanTask(task.id, { value: result }, result);
      await devStudioApi.verifyHumanTask(task.id);
      onUpdated?.();
    } finally { setLoading(false); }
  }

  const isSubmitted = task.status === 'submitted';

  return (
    <div className={cn(
      'rounded-md border px-3 py-2.5 space-y-2',
      task.sensitive ? 'border-orange-500/20 bg-orange-500/5' : 'border-amber-500/20 bg-amber-500/5',
    )}>
      <div className="flex items-start gap-2 cursor-pointer" onClick={() => setExpanded((e) => !e)}>
        <span className="text-zinc-700 mt-0.5">
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-zinc-200">{task.title}</span>
            {task.sensitive && (
              <span className="text-[10px] font-mono border border-orange-500/30 text-orange-400 px-1.5 py-0.5 rounded">sensible</span>
            )}
            {isSubmitted && (
              <span className="text-[10px] font-mono border border-zinc-700 text-zinc-500 px-1.5 py-0.5 rounded">enviado</span>
            )}
          </div>
          {task.required_output && (
            <p className="text-[10px] text-zinc-600 mt-0.5">Necesita: {task.required_output}</p>
          )}
        </div>
      </div>

      {expanded && (
        <>
          {task.description && <p className="text-xs text-zinc-500 pl-5">{task.description}</p>}

          {!isSubmitted && (
            <div className="space-y-2 pl-5">
              <div className="relative">
                <textarea
                  value={result}
                  onChange={(e) => setResult(e.target.value)}
                  placeholder={task.sensitive ? '(valor sensible)' : 'Escribe tu respuesta…'}
                  rows={3}
                  className="w-full rounded border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-700 resize-none focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
                  style={task.sensitive && !showSensitive ? { WebkitTextSecurity: 'disc' } as React.CSSProperties : undefined}
                />
                {task.sensitive && (
                  <button type="button" onClick={() => setShowSensitive((s) => !s)}
                    className="absolute right-2 top-2 text-zinc-700 hover:text-zinc-400">
                    {showSensitive ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                )}
              </div>
              <div className="flex items-center justify-end">
                <button onClick={handleSubmit} disabled={loading || !result.trim()}
                  className="rounded border border-cyan-500/20 bg-cyan-500/10 px-3 py-1.5 text-xs font-mono text-cyan-400 hover:bg-cyan-500/20 disabled:opacity-40 transition-colors">
                  {loading ? '…' : 'Entregar y desbloquear'}
                </button>
              </div>
            </div>
          )}

          {isSubmitted && (
            <div className="flex items-center gap-2 text-xs text-zinc-500 pl-5">
              <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />
              Enviado — esperando verificación
            </div>
          )}
        </>
      )}
    </div>
  );
}
