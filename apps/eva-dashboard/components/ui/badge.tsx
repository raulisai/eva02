import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10px] font-medium font-mono uppercase tracking-wider transition-colors',
  {
    variants: {
      variant: {
        default:   'border-zinc-700 bg-zinc-800/60 text-zinc-300',
        pending:   'border-amber-500/30 bg-amber-500/10 text-amber-400',
        planning:  'border-blue-500/30 bg-blue-500/10 text-blue-400',
        running:   'border-cyan-500/40 bg-cyan-500/10 text-cyan-300',
        waiting:   'border-orange-500/30 bg-orange-500/10 text-orange-400',
        completed: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
        failed:    'border-red-500/30 bg-red-500/10 text-red-400',
        cancelled: 'border-zinc-700 bg-zinc-800/40 text-zinc-500',
        online:    'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
        offline:   'border-red-500/30 bg-red-500/10 text-red-400',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
