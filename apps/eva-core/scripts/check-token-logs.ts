import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

async function main() {
  console.log('\n🔍 EVA Token Logs Diagnostic\n');

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.error('❌ Error: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set in apps/eva-core/.env');
    return;
  }

  console.log(`Connecting to Supabase at: ${url}`);
  const supabase = createClient(url, key);

  // 1. Fetch organization IDs to see what we have
  console.log('\n1️⃣  Fetching organizations...');
  const { data: orgs, error: orgsError } = await supabase.from('organizations').select('id, name');
  if (orgsError) {
    console.error('❌ Failed to fetch organizations:', orgsError.message);
    return;
  }
  
  if (!orgs || orgs.length === 0) {
    console.log('⚠️  No organizations found in the database.');
    return;
  }
  
  console.log(`✅ Found ${orgs.length} organization(s):`);
  orgs.forEach(o => console.log(`   - ${o.name} (id: ${o.id})`));

  const targetOrgId = orgs[0].id;

  // 2. Check token_logs table rows
  console.log('\n2️⃣  Checking token_logs rows...');
  const { data: logs, error: logsError } = await supabase
    .from('token_logs')
    .select('*')
    .limit(5);

  if (logsError) {
    console.error('❌ Failed to query token_logs:', logsError.message);
    console.log('💡 Tip: Make sure the 023_token_logs.sql migration was successfully executed on your database.');
    return;
  }

  console.log(`✅ token_logs query success. Found ${logs?.length ?? 0} log(s) in limit query.`);
  if (logs && logs.length > 0) {
    logs.forEach(l => {
      console.log(`   - [${l.created_at}] Model: ${l.model}, Type: ${l.request_type}, Tokens: ${l.total_tokens}, Cost: $${l.cost_usd}`);
    });
  } else {
    console.log('⚠️  token_logs table is empty. No LLM calls have been recorded yet.');
  }

  // 3. Test the get_billing_stats RPC function
  console.log('\n3️⃣  Testing get_billing_stats RPC...');
  const { data: stats, error: rpcError } = await supabase.rpc('get_billing_stats', {
    p_org_id: targetOrgId
  });

  if (rpcError) {
    console.error('❌ RPC get_billing_stats failed:', rpcError.message);
    console.log('💡 Tip: Ensure the SQL function was created successfully in public schema and permission was granted.');
  } else {
    console.log('✅ RPC get_billing_stats returned successfully:');
    console.log(JSON.stringify(stats, null, 2));
  }

  console.log('\nDiagnostic finished.\n');
}

main().catch((err) => {
  console.error('\n❌ Unexpected Error:', (err as Error).message);
  process.exit(1);
});
