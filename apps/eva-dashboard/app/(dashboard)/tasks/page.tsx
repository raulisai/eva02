import type { Metadata } from 'next';
import { requireOrgContext } from '@/lib/supabase/org';
import { Topbar } from '@/components/layout/topbar';
import { TaskList } from '@/components/tasks/task-list';
import type { Task } from '@/lib/types';

export const metadata: Metadata = { title: 'Tasks' };

export const dynamic = 'force-dynamic';

export default async function TasksPage() {
  const { supabase, orgId } = await requireOrgContext();

  const { data: tasks } = await supabase
    .from('tasks')
    .select('*')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(100);

  return (
    <>
      <Topbar title="Tasks" subtitle={`${tasks?.length ?? 0} loaded`} />
      <div className="flex-1 min-h-0">
        <TaskList initialTasks={(tasks ?? []) as Task[]} />
      </div>
    </>
  );
}
