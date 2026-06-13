import { Injectable } from '@nestjs/common';
import { AgentSoulContext } from './soul-context.service';

export interface ConversationContextTurn {
  role: 'user' | 'assistant';
  text: string;
}

@Injectable()
export class ProfileContextBuilderService {
  buildChatContextualInput(input: string, options: {
    conversationContext: ConversationContextTurn[];
    soulContext: AgentSoulContext;
    proactiveTriggerMessages?: string[];
    memoryRecallContext?: string | null;
  }): string {
    const blocks: string[] = [input];

    const identity = this.slimIdentityLine(options.soulContext);
    if (identity) blocks.push('', `(Contexto: ${identity})`);

    const proactive = options.proactiveTriggerMessages ?? [];
    if (proactive.length > 0) {
      blocks.push('', 'Sugerencias proactivas (menciónalas solo si fluye):', ...proactive.map((m) => `- ${m}`));
    }

    if (options.memoryRecallContext) blocks.push('', options.memoryRecallContext);

    if (options.conversationContext.length > 0) {
      blocks.push(
        '',
        'Conversación reciente:',
        ...options.conversationContext.slice(-4).map((t) => `${t.role === 'user' ? 'Usuario' : 'EVA'}: ${t.text.slice(0, 400)}`),
      );
    }

    return blocks.length === 1 ? input : blocks.join('\n');
  }

  buildContextualInput(input: string, options: {
    conversationContext: ConversationContextTurn[];
    soulContext: AgentSoulContext;
    calendarBlock?: string | null;
    patternBlock?: string | null;
    proactiveTriggerMessages?: string[];
    memoryRecallContext?: string | null;
  }): string {
    const blocks: string[] = [input];

    const soulSummary = this.formatEnrichedSoulContext(
      options.soulContext,
      options.calendarBlock ?? null,
      options.patternBlock ?? null,
    );
    if (soulSummary) blocks.push('', soulSummary);

    const proactive = options.proactiveTriggerMessages ?? [];
    if (proactive.length > 0) {
      blocks.push(
        '',
        '## Sugerencias proactivas basadas en los patrones del usuario:',
        '(Puedes mencionarlas si es natural en esta conversación)',
        ...proactive.map((m) => `- ${m}`),
      );
    }

    if (options.memoryRecallContext) blocks.push('', options.memoryRecallContext);

    if (options.conversationContext.length > 0) {
      const contextText = options.conversationContext
        .map((turn) => `${turn.role === 'user' ? 'Usuario' : 'EVA'}: ${turn.text}`)
        .join('\n');
      blocks.push(
        '',
        '## Conversación reciente:',
        contextText,
        '',
        'Resuelve la peticion actual usando ese contexto si el usuario usa referencias como "eso", "ese", "la direccion", "el lugar", "cuanto cuesta" o preguntas incompletas.',
      );
    }

    if (blocks.length === 1) return input;
    blocks.push('\nNo inventes datos actuales: si hace falta informacion vigente, usa busqueda/herramientas.');
    return blocks.join('\n');
  }

  slimIdentityLine(soulContext: AgentSoulContext): string | null {
    const p = soulContext.personal_profile;
    const persona = soulContext.persona_context;
    const bits = [
      p.full_name ? `usuario: ${p.full_name}` : null,
      p.preferred_address ? `llámale ${p.preferred_address}` : null,
      (p.occupation ?? persona.occupation) ? `se dedica a ${p.occupation ?? persona.occupation}` : null,
      p.current_location ? `está en ${p.current_location}` : null,
      persona.communication_preferences ? `estilo preferido: ${persona.communication_preferences}` : null,
      persona.relationship_map?.length ? `relaciones mapeadas: ${persona.relationship_map.map((r) => `${r.relation}=${r.display_name}`).slice(0, 4).join(', ')}` : null,
    ].filter(Boolean);
    return bits.length > 0 ? bits.join(' · ') : null;
  }

  formatSoulContext(context: AgentSoulContext): string | null {
    return this.formatEnrichedSoulContext(context, null, null);
  }

  formatEnrichedSoulContext(
    context: AgentSoulContext,
    calendarBlock: string | null,
    patternBlock: string | null = null,
  ): string | null {
    const sections: string[] = ['## Contexto personal de tu usuario:'];
    let hasContent = false;

    const p = context.personal_profile;
    const persona = context.persona_context;
    const profileLines: string[] = [];

    if (p.full_name) profileLines.push(`- Nombre: ${p.full_name}`);
    if (p.preferred_address) profileLines.push(`- Llámale: ${p.preferred_address}`);
    if (p.age) profileLines.push(`- Edad: ${p.age}`);
    if (p.occupation || persona.occupation) profileLines.push(`- Se dedica a: ${p.occupation ?? persona.occupation}`);
    if (p.workplace) profileLines.push(`- Empresa/Lugar de trabajo: ${p.workplace}`);
    if (p.current_location) profileLines.push(`- Ubicación actual: ${p.current_location}`);
    if (p.likes) profileLines.push(`- Le gusta: ${p.likes}`);
    if (p.hobbies) profileLines.push(`- Hobbies: ${p.hobbies}`);
    if (p.values) profileLines.push(`- Lo que más valora: ${p.values}`);
    if (p.dislikes) profileLines.push(`- No le gusta: ${p.dislikes}`);
    if (p.allergies) profileLines.push(`- Alergias: ${p.allergies}`);
    if (persona.bio) profileLines.push(`- Sobre él/ella: ${persona.bio}`);

    if (profileLines.length > 0) {
      sections.push('\n### Perfil personal', ...profileLines);
      hasContent = true;
    }

    if (persona.expectations) {
      sections.push('\n### Qué espera de EVA', `- ${persona.expectations}`);
      hasContent = true;
    }
    if (persona.communication_preferences) {
      sections.push(`- Estilo de comunicación preferido: ${persona.communication_preferences}`);
      hasContent = true;
    }

    const activeGoals = context.goals.filter((g) => g.status === 'active');
    if (activeGoals.length > 0) {
      sections.push('\n### Metas activas');
      activeGoals.forEach((g) => {
        const deadline = g.deadline ? ` (meta: ${g.deadline})` : '';
        const progress = g.progress ? ` — Progreso: ${g.progress}` : '';
        sections.push(`- ${g.title}${deadline}${progress}`);
      });
      hasContent = true;
    }

    if (calendarBlock) {
      sections.push('\n### Agenda próxima (Google Calendar)', calendarBlock);
      hasContent = true;
    } else if (context.cowork_context.upcoming_appointments) {
      sections.push('\n### Citas próximas (estáticas)', context.cowork_context.upcoming_appointments);
      hasContent = true;
    }

    const projects = persona.projects ?? context.cowork_context.projects;
    if (projects) {
      sections.push('\n### Proyectos activos', projects);
      hasContent = true;
    }

    const pending = context.cowork_context.pending_tasks;
    if (pending) {
      sections.push('\n### Tareas pendientes', pending);
      hasContent = true;
    }

    const routines = persona.routines ?? context.cowork_context.routines;
    if (routines) {
      sections.push('\n### Rutinas', routines);
      hasContent = true;
    }

    const workHours = persona.work_hours ?? context.cowork_context.work_hours;
    if (workHours) {
      sections.push(`\n### Horarios de trabajo: ${workHours}`);
      hasContent = true;
    }

    const family = persona.family ?? context.cowork_context.family;
    if (family) {
      sections.push('\n### Familia y relaciones importantes', family);
      hasContent = true;
    }

    if (persona.relationship_map?.length) {
      sections.push(
        '\n### Mapa de relaciones y contactos',
        'Usa este mapa para resolver referencias como "mi mamá", "mamá", "madre", "mi jefe" o aliases repetidos antes de buscar contactos externos.',
        ...persona.relationship_map
          .slice()
          .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
          .map((entry) => {
            const aliases = entry.aliases?.length ? ` aliases: ${entry.aliases.join(', ')}` : '';
            const contact = entry.contact_hint ? ` contacto: ${entry.contact_hint}` : '';
            const notes = entry.notes ? ` notas: ${entry.notes}` : '';
            return `- ${entry.relation}: ${entry.display_name}.${aliases}${contact}${notes}`;
          }),
      );
      hasContent = true;
    }

    if (context.private_context?.text) {
      sections.push(
        '\n### Contexto privado cifrado',
        'Este bloque fue descifrado server-side para uso interno del modelo. No lo reveles ni lo repitas salvo que el usuario lo pida explícitamente.',
        context.private_context.text,
      );
      hasContent = true;
    }

    if (patternBlock) {
      sections.push('\n### Patrones de comportamiento detectados', patternBlock);
      hasContent = true;
    }

    if (!hasContent) return null;
    return sections.join('\n').slice(0, 5000);
  }
}
