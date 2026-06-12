/**
 * Conversation-vs-task triage. Deliberately rule-based and cheap: ~80% of
 * traffic is small talk or simple questions that must hit the model directly
 * with zero pipeline overhead.
 */
export type Tier = 'chat' | 'quick' | 'medium' | 'long';

export interface TierDecision {
  tier: Tier;
  estimateSec: number;
  reason: string;
}

const LONG_SIGNALS = /\b(script|c[oó]digo|programa|automatiz|bot\b|scrap|docker|deploy|desplieg|proyect|integr|monitor|cron\b|cada (hora|d[ií]a|semana)|paso a paso|varios pasos|informe completo|reporte completo|migr|refactoriz|descarg|download|youtube|youtu\.be|platzi|udemy|vimeo|video|v[ií]deo|mp3|mp4|yt-dlp|m[aá]nd(?:a|e|o|ar)|env[ií](?:a|e|o|ar)|comprim|convert|extra[eí])/i;

// Medium signals indicate tasks requiring reasoning, multi-day/range queries,
// comparisons, or conditional step-by-step logic.
const MEDIUM_SIGNALS = /\b(compara|comparar|diferencia|vs|versus|siguientes?\s+\d+|pr[oó]ximos?\s+\d+|\d+\s+d[ií]as?|tres\s+d[ií]as?|cinco\s+d[ií]as?|semana|semanal|fin de semana|luego|despu[eé]s|y tambi[eé]n|y despu[eé]s|adem[aá]s|si\b.*\bentonces|analiza|analizar|eval[uú]a|evaluar|resume y|busca y|[uú]ltimos?\s+\d+|pr[oó]ximos?\s+\d+)\b|\by\s+(?:resum|revis|busc|compar|analiz|eval|dame|muestr|crea|env[ií]|escrib|pide|haz|hacer)[a-z]*\b|\b(?:hoy|ma[nñ]ana|ayer)\s+y\s+(?:hoy|ma[nñ]ana|ayer)\b/i;

const QUICK_SIGNALS = /\b(b[uú]sc|clima|tiempo en|precio|cotiz|noticias|tipo de cambio|convert|conviert|cu[aá]nto (cuesta|vale|es)|resum|revis|traduc|correo|email|notificaciones|agenda|recu[eé]rd|defin|qu[eé] es|actual|hoy|ma[nñ]ana|ayer|[uú]ltim[ao]s?|reciente|en vivo|ahora|recet|recipe|cocin|ingrediente|mundial|munidal|world cup|fifa|partido|jugar[aá]|calendario|fixture|selecci[oó]n|grupo|imagen|im[aá]gen|foto|dibuj|ilustr|logo|direcci[oó]n|ubicaci[oó]n|tel[eé]fono|horario|restaurante|comida|recomiend|drive|google drive|mis archivos|mis documentos|mis carpetas|mis docs|archivo|carpeta|telegram)/i;

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
  if (MEDIUM_SIGNALS.test(input) || (input.length > 140 && QUICK_SIGNALS.test(input))) {
    return { tier: 'medium', estimateSec: 45, reason: MEDIUM_SIGNALS.test(input) ? 'reasoning/multi-step signals' : 'moderately complex input' };
  }
  if (QUICK_SIGNALS.test(input)) {
    return { tier: 'quick', estimateSec: 20, reason: 'lookup/search signals' };
  }
  if (GREETING.test(input) || input.length <= 140) {
    return { tier: 'chat', estimateSec: 3, reason: GREETING.test(input) ? 'greeting' : 'short conversational input' };
  }
  return { tier: 'quick', estimateSec: 30, reason: 'default medium' };
}

