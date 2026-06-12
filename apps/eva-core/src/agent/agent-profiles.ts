/**
 * Perfiles de sub-agentes especializados para el agent-loop.
 *
 * Cada perfil define la misión (bloque de system prompt), el subconjunto de
 * herramientas que el rol realmente necesita (menos catálogo = decisiones más
 * enfocadas y prompt más barato) y su presupuesto de pasos. Los roles se
 * complementan: planeador descompone, investigador y programador ejecutan,
 * seguridad audita antes de entregar.
 *
 * `resolveAgentProfile` normaliza roles libres ("researcher", "auditor de
 * seguridad"…) al perfil más cercano; sin match devuelve null y el sub-agente
 * corre como generalista con el catálogo completo (back-compat con los
 * agentRole de skills).
 */
export interface AgentProfile {
  /** Slug canónico del rol (lo que ve el modelo en el catálogo de delegate). */
  role: string;
  /** Fragmentos que mapean roles libres a este perfil (lowercase, substring). */
  aliases: string[];
  /** Descripción de una línea para el catálogo de delegate del agente raíz. */
  tagline: string;
  /** Bloque de especialidad que se inyecta en el system prompt del sub-agente. */
  mission: string;
  /** Herramientas permitidas; undefined = todas las no-rootOnly. */
  tools?: string[];
  /** Pasos por defecto para este rol (sobre el DEFAULT_SUB_STEPS genérico). */
  maxSteps: number;
}

export const AGENT_PROFILES: AgentProfile[] = [
  {
    role: 'investigador',
    aliases: ['investig', 'research', 'analista', 'busca', 'búsqueda', 'busqueda'],
    tagline: 'busca y verifica datos en fuentes externas',
    mission:
      'ESPECIALIDAD — investigación: contrasta al menos dos fuentes antes de afirmar algo, cita datos concretos (cifras, fechas, nombres) y distingue hechos verificados de suposiciones. Entrega hallazgos verificables, no opiniones.',
    tools: ['web_search', 'memory_recall', 'gmail_read', 'calendar_read', 'drive_read', 'image_analyze', 'code_execute', 'sandbox_ls'],
    maxSteps: 4,
  },
  {
    role: 'programador',
    aliases: ['program', 'coder', 'developer', 'desarroll', 'ingenier', 'código', 'codigo', 'engineer'],
    tagline: 'escribe, ejecuta y corrige código en el sandbox',
    mission:
      'ESPECIALIDAD — código: escribe código pequeño y verificable, ejecútalo en el sandbox y corrige iterando sobre los errores reales. Verifica la salida (lee archivos, imprime resultados) antes de reportar éxito, y guarda con skill_save lo que funcione y no sea trivial.',
    tools: ['code_execute', 'terminal_run', 'terminal_output', 'skill_run', 'skill_save', 'sandbox_ls', 'memory_recall', 'web_search', 'image_analyze'],
    maxSteps: 5,
  },
  {
    role: 'planeador',
    aliases: ['plan', 'arquitect', 'estrateg', 'organiz'],
    tagline: 'descompone objetivos complejos en pasos delegables',
    mission:
      'ESPECIALIDAD — planeación: descompone el objetivo en pasos concretos y ordenados, identifica riesgos y dependencias, y marca qué paso conviene delegar a investigador, programador o seguridad. Tu final_answer ES el plan (numerado, accionable); no ejecutes el trabajo.',
    tools: ['memory_recall', 'web_search', 'calendar_read'],
    maxSteps: 2,
  },
  {
    role: 'seguridad',
    aliases: ['segur', 'security', 'auditor', 'pentest', 'riesgo'],
    tagline: 'audita riesgos de código y acciones antes de entregar',
    mission:
      'ESPECIALIDAD — seguridad: audita código y planes buscando fugas de secretos, comandos destructivos, inyección, exfiltración de datos y permisos excesivos. Reporta cada riesgo con severidad y mitigación concreta; si algo es seguro, dilo explícitamente. No persistas skills ni envíes nada externo.',
    tools: ['code_execute', 'terminal_run', 'sandbox_ls', 'memory_recall', 'web_search'],
    maxSteps: 3,
  },
];

export function resolveAgentProfile(role?: string): AgentProfile | null {
  const norm = (role ?? '').trim().toLowerCase();
  if (!norm) return null;
  return (
    AGENT_PROFILES.find((p) => p.role === norm) ??
    AGENT_PROFILES.find((p) => p.aliases.some((a) => norm.includes(a))) ??
    null
  );
}

/** Línea de catálogo para el usage de delegate (lo que el raíz ve por rol). */
export const DELEGATE_ROLE_CATALOG = AGENT_PROFILES
  .map((p) => `${p.role} (${p.tagline})`)
  .join('; ');
