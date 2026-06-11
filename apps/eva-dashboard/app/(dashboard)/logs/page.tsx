import type { Metadata } from 'next';
import { Topbar } from '@/components/layout/topbar';
import { LogConsole } from '@/components/debug/log-console';

export const metadata: Metadata = { title: 'Debug Logs' };

export default function LogsPage() {
  return (
    <>
      <Topbar title="Debug Logs" subtitle="live system trace" />
      <div className="flex-1 min-h-0">
        <LogConsole mode="page" />
      </div>
    </>
  );
}
