export interface JwtPayload {
  sub: string;        // user_id (auth.users.id)
  email?: string;
  role: string;
  aud: string;
  iat: number;
  exp: number;
  app_metadata?: {
    org_id?: string;  // optional single-org shortcut in JWT
    [key: string]: unknown;
  };
}

export interface AuthenticatedRequest extends Express.Request {
  user: {
    userId: string;
    orgId: string;
    role: string;
    jwt: string;
  };
}
