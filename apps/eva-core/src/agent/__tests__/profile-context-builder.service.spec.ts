import { ProfileContextBuilderService } from '../profile-context-builder.service';
import { AgentSoulContext } from '../soul-context.service';

function context(overrides: Partial<AgentSoulContext> = {}): AgentSoulContext {
  return {
    personal_profile: {},
    cowork_context: {},
    goals: [],
    persona_context: {},
    ...overrides,
  };
}

describe('ProfileContextBuilderService', () => {
  let service: ProfileContextBuilderService;

  beforeEach(() => {
    service = new ProfileContextBuilderService();
  });

  it('builds a compact chat context from structured profile identity', () => {
    const input = service.buildChatContextualInput('hola', {
      soulContext: context({
        personal_profile: {
          full_name: 'Raul',
          preferred_address: 'Rulis',
          current_location: 'CDMX',
        },
        persona_context: {
          occupation: 'founder',
          communication_preferences: 'breve y directo',
        },
      }),
      conversationContext: [
        { role: 'user', text: 'ayer hablamos del deck' },
        { role: 'assistant', text: 'si, quedo pendiente' },
      ],
      proactiveTriggerMessages: ['Tienes una llamada pronto'],
      memoryRecallContext: 'Memoria: prefiere ejemplos concretos.',
    });

    expect(input).toContain('usuario: Raul');
    expect(input).toContain('llámale Rulis');
    expect(input).toContain('estilo preferido: breve y directo');
    expect(input).toContain('Sugerencias proactivas');
    expect(input).toContain('Conversación reciente');
    expect(input).toContain('Memoria: prefiere ejemplos concretos.');
  });

  it('formats full profile context with structured data before legacy cowork fields', () => {
    const output = service.buildContextualInput('prepara mi dia', {
      soulContext: context({
        personal_profile: {
          full_name: 'Raul',
          occupation: 'CTO',
          current_location: 'CDMX',
          allergies: 'cacahuate',
        },
        persona_context: {
          expectations: 'que EVA anticipe bloqueos',
          projects: 'EVA control plane',
          routines: 'deep work por la manana',
          work_hours: '10-18',
          family: 'Mama: Ana',
          relationship_map: [
            {
              id: 'rel-1',
              relation: 'mama',
              display_name: 'Ana',
              aliases: ['ma'],
              priority: 1,
            },
          ],
        },
        cowork_context: {
          projects: 'legacy project should not win',
          pending_tasks: 'cerrar roadmap',
          upcoming_appointments: '12:00 sync',
        },
        goals: [
          {
            id: 'g1',
            title: 'Lanzar EVA',
            status: 'active',
            deadline: '2026-07-01',
            progress: 'MVP listo',
            created_at: '2026-06-01T00:00:00Z',
          },
        ],
        private_context: { text: 'dato privado para decisiones internas' },
      }),
      conversationContext: [{ role: 'user', text: 'recuerda lo anterior' }],
      calendarBlock: '13:00 llamada',
      patternBlock: 'Suele pedir Uber a las 18:00',
      proactiveTriggerMessages: ['Puedes preparar agenda'],
      memoryRecallContext: 'Memoria: usa Notion.',
    });

    expect(output).toContain('### Perfil personal');
    expect(output).toContain('- Nombre: Raul');
    expect(output).toContain('- Alergias: cacahuate');
    expect(output).toContain('### Qué espera de EVA');
    expect(output).toContain('- Lanzar EVA (meta: 2026-07-01) — Progreso: MVP listo');
    expect(output).toContain('### Agenda próxima (Google Calendar)');
    expect(output).toContain('13:00 llamada');
    expect(output).toContain('EVA control plane');
    expect(output).not.toContain('legacy project should not win');
    expect(output).toContain('cerrar roadmap');
    expect(output).toContain('Contexto privado cifrado');
    expect(output).toContain('No inventes datos actuales');
  });

  it('returns the raw input when there is no profile or contextual data', () => {
    expect(service.buildContextualInput('solo responde', {
      soulContext: context(),
      conversationContext: [],
    })).toBe('solo responde');
  });
});
