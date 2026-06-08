import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class DatabaseService implements OnModuleInit {
  private readonly logger = new Logger(DatabaseService.name);
  private adminClient!: SupabaseClient;

  onModuleInit() {
    const url = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !serviceKey) {
      this.logger.warn(
        'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — using mock client for tests',
      );
      // In test environments the client may be provided via override
      return;
    }

    this.adminClient = createClient(url, serviceKey, {
      auth: { persistSession: false },
    });
  }

  /** Service-role client. ALWAYS add .eq('org_id', orgId) to every query. */
  get admin(): SupabaseClient {
    return this.adminClient;
  }

  /**
   * Returns a client that uses the caller's JWT, so Supabase RLS applies.
   * Use this when you want the database to enforce access control as the second layer.
   */
  forUser(jwt: string): SupabaseClient {
    return createClient(
      process.env.SUPABASE_URL ?? '',
      process.env.SUPABASE_ANON_KEY ?? '',
      {
        global: { headers: { Authorization: `Bearer ${jwt}` } },
        auth: { persistSession: false },
      },
    );
  }

  /** Convenience: set the service client (used in tests to inject mocks). */
  setAdminClient(client: SupabaseClient) {
    this.adminClient = client;
  }
}
