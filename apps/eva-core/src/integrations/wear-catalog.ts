/**
 * Wear OS command catalog — the contract between eva-core and the watch app.
 *
 * watch→core commands ride the fast path (`POST /wear-fast-path/request`) or
 * create tasks; core→watch directives are persisted in `wear_directives` and
 * delivered over the `/eva` Socket.io namespace.
 */
export interface WearCommand {
  id: string;
  direction: 'watch_to_core' | 'core_to_watch';
  label: string;
  description: string;
  category: 'agent' | 'web' | 'media' | 'apps' | 'system' | 'sensors';
  approval_level: 0 | 1 | 2 | 3;
  example: Record<string, unknown>;
}

export const WEAR_COMMANDS: WearCommand[] = [
  // ── watch → core ─────────────────────────────────────────
  {
    id: 'agent.ask',
    direction: 'watch_to_core',
    label: 'Ask EVA',
    description: 'Voice/text query; fast path answers directly, complex orders become tasks.',
    category: 'agent',
    approval_level: 0,
    example: { request_type: 'ask', input: 'Resume mis notificaciones de hoy' },
  },
  {
    id: 'agent.request_image',
    direction: 'watch_to_core',
    label: 'Request image',
    description: 'Ask EVA to fetch or generate an image and push it back to the watch.',
    category: 'media',
    approval_level: 0,
    example: { request_type: 'image', input: 'foto del clima actual en CDMX' },
  },
  {
    id: 'web.search',
    direction: 'watch_to_core',
    label: 'Web search',
    description: 'Search the internet and read back a summary.',
    category: 'web',
    approval_level: 0,
    example: { request_type: 'search', input: 'tipo de cambio USD MXN' },
  },
  {
    id: 'web.browse',
    direction: 'watch_to_core',
    label: 'Browse a site',
    description: 'Drive the browser agent (Playwright) against a URL; sensitive clicks go through approvals.',
    category: 'web',
    approval_level: 1,
    example: { request_type: 'browse', input: 'https://news.ycombinator.com — top 3 titulares' },
  },
  {
    id: 'memory.save',
    direction: 'watch_to_core',
    label: 'Remember this',
    description: 'Persist a note/fact into EVA memory (pgvector).',
    category: 'agent',
    approval_level: 0,
    example: { request_type: 'memory.save', input: 'El código del estacionamiento es 4821' },
  },
  {
    id: 'memory.recall',
    direction: 'watch_to_core',
    label: 'Recall',
    description: 'Semantic search over saved memories.',
    category: 'agent',
    approval_level: 0,
    example: { request_type: 'memory.recall', input: 'código del estacionamiento' },
  },
  {
    id: 'tasks.status',
    direction: 'watch_to_core',
    label: 'Task status',
    description: 'Check the pipeline state of a running task.',
    category: 'system',
    approval_level: 0,
    example: { request_type: 'tasks.status', input: '<task_id>' },
  },
  {
    id: 'sensors.share',
    direction: 'watch_to_core',
    label: 'Share sensor data',
    description: 'Stream heart rate / location / notifications after on-watch consent (wear_sensor_consents).',
    category: 'sensors',
    approval_level: 1,
    example: { request_type: 'sensors.share', metadata: { resource: 'heart_rate' } },
  },

  // ── core → watch (wear_directives.action) ───────────────
  {
    id: 'wear.notify',
    direction: 'core_to_watch',
    label: 'Notify',
    description: 'Show a notification card on the watch.',
    category: 'system',
    approval_level: 0,
    example: { action: 'wear.notify', payload: { title: 'Tarea lista', body: 'Resumen enviado a Telegram' } },
  },
  {
    id: 'wear.show_image',
    direction: 'core_to_watch',
    label: 'Show image',
    description: 'Render an image (url or base64) full-screen on the watch.',
    category: 'media',
    approval_level: 0,
    example: { action: 'wear.show_image', payload: { url: 'https://…/map.png' } },
  },
  {
    id: 'wear.speak',
    direction: 'core_to_watch',
    label: 'Speak',
    description: 'Text-to-speech through the watch speaker.',
    category: 'media',
    approval_level: 0,
    example: { action: 'wear.speak', payload: { text: 'Tu Uber llega en 3 minutos' } },
  },
  {
    id: 'wear.open_app',
    direction: 'core_to_watch',
    label: 'Open app',
    description: 'Launch an app on the watch by package name (Uber, Maps, Spotify, Phone…).',
    category: 'apps',
    approval_level: 1,
    example: { action: 'wear.open_app', payload: { package: 'com.ubercab', deep_link: 'uber://?action=setPickup' } },
  },
  {
    id: 'wear.show_form',
    direction: 'core_to_watch',
    label: 'Show form (SDUI)',
    description: 'Render a server-driven form; answers land in wear_form_responses.',
    category: 'system',
    approval_level: 0,
    example: {
      action: 'wear.show_form',
      payload: { form_key: 'confirm_purchase', fields: [{ id: 'ok', type: 'boolean', label: '¿Confirmar compra?' }] },
    },
  },
  {
    id: 'wear.haptic',
    direction: 'core_to_watch',
    label: 'Haptic',
    description: 'Vibration pattern for silent alerts.',
    category: 'system',
    approval_level: 0,
    example: { action: 'wear.haptic', payload: { pattern: 'double_tap' } },
  },
  {
    id: 'wear.set_complication',
    direction: 'core_to_watch',
    label: 'Update complication',
    description: 'Update the watch-face complication (pending approvals, active task count…).',
    category: 'system',
    approval_level: 0,
    example: { action: 'wear.set_complication', payload: { slot: 'main', text: '2 tareas' } },
  },
];

/** Default-on commands when the wear channel is first enabled. */
export const WEAR_DEFAULT_ENABLED = WEAR_COMMANDS
  .filter((command) => command.approval_level === 0)
  .map((command) => command.id);
