'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Inbox, BrainCircuit, Cog, ShieldCheck, Flag, Send, Loader2,
  ChevronRight, AlertTriangle,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { coreFetch } from '@/lib/core-api';
import { useTaskEvents, useLiveStatus } from '@/hooks/use-ws';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { StatusBadge } from '@/components/tasks/status-badge';
import { cn, age, shortId } from '@/lib/utils';
import type { Task, TaskStatus } from '@/lib/types';

const STAGES = [
  { key: 'pending',              label: 'Received',  icon: Inbox },
  { key: 'planning',             label: 'Planning',  icon: BrainCircuit },
  { key: 'running',              label: 'Executing', icon: Cog },
  { key: 'waiting_for_approval', label: 'Approval',  icon: ShieldCheck },
  { key: 'done',                 label: 'Done',      icon: Flag },
] as const;

/** Index of the active pipeline stage for a task status. */
function stageIndex(status: TaskStatus): number {
  switch (status) {
    case 'pending': return 0;
    case 'planning': return 1;
    case 'running': return 2;
    case 'waiting_for_approval': return 3;
    default: return 4; // completed | failed | cancelled
  }
}

const STUCK_WARN_MS = 60_000;
const STUCK_ALERT_MS = 5 * 60_000;

export function PlaygroundClient() {
  const [order, setOrder] = useState('');
  const [task, setTask] = useState<Task | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stageSince, setStageSince] = useState<number>(Date.now());
  const [now, setNow] = useState(Date.now());

  const liveStatus = useLiveStatus(task?.id ?? '');
  const events = useTaskEvents(task?.id ?? '');
  const status: TaskStatus = liveStatus ?? task?.status ?? 'pending';
  const prevStatus = useRef<TaskStatus | null>(null);

  // When task.completed WS event arrives, patch the task result immediately.
  useEffect(() => {
    if (!task) return;
    const completed = events.find(
      e => e.type === 'task.completed' && e.taskId === task.id,
    );
    if (completed) {
      const text = (completed.payload as Record<string, unknown>)['result'] as string | undefined;
      if (text) setTask(prev => prev ? { ...prev, result: { text } } : prev);
    }
  }, [events, task]);

  // Track how long the task has been sitting in the current stage.
  useEffect(() => {
    if (status !== prevStatus.current) {
      prevStatus.current = status;
      setStageSince(Date.now());
    }
  }, [status]);

  // Tick for the stuck timer + poll Supabase as fallback when WS misses events.
  useEffect(() => {
    if (!task || stageIndex(status) === 4) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(async () => {
      const supabase = createClient();
      const { data } = await supabase.from('tasks').select('*').eq('id', task.id).maybeSingle();
      if (data) setTask(data as Task);
    }, 5000);
    return () => { clearInterval(tick); clearInterval(poll); };
  }, [task, status]);

  const msInStage = now - stageSince;
  const active = task ? stageIndex(status) : -1;
  const terminalVariant = status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'cancelled';

  // Chronological view of what EVA says and does (events arrive newest-first).
  const chronological = useMemo(() => [...events].reverse(), [events]);
  const sayMessages = chronological
    .filter((event) => event.type === 'task.say')
    .map((event) => ({ ts: event.ts, text: String((event.payload as Record<string, unknown>)['text'] ?? '') }));
  const resultEvent = chronological.find((event) => event.type === 'task.result');
  const resultText = resultEvent
    ? String((resultEvent.payload as Record<string, unknown>)['text'] ?? '')
    : (task?.result as Record<string, unknown> | null)?.['text'] as string | undefined;
  const resultMeta = resultEvent?.payload as { model?: string; latency_ms?: number } | undefined;
  const actionLog = chronological.filter((event) =>
    event.type === 'task.log' || event.type.startsWith('task.') && ['task.created', 'task.started', 'task.completed', 'task.failed', 'task.waiting_approval'].includes(event.type));
  const isWorking = task !== null && active >= 0 && active < 4 && !resultText;

  const logEndRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [actionLog.length]);

  const stuck = useMemo(() => {
    if (!task || active === 4) return null;
    if (msInStage > STUCK_ALERT_MS) return 'alert';
    if (msInStage > STUCK_WARN_MS) return 'warn';
    return null;
  }, [task, active, msInStage]);

  async function submit() {
    if (!order.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await coreFetch<Task>('/tasks', {
        method: 'POST',
        body: JSON.stringify({
          title: order.length > 80 ? `${order.slice(0, 77)}...` : order,
          description: order,
          metadata: { source: 'playground' },
        }),
      });
      setTask(created);
      setStageSince(Date.now());
      prevStatus.current = created.status;
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Order input */}
      <div className="px-4 py-3 border-b border-zinc-800 flex gap-2">
        <input
          value={order}
          onChange={(event) => setOrder(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && !busy && submit()}
          placeholder="Type an order for EVA… e.g. 'Resume mis notificaciones de hoy'"
          aria-label="Order"
          className="flex-1 bg-zinc-900 border border-zinc-700 rounded-sm px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/60"
        />
        <Button onClick={submit} disabled={busy || !order.trim()}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
          Run
        </Button>
      </div>

      {error && (
        <p className="px-4 py-2 text-xs font-mono text-red-400 border-b border-zinc-800 break-all">{error}</p>
      )}

      {!task && !error && (
        <div className="flex-1 flex items-center justify-center text-xs font-mono text-zinc-600">
          Submit an order to watch it flow through the EVA pipeline
        </div>
      )}

      {task && (
        <ScrollArea className="flex-1">
          <div className="p-6 space-y-6">
            {/* Header */}
            <div className="flex items-center gap-3">
              <span className="font-mono text-xs text-zinc-400">{shortId(task.id)}</span>
              <StatusBadge status={status} />
              <span className="text-xs text-zinc-500 truncate flex-1">{task.title}</span>
              <span className="text-[10px] font-mono text-zinc-600">created {age(task.created_at)} ago</span>
            </div>

            {/* Pipeline diagram */}
            <div className="flex items-stretch gap-0" data-testid="pipeline">
              {STAGES.map(({ key, label, icon: Icon }, index) => {
                const isActive = index === active && active !== 4;
                const isDone = index < active || active === 4;
                const isTerminal = index === 4 && active === 4;
                return (
                  <div key={key} className="flex items-center flex-1 min-w-0">
                    <div
                      className={cn(
                        'flex-1 border rounded-sm px-3 py-4 text-center transition-all relative',
                        isActive && stuck === 'alert' && 'border-red-500/60 bg-red-500/10',
                        isActive && stuck === 'warn' && 'border-amber-500/60 bg-amber-500/10',
                        isActive && !stuck && 'border-cyan-500/60 bg-cyan-500/10 shadow-[0_0_12px_rgba(34,211,238,0.15)]',
                        !isActive && isDone && !isTerminal && 'border-emerald-500/30 bg-emerald-500/5',
                        isTerminal && status === 'completed' && 'border-emerald-500/60 bg-emerald-500/10',
                        isTerminal && status !== 'completed' && 'border-red-500/60 bg-red-500/10',
                        !isActive && !isDone && 'border-zinc-800 opacity-50',
                      )}
                    >
                      <Icon className={cn(
                        'w-4 h-4 mx-auto mb-1.5',
                        isActive ? 'text-cyan-300 animate-pulse' : isDone ? 'text-emerald-400' : 'text-zinc-600',
                        isActive && stuck && 'text-amber-300',
                      )} />
                      <div className={cn(
                        'text-[10px] font-mono uppercase tracking-wider',
                        isActive ? 'text-zinc-100' : 'text-zinc-500',
                      )}>
                        {label}
                      </div>
                      {isActive && (
                        <div className={cn(
                          'text-[10px] font-mono mt-1',
                          stuck === 'alert' ? 'text-red-400' : stuck === 'warn' ? 'text-amber-400' : 'text-cyan-400',
                        )}>
                          {Math.floor(msInStage / 1000)}s
                        </div>
                      )}
                      {isTerminal && (
                        <div className="mt-1 flex justify-center">
                          <Badge variant={terminalVariant}>{status}</Badge>
                        </div>
                      )}
                    </div>
                    {index < STAGES.length - 1 && (
                      <ChevronRight className={cn(
                        'w-4 h-4 flex-shrink-0 mx-1',
                        index < active ? 'text-emerald-500' : 'text-zinc-700',
                      )} />
                    )}
                  </div>
                );
              })}
            </div>

            {stuck && (
              <div className={cn(
                'flex items-center gap-2 text-xs font-mono border rounded-sm px-3 py-2',
                stuck === 'alert' ? 'border-red-500/40 text-red-400' : 'border-amber-500/40 text-amber-400',
              )}>
                <AlertTriangle className="w-3.5 h-3.5" />
                Task has been in “{STAGES[active]?.label}” for {Math.floor(msInStage / 1000)}s —
                {stuck === 'alert' ? ' likely stuck. Check eva-core logs / approvals.' : ' keep an eye on it.'}
              </div>
            )}

            {task.error && (
              <p className="text-xs font-mono text-red-400 border border-red-500/30 rounded-sm px-3 py-2 break-all">
                {task.error}
              </p>
            )}

            {/* Conversation — what EVA says while she works */}
            <section className="space-y-2" data-testid="conversation">
              <h3 className="text-[10px] font-mono uppercase tracking-widest text-zinc-600">Conversation</h3>

              {/* User order */}
              <div className="flex justify-end">
                <div className="max-w-[80%] border border-zinc-700 bg-zinc-800/60 rounded-sm px-3 py-2 text-xs text-zinc-200">
                  {task.description ?? task.title}
                </div>
              </div>

              {/* EVA instant acknowledgments */}
              {sayMessages.map((message, index) => (
                <div key={`say-${message.ts}-${index}`} className="flex justify-start animate-slide-up">
                  <div className="max-w-[80%] border border-cyan-500/30 bg-cyan-500/5 rounded-sm px-3 py-2 text-xs text-cyan-100">
                    {message.text}
                  </div>
                </div>
              ))}

              {/* Typing indicator while working */}
              {isWorking && (
                <div className="flex justify-start">
                  <div className="border border-zinc-800 rounded-sm px-3 py-2 inline-flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                    <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse [animation-delay:150ms]" />
                    <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse [animation-delay:300ms]" />
                    <span className="text-[10px] font-mono text-zinc-500 ml-1.5">EVA está trabajando…</span>
                  </div>
                </div>
              )}

              {/* Final answer */}
              {resultText && (
                <div className="flex justify-start animate-slide-up">
                  <div className="max-w-[85%] border border-emerald-500/30 bg-emerald-500/5 rounded-sm px-3 py-2 space-y-1.5">
                    <p className="text-xs text-zinc-100 whitespace-pre-wrap leading-relaxed">{resultText}</p>
                    {resultMeta?.model && (
                      <p className="text-[9px] font-mono text-zinc-600">
                        {resultMeta.model} · {resultMeta.latency_ms}ms
                      </p>
                    )}
                  </div>
                </div>
              )}
            </section>

            {/* Transparent action log — every step EVA takes, live */}
            <section className="space-y-2" data-testid="action-log">
              <h3 className="text-[10px] font-mono uppercase tracking-widest text-zinc-600">
                Action log · {actionLog.length} entries
              </h3>
              <div className="border border-zinc-800 rounded-sm bg-zinc-950/80 max-h-72 overflow-y-auto font-mono text-[11px]">
                {actionLog.length === 0 && (
                  <p className="px-3 py-3 text-zinc-600">Waiting for the agent to start…</p>
                )}
                {actionLog.map((event, index) => {
                  const payload = event.payload as { message?: string; scope?: string; status?: string; error?: string };
                  const isLog = event.type === 'task.log';
                  const isError = Boolean(payload.error) || payload.message?.startsWith('ERROR');
                  return (
                    <div
                      key={`${event.type}-${event.ts}-${index}`}
                      className="flex items-start gap-2 px-3 py-1 border-b border-zinc-800/40 animate-fade-in"
                    >
                      <span className="text-zinc-600 flex-shrink-0">
                        {new Date(event.ts).toLocaleTimeString()}
                      </span>
                      <span className={cn(
                        'flex-shrink-0 uppercase tracking-wider text-[9px] mt-0.5 px-1 rounded-sm border',
                        isError ? 'text-red-400 border-red-500/40' :
                          isLog ? 'text-cyan-400 border-cyan-500/30' : 'text-amber-400 border-amber-500/30',
                      )}>
                        {isLog ? (payload.scope ?? 'log') : event.type.replace('task.', '')}
                      </span>
                      <span className={cn('break-all', isError ? 'text-red-300' : 'text-zinc-300')}>
                        {payload.message ?? payload.error ?? (payload.status ? `status → ${payload.status}` : JSON.stringify(event.payload))}
                      </span>
                    </div>
                  );
                })}
                <div ref={logEndRef} />
              </div>
            </section>
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
