import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import { Topbar } from '@/components/layout/topbar';
import { TaskDetail } from '@/components/tasks/task-detail';
import type { Task } from '@/lib/types';

export const metadata: Metadata = { title: 'Task Detail' };
export const dynamic = 'force-dynamic';

export default async function TaskDetailPage({ params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: task } = await supabase
    .from('tasks')
    .select('*')
    .eq('id', params.id)
    .maybeSingle();

  if (!task) notFound();

  return (
    <>
      <Topbar
        title="Task Detail"
        subtitle={params.id.slice(0, 8)}
        actions={
          <Link
            href="/tasks"
            className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <ChevronLeft className="w-3 h-3" />Back
          </Link>
        }
      />
      <div className="flex-1 min-h-0">
        <TaskDetail task={task as Task} />
      </div>
    </>
  );
}
