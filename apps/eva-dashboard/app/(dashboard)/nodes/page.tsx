import type { Metadata } from 'next';
import { Topbar } from '@/components/layout/topbar';
import { NodeGrid } from '@/components/nodes/node-grid';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { NodeInfo } from '@/lib/types';

export const metadata: Metadata = { title: 'Nodes' };

// Mock data — replace with real API once node heartbeat endpoint is built
const MOCK_NODES: NodeInfo[] = [
  { id: 'n-001', name: 'eva-node-01', status: 'running', last_seen: new Date(Date.now() - 3000).toISOString(), current_task_id: 'cccc-0001-demo', cpu_pct: 72, mem_pct: 45, version: 'v0.1.0' },
  { id: 'n-002', name: 'eva-node-02', status: 'idle',    last_seen: new Date(Date.now() - 8000).toISOString(), current_task_id: null, cpu_pct: 4,  mem_pct: 31, version: 'v0.1.0' },
  { id: 'n-003', name: 'eva-node-03', status: 'offline', last_seen: new Date(Date.now() - 120000).toISOString(), current_task_id: null, cpu_pct: 0, mem_pct: 0,  version: 'v0.1.0' },
];

export default function NodesPage() {
  return (
    <>
      <Topbar title="Nodes" subtitle={`${MOCK_NODES.filter(n => n.status !== 'offline').length}/${MOCK_NODES.length} online`} />
      <ScrollArea className="flex-1">
        <div className="p-4">
          <NodeGrid nodes={MOCK_NODES} />
        </div>
      </ScrollArea>
    </>
  );
}
