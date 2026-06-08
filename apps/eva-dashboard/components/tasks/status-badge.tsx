import { Badge } from '@/components/ui/badge';
import type { TaskStatus } from '@/lib/types';

const STATUS_MAP: Record<TaskStatus, {
  label: string;
  variant: 'pending' | 'planning' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
}> = {
  pending:              { label: 'pending',  variant: 'pending' },
  planning:             { label: 'planning', variant: 'planning' },
  running:              { label: 'running',  variant: 'running' },
  waiting_for_approval: { label: 'approval', variant: 'waiting' },
  completed:            { label: 'done',     variant: 'completed' },
  failed:               { label: 'failed',   variant: 'failed' },
  cancelled:            { label: 'cancelled',variant: 'cancelled' },
};

const LED_CLASS: Record<TaskStatus, string> = {
  pending:              'led-pending',
  planning:             'led-planning',
  running:              'led-running',
  waiting_for_approval: 'led-waiting',
  completed:            'led-completed',
  failed:               'led-failed',
  cancelled:            'led-cancelled',
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  const { label, variant } = STATUS_MAP[status] ?? { label: status, variant: 'default' as const };
  return (
    <Badge variant={variant}>
      <span className={`led ${LED_CLASS[status]}`} />
      {label}
    </Badge>
  );
}

export function StatusDot({ status }: { status: TaskStatus }) {
  return <span className={`led ${LED_CLASS[status]}`} title={status} />;
}
