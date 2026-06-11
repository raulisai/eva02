import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { ModelRouterService } from '../model-router/model-router.service';
import { SandboxLanguage, SandboxService } from './sandbox.service';

const FORGE_PROMPT = `Eres EVA. Genera UN script autocontenido que resuelva la tarea del usuario.
Responde SOLO con JSON válido: {"language": "python"|"node"|"bash", "filename": "...",
"description": "una línea", "code": "el script completo"}.
El script no debe requerir red ni dependencias externas; imprime su resultado por stdout.`;

export interface ForgeOutcome {
  scriptUrl?: string;
  language: string;
  filename: string;
  description: string;
  executed: boolean;
  output?: string;
  skillSlug?: string;
  note?: string;
}

/**
 * Autonomy core: EVA writes her own script for the task, runs it inside the
 * shared sandbox (SandboxService), persists it as an artifact and registers
 * it as a reusable skill that SkillLibraryService can re-run later.
 */
@Injectable()
export class ScriptForgeService {
  private readonly logger = new Logger(ScriptForgeService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly modelRouter: ModelRouterService,
    private readonly sandbox: SandboxService,
  ) {}

  /** Cheap signal: does this order ask for code/automation EVA should build? */
  isScriptTask(text: string): boolean {
    return /\b(script|c[oó]digo|programa|automatiza|bot|scraper|cron|docker|funci[oó]n que|genera (un|una) (script|programa)|calcula .*con c[oó]digo)\b/i.test(text);
  }

  async forge(orgId: string, taskId: string, input: string, log: (message: string, scope: string) => Promise<unknown>): Promise<ForgeOutcome> {
    await log('forjando script con el modelo…', 'forge');
    const generated = await this.modelRouter.generate(input, {
      orgId,
      taskId,
      requestType: 'code',
      budget: 'balanced',
      maxTokens: 1800,
      responseFormat: 'json',
      systemPrompt: FORGE_PROMPT,
    });

    const spec = this.parseSpec(generated.text);
    await log(`script listo: ${spec.filename} (${spec.language}) — ${spec.description}`, 'forge');

    // Persist the script as an artifact so it shows up in /artifacts
    await this.saveArtifact(orgId, taskId, 'code', spec.filename, spec.code, {
      language: spec.language, generated: true,
    });

    // Register as a reusable skill
    const skillSlug = await this.registerSkill(orgId, spec).catch((error) => {
      this.logger.warn(`skill registration failed: ${(error as Error).message}`);
      return undefined;
    });
    if (skillSlug) await log(`registrada como skill "${skillSlug}"`, 'forge');

    // Execute in the shared throwaway sandbox if Docker is around
    if (!(await this.sandbox.dockerAvailable())) {
      await log('docker no disponible en este nodo — script guardado sin ejecutar', 'sandbox');
      return { ...spec, executed: false, skillSlug, note: 'Docker no disponible; el script quedó como artifact + skill.' };
    }

    await log(`ejecutando en sandbox docker (sin red, 60s máx)…`, 'sandbox');
    const result = await this.sandbox.runOneShot({
      language: spec.language as SandboxLanguage,
      code: spec.code,
      filename: spec.filename,
      orgId,
    });

    if (!result.ok) {
      const message = (result.error ?? result.output).slice(0, 500);
      await log(`sandbox falló: ${message}`, 'sandbox');
      return { ...spec, executed: false, skillSlug, note: `Ejecución falló: ${message}` };
    }

    await log(`sandbox terminó OK (${result.output.length} bytes de salida)`, 'sandbox');
    await this.saveArtifact(orgId, taskId, 'text', `${spec.filename}.output`, result.output || '(sin salida)', {
      execution: true,
    });
    return { ...spec, executed: true, output: result.output, skillSlug };
  }

  private parseSpec(raw: string): { language: string; filename: string; description: string; code: string } {
    const jsonText = raw.match(/\{[\s\S]*\}/)?.[0] ?? raw;
    const parsed = JSON.parse(jsonText) as { language?: string; filename?: string; description?: string; code?: string };
    if (!parsed.code) throw new Error('Model returned no code');
    const language = ['python', 'node', 'bash'].includes(parsed.language ?? '') ? parsed.language! : 'python';
    return {
      language,
      filename: (parsed.filename ?? `script.${language === 'python' ? 'py' : language === 'node' ? 'js' : 'sh'}`).replace(/[^\w.\-]/g, '_'),
      description: parsed.description ?? 'Script generado por EVA',
      code: parsed.code,
    };
  }

  private async saveArtifact(
    orgId: string, taskId: string, kind: string, title: string, content: string,
    metadata: Record<string, unknown>,
  ) {
    const { error } = await this.db.admin.from('artifacts').insert({
      org_id: orgId, task_id: taskId, kind, title, content, metadata,
    });
    if (error) this.logger.warn(`artifact save failed: ${error.message}`);
  }

  private async registerSkill(orgId: string, spec: { filename: string; language: string; description: string; code: string }) {
    const slug = `gen-${spec.filename.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 60);
    const { data: skill, error } = await this.db.admin
      .from('skills')
      .upsert({
        org_id: orgId,
        slug,
        display_name: spec.filename,
        description: `${spec.description} (auto-generada por EVA)`,
        status: 'active',
        latest_version: '1.0.0',
        metadata: { generated: true, language: spec.language },
      }, { onConflict: 'org_id,slug' })
      .select()
      .single();
    if (error || !skill) throw new Error(error?.message ?? 'skill upsert failed');

    await this.db.admin.from('skill_versions').upsert({
      org_id: orgId,
      skill_id: skill.id,
      version: '1.0.0',
      manifest: { name: slug, version: '1.0.0', generated: true, language: spec.language, filename: spec.filename },
      instructions: spec.code,
      checksum: createHash('md5').update(spec.code).digest('hex'),
    }, { onConflict: 'org_id,skill_id,version' });

    return slug;
  }
}
