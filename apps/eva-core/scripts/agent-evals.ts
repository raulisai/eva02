import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgentLoopService } from '../src/agent/agent-loop.service';

interface GoldenDecision {
  tool: string;
  args: Record<string, unknown>;
}

interface GoldenTask {
  id: string;
  goal: string;
  decisions: GoldenDecision[];
  nativeToolCalls?: Array<{ name: string; input: Record<string, unknown> }>;
  expectedTools: string[];
  expectedFinalIncludes: string[];
  maxSteps: number;
}

const ORG = '00000000-0000-0000-0000-000000000001';

function reply(text: string, tokens = 40) {
  return {
    text,
    model: 'eval-stub',
    backend: 'openai' as const,
    usage: { promptTokens: Math.floor(tokens / 2), completionTokens: Math.ceil(tokens / 2), totalTokens: tokens },
  };
}

function jsonDecision(decision: GoldenDecision) {
  return JSON.stringify({ thought: `eval ${decision.tool}`, tool: decision.tool, args: decision.args });
}

function buildLoop(task: GoldenTask) {
  let calls = 0;
  const decisions = [...task.decisions];
  const nativeToolCalls = task.nativeToolCalls;

  const db = {
    admin: {
      from: () => ({
        select: function select() { return this; },
        eq: function eq() { return this; },
        maybeSingle: async () => ({ data: { status: 'running', metadata: {}, created_by: 'user-eval' }, error: null }),
        insert: async () => ({ data: null, error: null }),
        upsert: async () => ({ data: null, error: null }),
      }),
    },
  } as any;

  const modelRouter = {
    generate: async (prompt: string, opts: any = {}) => {
      calls += 1;
      if (prompt.includes('INTENTOS REALIZADOS')) {
        return reply('Intenté las herramientas disponibles sin éxito. Opciones: reintentar, conectar credenciales o aportar el dato faltante.', 55);
      }
      if (prompt.includes('capa de pensamiento')) {
        const match = prompt.match(/Respuesta propuesta: "([\s\S]*?)"\n\nCRITERIOS/);
        return reply(match?.[1] ?? 'Listo.', 30);
      }
      if (nativeToolCalls && calls === 1) {
        return {
          ...reply('', 45),
          toolCalls: nativeToolCalls.map((tc, idx) => ({ id: `tc_${idx}`, name: tc.name, input: tc.input })),
          stopReason: 'tool_use' as const,
        };
      }
      const next = decisions.shift();
      if (!next) return reply(JSON.stringify({ thought: 'eval close', tool: 'final_answer', args: { text: 'Sin más pasos.' } }));
      return reply(jsonDecision(next));
    },
  } as any;

  const research = {
    answer: async () => {
      if (task.id === 'recovery-options') throw new Error('API caída');
      return { text: 'Clima: 22°C despejado', tool: 'eval', sources: [] };
    },
  } as any;
  const gmail = {
    fetchLatest: async () => ({ ok: true, text: '1 correo de Banco' }),
    fetchSearchWithFallback: async () => task.id === 'recovery-options'
      ? { ok: false, reason: 'no_credential' }
      : { ok: true, text: 'correo de Ana' },
  } as any;
  const calendar = { formatUpcomingForSoul: async () => '- Junta 10am' } as any;
  const schedule = { formatUpcomingForSoul: async () => null } as any;
  const drive = { fetchForQuery: async () => ({ ok: true, text: '3 archivos' }) } as any;
  const memory = {
    recall: async () => [{ id: 'm1', summary: 'Prefiere café americano', created_at: '2026-06-01T00:00:00Z' }],
    ingest: async () => ({ stored: true }),
  } as any;
  const forge = { forge: async () => ({ language: 'python', filename: 'eval.py', executed: true, output: '42' }) } as any;
  const sandbox = {
    execInSession: async (_taskId: string, args: any) => {
      const code = String(args.code ?? '');
      if (code.includes('1/0')) return { ok: false, output: 'ZeroDivisionError', error: 'exit 1' };
      if (code.includes('PermissionError')) return { ok: false, output: '', error: 'permission denied' };
      return { ok: true, output: code.includes('37 + 5') ? '42' : 'ok' };
    },
    readBackgroundOutput: async () => ({ ok: true, output: 'bg log' }),
    getHostDir: () => '/tmp',
  } as any;
  const skills = {
    findRelevant: async () => [],
    getRunnable: async () => ({ slug: 'clean-data', language: 'python', code: 'print("clean")' }),
    register: async () => ({ ok: true, slug: 'sumador', version: '1.0.0' }),
    recordOutcome: async () => undefined,
    beginSelection: async () => undefined,
  } as any;
  const trajectories = { checkpoint: async () => undefined, complete: async () => undefined } as any;

  return new AgentLoopService(
    db, modelRouter, research, gmail, calendar, schedule, drive, memory, forge, sandbox, skills,
    undefined, undefined, undefined, undefined, trajectories,
  );
}

async function main() {
  const file = path.resolve(__dirname, '../evals/golden-tasks.json');
  const tasks = JSON.parse(fs.readFileSync(file, 'utf8')) as GoldenTask[];
  const results = [];

  for (const task of tasks) {
    const loop = buildLoop(task);
    const started = Date.now();
    const outcome = await loop.run(ORG, `task-${task.id}`, task.goal, { maxSteps: task.maxSteps });
    const text = outcome.text.toLowerCase();
    const includesOk = task.expectedFinalIncludes.every((needle) => text.includes(needle.toLowerCase()));
    const toolsOk = task.expectedTools.every((tool) => outcome.toolsUsed.includes(tool));
    const stepsOk = outcome.steps.length <= task.maxSteps;
    const pass = outcome.ok && includesOk && toolsOk && stepsOk;
    results.push({ id: task.id, pass, steps: outcome.steps.length, tokens: outcome.tokensUsed, ms: Date.now() - started });
  }

  const passed = results.filter((r) => r.pass).length;
  const avgSteps = results.reduce((sum, r) => sum + r.steps, 0) / results.length;
  const avgTokens = results.reduce((sum, r) => sum + r.tokens, 0) / results.length;

  console.log(JSON.stringify({
    passRate: Number((passed / results.length).toFixed(4)),
    passed,
    total: results.length,
    avgSteps: Number(avgSteps.toFixed(2)),
    avgTokens: Number(avgTokens.toFixed(2)),
    regressions: results.filter((r) => !r.pass).map((r) => r.id),
    results,
  }, null, 2));

  if (passed !== results.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
