import { DevModeClassification } from './dev-studio.types';

// Disparador explícito: el usuario activa modo desarrollo sin ambigüedad
const EXPLICIT_DEV_MODE = /\b(modo\s+desarrollo|activa[r]?\s+(el\s+)?dev\s+studio|dev\s+studio|development\s+studio|quiero\s+(construir|desarrollar|crear)\s+(una?\s+)?(app|aplicaci[oó]n|plataforma|sistema|saas|api|mvp)\b.{20,}|construye(me)?\s+(una?\s+)?(app|aplicaci[oó]n|plataforma|sistema)\s+.{10,}para\s+.{5,}|desarrolla(me)?\s+(una?\s+)?(app|aplicaci[oó]n|plataforma|sistema)\s+.{10,})/i;

// Señales de producto multi-feature (≥2 features distintas = es producto, no tarea)
const MULTI_FEATURE_SIGNALS = [
  /\b(login|auth(?:enticaci[oó]n)?|registro|sign[- ]?(?:up|in))\b/i,
  /\b(dashboard|panel|crud|gesti[oó]n|administra[c]?i[oó]n)\b/i,
  /\b(deploy|despliegue|producci[oó]n|staging|ci[/\-]?cd)\b/i,
  /\b(base\s+de\s+datos|migraci[oó]n|modelo\s+de\s+datos|esquema)\b/i,
  /\b(api\s+rest|endpoints?|backend|frontend|fullstack)\b/i,
  /\b(pagos?|stripe|suscripci[oó]n|facturaci[oó]n)\b/i,
  /\b(notificaciones?|emails?|alertas?|webhooks?)\b/i,
  /\b(multi-?tenant|organizaciones?|equipos?|permisos?|roles?)\b/i,
  /\b(tests?|pruebas?|cobertura|e2e|integraci[oó]n)\b/i,
  /\b(docker|contenedor|kubernetes|microservicio)\b/i,
];

// Señales de proyecto completo (hablan de construir algo de principio a fin)
const PROJECT_SCOPE_SIGNALS = /\b(desde\s+cero|de\s+cero|completo|completa|end[\s-]?to[\s-]?end|de\s+principio\s+a\s+fin|producci[oó]n\s+lista|production[\s-]?ready|mvp|plataforma|saas|sistema\s+completo|aplicaci[oó]n\s+completa|proyecto\s+de\s+software|stack\s+completo)\b/i;

// Señales de TAREA PUNTUAL que no debe entrar a Dev Studio
// (refactor de un archivo, añadir endpoint a algo existente, fix puntual)
const SINGLE_TASK_EXCLUSIONS = /\b(a[nñ]ade[r]?|agrega[r]?|crea[r]?|modifica[r]?|corrige[r]?|arregla[r]?|refactoriza[r]?)\s+(el|la|un|una|este|esta|ese|esa)?\s*(endpoint|archivo|función|componente|método|bug|error|fallo|clase|servicio|módulo|columna|campo|ruta|botón|formulario|validación)\b/i;

// Excluye tareas cotidianas del asistente
const ASSISTANT_TASK = /\b(busca|revisa|envía|manda|agenda|recuerda|busca|clima|correo|email|whatsapp|telegram|uber|precio|noticia|calend|resumen|traduc)\b/i;

export function classifyDevMode(input: string): DevModeClassification {
  const text = input.trim();

  // Exclusión rápida: tareas de asistente o tarea puntual
  if (ASSISTANT_TASK.test(text) && text.length < 300) {
    return { isDevProject: false, confidence: 0.95, reason: 'assistant task signal', requiresHandshake: false };
  }

  // Disparador explícito: entra directo sin handshake
  if (EXPLICIT_DEV_MODE.test(text)) {
    const titleMatch = text.match(
      /(?:modo\s+desarrollo|dev\s+studio)[:\s]+(.{5,120})/i,
    ) ?? text.match(
      /(?:construir|desarrollar|crear)\s+(?:una?\s+)?(?:app|aplicaci[oó]n|plataforma|sistema|saas|api|mvp)\s+(?:de\s+|para\s+)?(.{5,120})/i,
    );
    return {
      isDevProject: true,
      confidence: 0.97,
      reason: 'explicit dev mode trigger',
      requiresHandshake: false,
      extractedTitle: titleMatch ? titleMatch[1].trim().slice(0, 100) : undefined,
    };
  }

  // Exclusión: tarea puntual sobre código existente
  if (SINGLE_TASK_EXCLUSIONS.test(text) && !PROJECT_SCOPE_SIGNALS.test(text)) {
    return { isDevProject: false, confidence: 0.85, reason: 'single task on existing code', requiresHandshake: false };
  }

  // Proyecto con scope completo explícito
  if (PROJECT_SCOPE_SIGNALS.test(text) && text.length > 80) {
    const featureCount = MULTI_FEATURE_SIGNALS.filter((s) => s.test(text)).length;
    if (featureCount >= 2) {
      return {
        isDevProject: true,
        confidence: 0.88,
        reason: `project scope + ${featureCount} feature signals`,
        requiresHandshake: true,
      };
    }
    return {
      isDevProject: true,
      confidence: 0.75,
      reason: 'project scope signal',
      requiresHandshake: true,
    };
  }

  // Múltiples features sin scope explícito pero texto largo
  const featureCount = MULTI_FEATURE_SIGNALS.filter((s) => s.test(text)).length;
  if (featureCount >= 3 && text.length > 120) {
    return {
      isDevProject: true,
      confidence: 0.80,
      reason: `${featureCount} multi-feature signals in long prompt`,
      requiresHandshake: true,
    };
  }

  return { isDevProject: false, confidence: 0.70, reason: 'no project signals', requiresHandshake: false };
}

/** Returns the handshake message EVA shows when it detects a project but needs confirmation. */
export function buildHandshakeMessage(input: string): string {
  return (
    `Esto parece un **proyecto completo de software**, no una tarea suelta.\n\n` +
    `¿Lo abro como sesión de **Dev Studio** (equipo de agentes, goals, iteraciones autónomas) ` +
    `o lo resuelvo como **tarea normal** aquí mismo?\n\n` +
    `> **Dev Studio**: crea goals, coordina agentes Frontend/Backend/Testing, itera hasta completar.\n` +
    `> **Tarea normal**: resuelvo en el contexto del chat, sin sesión persistente.\n\n` +
    `Responde "**dev studio**" para activarlo, o cuéntame más y lo resuelvo directamente.`
  );
}
