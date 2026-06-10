import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-custom';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class SupabaseJwtStrategy extends PassportStrategy(Strategy, 'supabase-jwt') {
  private readonly logger = new Logger(SupabaseJwtStrategy.name);

  constructor(private db: DatabaseService) {
    super();
  }

  async validate(req: any): Promise<{ userId: string; orgId: string; role: string; jwt: string }> {
    const authHeader: string | undefined = req.headers?.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
    if (!token) throw new UnauthorizedException('Missing bearer token');

    // Validate via Supabase — works for any JWT algorithm (HS256, RS256, etc.)
    const { data, error } = await this.db.admin.auth.getUser(token);
    if (error || !data?.user) {
      this.logger.warn(`Supabase auth.getUser failed: ${error?.message}`);
      throw new UnauthorizedException(error?.message ?? 'Invalid token');
    }

    const userId = data.user.id;
    let orgId: string | null = (data.user.app_metadata?.org_id as string) ?? null;

    if (!orgId) {
      const headerOrgId = req.headers?.['x-org-id'] as string | undefined;
      if (headerOrgId) {
        const { data: member } = await this.db.admin
          .from('users')
          .select('org_id')
          .eq('id', userId)
          .eq('org_id', headerOrgId)
          .maybeSingle();
        if (member) orgId = member.org_id;
      }
    }

    if (!orgId) {
      const { data: rows } = await this.db.admin
        .from('users')
        .select('org_id')
        .eq('id', userId)
        .limit(2);

      if (rows?.length === 1) orgId = rows[0].org_id;
    }

    if (!orgId) {
      throw new UnauthorizedException(
        'Cannot resolve org. Provide X-Org-Id header or embed org_id in JWT app_metadata.',
      );
    }

    return { userId, orgId, role: data.user.role ?? 'authenticated', jwt: token };
  }
}
