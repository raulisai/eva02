'use client';

import { useState, useMemo } from 'react';
import {
  Clock, Play, Pause, Trash2, AlarmClock, Mail, TrendingDown,
  Globe, Cpu, RefreshCw, Calendar, ChevronDown, ChevronRight,
  Plus, X,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useToast } from '@/components/ui/toast';
import { cn, shortId, age } from '@/lib/utils';
import type { ScheduledJob, JobType, JobStatus, ScheduleType } from '@/lib/types';

// ── display helpers ───────────────────────────────────────────────────────────

const JOB_TYPE_ICON: Record<JobType, React.ElementType> = {
  briefing:      AlarmClock,
  email_check:   Mail,
  price_monitor: TrendingDown,
  url_monitor:   Globe,
  custom:        Cpu,
};

const JOB_TYPE_LABEL: Record<JobType, string> = {
  briefing:      'Briefing',
  email_check:   'Email',
  price_monitor: 'Price',
  url_monitor:   'URL',
  custom:        'Custom',
};

const STATUS_VARIANT: Record<JobStatus, 'completed' | 'cancelled' | 'pending'> = {
  active:    'completed',
  paused:    'cancelled',
  completed: 'pending',
};

function formatSchedule(job: ScheduledJob): string {
  if (job.schedule_type === 'cron' && job.cron_expr) {
    const parts = job.cron_expr.split(' ');
    const h = parts[1];
    const dow = parts[4];
    const timeLabel = h === '*' ? 'every hour' : `${h}:00`;
    const dayLabel = dow === '*' ? 'daily' : dow === '1-5' ? 'Mon–Fri' : `dow ${dow}`;
    return `${timeLabel} · ${dayLabel}`;
  }
  if (job.schedule_type === 'interval' && job.interval_minutes) {
    const h = Math.floor(job.interval_minutes / 60);
    const m = job.interval_minutes % 60;
    const label = h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
    return `every ${label}`;
  }
  if (job.schedule_type === 'once' && job.run_at) {
    return new Date(job.run_at).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });
  }
  return '—';
}

function formatNextRun(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const diffMs = d.getTime() - Date.now();
  if (diffMs < 0) return 'overdue';
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return `in ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `in ${m}m`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return `in ${hr}h ${m % 60}m`;
  return `in ${Math.floor(hr / 24)}d`;
}

// ── default task prompts ──────────────────────────────────────────────────────

const DEFAULT_PROMPT: Record<JobType, string> = {
  briefing: 'Buenos días! Dame el briefing matutino: clima de hoy en mi ciudad, mis correos importantes de las últimas 12 horas, y mi agenda de hoy.',
  email_check: 'Revisa mis correos importantes de las últimas 2 horas y dime si hay algo urgente.',
  url_monitor: 'Verifica si esta URL responde correctamente: {URL}. Dime el estado HTTP y si está arriba o caída.',
  price_monitor: 'Revisa el precio actual en esta página: {URL}. Dime el precio visible y si ha cambiado.',
  custom: '',
};

const DEFAULT_NAME: Record<JobType, string> = {
  briefing:      'Mañanero 🌅',
  email_check:   'Revisión de correo 📬',
  price_monitor: 'Monitor de precio 💰',
  url_monitor:   'Monitor de URL 🌐',
  custom:        '',
};

const TIMEZONES = [
  'America/Mexico_City',
  'America/New_York',
  'America/Los_Angeles',
  'America/Chicago',
  'America/Bogota',
  'America/Lima',
  'America/Santiago',
  'America/Argentina/Buenos_Aires',
  'Europe/Madrid',
  'UTC',
];

// ── CreatePanel ───────────────────────────────────────────────────────────────

interface CreatePanelProps {
  onClose: () => void;
  onCreated: (job: ScheduledJob) => void;
}

function CreatePanel({ onClose, onCreated }: CreatePanelProps) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);

  // form state
  const [jobType, setJobType] = useState<JobType>('briefing');
  const [name, setName] = useState('Mañanero 🌅');
  const [description, setDescription] = useState('');
  const [scheduleType, setScheduleType] = useState<ScheduleType>('cron');
  const [hour, setHour] = useState(7);
  const [dow, setDow] = useState<'*' | '1-5'>('*');
  const [intervalMin, setIntervalMin] = useState(60);
  const [runAt, setRunAt] = useState('');
  const [timezone, setTimezone] = useState('America/Mexico_City');
  const [taskInput, setTaskInput] = useState(DEFAULT_PROMPT.briefing);
  const [url, setUrl] = useState('');
  const [priceThreshold, setPriceThreshold] = useState('');

  function onTypeChange(t: JobType) {
    setJobType(t);
    setName(DEFAULT_NAME[t]);
    const prompt = DEFAULT_PROMPT[t];
    setTaskInput(url ? prompt.replace('{URL}', url) : prompt);
  }

  function onUrlChange(v: string) {
    setUrl(v);
    if (jobType === 'url_monitor' || jobType === 'price_monitor') {
      setTaskInput(DEFAULT_PROMPT[jobType].replace('{URL}', v));
    }
  }

  function buildCronExpr(): string {
    return `0 ${hour} * * ${dow}`;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !taskInput.trim()) {
      toast('Name and prompt are required.', 'error');
      return;
    }

    const body: Record<string, unknown> = {
      name: name.trim(),
      description: description.trim() || undefined,
      job_type: jobType,
      schedule_type: scheduleType,
      timezone,
      task_input: taskInput.trim(),
      payload: {} as Record<string, unknown>,
    };

    if (scheduleType === 'cron') {
      body.cron_expr = buildCronExpr();
    } else if (scheduleType === 'interval') {
      body.interval_minutes = intervalMin;
    } else {
      body.run_at = new Date(runAt).toISOString();
    }

    if ((jobType === 'url_monitor' || jobType === 'price_monitor') && url) {
      (body.payload as Record<string, unknown>).url = url;
      if (jobType === 'price_monitor' && priceThreshold) {
        (body.payload as Record<string, unknown>).threshold = parseFloat(priceThreshold);
      }
    }

    setSaving(true);
    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) { toast('Session expired', 'error'); return; }

      const res = await fetch(`${process.env.NEXT_PUBLIC_EVA_CORE_URL}/jobs`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.text();
        toast(`Error: ${err}`, 'error');
        return;
      }
      const data = await res.json();
      onCreated(data.job as ScheduledJob);
      toast(`Job "${name}" created`, 'success');
      onClose();
    } finally {
      setSaving(false);
    }
  }

  const typeOptions: { type: JobType; label: string; desc: string; Icon: React.ElementType }[] = [
    { type: 'briefing',      Icon: AlarmClock,   label: 'Briefing',      desc: 'Clima, correos y agenda' },
    { type: 'email_check',   Icon: Mail,         label: 'Email',         desc: 'Revisa correos urgentes' },
    { type: 'url_monitor',   Icon: Globe,        label: 'URL Monitor',   desc: 'Verifica si una página está activa' },
    { type: 'price_monitor', Icon: TrendingDown, label: 'Precio',        desc: 'Monitorea el precio de un producto' },
    { type: 'custom',        Icon: Cpu,          label: 'Custom',        desc: 'Cualquier tarea personalizada' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* backdrop */}
      <div className="flex-1 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* panel */}
      <div className="w-[480px] flex-shrink-0 bg-zinc-950 border-l border-zinc-800 flex flex-col h-full shadow-2xl">
        {/* header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800 flex-shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">New Scheduled Job</h2>
            <p className="text-[11px] text-zinc-600 font-mono mt-0.5">Automated recurring task</p>
          </div>
          <button onClick={onClose} className="text-zinc-600 hover:text-zinc-300 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <ScrollArea className="flex-1">
          <form id="create-job-form" onSubmit={handleSubmit} className="px-5 py-4 space-y-5">

            {/* Job type */}
            <fieldset>
              <legend className="text-[10px] font-mono uppercase tracking-widest text-zinc-600 mb-2">Type</legend>
              <div className="grid grid-cols-5 gap-1.5">
                {typeOptions.map(({ type, label, Icon }) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => onTypeChange(type)}
                    className={cn(
                      'flex flex-col items-center gap-1 py-2.5 px-1 rounded border text-[10px] font-mono transition-all',
                      jobType === type
                        ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-300'
                        : 'border-zinc-800 text-zinc-600 hover:border-zinc-700 hover:text-zinc-400',
                    )}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {label}
                  </button>
                ))}
              </div>
            </fieldset>

            {/* Name */}
            <div>
              <label className="block text-[10px] font-mono uppercase tracking-widest text-zinc-600 mb-1.5">Name</label>
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-700 focus:outline-none focus:border-cyan-500/50 transition-colors"
                placeholder="My scheduled job"
              />
            </div>

            {/* Description (optional) */}
            <div>
              <label className="block text-[10px] font-mono uppercase tracking-widest text-zinc-600 mb-1.5">
                Description <span className="text-zinc-700 normal-case">(optional)</span>
              </label>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-400 placeholder-zinc-700 focus:outline-none focus:border-cyan-500/50 transition-colors"
                placeholder="What does this job do?"
              />
            </div>

            {/* URL field (url_monitor / price_monitor) */}
            {(jobType === 'url_monitor' || jobType === 'price_monitor') && (
              <div>
                <label className="block text-[10px] font-mono uppercase tracking-widest text-zinc-600 mb-1.5">URL</label>
                <input
                  value={url}
                  onChange={(e) => onUrlChange(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-700 focus:outline-none focus:border-cyan-500/50 font-mono transition-colors"
                  placeholder="https://example.com/product"
                />
              </div>
            )}

            {/* Price threshold */}
            {jobType === 'price_monitor' && (
              <div>
                <label className="block text-[10px] font-mono uppercase tracking-widest text-zinc-600 mb-1.5">
                  Alert threshold <span className="text-zinc-700 normal-case">(optional)</span>
                </label>
                <input
                  type="number"
                  value={priceThreshold}
                  onChange={(e) => setPriceThreshold(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-700 focus:outline-none focus:border-cyan-500/50 transition-colors"
                  placeholder="e.g. 999.00"
                />
              </div>
            )}

            {/* Schedule type tabs */}
            <fieldset>
              <legend className="text-[10px] font-mono uppercase tracking-widest text-zinc-600 mb-2">Schedule</legend>
              <div className="flex gap-1 mb-3">
                {(['cron', 'interval', 'once'] as ScheduleType[]).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setScheduleType(s)}
                    className={cn(
                      'px-3 py-1 rounded-sm text-[11px] font-mono border transition-all',
                      scheduleType === s
                        ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300'
                        : 'border-zinc-800 text-zinc-600 hover:border-zinc-700 hover:text-zinc-400',
                    )}
                  >
                    {s === 'cron' ? 'Daily / Weekly' : s === 'interval' ? 'Interval' : 'Once'}
                  </button>
                ))}
              </div>

              {scheduleType === 'cron' && (
                <div className="space-y-3">
                  <div>
                    <label className="block text-[10px] font-mono text-zinc-600 mb-1.5">Hour (0–23)</label>
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min={0}
                        max={23}
                        value={hour}
                        onChange={(e) => setHour(parseInt(e.target.value))}
                        className="flex-1 accent-cyan-500"
                      />
                      <span className="w-10 text-right text-sm font-mono text-zinc-300">
                        {String(hour).padStart(2, '0')}:00
                      </span>
                    </div>
                  </div>
                  <div>
                    <label className="block text-[10px] font-mono text-zinc-600 mb-1.5">Days</label>
                    <div className="flex gap-1.5">
                      {([['*', 'Every day'], ['1-5', 'Mon – Fri']] as const).map(([val, label]) => (
                        <button
                          key={val}
                          type="button"
                          onClick={() => setDow(val)}
                          className={cn(
                            'px-3 py-1 rounded-sm text-[11px] font-mono border transition-all',
                            dow === val
                              ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300'
                              : 'border-zinc-800 text-zinc-600 hover:text-zinc-400',
                          )}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <p className="text-[11px] font-mono text-zinc-700">
                    cron: <span className="text-zinc-500">{buildCronExpr()}</span>
                  </p>
                </div>
              )}

              {scheduleType === 'interval' && (
                <div>
                  <label className="block text-[10px] font-mono text-zinc-600 mb-1.5">Every (minutes)</label>
                  <div className="flex items-center gap-3">
                    <input
                      type="number"
                      min={1}
                      max={10080}
                      value={intervalMin}
                      onChange={(e) => setIntervalMin(parseInt(e.target.value) || 60)}
                      className="w-28 bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-cyan-500/50 font-mono"
                    />
                    <span className="text-[11px] text-zinc-600 font-mono">
                      {intervalMin < 60
                        ? `${intervalMin}m`
                        : intervalMin % 60 === 0
                          ? `${intervalMin / 60}h`
                          : `${Math.floor(intervalMin / 60)}h ${intervalMin % 60}m`}
                    </span>
                  </div>
                </div>
              )}

              {scheduleType === 'once' && (
                <div>
                  <label className="block text-[10px] font-mono text-zinc-600 mb-1.5">Run at</label>
                  <input
                    type="datetime-local"
                    required
                    value={runAt}
                    onChange={(e) => setRunAt(e.target.value)}
                    className="bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-cyan-500/50 font-mono"
                  />
                </div>
              )}
            </fieldset>

            {/* Timezone */}
            <div>
              <label className="block text-[10px] font-mono uppercase tracking-widest text-zinc-600 mb-1.5">Timezone</label>
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-300 focus:outline-none focus:border-cyan-500/50 font-mono"
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </select>
            </div>

            {/* Prompt */}
            <div>
              <label className="block text-[10px] font-mono uppercase tracking-widest text-zinc-600 mb-1.5">Task prompt</label>
              <textarea
                required
                rows={4}
                value={taskInput}
                onChange={(e) => setTaskInput(e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-300 placeholder-zinc-700 focus:outline-none focus:border-cyan-500/50 resize-none leading-relaxed"
                placeholder="What should EVA do when this job fires?"
              />
            </div>
          </form>
        </ScrollArea>

        {/* footer */}
        <div className="px-5 py-4 border-t border-zinc-800 flex items-center justify-end gap-2 flex-shrink-0">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="create-job-form" disabled={saving}>
            {saving ? 'Creating…' : 'Create job'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── JobsClient (main) ─────────────────────────────────────────────────────────

interface JobsClientProps {
  initialJobs: ScheduledJob[];
}

export function JobsClient({ initialJobs }: JobsClientProps) {
  const { toast } = useToast();
  const [jobs, setJobs] = useState<ScheduledJob[]>(initialJobs);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | JobStatus>('all');
  const [creating, setCreating] = useState(false);

  const filtered = useMemo(() => {
    const list = filter === 'all' ? jobs : jobs.filter((j) => j.status === filter);
    return [...list].sort((a, b) => {
      const order: Record<JobStatus, number> = { active: 0, paused: 1, completed: 2 };
      if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });
  }, [jobs, filter]);

  const counts = useMemo(() => ({
    active: jobs.filter((j) => j.status === 'active').length,
    paused: jobs.filter((j) => j.status === 'paused').length,
    completed: jobs.filter((j) => j.status === 'completed').length,
  }), [jobs]);

  async function callApi(id: string, action: 'pause' | 'resume' | 'delete') {
    setBusyId(id);
    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) return;

      const method = action === 'delete' ? 'DELETE' : 'POST';
      const url = action === 'delete'
        ? `${process.env.NEXT_PUBLIC_EVA_CORE_URL}/jobs/${id}`
        : `${process.env.NEXT_PUBLIC_EVA_CORE_URL}/jobs/${id}/${action}`;

      const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) { toast('Request failed', 'error'); return; }

      if (action === 'delete') {
        setJobs((prev) => prev.filter((j) => j.id !== id));
        toast('Job deleted', 'success');
      } else {
        const body = await res.json();
        const updated: ScheduledJob = body.job ?? body;
        setJobs((prev) => prev.map((j) => (j.id === id ? updated : j)));
        toast(`Job ${action === 'pause' ? 'paused' : 'resumed'}`, 'success');
      }
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      {creating && (
        <CreatePanel
          onClose={() => setCreating(false)}
          onCreated={(job) => setJobs((prev) => [...prev, job])}
        />
      )}

      <div className="flex flex-col h-full">
        {/* Toolbar: filters + create button */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800/60 flex-shrink-0">
          <div className="flex items-center gap-2">
            {(['all', 'active', 'paused', 'completed'] as const).map((s) => {
              const count = s === 'all' ? jobs.length : counts[s];
              return (
                <button
                  key={s}
                  onClick={() => setFilter(s)}
                  className={cn(
                    'text-[10px] font-mono uppercase tracking-wider px-2.5 py-1 rounded-sm border transition-all',
                    filter === s
                      ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300'
                      : 'border-zinc-800 text-zinc-600 hover:text-zinc-400 hover:border-zinc-700',
                  )}
                >
                  {s} <span className="opacity-60">({count})</span>
                </button>
              );
            })}
          </div>

          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="w-3 h-3" />
            New job
          </Button>
        </div>

        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center flex-1 text-center gap-3 text-zinc-600">
            <Clock className="w-8 h-8 opacity-30" />
            <p className="text-sm">
              {filter === 'all' ? 'No scheduled jobs yet.' : `No ${filter} jobs.`}
            </p>
            {filter === 'all' && (
              <>
                <p className="text-xs font-mono text-zinc-700">
                  Create one here or ask EVA:
                </p>
                <p className="text-xs font-mono text-zinc-600 italic">
                  &quot;activa el mañanero&quot; · &quot;avísame cada hora el clima&quot;
                </p>
              </>
            )}
          </div>
        ) : (
          <ScrollArea className="flex-1">
            <div className="px-5 py-3 space-y-2">
              {filtered.map((job) => {
                const TypeIcon = JOB_TYPE_ICON[job.job_type];
                const expanded = expandedId === job.id;
                const busy = busyId === job.id;

                return (
                  <div
                    key={job.id}
                    className={cn(
                      'rounded border transition-colors',
                      job.status === 'active'
                        ? 'border-zinc-700/60 bg-zinc-900/50'
                        : 'border-zinc-800/40 bg-zinc-900/20',
                    )}
                  >
                    {/* Main row */}
                    <div
                      className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none"
                      onClick={() => setExpandedId(expanded ? null : job.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => e.key === 'Enter' && setExpandedId(expanded ? null : job.id)}
                    >
                      <span className="text-zinc-700 flex-shrink-0">
                        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                      </span>

                      <div className={cn(
                        'w-7 h-7 rounded flex items-center justify-center flex-shrink-0',
                        job.status === 'active' ? 'bg-cyan-500/10' : 'bg-zinc-800/50',
                      )}>
                        <TypeIcon className={cn(
                          'w-3.5 h-3.5',
                          job.status === 'active' ? 'text-cyan-400' : 'text-zinc-600',
                        )} />
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={cn(
                            'text-sm font-medium truncate',
                            job.status === 'active' ? 'text-zinc-100' : 'text-zinc-500',
                          )}>
                            {job.name}
                          </span>
                          <Badge variant={STATUS_VARIANT[job.status]}>{job.status}</Badge>
                          <Badge variant="default">{JOB_TYPE_LABEL[job.job_type]}</Badge>
                        </div>
                        <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                          <span className="text-[11px] font-mono text-zinc-600 flex items-center gap-1">
                            <Clock className="w-2.5 h-2.5" />
                            {formatSchedule(job)}
                          </span>
                          {job.status === 'active' && (
                            <span className="text-[11px] font-mono text-zinc-600 flex items-center gap-1">
                              <Calendar className="w-2.5 h-2.5" />
                              {formatNextRun(job.next_run_at)}
                            </span>
                          )}
                          {job.run_count > 0 && (
                            <span className="text-[11px] font-mono text-zinc-600 flex items-center gap-1">
                              <RefreshCw className="w-2.5 h-2.5" />
                              {job.run_count}x
                            </span>
                          )}
                        </div>
                      </div>

                      <div
                        className="flex items-center gap-1.5 flex-shrink-0"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {job.status === 'active' ? (
                          <Button size="sm" variant="ghost" disabled={busy} onClick={() => callApi(job.id, 'pause')} title="Pause">
                            <Pause className="w-3 h-3" />
                          </Button>
                        ) : job.status === 'paused' ? (
                          <Button size="sm" variant="ghost" disabled={busy} onClick={() => callApi(job.id, 'resume')} title="Resume">
                            <Play className="w-3 h-3" />
                          </Button>
                        ) : null}
                        <Button
                          size="sm" variant="ghost" disabled={busy}
                          onClick={() => callApi(job.id, 'delete')} title="Delete"
                          className="text-zinc-600 hover:text-red-400"
                        >
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    </div>

                    {/* Expanded */}
                    {expanded && (
                      <div className="border-t border-zinc-800/60 px-4 py-3 space-y-2.5">
                        {job.description && (
                          <p className="text-xs text-zinc-500">{job.description}</p>
                        )}
                        <div className="grid grid-cols-2 gap-x-8 gap-y-1.5 text-[11px] font-mono">
                          <Row label="ID" value={shortId(job.id)} />
                          <Row label="Type" value={job.job_type} />
                          <Row label="Schedule" value={`${job.schedule_type} · ${formatSchedule(job)}`} />
                          <Row label="Timezone" value={job.timezone} />
                          {job.last_run_at && <Row label="Last run" value={age(job.last_run_at) + ' ago'} />}
                          {job.next_run_at && <Row label="Next run" value={formatNextRun(job.next_run_at)} />}
                          <Row label="Runs" value={String(job.run_count)} />
                          <Row label="Created" value={age(job.created_at) + ' ago'} />
                        </div>
                        <div>
                          <p className="text-[10px] font-mono text-zinc-700 uppercase tracking-widest mb-1">Prompt</p>
                          <p className="text-xs text-zinc-400 bg-zinc-950/60 rounded px-3 py-2 leading-relaxed border border-zinc-800/40">
                            {job.task_input}
                          </p>
                        </div>
                        {Object.keys(job.payload).length > 0 && !('is_default' in job.payload) && (
                          <div>
                            <p className="text-[10px] font-mono text-zinc-700 uppercase tracking-widest mb-1">Payload</p>
                            <pre className="text-[10px] text-zinc-500 bg-zinc-950/60 rounded px-3 py-2 border border-zinc-800/40 overflow-x-auto">
                              {JSON.stringify(job.payload, null, 2)}
                            </pre>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-zinc-700 w-20 flex-shrink-0">{label}</span>
      <span className="text-zinc-400 truncate">{value}</span>
    </div>
  );
}
