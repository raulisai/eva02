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
  // ── Comunicación ─────────────────────────────────────────────────────────
  gmail_write: [
    { tool: 'whatsapp_send', rationale: 'enviar mensaje de texto por WhatsApp' },
    { tool: 'telegram_send_file', rationale: 'enviar archivo o texto por Telegram' },
  ],
  gmail_read: [
    { tool: 'calendar_read', rationale: 'consulta agenda si el objetivo es horarios/eventos' },
    { tool: 'drive_read', rationale: 'busca en Drive si el objetivo es un documento adjunto' },
    { tool: 'web_search', rationale: 'buscar información pública si el correo no está disponible' },
  ],
  whatsapp_send: [
    { tool: 'gmail_write', rationale: 'enviar email si WhatsApp no está disponible' },
    { tool: 'telegram_send_file', rationale: 'enviar por Telegram como alternativa de mensajería' },
  ],
  whatsapp_read: [
    { tool: 'gmail_read', rationale: 'leer correos como alternativa de mensajes entrantes' },
    { tool: 'ask_user', rationale: 'pedir al usuario que comparta el mensaje si WhatsApp no está vinculado' },
  ],
  telegram_send_file: [
    { tool: 'gmail_write', rationale: 'enviar el archivo como adjunto de email' },
    { tool: 'whatsapp_send', rationale: 'enviar enlace o texto por WhatsApp' },
    { tool: 'drive_read', rationale: 'guardar en Drive si no hay canal de mensajería disponible' },
  ],

  // ── Búsqueda y datos externos ─────────────────────────────────────────────
  web_search: [
    { tool: 'code_execute', rationale: 'scraping con requests+bs4 o llamada a API REST pública desde Python (más control que web_search)' },
    { tool: 'terminal_run', rationale: 'usar curl/wget directamente para obtener datos de URLs o APIs' },
    { tool: 'memory_recall', rationale: 'buscar en memoria si esta información ya fue investigada antes' },
  ],

  // ── Ejecución en sandbox ──────────────────────────────────────────────────
  code_execute: [
    { tool: 'terminal_run', rationale: 'ejecutar el mismo código como comando de shell (bash, git, curl, jq, sqlite3, ffmpeg, gcc…)' },
    { tool: 'script_forge', rationale: 'pedir a un modelo especializado que genere y ejecute el script si no sabes el código exacto' },
    { tool: 'web_search', rationale: 'buscar la API/documentación si el error es por falta de datos o endpoint desconocido' },
  ],
  terminal_run: [
    { tool: 'code_execute', rationale: 'ejecutar la misma lógica en Python con subprocess/os.system (más portable)' },
    { tool: 'script_forge', rationale: 'generar el script completo con un modelo especializado si los comandos exactos son inciertos' },
  ],
  terminal_input: [
    { tool: 'terminal_run', rationale: 'ejecutar el mismo comando con flags no-interactivas (ej. -y, --yes, --non-interactive)' },
    { tool: 'code_execute', rationale: 'reimplementar la interacción en Python usando subprocess con stdin=PIPE' },
  ],
  script_forge: [
    { tool: 'code_execute', rationale: 'escribir el código directamente con code_execute (más control e iteración rápida)' },
    { tool: 'terminal_run', rationale: 'ejecutar el comando del sistema directamente si la lógica es una sola línea de shell' },
  ],

  // ── Skills ───────────────────────────────────────────────────────────────
  skill_run: [
    { tool: 'skill_view', rationale: 'ver el código de la skill y ejecutarla manualmente ajustando argumentos con code_execute' },
    { tool: 'code_execute', rationale: 'reimplementar la lógica de la skill directamente con control total' },
  ],
  skill_view: [
    { tool: 'skill_manage', rationale: 'listar skills disponibles con skill_manage(action="list") para encontrar el slug correcto' },
    { tool: 'web_search', rationale: 'buscar documentación externa si la skill no existe en el catálogo' },
  ],

  // ── Calendario y agenda ───────────────────────────────────────────────────
  calendar_read: [
    { tool: 'gmail_read', rationale: 'buscar invitaciones o recordatorios de eventos en el correo' },
    { tool: 'web_search', rationale: 'buscar horarios o eventos públicos si el calendario no está conectado' },
  ],
  calendar_write: [
    { tool: 'gmail_write', rationale: 'enviar correo de confirmación de cita si Calendar no está disponible' },
    { tool: 'ask_user', rationale: 'pedir al usuario que confirme o añada el evento manualmente' },
  ],

  // ── Drive y archivos ──────────────────────────────────────────────────────
  drive_read: [
    { tool: 'gmail_read', rationale: 'buscar adjuntos o documentos en correos recientes' },
    { tool: 'web_search', rationale: 'buscar el documento o datos equivalentes en la web' },
    { tool: 'code_execute', rationale: 'leer archivos locales en /work si el documento fue descargado al sandbox' },
  ],

  // ── Imágenes y visión ─────────────────────────────────────────────────────
  image_analyze: [
    { tool: 'code_execute', rationale: 'extraer texto con pytesseract o easyocr desde Python si image_analyze no está disponible' },
    { tool: 'terminal_run', rationale: 'usar imagemagick (identify/convert) para inspeccionar metadata de la imagen' },
    { tool: 'web_search', rationale: 'buscar información sobre el contenido si es una imagen pública conocida' },
  ],
  browser_navigate: [
    { tool: 'web_search', rationale: 'buscar la información directamente sin navegador si no necesitas interacción visual' },
    { tool: 'code_execute', rationale: 'usar requests+bs4 para scraping si el contenido es accesible por HTTP' },
  ],

  // ── Transporte ────────────────────────────────────────────────────────────
  uber_quote: [
    { tool: 'code_execute', rationale: 'calcular distancia/tiempo con la API de OpenRouteService o Nominatim (gratuitas)' },
    { tool: 'web_search', rationale: 'buscar estimado de tarifa en Google Maps o web de Uber' },
    { tool: 'ask_user', rationale: 'pedir al usuario que abra Uber y comparta la tarifa o screenshot' },
  ],

  // ── Memoria y datos de largo plazo ────────────────────────────────────────
  memory_recall: [
    { tool: 'scratchpad', rationale: 'leer el bloc de notas de esta tarea si es contexto reciente (no persistente entre sesiones)' },
    { tool: 'web_search', rationale: 'buscar externamente si la información no está en memoria' },
  ],
  scratchpad: [
    { tool: 'code_execute', rationale: 'guardar hallazgos en un archivo .json en /work como alternativa de almacenamiento temporal' },
  ],
  data_log: [
    { tool: 'scratchpad', rationale: 'guardar en scratchpad si data_log no está disponible (solo persiste en esta sesión)' },
    { tool: 'code_execute', rationale: 'guardar en un archivo CSV/JSON en /work para acumulación manual' },
  ],

  // ── Jobs y scheduling ─────────────────────────────────────────────────────
  schedule_job_manage: [
    { tool: 'ask_user', rationale: 'pedir al usuario que configure el job manualmente si el scheduler no está disponible' },
    { tool: 'code_execute', rationale: 'probar el script del job una vez de forma inmediata antes de programarlo' },
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
