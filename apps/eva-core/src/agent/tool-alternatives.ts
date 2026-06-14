/**
 * Static inverse-capability map: when a tool fails, the loop injects concrete
 * alternative routes instead of the generic "try another tool" hint.
 *
 * Design constraints:
 *  - Pure data, no I/O, no LLM calls — zero extra compute at error time.
 *  - Keyed by the failing tool; values are goal-aware alternative tool lists
 *    with a short rationale the model can parse in one line.
 *  - Only list alternatives that are actually in the tool catalog so the model
 *    doesn't reference phantom tools.
 */

export interface ToolAlternative {
  /** Alternative tool slug. */
  tool: string;
  /** One-line rationale: why this alternative can cover the same sub-goal. */
  rationale: string;
}

/** Map: failing tool → ordered alternatives (best first). */
const ALTERNATIVES: Readonly<Record<string, ToolAlternative[]>> = {
  gmail_write: [
    { tool: 'whatsapp_send', rationale: 'enviar mensaje de texto por WhatsApp' },
    { tool: 'telegram_send_file', rationale: 'enviar archivo o texto por Telegram' },
  ],
  gmail_read: [
    { tool: 'calendar_read', rationale: 'consulta agenda si el objetivo es horarios/eventos' },
    { tool: 'drive_read', rationale: 'busca en Drive si el objetivo es un documento adjunto' },
  ],
  whatsapp_send: [
    { tool: 'gmail_write', rationale: 'enviar email si WhatsApp no está disponible' },
    { tool: 'telegram_send_file', rationale: 'enviar por Telegram como alternativa' },
  ],
  whatsapp_read: [
    { tool: 'gmail_read', rationale: 'leer correos en su lugar' },
  ],
  telegram_send_file: [
    { tool: 'gmail_write', rationale: 'enviar el archivo por email' },
    { tool: 'whatsapp_send', rationale: 'enviar enlace o texto por WhatsApp' },
  ],
  web_search: [
    { tool: 'code_execute', rationale: 'hacer scraping o consultar API pública desde Python' },
    { tool: 'memory_recall', rationale: 'buscar en la memoria si ya se investigó esto antes' },
  ],
  code_execute: [
    { tool: 'terminal_run', rationale: 'ejecutar comandos de shell en lugar de Python' },
    { tool: 'script_forge', rationale: 'generar y ejecutar un script con ScriptForge' },
  ],
  terminal_run: [
    { tool: 'code_execute', rationale: 'ejecutar con Python en lugar de shell' },
  ],
  calendar_read: [
    { tool: 'gmail_read', rationale: 'buscar invitaciones/eventos en el correo' },
  ],
  calendar_write: [
    { tool: 'gmail_write', rationale: 'enviar un correo de confirmación de cita en su lugar' },
    { tool: 'ask_user', rationale: 'pedir al usuario que confirme la cita manualmente' },
  ],
  drive_read: [
    { tool: 'web_search', rationale: 'buscar el documento en la web si no está en Drive' },
    { tool: 'gmail_read', rationale: 'buscar en correos adjuntos' },
  ],
  uber_quote: [
    { tool: 'web_search', rationale: 'buscar estimado de tarifa en Google Maps o Uber web' },
    { tool: 'ask_user', rationale: 'pedir al usuario que abra Uber y comparta la tarifa' },
  ],
  skill_run: [
    { tool: 'skill_view', rationale: 'ver el código de la skill y ejecutarla manualmente con code_execute' },
    { tool: 'code_execute', rationale: 'reimplementar la lógica de la skill directamente' },
  ],
  memory_recall: [
    { tool: 'scratchpad', rationale: 'leer el bloc de notas de esta tarea si es contexto reciente' },
  ],
};

/**
 * Returns a formatted hint string to append to an error observation when
 * `failingTool` has known alternatives. Returns `null` when no alternatives
 * are registered (no extra text added to the prompt).
 *
 * @param failingTool - The name of the tool that returned an ERROR.
 * @param availableTools - Tool names currently exposed to the model (step-filtered).
 *   Alternatives that are NOT in this set are omitted so the model doesn't pick
 *   a tool that isn't loaded for this step.
 */
export function buildAlternativesHint(
  failingTool: string,
  availableTools: ReadonlySet<string>,
): string | null {
  const candidates = ALTERNATIVES[failingTool];
  if (!candidates || candidates.length === 0) return null;

  const viable = candidates.filter((alt) => availableTools.has(alt.tool));
  if (viable.length === 0) return null;

  const lines = viable
    .map((alt, i) => `  ${i + 1}. ${alt.tool} — ${alt.rationale}`)
    .join('\n');

  return `\nAlternativas disponibles para este sub-objetivo:\n${lines}`;
}
