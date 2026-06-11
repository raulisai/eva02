import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import { Topbar } from '@/components/layout/topbar';
import { TaskDetail } from '@/components/tasks/task-detail';
import type { Task, TokenLog } from '@/lib/types';

export const metadata: Metadata = { title: 'Task Detail' };
export const dynamic = 'force-dynamic';

export default async function TaskDetailPage({ params }: { params: { id: string } }) {
  const supabase = createClient();

  // Authenticate and get user
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Resolve user's organization ID
  const { data: profile } = await supabase
    .from('users')
    .select('org_id')
    .eq('id', user.id)
    .single();
    
  if (!profile?.org_id) redirect('/login');

  // Query the task, filtering by org_id
  const { data: task } = await supabase
    .from('tasks')
    .select('*')
    .eq('id', params.id)
    .eq('org_id', profile.org_id)
    .maybeSingle();

  if (!task) notFound();

  // Query token logs for this task, filtering by org_id
  const { data: tokenLogs } = await supabase
    .from('token_logs')
    .select('*')
    .eq('task_id', params.id)
    .eq('org_id', profile.org_id)
    .order('created_at', { ascending: true });

  // Query task events for this task, filtering by org_id
  const { data: dbEvents } = await supabase
    .from('task_events')
    .select('*')
    .eq('task_id', params.id)
    .eq('org_id', profile.org_id)
    .order('created_at', { ascending: true });

  const initialEvents = (dbEvents || []).map(e => ({
    id: e.id,
    type: e.event_type,
    orgId: e.org_id,
    taskId: e.task_id,
    payload: e.payload || {},
    ts: new Date(e.created_at).getTime(),
  }));

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
        <TaskDetail
          task={task as Task}
          tokenLogs={(tokenLogs || []) as TokenLog[]}
          initialEvents={initialEvents}
        />
      </div>
    </>
  );
}

