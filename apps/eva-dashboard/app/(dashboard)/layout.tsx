import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { Sidebar } from '@/components/layout/sidebar';
import { ToastProvider } from '@/components/ui/toast';
import { WsProvider } from '@/hooks/use-ws';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient();
  // Always use getUser() (network-validated) not getSession() for auth checks
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token ?? '';

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100 overflow-hidden">
      <WsProvider token={token}>
        <ToastProvider>
          <Sidebar />
          <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
            {children}
          </main>
        </ToastProvider>
      </WsProvider>
    </div>
  );
}
