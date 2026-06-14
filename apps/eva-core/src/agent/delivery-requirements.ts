/**
 * Declarative delivery-requirement rules.
 *
 * Each rule maps a "verb × artifact" pattern to a verifiable tool + an
 * observation matcher that proves the deliverable was produced.
 *
 * Design:
 *  - Pure data + pure functions — no I/O, no LLM.
 *  - `deriveDeliveryRequirements` replaces the hardcoded regex in agent-loop.
 *  - `missingDeliveryRequirements` replaces the ad-hoc per-kind checks.
 *  - Adding a new deliverable type is one entry in DELIVERY_RULES — no other
 *    change required in agent-loop.
 */

export interface DeliveryRequirement {
  kind: string;
  label: string;
  /** Tool the model must call to satisfy this requirement. */
  tool: string;
  /** Shown in the system prompt and delivery-blocked message. */
  guidance: string;
  /** Observation success matcher — returns true when the deliverable is done. */
  satisfied: (step: { tool: string; args: Record<string, unknown>; observation: string }) => boolean;
}

interface DeliveryRule {
  kind: string;
  label: string;
  tool: string;
  guidance: string;
  /** Returns true when the goal text triggers this requirement. */
  detect: (goal: string) => boolean;
  satisfied: DeliveryRequirement['satisfied'];
}

const DELIVERY_RULES: DeliveryRule[] = [
  // ── PDF file ─────────────────────────────────────────────────────────────
  {
    kind: 'pdf_file',
    label: 'crear archivo PDF',
    tool: 'code_execute',
    guidance: 'crea el PDF en /work con code_execute y deja evidencia de la ruta/nombre .pdf en la observación.',
    detect: (g) =>
      /\bpdf\b/i.test(g) &&
      /\b(genera|generar|crea|crear|haz|hacer|arma|armar|archivo|reporte|documento|informe)\b/i.test(g),
    satisfied: (s) =>
      !s.observation.startsWith('ERROR:') &&
      ['code_execute', 'sandbox_ls', 'script_forge'].includes(s.tool) &&
      (JSON.stringify(s.args).toLowerCase().includes('.pdf') ||
        s.observation.toLowerCase().includes('.pdf') ||
        s.observation.toLowerCase().includes('pdf')),
  },

  // ── Telegram file/message ─────────────────────────────────────────────────
  {
    kind: 'telegram_file',
    label: 'enviar archivo por Telegram',
    tool: 'telegram_send_file',
    guidance: 'usa telegram_send_file con el archivo generado y espera una observación de envío exitoso.',
    detect: (g) =>
      /\btelegram\b/i.test(g) &&
      /\b(env[ií]a|enviar|mand[aá]|mandar|m[aá]ndalo|m[aá]ndame|comparte|compartir)\b/i.test(g),
    satisfied: (s) =>
      s.tool === 'telegram_send_file' &&
      !s.observation.startsWith('ERROR:') &&
      /enviado a telegram|message_id|archivo ".+" .*telegram/i.test(s.observation),
  },

  // ── Email / Gmail ─────────────────────────────────────────────────────────
  {
    kind: 'email_send',
    label: 'enviar email',
    tool: 'gmail_write',
    guidance: 'usa gmail_write para enviar el correo y confirma el message_id en la observación.',
    detect: (g) =>
      /\b(env[ií]a|enviar|manda|mandar|escribe|redacta)\b/i.test(g) &&
      /\b(correo|email|gmail|mail)\b/i.test(g),
    satisfied: (s) =>
      s.tool === 'gmail_write' &&
      !s.observation.startsWith('ERROR:') &&
      /enviado|sent|message_id|message.*id/i.test(s.observation),
  },

  // ── WhatsApp ──────────────────────────────────────────────────────────────
  {
    kind: 'whatsapp_send',
    label: 'enviar mensaje por WhatsApp',
    tool: 'whatsapp_send',
    guidance: 'usa whatsapp_send y confirma el mensaje enviado en la observación.',
    detect: (g) =>
      /\bwhatsapp\b/i.test(g) &&
      /\b(env[ií]a|enviar|manda|mandar|comparte|compartir|avisa|notifica)\b/i.test(g),
    satisfied: (s) =>
      s.tool === 'whatsapp_send' &&
      !s.observation.startsWith('ERROR:') &&
      /enviado|sent|message.*ok/i.test(s.observation),
  },

  // ── Excel / XLSX ──────────────────────────────────────────────────────────
  {
    kind: 'excel_file',
    label: 'crear archivo Excel/XLSX',
    tool: 'code_execute',
    guidance: 'crea el archivo .xlsx en /work con openpyxl o pandas (disponibles en el sandbox) y verifica su tamaño.',
    detect: (g) =>
      /\b(excel|xlsx|hoja de c[aá]lculo|spreadsheet|tabla)\b/i.test(g) &&
      /\b(genera|generar|crea|crear|haz|hacer|exporta|exportar)\b/i.test(g),
    satisfied: (s) =>
      !s.observation.startsWith('ERROR:') &&
      ['code_execute', 'sandbox_ls'].includes(s.tool) &&
      (JSON.stringify(s.args).toLowerCase().includes('.xlsx') ||
        s.observation.toLowerCase().includes('.xlsx') ||
        s.observation.toLowerCase().includes('excel')),
  },

  // ── Calendar event ────────────────────────────────────────────────────────
  {
    kind: 'calendar_event',
    label: 'crear evento en calendario',
    tool: 'calendar_write',
    guidance: 'usa calendar_write y confirma el event_id o enlace en la observación.',
    detect: (g) =>
      /\b(agend[ae]|crear?\s+(?:un\s+)?evento|cita|reuni[oó]n|meeting|a[nñ]ade\s+al\s+calendario|poner\s+en\s+(?:el\s+)?calendario)\b/i.test(g),
    satisfied: (s) =>
      s.tool === 'calendar_write' &&
      !s.observation.startsWith('ERROR:') &&
      /event_id|eventId|creado|created|agendado/i.test(s.observation),
  },
];

/**
 * Derive delivery requirements from a goal string.
 * Returns only the rules triggered by the goal.
 */
export function deriveDeliveryRequirements(goal: string): DeliveryRequirement[] {
  return DELIVERY_RULES
    .filter((rule) => rule.detect(goal))
    .map(({ kind, label, tool, guidance, satisfied }) => ({ kind, label, tool, guidance, satisfied }));
}

/**
 * Returns the subset of requirements not yet satisfied by any step.
 */
export function missingDeliveryRequirements(
  steps: ReadonlyArray<{ tool: string; args: Record<string, unknown>; observation: string }>,
  requirements: DeliveryRequirement[],
): DeliveryRequirement[] {
  return requirements.filter(
    (req) => !steps.some((step) => req.satisfied(step)),
  );
}
