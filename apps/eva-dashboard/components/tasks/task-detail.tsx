"use client";

import { useState, useEffect } from 'react';
import { useTaskEvents, useLiveStatus } from '@/hooks/use-ws';
import { StatusBadge } from './status-badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { shortId, age } from '@/lib/utils';
import type { Task, TokenLog, EvaEvent, TaskStatus } from '@/lib/types';
import { coreFetch } from '@/lib/core-api';
import { Brain, BarChart3, Code, MessageSquare, Cpu, RotateCcw, Square, Loader2 } from 'lucide-react';

interface TaskDetailProps {
  task: Task;
  tokenLogs?: TokenLog[];
  initialEvents?: EvaEvent[];
}

function EventItem({ ev }: { ev: EvaEvent }) {
  const [expanded, setExpanded] = useState(false);
  const timeStr = new Date(ev.ts).toLocaleTimeString();

  let title = ev.type;
  let content = null;
  let badgeColor = 'bg-zinc-800 text-zinc-400 border-zinc-700';

  if (ev.type === 'task.log') {
    const scope = String(ev.payload.scope ?? 'debug');
    const msg = String(ev.payload.message ?? '');
    const isError = ev.payload.level === 'error' || msg.startsWith('ERROR:') || msg.toLowerCase().includes('failed') || msg.toLowerCase().includes('error');
    
    title = `log [${scope}]`;
    badgeColor = isError 
      ? 'bg-red-500/10 text-red-400 border-red-500/20' 
      : scope === 'pipeline'
        ? 'bg-blue-500/10 text-blue-400 border-blue-500/20'
        : scope === 'tools'
          ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
          : scope === 'model'
            ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20'
            : scope === 'loop'
              ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20'
              : 'bg-zinc-800 text-zinc-400 border-zinc-700';

    content = (
      <p className={`font-mono text-xs break-words ${isError ? 'text-red-400 font-semibold' : 'text-zinc-300'}`}>
        {msg}
      </p>
    );
  } else if (ev.type === 'task.say') {
    title = 'say';
    badgeColor = 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20';
    content = (
      <div className="bg-cyan-500/5 border border-cyan-500/20 rounded p-2 text-xs text-cyan-200 italic">
        <span className="font-semibold not-italic text-cyan-400 mr-1">EVA:</span>
        &ldquo;{String(ev.payload.text ?? '')}&rdquo;
      </div>
    );
  } else if (ev.type === 'task.result') {
    title = 'result';
    badgeColor = 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
    content = (
      <div className="bg-emerald-500/5 border border-emerald-500/20 rounded p-2 text-xs text-emerald-300 font-mono whitespace-pre-wrap">
        <span className="font-semibold text-emerald-400 block mb-1">🏁 Final Result:</span>
        {typeof ev.payload.text === 'string' ? ev.payload.text : JSON.stringify(ev.payload, null, 2)}
      </div>
    );
  } else if (ev.type === 'task.form_request') {
    title = 'form request';
    badgeColor = 'bg-purple-500/10 text-purple-400 border-purple-500/20';
    content = (
      <div className="bg-purple-500/5 border border-purple-500/20 rounded p-2 text-xs text-purple-300">
        <span className="font-semibold text-purple-400 block mb-1">📝 Form Request:</span>
        {String(ev.payload.message ?? '')}
      </div>
    );
  } else if (ev.type === 'task.setup_required') {
    title = 'setup required';
    badgeColor = 'bg-rose-500/10 text-rose-400 border-rose-500/20';
    content = (
      <div className="bg-rose-500/5 border border-rose-500/20 rounded p-2 text-xs text-rose-300">
        <span className="font-semibold text-rose-400 block mb-1">⚙️ Setup Required:</span>
        {String(ev.payload.message ?? '')}
      </div>
    );
  } else {
    content = (
      <pre className="text-[10px] font-mono text-zinc-500 overflow-x-auto">
        {JSON.stringify(ev.payload, null, 2)}
      </pre>
    );
  }

  return (
    <div className="border border-zinc-900 bg-zinc-950/20 rounded p-2.5 hover:bg-zinc-900/10 transition-colors">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[9px] text-zinc-600">{timeStr}</span>
          <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono font-medium border ${badgeColor}`}>
            {title}
          </span>
        </div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-[9px] font-mono text-zinc-500 hover:text-zinc-300 underline"
        >
          {expanded ? 'Hide JSON' : 'Show JSON'}
        </button>
      </div>
      
      <div className="pl-1">
        {content}
      </div>

      {expanded && (
        <div className="mt-2 pt-2 border-t border-zinc-900/60">
          <pre className="text-[9px] font-mono text-zinc-500 overflow-x-auto bg-zinc-950/50 p-2 rounded max-h-40">
            {JSON.stringify(ev, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

export function TaskDetail({ task, tokenLogs = [], initialEvents = [] }: TaskDetailProps) {
  const liveStatusFromWs = useLiveStatus(task.id);
  const [localStatus, setLocalStatus] = useState<TaskStatus>(task.status);
  const currentStatus = liveStatusFromWs ?? localStatus;

  const liveEvents = useTaskEvents(task.id);
  const [eventsList, setEventsList] = useState<EvaEvent[]>(initialEvents);
  const [isActionLoading, setIsActionLoading] = useState(false);

  // Sync WebSocket state updates with localStatus
  useEffect(() => {
    if (liveStatusFromWs) {
      setLocalStatus(liveStatusFromWs);
    }
  }, [liveStatusFromWs]);

  // Sync / append new live events when they arrive
  useEffect(() => {
    if (liveEvents.length > 0) {
      setEventsList(prev => {
        const existingIds = new Set(prev.map(e => e.id || `${e.type}-${e.ts}`));
        const newEvents = liveEvents.filter(e => !existingIds.has(e.id || `${e.type}-${e.ts}`));
        if (newEvents.length === 0) return prev;
        return [...prev, ...newEvents].sort((a, b) => a.ts - b.ts);
      });
    }
  }, [liveEvents]);

  const isTerminal = ['completed', 'failed', 'cancelled'].includes(currentStatus);
  const cancelLabel = currentStatus === 'running' || currentStatus === 'planning' ? 'Stop Task' : 'Cancel Task';

  const handleCancel = async () => {
    setIsActionLoading(true);
    try {
      await coreFetch(`/tasks/${task.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'cancelled' }),
      });
      setLocalStatus('cancelled');
    } catch (err) {
      console.error('Failed to cancel task:', err);
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleRetry = async () => {
    setIsActionLoading(true);
    try {
      await coreFetch(`/tasks/${task.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'pending' }),
      });
      setLocalStatus('pending');
    } catch (err) {
      console.error('Failed to retry task:', err);
    } finally {
      setIsActionLoading(false);
    }
  };


  // Summing tokens and cost for this task
  const totalTaskTokens = tokenLogs.reduce((sum, log) => sum + log.total_tokens, 0);
  const totalTaskCost = tokenLogs.reduce((sum, log) => sum + Number(log.cost_usd), 0);

  // Grouping by type (phase)
  const taskTypeMap = tokenLogs.reduce((acc, log) => {
    if (!acc[log.request_type]) {
      acc[log.request_type] = { tokens: 0, cost: 0, count: 0 };
    }
    acc[log.request_type].tokens += log.total_tokens;
    acc[log.request_type].cost += Number(log.cost_usd);
    acc[log.request_type].count += 1;
    return acc;
  }, {} as Record<string, { tokens: number; cost: number; count: number }>);

  const requestTypes = [
    { key: 'reasoning', label: 'Reasoning', color: 'bg-cyan-500', textColor: 'text-cyan-400', borderColor: 'border-cyan-500/40 border-l-cyan-500', bgColor: 'bg-cyan-500/5', icon: Brain },
    { key: 'tools', label: 'Tools', color: 'bg-indigo-500', textColor: 'text-indigo-400', borderColor: 'border-indigo-500/40 border-l-indigo-500', bgColor: 'bg-indigo-500/5', icon: BarChart3 },
    { key: 'code', label: 'Code Gen', color: 'bg-emerald-500', textColor: 'text-emerald-400', borderColor: 'border-emerald-500/40 border-l-emerald-500', bgColor: 'bg-emerald-500/5', icon: Code },
    { key: 'response', label: 'Response', color: 'bg-amber-500', textColor: 'text-amber-400', borderColor: 'border-amber-500/40 border-l-amber-500', bgColor: 'bg-amber-500/5', icon: MessageSquare },
  ];

  return (
    <div className="grid grid-rows-[auto_1fr] h-full gap-0">
      {/* Header */}
      <div className="panel m-4 p-4 flex-shrink-0">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div>
            <p className="font-mono text-[10px] text-zinc-600 mb-1">{task.id}</p>
            <h2 className="text-base font-semibold text-zinc-100">{task.title}</h2>
            {task.description && (
              <p className="text-sm text-zinc-400 mt-1">{task.description}</p>
            )}
          </div>
          <div className="flex items-center gap-3">
            {isTerminal ? (
              <button
                onClick={handleRetry}
                disabled={isActionLoading}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium font-mono border border-emerald-500/30 text-emerald-400 bg-emerald-500/5 hover:bg-emerald-500/10 hover:border-emerald-500/50 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
              >
                {isActionLoading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RotateCcw className="w-3.5 h-3.5" />
                )}
                Retry Task
              </button>
            ) : (
              <button
                onClick={handleCancel}
                disabled={isActionLoading}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium font-mono border border-red-500/30 text-red-400 bg-red-500/5 hover:bg-red-500/10 hover:border-red-500/50 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
              >
                {isActionLoading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Square className="w-3.5 h-3.5 fill-current" />
                )}
                {cancelLabel}
              </button>
            )}
            <StatusBadge status={currentStatus} />
          </div>
        </div>

        <div className={`grid ${tokenLogs.length > 0 ? 'grid-cols-5' : 'grid-cols-3'} gap-4 pt-3 border-t border-zinc-800`}>
          {[
            { label: 'Created',   value: new Date(task.created_at).toLocaleString() },
            { label: 'Started',   value: task.started_at ? new Date(task.started_at).toLocaleString() : '—' },
            { label: 'Age',       value: age(task.created_at) },
            ...(tokenLogs.length > 0 ? [
              { label: 'Tokens Spent', value: totalTaskTokens.toLocaleString() },
              { label: 'Estimated Cost', value: `$${totalTaskCost.toFixed(5)}` }
            ] : [])
          ].map(({ label, value }) => (
            <div key={label}>
              <p className="text-[10px] font-mono text-zinc-600 uppercase tracking-widest">{label}</p>
              <p className="text-xs font-mono text-zinc-300 mt-0.5" suppressHydrationWarning>{value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Body: metadata + event stream + token logs */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 px-4 pb-4 min-h-0">
        {/* Metadata / result */}
        <div className="panel flex flex-col min-h-0">
          <p className="text-[10px] font-mono text-zinc-600 uppercase tracking-widest px-3 py-2 border-b border-zinc-800 flex-shrink-0">
            Metadata
          </p>
          <ScrollArea className="flex-1 p-3">
            <pre className="text-xs font-mono text-zinc-400 whitespace-pre-wrap break-all">
              {JSON.stringify(task.metadata, null, 2)}
            </pre>
            {task.result && (
              <>
                <p className="text-[10px] font-mono text-emerald-600 mt-4 mb-1 uppercase tracking-widest">Result</p>
                <pre className="text-xs font-mono text-emerald-400 whitespace-pre-wrap break-all">
                  {JSON.stringify(task.result, null, 2)}
                </pre>
              </>
            )}
            {task.error && (
              <>
                <p className="text-[10px] font-mono text-red-600 mt-4 mb-1 uppercase tracking-widest">Error</p>
                <pre className="text-xs font-mono text-red-400 whitespace-pre-wrap break-all">
                  {task.error}
                </pre>
              </>
            )}
          </ScrollArea>
        </div>

        {/* Live event log for this task */}
        <div className="panel flex flex-col min-h-0">
          <p className="text-[10px] font-mono text-zinc-600 uppercase tracking-widest px-3 py-2 border-b border-zinc-800 flex-shrink-0">
            Execution Log
            {eventsList.length > 0 && (
              <span className="ml-2 text-cyan-500">{eventsList.length}</span>
            )}
          </p>
          <ScrollArea className="flex-1 p-3">
            {eventsList.length === 0 ? (
              <p className="text-xs text-zinc-700 font-mono">Waiting for events…</p>
            ) : (
              <div className="space-y-2">
                {eventsList.map((ev, i) => (
                  <EventItem key={ev.id || i} ev={ev} />
                ))}
              </div>
            )}
          </ScrollArea>
        </div>

        {/* Token logs analysis */}
        <div className="panel flex flex-col min-h-0 border-l border-zinc-800/80">
          <p className="text-[10px] font-mono text-zinc-600 uppercase tracking-widest px-3 py-2 border-b border-zinc-800 flex-shrink-0 flex items-center justify-between">
            <span>LLM Request Analytics</span>
            {tokenLogs.length > 0 && (
              <span className="text-zinc-500 font-mono">
                {tokenLogs.length} calls • ${totalTaskCost.toFixed(5)}
              </span>
            )}
          </p>
          <ScrollArea className="flex-1 p-3">
            {tokenLogs.length === 0 ? (
              <p className="text-xs text-zinc-700 font-mono">No LLM usage recorded for this task.</p>
            ) : (
              <div className="space-y-4">
                {/* Cost/Tokens summary cards */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-zinc-900/40 border border-zinc-800/60 p-2.5 rounded">
                    <p className="text-[9px] font-mono text-zinc-500 uppercase">Task Cost</p>
                    <p className="text-sm font-semibold font-mono text-cyan-400 mt-0.5">${totalTaskCost.toFixed(5)}</p>
                  </div>
                  <div className="bg-zinc-900/40 border border-zinc-800/60 p-2.5 rounded">
                    <p className="text-[9px] font-mono text-zinc-500 uppercase">Total Tokens</p>
                    <p className="text-sm font-semibold font-mono text-emerald-400 mt-0.5">{totalTaskTokens.toLocaleString()}</p>
                  </div>
                </div>

                {/* Progress bar breakdown */}
                <div className="space-y-2 bg-zinc-900/20 border border-zinc-800/40 p-3 rounded">
                  <div className="flex justify-between text-[10px] font-mono text-zinc-400">
                    <span>Phase Distribution</span>
                    <span>{totalTaskTokens.toLocaleString()} tokens</span>
                  </div>
                  <div className="w-full h-2 bg-zinc-850 rounded-full overflow-hidden flex">
                    {requestTypes.map(({ key, color }) => {
                      const typeData = taskTypeMap[key] || { tokens: 0 };
                      const pct = totalTaskTokens > 0 ? (typeData.tokens / totalTaskTokens) * 100 : 0;
                      if (pct === 0) return null;
                      return (
                        <div
                          key={key}
                          className={`${color} h-full transition-all duration-300`}
                          style={{ width: `${pct}%` }}
                          title={`${key}: ${typeData.tokens.toLocaleString()} tokens (${pct.toFixed(1)}%)`}
                        />
                      );
                    })}
                  </div>
                  <div className="grid grid-cols-2 gap-x-2 gap-y-1 pt-1">
                    {requestTypes.map(({ key, label, textColor }) => {
                      const typeData = taskTypeMap[key] || { tokens: 0, cost: 0 };
                      const pct = totalTaskTokens > 0 ? (typeData.tokens / totalTaskTokens) * 100 : 0;
                      if (typeData.tokens === 0) return null;
                      return (
                        <div key={key} className="flex items-center justify-between text-[9px] font-mono">
                          <span className="flex items-center gap-1 text-zinc-400">
                            <span className={`w-1.5 h-1.5 rounded-full ${textColor.replace('text-', 'bg-')}`} />
                            {label}
                          </span>
                          <span className="text-zinc-500">
                            {pct.toFixed(0)}%
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Individual requests list */}
                <div className="space-y-2">
                  <p className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">Request Stream</p>
                  <div className="space-y-2">
                    {tokenLogs.map((log) => {
                      const matchedType = requestTypes.find(t => t.key === log.request_type) || {
                        label: log.request_type,
                        textColor: 'text-zinc-400',
                        borderColor: 'border-zinc-800 border-l-zinc-700',
                        bgColor: 'bg-zinc-900/20',
                        icon: Cpu
                      };
                      const Icon = matchedType.icon;
                      
                      return (
                        <div
                          key={log.id}
                          className={`border-l-2 p-3 rounded bg-zinc-900/30 flex flex-col gap-1.5 hover:bg-zinc-900/50 hover:border-l-4 transition-all duration-150 ${matchedType.borderColor} ${matchedType.bgColor}`}
                        >
                          <div className="flex justify-between items-start">
                            <span className="text-[10px] font-mono text-zinc-300 font-medium truncate max-w-[150px]" title={log.model}>
                              {log.model}
                            </span>
                            <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono font-medium flex items-center gap-1 ${matchedType.textColor} bg-zinc-950/40 border border-zinc-800/40`}>
                              <Icon className="w-2.5 h-2.5" />
                              {matchedType.label}
                            </span>
                          </div>
                          
                          <div className="flex justify-between items-center text-[10px] font-mono text-zinc-400 pt-0.5">
                            <div className="flex gap-2">
                              <span title={`Prompt: ${log.prompt_tokens} / Completion: ${log.completion_tokens}`}>
                                <strong className="text-zinc-300">{log.total_tokens.toLocaleString()}</strong> t
                              </span>
                              <span className="text-zinc-600">|</span>
                              <span className="text-[9px] text-zinc-500">
                                in:{log.prompt_tokens} out:{log.completion_tokens}
                              </span>
                            </div>
                            <span className="font-semibold text-zinc-300">${Number(log.cost_usd).toFixed(5)}</span>
                          </div>
                          <div className="text-[8px] font-mono text-zinc-600 text-right">
                            {new Date(log.created_at).toLocaleTimeString()}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </ScrollArea>
        </div>
      </div>
    </div>
  );
}
