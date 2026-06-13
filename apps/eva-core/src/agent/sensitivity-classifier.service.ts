import { Injectable } from '@nestjs/common';
import { SecretCipher } from '../common/secret-cipher';

export type ProfileSensitivity = 'normal' | 'personal' | 'sensitive';

export interface SensitivityResult {
  sensitivity: ProfileSensitivity;
  reason: string;
  hint?: string;
}

@Injectable()
export class SensitivityClassifierService {
  classify(input: string): SensitivityResult {
    const text = input.trim();
    if (!text) return { sensitivity: 'normal', reason: 'empty' };

    const lower = text.toLowerCase();
    if (/(password|contraseña|token|api key|secret|otp|2fa|cvv|nip|pin\b)/i.test(text)) {
      return { sensitivity: 'sensitive', reason: 'credential', hint: 'Credencial privada' };
    }
    if (/\b(?:\d[ -]*?){13,19}\b/.test(text)) {
      return { sensitivity: 'sensitive', reason: 'payment_card', hint: `Tarjeta ${SecretCipher.hint(text.replace(/\D/g, ''))}` };
    }
    if (/\b[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}\b/i.test(text)) {
      return { sensitivity: 'sensitive', reason: 'tax_id', hint: 'Identificador fiscal privado' };
    }
    if (/\b[A-Z][AEIOU][A-Z]{2}\d{6}[HM][A-Z]{5}[A-Z0-9]\d\b/i.test(text)) {
      return { sensitivity: 'sensitive', reason: 'curp', hint: 'CURP privada' };
    }
    if (/(diagn[oó]stico|medicamento|terapia|alergia|enfermedad|ansiedad|depresi[oó]n|cirug[ií]a)/i.test(text)) {
      return { sensitivity: 'sensitive', reason: 'health', hint: 'Dato de salud privado' };
    }
    const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
    if (email) {
      return { sensitivity: 'personal', reason: 'email', hint: this.maskEmail(email) };
    }
    const phoneDigits = text.match(/(?:\+?\d[\s().-]*){8,}/)?.[0]?.replace(/\D/g, '');
    if (phoneDigits && phoneDigits.length >= 8) {
      return { sensitivity: 'personal', reason: 'phone', hint: SecretCipher.hint(phoneDigits) };
    }
    if (/(direcci[oó]n|calle|avenida|colonia|cp\b|c[oó]digo postal|domicilio)/i.test(lower)) {
      return { sensitivity: 'personal', reason: 'address', hint: 'Direccion personal' };
    }

    return { sensitivity: 'normal', reason: 'general' };
  }

  private maskEmail(email: string): string {
    const [local, domain] = email.split('@');
    if (!domain) return 'Email privado';
    return `${local.slice(0, 2)}•••@${domain}`;
  }
}
