'use client';

import { useMemo, useState } from 'react';
import {
  Activity,
  Bot,
  Bug,
  Clock,
  MousePointerClick,
  Search,
  ShieldCheck,
  Terminal,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useWs } from '@/hooks/use-ws';
import type { EvaEvent } from '@/lib/types';
import { cn, shortId } from '@/lib/utils';

type LogFilter = 'all' | 'agent' | 'browser' | 'jobs' | 'approvals' | 'errors';

interface LogConsoleProps {
  mode?: 'drawer' | 'page';
  onClose?: () => void;
}

interface LogEntry {
  id: string;
  event: EvaEvent;
  category: LogFilter | 'system' | 'dev' | 'communication' | 'wear';
  scope: string;
  module: string;
  action: string;
  message: string;
  details: string;
  hasError: boolean;
}

const FILTERS: Array<{ id: LogFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'agent', label: 'Agent' },
  { id: 'browser', label: 'Browser' },
  { id: 'jobs', label: 'Jobs' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'errors', label: 'Errors' },
];

const SCOPE_STYLES: Record<string, string> = {
  pipeline: 'border-cyan-400/50 bg-cyan-400/10 text-cyan-200',
  tools: 'border-emerald-400/50 bg-emerald-400/10 text-emerald-200',
  browser: 'border-amber-400/60 bg-amber-400/10 text-amber-200',
  scheduler: 'border-sky-400/50 bg-sky-400/10 text-sky-200',
  model: 'border-fuchsia-400/50 bg-fuchsia-400/10 text-fuchsia-200',
  approval: 'border-orange-400/60 bg-orange-400/10 text-orange-200',
  loop: 'border-rose-400/50 bg-rose-400/10 text-rose-200',
  forge: 'border-lime-400/50 bg-lime-400/10 text-lime-200',
  sandbox: 'border-yellow-400/50 bg-yellow-400/10 text-yellow-200',
  media: 'border-teal-400/50 bg-teal-400/10 text-teal-200',
  forms: 'border-blue-400/50 bg-blue-400/10 text-blue-200',
  soul: 'border-violet-400/50 bg-violet-400/10 text-violet-200',
  dev: 'border-indigo-400/50 bg-indigo-400/10 text-indigo-200',
  communication: 'border-pink-400/50 bg-pink-400/10 text-pink-200',
  wear: 'border-green-400/50 bg-green-400/10 text-green-200',
  system: 'border-zinc-500/50 bg-zinc-700/20 text-zinc-300',
  error: 'border-red-400/60 bg-red-400/10 text-red-200',
};

const REDACTED_KEY = /(authorization|cookie|credential|encrypted|nonce|password|refresh|secret|token)/i;

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      REDACTED_KEY.test(key) ? '[redacted]' : redact(item),
    ]),
  );
}

function compactPayload(payload: Record<string, unknown>): string {
  const filtered = Object.fromEntries(
    Object.entries(redact(payload) as Record<string, unknown>)
      .filter(([key]) => !['message', 'text'].includes(key)),
  );
  return Object.keys(filtered).length > 0 ? JSON.stringify(filtered, null, 2) : '';
}

function categoryFor(type: string, payload: Record<string, unknown>, scope: string): LogEntry['category'] {
  if (scope === 'browser' || type.startsWith('browser.')) return 'browser';
  if (scope === 'scheduler' || asString(payload.module) === 'JobSchedulerService') return 'jobs';
  if (scope === 'approval' || type.startsWith('approval.')) return 'approvals';
  if (type.startsWith('dev.')) return 'dev';
  if (type.startsWith('communication.')) return 'communication';
  if (type.startsWith('wear.')) return 'wear';
  if (type.startsWith('task.')) return 'agent';
  return 'system';
}

function sourceIcon(category: LogEntry['category']) {
  if (category === 'browser') return MousePointerClick;
  if (category === 'jobs') return Clock;
  if (category === 'approvals') return ShieldCheck;
  if (category === 'dev') return Terminal;
  if (category === 'errors') return Bug;
  if (category === 'agent') return Bot;
  return Activity;
}

function summarizeEvent(event: EvaEvent): LogEntry {
  const payload = event.payload ?? {};
  const rawScope = asString(payload.scope) ?? asString(payload.agent) ?? event.type.split('.')[0] ?? 'system';
  const scope = rawScope.toLowerCase();
  const category = categoryFor(event.type, payload, scope);
  const message =
    asString(payload.message) ??
    asString(payload.text) ??
    asString(payload.summary) ??
    asString(payload.title) ??
    event.type;
  const hasError = category === 'errors' || event.type.includes('failed') || Boolean(payload.error);

  return {
    id: `${event.ts}-${event.type}-${event.taskId ?? 'system'}`,
    event,
    category,
    scope: hasError ? 'error' : scope,
    module: asString(payload.module) ?? moduleForEvent(event.type, category),
    action: asString(payload.action) ?? event.type,
    message,
    details: compactPayload(payload),
    hasError,
  };
}

function moduleForEvent(type: string, category: LogEntry['category']): string {
  if (category === 'browser') return 'BrowserService';
  if (category === 'jobs') return 'JobSchedulerService';
  if (category === 'approvals') return 'ApprovalsService';
  if (category === 'dev') return 'DevTaskQueueService';
  if (category === 'communication') return 'CommunicationService';
  if (category === 'wear') return 'WearFastPathService';
  if (type.startsWith('task.')) return 'AgentRunnerService';
  return 'System';
}

function matchesFilter(entry: LogEntry, filter: LogFilter) {
  if (filter === 'all') return true;
  if (filter === 'agent') return entry.category === 'agent' || entry.category === 'dev' || entry.category === 'communication' || entry.category === 'wear';
  if (filter === 'errors') return entry.hasError;
  return entry.category === filter;
}

function formatClock(ts: number) {
  return new Date(ts).toLocaleTimeString('en', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function LogRow({ entry }: { entry: LogEntry }) {
  const Icon = sourceIcon(entry.category);
  const style = SCOPE_STYLES[entry.scope] ?? SCOPE_STYLES.system;

  return (
    <div className={cn('event-new border-l-2 border-b border-zinc-800/70 px-3 py-2.5', style)}>
      <div className="grid grid-cols-[74px_116px_1fr] gap-3 items-start">
        <span className="font-mono text-[10px] text-zinc-500 tabular-nums pt-0.5">
          {formatClock(entry.event.ts)}
        </span>
        <div className="min-w-0 space-y-1">
          <span className="inline-flex max-w-full items-center gap-1.5 rounded-sm border border-current/30 px-1.5 py-0.5 font-mono text-[10px] uppercase">
            <Icon className="h-3 w-3 flex-shrink-0" />
            <span className="truncate">{entry.scope}</span>
          </span>
          <p className="font-mono text-[10px] text-zinc-500 truncate">{entry.module}</p>
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-[10px] text-zinc-500">{entry.action}</span>
            {entry.event.taskId && (
              <span className="font-mono text-[10px] text-zinc-600">task {shortId(entry.event.taskId)}</span>
            )}
          </div>
          <p className="mt-1 text-xs leading-5 text-zinc-100 break-words">{entry.message}</p>
          {entry.details && (
            <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded-sm border border-zinc-800/70 bg-zinc-950/70 p-2 font-mono text-[10px] leading-4 text-zinc-500">
              {entry.details}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

export function LogConsoleContent() {
  const { connected, events } = useWs();
  const [filter, setFilter] = useState<LogFilter>('all');
  const [query, setQuery] = useState('');

  const entries = useMemo(() => events.map(summarizeEvent), [events]);
  const visible = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (!matchesFilter(entry, filter)) return false;
      if (!normalizedQuery) return true;
      return [
        entry.event.type,
        entry.event.taskId,
        entry.scope,
        entry.module,
        entry.action,
        entry.message,
        entry.details,
      ].filter(Boolean).some((value) => String(value).toLowerCase().includes(normalizedQuery));
    });
  }, [entries, filter, query]);

  const browserCount = entries.filter(entry => entry.category === 'browser').length;
  const jobCount = entries.filter(entry => entry.category === 'jobs').length;

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-950">
      <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Bug className="h-4 w-4 text-cyan-300" />
            <h2 className="text-sm font-semibold text-zinc-100">Debug Logs</h2>
            <span className={cn('led', connected ? 'led-running' : 'led-failed')} />
          </div>
          <p className="mt-1 font-mono text-[10px] text-zinc-600">
            {visible.length}/{entries.length} visible / {browserCount} browser / {jobCount} jobs
          </p>
        </div>

        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
          <div className="relative w-full min-w-[180px] max-w-xs">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search logs"
              className="h-8 w-full rounded-sm border border-zinc-800 bg-zinc-900 pl-7 pr-2 font-mono text-xs text-zinc-200 outline-none transition-colors placeholder:text-zinc-700 focus:border-cyan-500/60"
            />
          </div>
          <div className="flex rounded-sm border border-zinc-800 bg-zinc-900 p-0.5">
            {FILTERS.map(item => (
              <button
                key={item.id}
                type="button"
                onClick={() => setFilter(item.id)}
                className={cn(
                  'h-7 px-2 font-mono text-[10px] transition-colors',
                  filter === item.id
                    ? 'bg-zinc-700 text-zinc-100'
                    : 'text-zinc-500 hover:text-zinc-200',
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {visible.length === 0 ? (
          <div className="flex h-40 items-center justify-center font-mono text-xs text-zinc-700">
            {connected ? 'No matching logs' : 'Waiting for Core connection'}
          </div>
        ) : (
          visible.map((entry, index) => <LogRow key={`${entry.id}-${index}`} entry={entry} />)
        )}
      </ScrollArea>
    </div>
  );
}

export function LogConsole({ mode = 'drawer', onClose }: LogConsoleProps) {
  if (mode === 'page') {
    return <LogConsoleContent />;
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />
      <aside className="fixed bottom-4 right-4 top-14 z-50 w-[min(760px,calc(100vw-2rem))] overflow-hidden rounded-sm border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/50">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Close logs"
          title="Close logs"
          onClick={onClose}
          className="absolute right-3 top-3 z-10"
        >
          <X className="h-4 w-4" />
        </Button>
        <LogConsoleContent />
      </aside>
    </>
  );
}

export function LogsButton({ onClick, count }: { onClick: () => void; count: number }) {
  return (
    <Button type="button" variant="outline" size="sm" onClick={onClick} title="Open debug logs">
      <Bug className="h-3.5 w-3.5" />
      <span>Logs</span>
      {count > 0 && <span className="font-mono text-[10px] text-zinc-500">{count}</span>}
    </Button>
  );
}
