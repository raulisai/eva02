'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Inbox, BrainCircuit, Cog, ShieldCheck, Flag, Send, Loader2,
  ChevronRight, AlertTriangle, Clock, ClipboardList,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { coreFetch } from '@/lib/core-api';
import { useWs } from '@/hooks/use-ws';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { StatusBadge } from '@/components/tasks/status-badge';
import { cn, shortId } from '@/lib/utils';
import type { EvaEvent, Task, TaskStatus } from '@/lib/types';

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

const TERMINAL: TaskStatus[] = ['completed', 'failed', 'cancelled'];
const STUCK_WARN_MS = 60_000;
const STUCK_ALERT_MS = 5 * 60_000;

interface SessionEntry {
  task: Task;
  order: string;
}

interface ConversationContextTurn {
  role: 'user' | 'assistant';
  text: string;
}

export function PlaygroundClient() {
  const { events, taskPatches } = useWs();
  const [order, setOrder] = useState('');
  const [session, setSession] = useState<SessionEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const statusOf = (entry: SessionEntry): TaskStatus =>
    taskPatches[entry.task.id] ?? entry.task.status;

  const selected = session.find((entry) => entry.task.id === selectedId) ?? session[session.length - 1] ?? null;
  const selectedStatus: TaskStatus = selected ? statusOf(selected) : 'pending';

  // Per-task event slices (chronological — events arrive newest-first)
  const chronological = useMemo(() => [...events].reverse(), [events]);
  const eventsFor = (taskId: string) => chronological.filter((event) => event.taskId === taskId);

  // Poll non-terminal session tasks as fallback when WS misses events
  useEffect(() => {
    const pending = session.filter((entry) => !TERMINAL.includes(statusOf(entry)));
    if (pending.length === 0) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(async () => {
      const supabase = createClient();
      for (const entry of pending) {
        const { data } = await supabase
          .from('tasks')
          .select('*')
          .eq('id', entry.task.id)
          .eq('org_id', entry.task.org_id)
          .maybeSingle();
        if (data) {
          setSession((prev) => prev.map((item) => item.task.id === entry.task.id ? { ...item, task: data as Task } : item));
        }
      }
    }, 5000);
    return () => { clearInterval(tick); clearInterval(poll); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.map((entry) => `${entry.task.id}:${statusOf(entry)}`).join(',')]);

  // Auto-scroll conversation + action log on new content
  const conversationEndRef = useRef<HTMLDivElement | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    conversationEndRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    logEndRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  }, [events.length, session.length]);

  async function submit() {
    if (!order.trim() || busy) return;
    const text = order.trim();
    const conversationContext = buildConversationContext(session, chronological);
    setBusy(true);
    setError(null);
    try {
      const created = await coreFetch<Task>('/tasks', {
        method: 'POST',
        body: JSON.stringify({
          title: text.length > 80 ? `${text.slice(0, 77)}...` : text,
          description: text,
          metadata: { source: 'playground', conversation_context: conversationContext },
        }),
      });
      setSession((prev) => [...prev, { task: created, order: text }]);
      setSelectedId(created.id);
      setOrder('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Stuck detection for the selected task (time since its last event)
  const selectedEvents = selected ? eventsFor(selected.task.id) : [];
  const lastEventTs = selectedEvents.length > 0
    ? selectedEvents[selectedEvents.length - 1].ts
    : selected ? new Date(selected.task.created_at).getTime() : now;
  const msInStage = now - lastEventTs;
  const active = selected ? stageIndex(selectedStatus) : -1;
  const stuck = selected && active < 4
    ? (msInStage > STUCK_ALERT_MS ? 'alert' : msInStage > STUCK_WARN_MS ? 'warn' : null)
    : null;
  const terminalVariant = selectedStatus === 'completed' ? 'completed' : selectedStatus === 'failed' ? 'failed' : 'cancelled';

  const actionLog = selectedEvents.filter((event) =>
    ['task.log', 'task.created', 'task.started', 'task.completed', 'task.failed', 'task.waiting_approval', 'task.form_request'].includes(event.type));

  return (
    <div className="flex flex-col h-full">
      {/* Order input — always free: long tasks run in background */}
      <div className="px-4 py-3 border-b border-zinc-800 flex gap-2">
        <input
          value={order}
          onChange={(event) => setOrder(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && submit()}
          placeholder="Habla con EVA… 'hola' responde al instante, las tareas largas siguen en segundo plano"
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

      {session.length === 0 && !error && (
        <div className="flex-1 flex items-center justify-center text-xs font-mono text-zinc-600">
          Submit an order to watch it flow through the EVA pipeline
        </div>
      )}

      {session.length > 0 && (
        <ScrollArea className="flex-1">
          <div className="p-6 space-y-6">
            {/* Conversation — every order in this session */}
            <section className="space-y-3" data-testid="conversation">
              <h3 className="text-[10px] font-mono uppercase tracking-widest text-zinc-600">Conversation</h3>
              {session.map((entry) => (
                <ConversationGroup
                  key={entry.task.id}
                  entry={entry}
                  status={statusOf(entry)}
                  events={eventsFor(entry.task.id)}
                  selected={selected?.task.id === entry.task.id}
                  onSelect={() => setSelectedId(entry.task.id)}
                />
              ))}
              <div ref={conversationEndRef} />
            </section>

            {selected && (
              <>
                {/* Pipeline diagram for the selected order */}
                <section className="space-y-2">
                  <div className="flex items-center gap-2">
                    <h3 className="text-[10px] font-mono uppercase tracking-widest text-zinc-600">Pipeline</h3>
                    <span className="font-mono text-[10px] text-zinc-500">{shortId(selected.task.id)}</span>
                    <StatusBadge status={selectedStatus} />
                  </div>
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
                              isTerminal && selectedStatus === 'completed' && 'border-emerald-500/60 bg-emerald-500/10',
                              isTerminal && selectedStatus !== 'completed' && 'border-red-500/60 bg-red-500/10',
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
                            {isTerminal && (
                              <div className="mt-1 flex justify-center">
                                <Badge variant={terminalVariant}>{selectedStatus}</Badge>
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
                      Sin actividad hace {Math.floor(msInStage / 1000)}s en “{STAGES[active]?.label}” —
                      {stuck === 'alert' ? ' posible atasco: revisa logs de eva-core / approvals.' : ' vigílalo.'}
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
              </>
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

function buildConversationContext(session: SessionEntry[], chronological: EvaEvent[]): ConversationContextTurn[] {
  const turns = session.slice(-4).flatMap((entry): ConversationContextTurn[] => {
    const taskEvents = chronological.filter((event) => event.taskId === entry.task.id);
    const resultEvent = taskEvents.find((event) => event.type === 'task.result');
    const resultText = resultEvent
      ? String((resultEvent.payload as Record<string, unknown>)['text'] ?? '')
      : (entry.task.result as Record<string, unknown> | null)?.['text'] as string | undefined;

    return [
      { role: 'user', text: entry.order },
      ...(resultText ? [{ role: 'assistant' as const, text: resultText }] : []),
    ];
  });

  return turns
    .map((turn) => ({ ...turn, text: turn.text.trim().slice(0, 1200) }))
    .filter((turn) => turn.text.length > 0)
    .slice(-8);
}

/** One order + EVA's bubbles (acks, media, result) for a session task. */
function ConversationGroup({ entry, status, events, selected, onSelect }: {
  entry: SessionEntry;
  status: TaskStatus;
  events: EvaEvent[];
  selected: boolean;
  onSelect: () => void;
}) {
  const says = events
    .filter((event) => event.type === 'task.say')
    .map((event) => String((event.payload as Record<string, unknown>)['text'] ?? ''));
  const resultEvent = events.find((event) => event.type === 'task.result');
  const resultText = resultEvent
    ? String((resultEvent.payload as Record<string, unknown>)['text'] ?? '')
    : (entry.task.result as Record<string, unknown> | null)?.['text'] as string | undefined;
  const resultMeta = resultEvent?.payload as { model?: string; latency_ms?: number } | undefined;
  const mediaEvents = events.filter((event) => event.type === 'task.media');
  const formEvents = events.filter((event) => event.type === 'task.form_request');
  const working = !TERMINAL.includes(status) && !resultText;
  const failed = status === 'failed';

  return (
    <div
      onClick={onSelect}
      className={cn(
        'space-y-2 rounded-sm p-2 -m-2 cursor-pointer transition-colors',
        selected ? 'bg-zinc-900/40 ring-1 ring-zinc-800' : 'hover:bg-zinc-900/20',
      )}
    >
      {/* User order */}
      <div className="flex justify-end items-start gap-2">
        {working && (
          <Badge variant="running">
            <Clock className="w-2.5 h-2.5" />
            en segundo plano
          </Badge>
        )}
        <div className="max-w-[80%] border border-zinc-700 bg-zinc-800/60 rounded-sm px-3 py-2 text-xs text-zinc-200">
          {entry.order}
        </div>
      </div>

      {/* EVA instant acknowledgments */}
      {says.map((text, index) => (
        <div key={`say-${index}`} className="flex justify-start animate-slide-up">
          <div className="max-w-[80%] border border-cyan-500/30 bg-cyan-500/5 rounded-sm px-3 py-2 text-xs text-cyan-100">
            {text}
          </div>
        </div>
      ))}

      {/* Typing indicator while working */}
      {working && (
        <div className="flex justify-start">
          <div className="border border-zinc-800 rounded-sm px-3 py-2 inline-flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse [animation-delay:150ms]" />
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse [animation-delay:300ms]" />
            <span className="text-[10px] font-mono text-zinc-500 ml-1.5">EVA está trabajando…</span>
          </div>
        </div>
      )}

      {/* Media attachments from the eva-media bucket */}
      {mediaEvents.map((event, index) => {
        const payload = event.payload as { kind?: string; url?: string };
        if (!payload.url) return null;
        return (
          <div key={`media-${index}`} className="flex justify-start animate-slide-up">
            <div className="max-w-[70%] border border-violet-500/30 bg-violet-500/5 rounded-sm p-2 space-y-1">
              {payload.kind === 'image' ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={payload.url} alt="EVA attachment" className="max-h-56 rounded-sm" />
              ) : (
                <audio controls src={payload.url} className="h-8 w-64" />
              )}
              <p className="text-[9px] font-mono text-zinc-600 break-all">{payload.url}</p>
            </div>
          </div>
        );
      })}

      {formEvents.map((event, index) => {
        const payload = event.payload as {
          message?: string;
          form?: {
            title?: string;
            description?: string;
            fields?: Array<{ id: string; type?: string; label?: string; placeholder?: string; required?: boolean }>;
          };
        };
        const form = payload.form;
        return (
          <div key={`form-${index}`} className="flex justify-start animate-slide-up">
            <div className="max-w-[85%] border border-amber-500/30 bg-amber-500/5 rounded-sm p-3 space-y-3">
              <div className="flex items-center gap-2 text-amber-200">
                <ClipboardList className="w-3.5 h-3.5" />
                <span className="text-xs font-medium">{form?.title ?? 'Falta informacion'}</span>
              </div>
              {(payload.message || form?.description) && (
                <p className="text-xs text-zinc-300 leading-relaxed">{payload.message ?? form?.description}</p>
              )}
              <div className="space-y-2">
                {(form?.fields ?? []).map((field) => (
                  <label key={field.id} className="block space-y-1">
                    <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">
                      {field.label ?? field.id}{field.required ? ' *' : ''}
                    </span>
                    {field.type === 'textarea' ? (
                      <textarea
                        placeholder={field.placeholder}
                        rows={2}
                        className="w-full bg-zinc-950 border border-zinc-700 rounded-sm px-2.5 py-2 text-xs text-zinc-100 placeholder:text-zinc-600"
                      />
                    ) : (
                      <input
                        type={field.type === 'number' ? 'number' : 'text'}
                        placeholder={field.placeholder}
                        className="w-full bg-zinc-950 border border-zinc-700 rounded-sm px-2.5 py-2 text-xs text-zinc-100 placeholder:text-zinc-600"
                      />
                    )}
                  </label>
                ))}
              </div>
            </div>
          </div>
        );
      })}

      {/* Final answer / failure */}
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
      {failed && !resultText && (
        <div className="flex justify-start">
          <div className="max-w-[85%] border border-red-500/30 bg-red-500/5 rounded-sm px-3 py-2 text-xs text-red-300">
            {entry.task.error ?? 'La tarea falló — revisa el action log.'}
          </div>
        </div>
      )}
    </div>
  );
}
