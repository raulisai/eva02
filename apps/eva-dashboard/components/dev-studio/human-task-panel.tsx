'use client';

import { useState } from 'react';
import { AlertTriangle, CheckCircle, Eye, EyeOff, ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DevHumanTask } from '@/lib/dev-studio-types';
import { devStudioApi } from '@/lib/dev-studio-api';

interface HumanTaskPanelProps {
  tasks: DevHumanTask[];
  onUpdated?: () => void;
}

export function HumanTaskPanel({ tasks, onUpdated }: HumanTaskPanelProps) {
  if (tasks.length === 0) return null;

  const pending = tasks.filter((t) => t.status === 'pending' || t.status === 'waiting_user');
  const submitted = tasks.filter((t) => t.status === 'submitted');

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-orange-500" />
        <span className="text-sm font-medium text-orange-700">
          Tus tareas pendientes ({pending.length + submitted.length})
        </span>
      </div>
      <div className="space-y-2">
        {[...pending, ...submitted].map((task) => (
          <HumanTaskCard key={task.id} task={task} onUpdated={onUpdated} />
        ))}
      </div>
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
    } finally {
      setLoading(false);
    }
  }

  const isSubmitted = task.status === 'submitted';

  return (
    <div className={cn(
      'rounded-xl border p-4 space-y-3',
      task.sensitive ? 'border-orange-200 bg-orange-50' : 'border-amber-200 bg-amber-50',
    )}>
      <div
        className="flex items-start gap-2 cursor-pointer"
        onClick={() => setExpanded((e) => !e)}
      >
        <span className="mt-0.5 text-slate-400">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </span>
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm text-slate-800">{task.title}</span>
            {task.sensitive && (
              <span className="rounded-full bg-orange-200 px-2 py-0.5 text-xs text-orange-700 font-medium">
                Sensible
              </span>
            )}
            {isSubmitted && (
              <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700">
                Enviado — pendiente verificación
              </span>
            )}
          </div>
          {task.required_output && (
            <p className="text-xs text-slate-500 mt-1">Se necesita: {task.required_output}</p>
          )}
        </div>
      </div>

      {expanded && (
        <>
          {task.description && (
            <p className="text-sm text-slate-700">{task.description}</p>
          )}

          {!isSubmitted && (
            <div className="space-y-2">
              <div className="relative">
                <textarea
                  value={result}
                  onChange={(e) => setResult(e.target.value)}
                  placeholder={task.sensitive ? '(valor sensible — no se mostrará en logs)' : 'Escribe tu respuesta aquí…'}
                  rows={3}
                  className={cn(
                    'w-full rounded-lg border px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-400',
                    task.sensitive ? 'border-orange-200 bg-white' : 'border-amber-200 bg-white',
                    task.sensitive && !showSensitive ? 'text-security-disc' : '',
                  )}
                />
                {task.sensitive && (
                  <button
                    type="button"
                    onClick={() => setShowSensitive((s) => !s)}
                    className="absolute right-2 top-2 text-slate-400 hover:text-slate-600"
                  >
                    {showSensitive ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                )}
              </div>

              <div className="flex items-center justify-between">
                {task.blocks_task_ids.length > 0 && (
                  <span className="text-xs text-slate-500">
                    Bloquea {task.blocks_task_ids.length} tarea(s)
                  </span>
                )}
                <button
                  onClick={handleSubmit}
                  disabled={loading || !result.trim()}
                  className="ml-auto rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {loading ? 'Enviando…' : 'Entregar y desbloquear'}
                </button>
              </div>
            </div>
          )}

          {isSubmitted && (
            <div className="flex items-center gap-2 text-sm text-blue-700">
              <CheckCircle className="h-4 w-4" />
              Enviado. Esperando verificación del agente.
            </div>
          )}
        </>
      )}
    </div>
  );
}
