/**
 * Conversation-vs-task triage. Deliberately rule-based and cheap: ~80% of
 * traffic is small talk or simple questions that must hit the model directly
 * with zero pipeline overhead.
 */
export type Tier = 'chat' | 'quick' | 'medium' | 'long';
export type TaskHorizonMode = 'conversation' | 'immediate' | 'background' | 'scheduled' | 'standby' | 'approval';
export type TaskWaitPolicy = 'none' | 'approval' | 'user_input' | 'external_event' | 'schedule';
export type TaskDurationBand = 'seconds' | 'minutes' | 'hours' | 'indefinite';

export interface TierDecision {
  tier: Tier;
  estimateSec: number;
  reason: string;
}

export interface TaskHorizonDecision extends TierDecision {
  mode: TaskHorizonMode;
  waitPolicy: TaskWaitPolicy;
  durationBand: TaskDurationBand;
  expectedDurationSec: number;
  resumable: boolean;
  shouldCreateScheduledJob: boolean;
  shouldUseCodeTools: boolean;
  shouldUseSkills: boolean;
  shouldSelfImprove: boolean;
  timeoutMinutes?: number;
  summary: string;
}

const LONG_SIGNALS = /\b(script|c[oó]digo|programa|automatiz|bot\b|scrap|docker|deploy|desplieg|proyect|integr|monitor|cron\b|cada (hora|d[ií]a|semana)|paso a paso|varios pasos|informe completo|reporte completo|migr|refactoriz|descarg(?:a|ar|ue|uen|ando|ad[ao]s?)?(?:melo|mela|noslo|nosla|selo|sela|lo|la|me|nos)?|download|youtube|youtu\.be|platzi|udemy|vimeo|video|v[ií]deo|mp3|mp4|yt-dlp|m[aá]nd(?:a|e|o|ar|alo|ala|ame|eme|amelo|amela|aselo|asela|eselo|esela)|env[ií](?:a|e|o|ar|alo|ala|ame|eme|amelo|amela|aselo|asela|eselo|esela)|comprim|convert|extra[eí])/i;

// Medium signals indicate tasks requiring reasoning, multi-day/range queries,
// comparisons, or conditional step-by-step logic.
const MEDIUM_SIGNALS = /\b(compara|comparar|diferencia|vs|versus|siguientes?\s+\d+|pr[oó]ximos?\s+\d+|\d+\s+d[ií]as?|tres\s+d[ií]as?|cinco\s+d[ií]as?|semana|semanal|fin de semana|luego|despu[eé]s|y tambi[eé]n|y despu[eé]s|adem[aá]s|si\b.*\bentonces|analiza|analizar|eval[uú]a|evaluar|resume y|busca y|[uú]ltimos?\s+\d+|pr[oó]ximos?\s+\d+)\b|\by\s+(?:resum|revis|busc|compar|analiz|eval|dame|muestr|crea|env[ií]|escrib|pide|haz|hacer)[a-z]*\b|\b(?:hoy|ma[nñ]ana|ayer)\s+y\s+(?:hoy|ma[nñ]ana|ayer)\b/i;

const QUICK_SIGNALS = /\b(b[uú]sc|clima|tiempo en|precio|cotiz|noticias|tipo de cambio|convert|conviert|cu[aá]nto (cuesta|vale|es)|resum|revis|traduc|correo|email|notificaciones|agenda|recu[eé]rd(?:a|ame|eme|amelo|amela|aselo|asela|eselo|esela|alo|ala|ar)?|defin|qu[eé] es|actual|hoy|ma[nñ]ana|ayer|[uú]ltim[ao]s?|reciente|en vivo|ahora|recet|recipe|cocin|ingrediente|mundial|munidal|world cup|fifa|partido|jugar[aá]|calendario|fixture|selecci[oó]n|grupo|imagen|im[aá]gen|foto|dibuj|ilustr|logo|direcci[oó]n|ubicaci[oó]n|tel[eé]fono|horario|restaurante|comida|recomiend|drive|google drive|mis archivos|mis documentos|mis carpetas|mis docs|archivo|carpeta|telegram)/i;

const GREETING = /^(hola|hey|buenas|buenos d[ií]as|buenas tardes|buenas noches|qu[eé] tal|c[oó]mo est[aá]s|gracias|ok|vale|jaja|adi[oó]s|bye)\b/i;

// Money/production/data actions must NEVER take the chat shortcut — they have
// to flow through intent classification and the approval gate.
const SENSITIVE = /\b(compra|comprar|paga|pagar|transfiere|env[ií]a dinero|deploy|producci[oó]n|borra|elimina|delete|drop)\b/i;

const SCHEDULE_HORIZON_SIGNALS =
  /\b(cron\b|programa[r]?\s+(?:un\s+)?(?:job|recordatorio|tarea)|tarea\s+programada|recu[eé]rd(?:a|ame|eme|amelo|amela|alo|ala|ar)?|av[ií]same|notif[ií]came|cada\s+(?:hora|d[ií]a|semana|mes|\d+\s*(?:minutos?|horas?|d[ií]as?))|todos\s+los\s+(?:d[ií]as|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados?|domingos?)|a\s+partir\s+de\s+hoy|monitor(?:ea|ear|iza|izar)|vigila(?:r)?|cuando\s+(?:baje|suba|cambie|est[eé]\s+disponible)|si\s+(?:baja|sube|cambia|se\s+cae|vuelve))\b/i;

const STANDBY_HORIZON_SIGNALS =
  /\b(stand\s*by|pausa(?:do|da|r)?|qu[eé]date\s+en\s+pausa|espera\s+(?:a\s+que|hasta)|hasta\s+que|en\s+cuanto|cuando\s+(?:me|te|nos|le|les)?\s*(?:conteste|responda|llegue|aparezca|termine|avise)|si\s+(?:me|te|nos|le|les)?\s*(?:contesta|responde|avisa)|pendiente\s+de\s+respuesta|mientras\s+(?:contesta|responde|llega))\b/i;

const SELF_IMPROVEMENT_SIGNALS =
  /\b(skill|skills|aprend(?:e|er|izaje)|mejor(?:a|arse|arte|amiento)|memoria\s+procedural|procedimental|hermes|agente\s+cero|agent\s+zero|c[oó]digo|script|terminal|sandbox|automatiz|refactoriz|debug|depur)\b/i;

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

export function decideTaskHorizon(text: string, tierDecision: TierDecision = classifyTier(text)): TaskHorizonDecision {
  const input = text.trim();
  const scheduled = SCHEDULE_HORIZON_SIGNALS.test(input);
  const standby = STANDBY_HORIZON_SIGNALS.test(input);
  const approval = SENSITIVE.test(input);
  const codeOrProcedural = LONG_SIGNALS.test(input) || SELF_IMPROVEMENT_SIGNALS.test(input);

  if (approval) {
    return {
      ...tierDecision,
      mode: 'approval',
      waitPolicy: 'approval',
      durationBand: 'indefinite',
      expectedDurationSec: Math.max(tierDecision.estimateSec, 30),
      resumable: true,
      shouldCreateScheduledJob: false,
      shouldUseCodeTools: codeOrProcedural,
      shouldUseSkills: true,
      shouldSelfImprove: codeOrProcedural,
      summary: 'sensitive action parked behind Approval Engine',
    };
  }

  if (scheduled) {
    return {
      ...tierDecision,
      mode: 'scheduled',
      waitPolicy: 'schedule',
      durationBand: 'indefinite',
      expectedDurationSec: Math.max(tierDecision.estimateSec, 60),
      resumable: true,
      shouldCreateScheduledJob: true,
      shouldUseCodeTools: codeOrProcedural,
      shouldUseSkills: true,
      shouldSelfImprove: codeOrProcedural,
      summary: 'recurring/monitoring work should become a visible scheduled_job',
    };
  }

  if (standby) {
    return {
      ...tierDecision,
      mode: 'standby',
      waitPolicy: 'external_event',
      durationBand: 'indefinite',
      expectedDurationSec: Math.max(tierDecision.estimateSec, 60 * 60),
      resumable: true,
      shouldCreateScheduledJob: false,
      shouldUseCodeTools: codeOrProcedural,
      shouldUseSkills: true,
      shouldSelfImprove: codeOrProcedural,
      timeoutMinutes: 24 * 60,
      summary: 'task should pause until an external/user signal arrives',
    };
  }

  if (tierDecision.tier === 'long') {
    return {
      ...tierDecision,
      mode: 'background',
      waitPolicy: 'none',
      durationBand: 'hours',
      expectedDurationSec: Math.max(tierDecision.estimateSec, 2 * 60 * 60),
      resumable: true,
      shouldCreateScheduledJob: false,
      shouldUseCodeTools: codeOrProcedural,
      shouldUseSkills: true,
      shouldSelfImprove: true,
      summary: 'long-running background work with checkpoints and procedural learning',
    };
  }

  if (tierDecision.tier === 'medium') {
    return {
      ...tierDecision,
      mode: 'immediate',
      waitPolicy: 'none',
      durationBand: 'minutes',
      expectedDurationSec: Math.max(tierDecision.estimateSec, 3 * 60),
      resumable: true,
      shouldCreateScheduledJob: false,
      shouldUseCodeTools: codeOrProcedural,
      shouldUseSkills: true,
      shouldSelfImprove: codeOrProcedural,
      summary: 'multi-step immediate work',
    };
  }

  return {
    ...tierDecision,
    mode: tierDecision.tier === 'chat' ? 'conversation' : 'immediate',
    waitPolicy: 'none',
    durationBand: 'seconds',
    expectedDurationSec: tierDecision.estimateSec,
    resumable: false,
    shouldCreateScheduledJob: false,
    shouldUseCodeTools: codeOrProcedural,
    shouldUseSkills: tierDecision.tier !== 'chat' || codeOrProcedural,
    shouldSelfImprove: codeOrProcedural,
    summary: tierDecision.tier === 'chat' ? 'direct conversational response' : 'short immediate task',
  };
}
