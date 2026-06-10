import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { Topbar } from '@/components/layout/topbar';
import { McpClient } from '@/components/mcp/mcp-client';
import type { McpConnection } from '@/lib/types';

export const metadata: Metadata = { title: 'MCP' };
export const dynamic = 'force-dynamic';

export default async function McpPage() {
  const supabase = createClient();
  const { data: connections } = await supabase
    .from('mcp_connections')
    .select('id,name,transport,endpoint,enabled,status,tools,last_checked_at,last_error,updated_at')
    .order('name');

  return (
    <>
      <Topbar title="MCP" subtitle={`${connections?.length ?? 0} connections · Model Context Protocol`} />
      <div className="flex-1 min-h-0">
        <McpClient initialConnections={(connections ?? []) as McpConnection[]} />
      </div>
    </>
  );
}
