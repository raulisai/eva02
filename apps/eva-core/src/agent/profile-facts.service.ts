import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SecretCipher } from '../common/secret-cipher';
import { DatabaseService } from '../database/database.service';
import { SensitivityClassifierService } from './sensitivity-classifier.service';
import { SoulContextService } from './soul-context.service';

type ProfileFactType = 'todo' | 'note' | 'goal' | 'profile_field' | 'suggestion';
type ProfileSource = 'manual' | 'eva' | 'digester' | 'import';

interface ApplyFactInput {
  type: ProfileFactType;
  payload: Record<string, unknown>;
  source?: string;
  evidenceTaskId?: string;
}

@Injectable()
export class ProfileFactsService {
  private readonly logger = new Logger(ProfileFactsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly classifier: SensitivityClassifierService,
    private readonly soul: SoulContextService,
  ) {}

  async getOverview(orgId: string) {
    const [todos, notes, goals, privateItems, suggestions] = await Promise.all([
      this.readTable('profile_todos', 'id,title,notes,status,due_date,priority,source,confidence,sensitivity,sensitive_hint,updated_at', orgId, 'position'),
      this.readTable('profile_notes', 'id,title,content,color,pinned,agent_visible,source,confidence,sensitivity,sensitive_hint,updated_at', orgId, 'updated_at'),
      this.readTable('profile_goals', 'id,title,description,status,deadline,progress,category,source,confidence,sensitivity,sensitive_hint,updated_at', orgId, 'updated_at'),
      this.readTable('profile_private_items', 'id,kind,label,hint,sensitivity,source,updated_at', orgId, 'updated_at'),
      this.readTable('profile_suggestions', 'id,fact_type,payload,confidence,status,reason,created_at', orgId, 'created_at', { status: 'pending' }),
    ]);
    return { todos, notes, goals, private_items: privateItems, suggestions };
  }

  async createPrivateItem(orgId: string, userId: string, input: { kind: string; label: string; value: string }) {
    const value = input.value.trim();
    const classified = this.classifier.classify(value);
    const payload = {
      org_id: orgId,
      kind: input.kind.trim() || 'note',
      label: input.label.trim(),
      ciphertext: SecretCipher.encrypt(JSON.stringify({ value, updated_at: new Date().toISOString() })),
      hint: classified.hint ?? this.safeTextHint(value),
      sensitivity: classified.sensitivity === 'normal' ? 'personal' : classified.sensitivity,
      source: 'manual',
      created_by: userId,
    };
    const { data, error } = await this.db.admin
      .from('profile_private_items')
      .insert(payload)
      .select('id,kind,label,hint,sensitivity,source,created_at,updated_at')
      .single();
    if (error) throw error;
    return data;
  }

  async revealPrivateItem(orgId: string, userId: string, id: string, reason?: string) {
    const { data, error } = await this.db.admin
      .from('profile_private_items')
      .select('id,ciphertext,hint')
      .eq('org_id', orgId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new NotFoundException('Private profile item not found');

    await this.db.admin.from('profile_private_access_logs').insert({
      org_id: orgId,
      private_item_id: id,
      revealed_by: userId,
      reason: reason?.trim() || 'profile_reveal',
    });

    const parsed = JSON.parse(SecretCipher.decrypt(String(data.ciphertext))) as { value?: string };
    return { id, value: parsed.value ?? '', hint: data.hint };
  }

  async applyFact(orgId: string, userId: string, input: ApplyFactInput) {
    if ((Number(input.payload.confidence ?? 1) || 1) < 0.72 || input.type === 'suggestion') {
      return this.createSuggestion(orgId, input);
    }

    switch (input.type) {
      case 'todo':
        return this.insertTodo(orgId, userId, input);
      case 'note':
        return this.insertNote(orgId, userId, input);
      case 'goal':
        return this.insertGoal(orgId, userId, input);
      case 'profile_field':
        return this.updateProfileField(orgId, input.payload);
      default:
        return this.createSuggestion(orgId, input);
    }
  }

  async acceptSuggestion(orgId: string, userId: string, id: string) {
    const { data, error } = await this.db.admin
      .from('profile_suggestions')
      .select('id,fact_type,payload,status')
      .eq('org_id', orgId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new NotFoundException('Profile suggestion not found');
    const result = await this.applyFact(orgId, userId, {
      type: String(data.fact_type) as ProfileFactType,
      payload: { ...((data.payload ?? {}) as Record<string, unknown>), confidence: 1 },
      source: 'digester',
    });
    await this.db.admin
      .from('profile_suggestions')
      .update({ status: 'accepted' })
      .eq('org_id', orgId)
      .eq('id', id);
    return { accepted: true, result };
  }

  async dismissSuggestion(orgId: string, id: string) {
    const { error } = await this.db.admin
      .from('profile_suggestions')
      .update({ status: 'dismissed' })
      .eq('org_id', orgId)
      .eq('id', id);
    if (error) throw error;
    return { dismissed: true };
  }

  private async insertTodo(orgId: string, userId: string, input: ApplyFactInput) {
    const text = String(input.payload.title ?? input.payload.text ?? '').trim();
    const classified = this.classifier.classify(`${text} ${String(input.payload.notes ?? '')}`);
    const { data, error } = await this.db.admin
      .from('profile_todos')
      .insert({
        org_id: orgId,
        title: classified.sensitivity === 'sensitive' ? classified.hint ?? 'Tarea privada' : text,
        notes: classified.sensitivity === 'sensitive' ? null : this.optionalText(input.payload.notes),
        due_date: this.optionalText(input.payload.due_date),
        priority: this.clampInt(input.payload.priority, 0, 3, 2),
        source: this.source(input.source),
        confidence: this.confidence(input.payload.confidence),
        evidence_task_id: this.optionalText(input.evidenceTaskId),
        sensitivity: classified.sensitivity,
        sensitive_hint: classified.hint,
        created_by: userId,
      })
      .select('*')
      .single();
    if (error) throw error;
    if (classified.sensitivity === 'sensitive') {
      await this.createPrivateItem(orgId, userId, { kind: 'todo', label: text || 'Tarea privada', value: JSON.stringify(input.payload) });
    }
    return data;
  }

  private async insertNote(orgId: string, userId: string, input: ApplyFactInput) {
    const content = String(input.payload.content ?? input.payload.text ?? '').trim();
    const classified = this.classifier.classify(content);
    const { data, error } = await this.db.admin
      .from('profile_notes')
      .insert({
        org_id: orgId,
        title: this.optionalText(input.payload.title),
        content: classified.sensitivity === 'sensitive' ? classified.hint ?? 'Nota privada' : content,
        source: this.source(input.source),
        confidence: this.confidence(input.payload.confidence),
        evidence_task_id: this.optionalText(input.evidenceTaskId),
        sensitivity: classified.sensitivity,
        sensitive_hint: classified.hint,
        created_by: userId,
      })
      .select('*')
      .single();
    if (error) throw error;
    if (classified.sensitivity === 'sensitive') {
      await this.createPrivateItem(orgId, userId, { kind: 'note', label: this.optionalText(input.payload.title) ?? 'Nota privada', value: content });
    }
    return data;
  }

  private async insertGoal(orgId: string, userId: string, input: ApplyFactInput) {
    const title = String(input.payload.title ?? '').trim();
    const text = `${title} ${String(input.payload.description ?? '')}`;
    const classified = this.classifier.classify(text);
    const { data, error } = await this.db.admin
      .from('profile_goals')
      .insert({
        org_id: orgId,
        title: classified.sensitivity === 'sensitive' ? classified.hint ?? 'Meta privada' : title,
        description: classified.sensitivity === 'sensitive' ? null : this.optionalText(input.payload.description),
        deadline: this.optionalText(input.payload.deadline),
        progress: this.clampInt(input.payload.progress, 0, 100, 0),
        category: this.optionalText(input.payload.category),
        source: this.source(input.source),
        confidence: this.confidence(input.payload.confidence),
        evidence_task_id: this.optionalText(input.evidenceTaskId),
        sensitivity: classified.sensitivity,
        sensitive_hint: classified.hint,
        created_by: userId,
      })
      .select('*')
      .single();
    if (error) throw error;
    if (classified.sensitivity === 'sensitive') {
      await this.createPrivateItem(orgId, userId, { kind: 'goal', label: title || 'Meta privada', value: JSON.stringify(input.payload) });
    }
    return data;
  }

  private async updateProfileField(orgId: string, payload: Record<string, unknown>) {
    const key = String(payload.key ?? '').trim();
    const value = String(payload.value ?? '').trim();
    if (!key || !value) return { skipped: true, reason: 'missing_field' };
    const current = await this.soul.getPersonalProfile(orgId);
    if (current[key as keyof typeof current]) return { skipped: true, reason: 'user_value_exists' };
    return this.soul.updatePersonalProfile(orgId, { [key]: value });
  }

  private async createSuggestion(orgId: string, input: ApplyFactInput) {
    const { data, error } = await this.db.admin
      .from('profile_suggestions')
      .insert({
        org_id: orgId,
        fact_type: input.type,
        payload: input.payload,
        confidence: this.confidence(input.payload.confidence, 0.5),
        evidence_task_id: this.optionalText(input.evidenceTaskId),
        reason: 'needs_user_confirmation',
      })
      .select('*')
      .single();
    if (error) throw error;
    return data;
  }

  private async readTable(table: string, select: string, orgId: string, order: string, equals?: Record<string, string>) {
    let query = this.db.admin
      .from(table)
      .select(select)
      .eq('org_id', orgId);
    for (const [key, value] of Object.entries(equals ?? {})) {
      query = query.eq(key, value);
    }
    const { data, error } = await query.order(order, { ascending: order === 'position' });
    if (error) {
      this.logger.warn(`Could not read ${table} for org ${orgId}: ${error.message}`);
      return [];
    }
    return data ?? [];
  }

  private optionalText(value: unknown): string | null {
    const text = String(value ?? '').trim();
    return text || null;
  }

  private source(value?: string): ProfileSource {
    return ['manual', 'eva', 'digester', 'import'].includes(String(value)) ? value as ProfileSource : 'eva';
  }

  private confidence(value: unknown, fallback = 1): number {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(1, Math.max(0, number));
  }

  private clampInt(value: unknown, min: number, max: number, fallback: number): number {
    const number = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }

  private safeTextHint(value: string): string {
    const words = value.split(/\s+/).filter(Boolean).length;
    return `${words} words stored encrypted`;
  }
}
