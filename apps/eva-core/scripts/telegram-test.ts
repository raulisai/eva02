/**
 * Telegram diagnostic & test script.
 *
 * Usage:
 *   cd apps/eva-core
 *   npx ts-node scripts/telegram-test.ts
 *
 * What it does:
 *   1. Decrypts the stored bot token (using EVA_SECRETS_KEY from .env)
 *   2. Calls Telegram getMe  — verifies the token is valid
 *   3. Calls Telegram getWebhookInfo — shows current webhook URL
 *   4. Sends a "Hello World" test message to the configured chat (allowed_user_ids)
 */

import 'dotenv/config';
import { createDecipheriv, createHash } from 'crypto';

// ─── inline decrypt (same logic as SecretCipher) ───────────────────────────
function decrypt(ciphertext: string): string {
  const raw = process.env.EVA_SECRETS_KEY;
  if (!raw) throw new Error('EVA_SECRETS_KEY is not set');
  const key = createHash('sha256').update(raw).digest();
  const [version, iv, tag, data] = ciphertext.split(':');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Bad ciphertext format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

// ─── Telegram helpers ───────────────────────────────────────────────────────
async function tg<T = unknown>(token: string, method: string, body?: object): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!json.ok) throw new Error(`Telegram ${method} failed: ${json.description}`);
  return json.result as T;
}

// ─── Supabase fetch to get the stored ciphertext ───────────────────────────
async function getStoredCiphertext(): Promise<{ secretCiphertext: string; allowedUserIds: string }> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');

  const res = await fetch(
    `${url}/rest/v1/org_integrations?provider=eq.telegram&kind=eq.channel&select=secret_ciphertext,config`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
  );
  const rows = (await res.json()) as Array<{ secret_ciphertext: string; config: { allowed_user_ids?: string } }>;
  if (!rows.length) throw new Error('No Telegram integration found in org_integrations');
  const row = rows[0];
  return {
    secretCiphertext: row.secret_ciphertext,
    allowedUserIds: String(row.config?.allowed_user_ids ?? ''),
  };
}

// ─── main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🔍 EVA Telegram Diagnostic\n');

  // 1. Get stored token
  console.log('1️⃣  Fetching stored bot token from Supabase...');
  const { secretCiphertext, allowedUserIds } = await getStoredCiphertext();
  const token = decrypt(secretCiphertext);
  console.log(`   ✅ Token decrypted (hint: ••••${token.slice(-4)})`);

  // 2. Verify token with Telegram
  console.log('\n2️⃣  Calling Telegram getMe...');
  const me = await tg<{ username: string; id: number }>(token, 'getMe');
  console.log(`   ✅ Bot: @${me.username} (id: ${me.id})`);

  // 3. Check webhook
  console.log('\n3️⃣  Checking registered webhook...');
  const webhook = await tg<{
    url: string;
    has_custom_certificate: boolean;
    pending_update_count: number;
    last_error_message?: string;
    last_error_date?: number;
  }>(token, 'getWebhookInfo');
  if (webhook.url) {
    console.log(`   📌 Webhook URL: ${webhook.url}`);
    console.log(`   📬 Pending updates: ${webhook.pending_update_count}`);
    if (webhook.last_error_message) {
      console.log(`   ⚠️  Last error: ${webhook.last_error_message}`);
    }
  } else {
    console.log('   ❌ NO WEBHOOK REGISTERED — bot will not receive messages');
    console.log('   → Fix: set PUBLIC_WEBHOOK_URL in .env, then call POST /integrations/channel/telegram/webhook');
  }

  // 4. Send hello world test message
  const chatId = allowedUserIds.split(',')[0]?.trim();
  if (!chatId) {
    console.log('\n4️⃣  ❌ No chat_id found in allowed_user_ids config — skipping test message');
    return;
  }

  console.log(`\n4️⃣  Sending Hello World test to chat ${chatId}...`);
  const msg = await tg<{ message_id: number }>(token, 'sendMessage', {
    chat_id: chatId,
    text: '👋 *Hello World!*\n\nEste es un mensaje de test de EVA.\nEl bot está funcionando correctamente. ✅',
    parse_mode: 'Markdown',
  });
  console.log(`   ✅ Message sent! message_id: ${msg.message_id}`);

  console.log('\n✅ Diagnostic complete.\n');

  // 5. Summary
  console.log('─────────────────────────────────────');
  console.log('📋 NEXT STEPS:');
  if (!webhook.url) {
    console.log('  1. Set PUBLIC_WEBHOOK_URL=https://<your-public-url> in .env');
    console.log('  2. Restart the server');
    console.log('  3. Call: POST /integrations/channel/telegram/webhook  (with your JWT)');
    console.log('  4. Message the bot — it will reply with your Telegram ID');
    console.log('  5. Go to Dashboard → Integrations → Telegram → Link Account');
  } else {
    console.log('  1. Message the bot from Telegram');
    console.log('  2. If no response: check pending_update_count and last_error in this output');
    console.log('  3. Link your account via Dashboard → Integrations → Telegram');
  }
  console.log('─────────────────────────────────────\n');
}

main().catch((err) => {
  console.error('\n❌ Error:', (err as Error).message);
  process.exit(1);
});
