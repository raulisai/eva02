import 'dotenv/config';
import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  console.log('🚀 Running SQL Migration...');

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('❌ Error: DATABASE_URL not set in apps/eva-core/.env');
    return;
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    const sqlPath = path.join(__dirname, '../../supabase/migrations/024_fix_billing_stats_rpc.sql');
    console.log(`Reading SQL file from: ${sqlPath}`);
    const sql = fs.readFileSync(sqlPath, 'utf8');

    console.log('Executing SQL...');
    await client.query(sql);
    console.log('✅ SQL executed successfully!');
  } catch (err) {
    console.error('❌ SQL execution failed:', (err as Error).message);
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error('❌ Error in migration execution:', err);
});
