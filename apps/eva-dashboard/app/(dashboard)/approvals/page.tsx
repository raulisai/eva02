import type { Metadata } from 'next';
import { ShieldCheck } from 'lucide-react';
import { Topbar } from '@/components/layout/topbar';

export const metadata: Metadata = { title: 'Approvals' };

export default function ApprovalsPage() {
  return (
    <>
      <Topbar title="Approvals" subtitle="Approval Engine · action_hash + nonce" />
      <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
        <div className="w-14 h-14 rounded-full bg-zinc-800/60 border border-zinc-700 flex items-center justify-center mb-4">
          <ShieldCheck className="w-6 h-6 text-zinc-600" />
        </div>
        <h2 className="text-sm font-semibold text-zinc-400 mb-2">Approval Engine</h2>
        <p className="text-xs text-zinc-600 font-mono max-w-xs leading-relaxed">
          Pending approvals will appear here. Any action involving money, production
          data, or external APIs requires an explicit approval with action_hash + nonce
          before execution.
        </p>
        <div className="mt-6 px-4 py-3 rounded-sm border border-zinc-800 bg-zinc-900/50 font-mono text-xs text-zinc-600 max-w-sm">
          <p className="text-zinc-500 mb-1">→ Implementing in next sprint:</p>
          <p>• List pending approvals</p>
          <p>• Approve / Reject with 2FA</p>
          <p>• Audit trail</p>
          <p>• Expiry countdown</p>
        </div>
      </div>
    </>
  );
}
