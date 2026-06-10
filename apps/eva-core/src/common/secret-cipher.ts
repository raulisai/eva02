import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'crypto';

const VERSION = 'v1';

/**
 * AES-256-GCM cipher for org-level secrets (provider API keys, bot tokens).
 * Key material comes from EVA_SECRETS_KEY; ciphertext format is
 * `v1:<iv>:<authTag>:<data>` (base64 segments).
 */
export class SecretCipher {
  private static key(): Buffer {
    const raw = process.env.EVA_SECRETS_KEY;
    if (!raw) {
      throw new Error('EVA_SECRETS_KEY is not set — cannot encrypt/decrypt org secrets');
    }
    return createHash('sha256').update(raw).digest();
  }

  static encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(':');
  }

  static decrypt(ciphertext: string): string {
    const [version, iv, tag, data] = ciphertext.split(':');
    if (version !== VERSION || !iv || !tag || !data) {
      throw new Error('Invalid secret ciphertext format');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  }

  /** Last 4 chars for display, e.g. "••••abcd". Never returns the secret. */
  static hint(plaintext: string): string {
    return `••••${plaintext.slice(-4)}`;
  }

  /** Constant-time string comparison (webhook secrets, tokens). */
  static safeEqual(a: string | undefined, b: string | undefined): boolean {
    if (!a || !b) return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }
}
