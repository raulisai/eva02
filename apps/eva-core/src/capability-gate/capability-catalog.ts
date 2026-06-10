import { CapabilityRequirement } from './capability-gate.types';

/**
 * Maps user-intent patterns to required integrations.
 * Ordered from most-specific to least-specific: first match wins.
 *
 * Adding a new capability: add an entry here. The gate checks all matching
 * entries and blocks on the first one that has no configured integration.
 */
export const CAPABILITY_CATALOG: Array<{
  /** RegExp tested against the full, normalised input */
  pattern: RegExp;
  requirement: CapabilityRequirement;
}> = [
  // ── Email ─────────────────────────────────────────────────────────────────
  {
    pattern: /\b(correo|email|mail|inbox|bandeja|gmail|outlook|revisa.*correo|correo.*revisa|mensajes.*correo|mis mensajes de email)\b/i,
    requirement: {
      capability: 'email',
      ack_message: 'Para revisar tu correo necesito conectar tu cuenta de Gmail primero 📧',
      user_message:
        'Aún no tienes ninguna cuenta de correo conectada. '
        + 'Ve a **Integraciones → Google** y autoriza el acceso con tu cuenta de Gmail; '
        + 'una vez que lo hagas podré revisar, filtrar y resumir tus mensajes.',
      setup_label: 'Conectar Gmail',
      integrations: [
        { kind: 'credential', provider: 'google' },
        { kind: 'channel', provider: 'email' },
      ],
      setup_type: 'oauth',
      setup_meta: { scopes: ['gmail.readonly', 'gmail.send'] },
    },
  },

  // ── Calendar ──────────────────────────────────────────────────────────────
  {
    pattern: /\b(calendario|agenda|cita|evento|recordatorio|agendar|programar|google calendar|mis citas|pr[oó]ximas? citas?)\b/i,
    requirement: {
      capability: 'calendar',
      ack_message: 'Para acceder a tu calendario necesito conectar tu cuenta de Google 📅',
      user_message:
        'No tienes Google Calendar conectado. '
        + 'Ve a **Integraciones → Google** y autoriza el acceso; '
        + 'después podrás pedirme que revise tus citas, agende eventos o te mande recordatorios.',
      setup_label: 'Conectar Google Calendar',
      integrations: [{ kind: 'credential', provider: 'google' }],
      setup_type: 'oauth',
      setup_meta: { scopes: ['calendar.readonly', 'calendar.events'] },
    },
  },

  // ── WhatsApp ──────────────────────────────────────────────────────────────
  {
    pattern: /\b(whatsapp|whatsap|watsapp|watsap|whats app|guasap|guasapp|wa\b|mensajes? de whats|mis mensajes? de wa)\b/i,
    requirement: {
      capability: 'whatsapp',
      ack_message: 'Para acceder a WhatsApp necesito escanear el código QR con tu teléfono 📱',
      user_message:
        'No tienes WhatsApp conectado. '
        + 'Puedo abrir **WhatsApp Web** en segundo plano y necesito que '
        + 'escanees el código QR con tu teléfono para autorizar la sesión. '
        + 'Pulsa **Conectar WhatsApp** cuando estés listo — el QR aparece en pantalla.',
      setup_label: 'Conectar WhatsApp',
      integrations: [{ kind: 'channel', provider: 'whatsapp' }],
      setup_type: 'qr_scan',
      setup_meta: { session_key: 'whatsapp_web', endpoint: '/integrations/whatsapp/start-session' },
    },
  },

  // ── Telegram ──────────────────────────────────────────────────────────────
  {
    pattern: /\b(telegram|mensajes de telegram|bot de telegram|mis mensajes de tg)\b/i,
    requirement: {
      capability: 'telegram',
      ack_message: 'Para usar Telegram necesito configurar el bot token primero 💬',
      user_message:
        'No tienes un bot de Telegram configurado. '
        + 'Ve a **Integraciones → Telegram**, pega el token de tu bot de @BotFather '
        + 'y registra el webhook. Después podré leer y enviar mensajes por Telegram.',
      setup_label: 'Configurar bot de Telegram',
      integrations: [{ kind: 'channel', provider: 'telegram' }],
      setup_type: 'bot_token',
    },
  },

  // ── GitHub ────────────────────────────────────────────────────────────────
  {
    pattern: /\b(github|mis repos|mis repositorios|mis pr|mis pull requests|mis issues|mis commits)\b/i,
    requirement: {
      capability: 'github',
      ack_message: 'Para acceder a GitHub necesito un token de acceso personal 🐙',
      user_message:
        'No tienes GitHub conectado. '
        + 'Ve a **Integraciones → GitHub** y pega un Personal Access Token con '
        + 'los scopes que necesites (repo, read:org, etc.).',
      setup_label: 'Conectar GitHub',
      integrations: [{ kind: 'credential', provider: 'github' }],
      setup_type: 'api_key',
    },
  },

  // ── Google Drive / Docs ───────────────────────────────────────────────────
  {
    pattern: /\b(drive|google drive|mis documentos|mis docs|mis archivos de google|mis hojas de c[aá]lculo|sheets|docs)\b/i,
    requirement: {
      capability: 'google_drive',
      ack_message: 'Para acceder a Google Drive necesito conectar tu cuenta de Google 📂',
      user_message:
        'No tienes Google Drive conectado. '
        + 'Ve a **Integraciones → Google** y autoriza el acceso con tu cuenta.',
      setup_label: 'Conectar Google Drive',
      integrations: [{ kind: 'credential', provider: 'google' }],
      setup_type: 'oauth',
      setup_meta: { scopes: ['drive.readonly', 'drive.file'] },
    },
  },

  // ── Uber / ride hailing ───────────────────────────────────────────────────
  {
    pattern: /\b(uber|pedir.*uber|pedir.*taxi|mis viajes de uber|historial de uber)\b/i,
    requirement: {
      capability: 'uber',
      ack_message: 'Para acceder a Uber necesito conectar tu cuenta primero 🚗',
      user_message:
        'No tienes Uber conectado. '
        + 'Ve a **Integraciones → Uber** y añade las credenciales OAuth de tu cuenta.',
      setup_label: 'Conectar Uber',
      integrations: [{ kind: 'credential', provider: 'uber' }],
      setup_type: 'oauth',
    },
  },
];
