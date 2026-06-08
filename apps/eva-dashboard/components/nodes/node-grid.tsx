'use client';

import { useWs } from '@/hooks/use-ws';
import type { NodeInfo } from '@/lib/types';
import { age, cn } from '@/lib/utils';

function BarMeter({ value, accent }: { value: number; accent?: boolean }) {
  return (
    <div className="h-1 bg-zinc-800 rounded-full overflow-hidden w-full">
      <div
        className={cn('h-full rounded-full transition-all duration-500', accent ? 'bg-cyan-500' : 'bg-zinc-600')}
        style={{ width: `${value}%` }}
      />
    </div>
  );
}

function NodeCard({ node }: { node: NodeInfo }) {
  const statusColor = {
    idle:    'text-zinc-400 border-zinc-700',
    running: 'text-cyan-300 border-cyan-500/40',
    offline: 'text-zinc-600 border-zinc-800',
  }[node.status];

  return (
    <div className={cn('panel p-4 border transition-colors', statusColor)}>
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-xs font-semibold text-zinc-100">{node.name}</p>
          <p className="text-[10px] font-mono text-zinc-600 mt-0.5">{node.version}</p>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={cn('led', {
            idle:    'led-completed',
            running: 'led-running',
            offline: 'led-failed',
          }[node.status])} />
          <span className="text-[10px] font-mono uppercase text-zinc-600">{node.status}</span>
        </div>
      </div>

      <div className="space-y-2">
        <div>
          <div className="flex justify-between mb-1">
            <span className="text-[10px] font-mono text-zinc-600">CPU</span>
            <span className="text-[10px] font-mono text-zinc-500">{node.cpu_pct}%</span>
          </div>
          <BarMeter value={node.cpu_pct} accent={node.status === 'running'} />
        </div>
        <div>
          <div className="flex justify-between mb-1">
            <span className="text-[10px] font-mono text-zinc-600">MEM</span>
            <span className="text-[10px] font-mono text-zinc-500">{node.mem_pct}%</span>
          </div>
          <BarMeter value={node.mem_pct} />
        </div>
      </div>

      {node.current_task_id && (
        <p className="mt-3 text-[10px] font-mono text-cyan-600 truncate">
          task: {node.current_task_id.slice(0, 8)}
        </p>
      )}
      <p className="mt-1 text-[10px] font-mono text-zinc-700">
        last seen {age(node.last_seen)} ago
      </p>
    </div>
  );
}

export function NodeGrid({ nodes }: { nodes: NodeInfo[] }) {
  const { connected } = useWs();

  return (
    <div>
      {!connected && (
        <div className="mb-4 px-3 py-2 rounded-sm border border-amber-500/20 bg-amber-500/5 text-xs text-amber-400 font-mono">
          Core offline — node heartbeats unavailable
        </div>
      )}
      <div className="grid grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3">
        {nodes.map(n => <NodeCard key={n.id} node={n} />)}
      </div>
    </div>
  );
}
