import { Injectable } from '@nestjs/common';
import {
  RealtimeEphemeralKey,
  WEAR_DEFAULT_MODEL,
  WEAR_TOKEN_TTL_SECONDS,
} from './wear-fast-path.types';

@Injectable()
export class WearRealtimeTokenProvider {
  private get openaiKey() {
    return process.env.OPENAI_API_KEY;
  }

  async createEphemeralKey(input: {
    orgId: string;
    userId: string;
    deviceId: string;
    model?: string;
  }): Promise<RealtimeEphemeralKey> {
    if (!this.openaiKey) {
      const expiresAt = Math.floor(Date.now() / 1000) + WEAR_TOKEN_TTL_SECONDS;
      return {
        value: `dev-wear-ek-${input.orgId}-${input.deviceId}-${expiresAt}`,
        expiresAt,
        sessionId: 'dev-realtime-session',
      };
    }

    const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.openaiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expires_after: {
          anchor: 'created_at',
          seconds: WEAR_TOKEN_TTL_SECONDS,
        },
        session: {
          type: 'realtime',
          model: input.model ?? WEAR_DEFAULT_MODEL,
          instructions: 'Fast Path Wear session: answer briefly. Do not call tools, access memory, or perform actions.',
          tools: [],
          metadata: {
            org_id: input.orgId,
            user_id: input.userId,
            device_id: input.deviceId,
            scope: 'wear_fast_path',
          },
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI realtime client secret failed ${response.status}: ${body}`);
    }

    const data = (await response.json()) as {
      value?: string;
      expires_at?: number;
      client_secret?: { value: string; expires_at: number };
      session?: { id?: string };
    };

    return {
      value: data.value ?? data.client_secret?.value ?? '',
      expiresAt: data.expires_at ?? data.client_secret?.expires_at ?? Math.floor(Date.now() / 1000) + WEAR_TOKEN_TTL_SECONDS,
      sessionId: data.session?.id ?? null,
    };
  }
}
