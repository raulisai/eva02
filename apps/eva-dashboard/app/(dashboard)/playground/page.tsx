import type { Metadata } from 'next';
import { Topbar } from '@/components/layout/topbar';
import { PlaygroundClient } from '@/components/playground/playground-client';

export const metadata: Metadata = { title: 'Playground' };
export const dynamic = 'force-dynamic';

export default function PlaygroundPage() {
  return (
    <>
      <Topbar title="Playground" subtitle="submit an order · watch it move through the pipeline" />
      <div className="flex-1 min-h-0">
        <PlaygroundClient />
      </div>
    </>
  );
}
