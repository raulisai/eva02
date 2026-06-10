/**
 * Conversation-vs-task triage. Deliberately rule-based and cheap: ~80% of
 * traffic is small talk or simple questions that must hit the model directly
 * with zero pipeline overhead.
 */
export type Tier = 'chat' | 'quick' | 'long';

export interface TierDecision {
  tier: Tier;
  estimateSec: number;
  reason: string;
}

const LONG_SIGNALS = /\b(script|c[oó]digo|programa|automatiza|bot\b|scraper|scrape|docker|deploy|despliega|proyecto|integra|monitorea|cron|cada (hora|d[ií]a|semana)|paso a paso|varios pasos|informe completo|reporte completo|migra|refactoriza)\b/i;

const QUICK_SIGNALS = /\b(busca|buscar|b[uú]squeda|clima|tiempo en|precio|cotiza|noticias|tipo de cambio|convierte|cu[aá]nto (cuesta|vale|es)|resume|revisa|traduce|correo|email|notificaciones|agenda|recu[eé]rdame|define|qu[eé] es|actual|hoy|ma[nñ]ana|ayer|[uú]ltim[ao]s?|reciente|en vivo|ahora|mundial|munidal|world cup|fifa|partidos?|jugar[aá]|calendario|fixture|selecci[oó]n|grupos?|imagen|im[aá]genes|foto|dibuja|dibujo|ilustra|ilustraci[oó]n|logo|direcci[oó]n|ubicaci[oó]n|tel[eé]fono|horario|restaurante|comida|recomienda|recomendaci[oó]n)\b/i;

const GREETING = /^(hola|hey|buenas|buenos d[ií]as|buenas tardes|buenas noches|qu[eé] tal|c[oó]mo est[aá]s|gracias|ok|vale|jaja|adi[oó]s|bye)\b/i;

// Money/production/data actions must NEVER take the chat shortcut — they have
// to flow through intent classification and the approval gate.
const SENSITIVE = /\b(compra|comprar|paga|pagar|transfiere|env[ií]a dinero|deploy|producci[oó]n|borra|elimina|delete|drop)\b/i;

export function classifyTier(text: string): TierDecision {
  const input = text.trim();

  if (LONG_SIGNALS.test(input) || input.length > 280) {
    return { tier: 'long', estimateSec: 120, reason: LONG_SIGNALS.test(input) ? 'automation/code signals' : 'long order' };
  }
  if (SENSITIVE.test(input)) {
    return { tier: 'quick', estimateSec: 30, reason: 'sensitive action — full pipeline + approval gate' };
  }
  if (QUICK_SIGNALS.test(input)) {
    return { tier: 'quick', estimateSec: 20, reason: 'lookup/search signals' };
  }
  if (GREETING.test(input) || input.length <= 140) {
    return { tier: 'chat', estimateSec: 3, reason: GREETING.test(input) ? 'greeting' : 'short conversational input' };
  }
  return { tier: 'quick', estimateSec: 30, reason: 'default medium' };
}
