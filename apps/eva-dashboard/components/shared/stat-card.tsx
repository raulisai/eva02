import { cn } from '@/lib/utils';

interface StatCardProps {
  label: string;
  value: string | number;
  sub?: string;
  accent?: boolean;
  className?: string;
}

export function StatCard({ label, value, sub, accent, className }: StatCardProps) {
  return (
    <div className={cn('panel px-4 py-3', className)}>
      <p className="text-[10px] font-mono uppercase tracking-widest text-zinc-600 mb-1">{label}</p>
      <p className={cn('text-2xl font-bold tabular-nums', accent ? 'text-cyan-400' : 'text-zinc-100')}>
        {value}
      </p>
      {sub && <p className="text-[10px] text-zinc-600 mt-0.5 font-mono">{sub}</p>}
    </div>
  );
}
