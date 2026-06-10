import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { DatabaseService } from '../database/database.service';
import { JwtPayload } from '../common/types';

@Injectable()
export class SupabaseJwtStrategy extends PassportStrategy(Strategy, 'supabase-jwt') {
  constructor(private db: DatabaseService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.SUPABASE_JWT_SECRET ?? 'super-secret-jwt-token-with-at-least-32-characters-long',
      passReqToCallback: true,
    });
  }

  async validate(req: Express.Request, payload: JwtPayload) {
    const userId = payload.sub;
    if (!userId) throw new UnauthorizedException('Invalid token: missing sub');

    // Resolve org_id: prefer JWT claim, fall back to DB lookup
    let orgId: string | null = payload.app_metadata?.org_id ?? null;

    if (!orgId) {
      const headerOrgId = (req as any).headers?.['x-org-id'] as string | undefined;
      if (headerOrgId) {
        // Validate the user actually belongs to this org
        const member = await this.db.admin
          .from('users')
          .select('org_id')
          .eq('id', userId)
          .eq('org_id', headerOrgId)
          .maybeSingle();

        if (member.data) orgId = member.data.org_id;
      }
    }

    if (!orgId) {
      // Auto-select if user belongs to exactly one org
      const { data } = await this.db.admin
        .from('users')
        .select('org_id')
        .eq('id', userId)
        .limit(2);

      if (data?.length === 1) {
        orgId = data[0].org_id;
      }
    }

    if (!orgId) {
      throw new UnauthorizedException(
        'Cannot resolve org. Provide X-Org-Id header or embed org_id in JWT app_metadata.',
      );
    }

    const rawJwt = ExtractJwt.fromAuthHeaderAsBearerToken()(req as any) ?? '';

    return {
      userId,
      orgId,
      role: payload.role,
      jwt: rawJwt,
    };
  }
}
