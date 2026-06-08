import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { APP_GUARD } from '@nestjs/core';
import { SupabaseJwtStrategy } from './supabase-jwt.strategy';
import { JwtAuthGuard } from './jwt-auth.guard';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [PassportModule, DatabaseModule],
  providers: [
    SupabaseJwtStrategy,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
  exports: [SupabaseJwtStrategy],
})
export class AuthModule {}
