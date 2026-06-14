import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
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
    const [todos, notes, goals, privateItems, suggestions, places] = await Promise.all([
      this.readTable('profile_todos', 'id,title,notes,status,due_date,priority,source,confidence,sensitivity,sensitive_hint,updated_at', orgId, 'position'),
      this.readTable('profile_notes', 'id,title,content,color,pinned,agent_visible,source,confidence,sensitivity,sensitive_hint,updated_at', orgId, 'updated_at'),
      this.readTable('profile_goals', 'id,title,description,status,deadline,progress,category,source,confidence,sensitivity,sensitive_hint,updated_at', orgId, 'updated_at'),
      this.readTable('profile_private_items', 'id,kind,label,hint,sensitivity,source,updated_at', orgId, 'updated_at'),
      this.readTable('profile_suggestions', 'id,fact_type,payload,confidence,status,reason,created_at', orgId, 'created_at', { status: 'pending' }),
      this.getPlaces(orgId),
    ]);
    return { todos, notes, goals, private_items: privateItems, suggestions, places };
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

  async deletePrivateItem(orgId: string, id: string) {
    const { error } = await this.db.admin
      .from('profile_private_items')
      .delete()
      .eq('org_id', orgId)
      .eq('id', id);
    if (error) throw error;
    return { deleted: true };
  }

  async deleteTodo(orgId: string, id: string) {
    const { error } = await this.db.admin
      .from('profile_todos')
      .delete()
      .eq('org_id', orgId)
      .eq('id', id);
    if (error) throw error;
    return { deleted: true };
  }

  async deleteNote(orgId: string, id: string) {
    const { error } = await this.db.admin
      .from('profile_notes')
      .delete()
      .eq('org_id', orgId)
      .eq('id', id);
    if (error) throw error;
    return { deleted: true };
  }

  async deleteGoal(orgId: string, id: string) {
    const { error } = await this.db.admin
      .from('profile_goals')
      .delete()
      .eq('org_id', orgId)
      .eq('id', id);
    if (error) throw error;
    return { deleted: true };
  }

  async updatePersonaField(orgId: string, key: string, value: string, section: 'personal_profile' | 'persona_context' | 'cowork_context' = 'personal_profile') {
    const trimmedKey = key.trim();
    const trimmedValue = value.trim();
    if (!trimmedKey) return { skipped: true, reason: 'missing_key' };

    if (section === 'personal_profile') {
      return this.soul.updatePersonalProfile(orgId, { [trimmedKey]: trimmedValue || undefined });
    }

    const { data, error } = await this.db.admin
      .from('agent_souls')
      .select('persona_context')
      .eq('org_id', orgId)
      .maybeSingle();
    if (error) throw error;

    const current = ((data?.persona_context ?? {}) as Record<string, unknown>);

    let updated: Record<string, unknown>;
    if (section === 'cowork_context') {
      const nested = (current.cowork_context ?? {}) as Record<string, unknown>;
      updated = { ...current, cowork_context: { ...nested, [trimmedKey]: trimmedValue || undefined } };
    } else {
      updated = { ...current, [trimmedKey]: trimmedValue || undefined };
    }

    await this.db.admin
      .from('agent_souls')
      .upsert({ org_id: orgId, persona_context: updated }, { onConflict: 'org_id' })
      .select();

    return updated;
  }

  async getPlaces(orgId: string) {
    const { data, error } = await this.db.admin
      .from('known_places')
      .select('id,label,address,lat,lng,radius_m,visit_count,last_visit,typical_days,typical_time')
      .eq('org_id', orgId)
      .order('visit_count', { ascending: false });
    if (error) {
      this.logger.warn(`Could not read known_places for org ${orgId}: ${error.message}`);
      return [];
    }
    return data ?? [];
  }

  async addPlace(orgId: string, userId: string, input: { label: string; address?: string; lat?: number; lng?: number; radius_m?: number }) {
    const { data, error } = await this.db.admin
      .from('known_places')
      .upsert({
        org_id: orgId,
        label: input.label.trim(),
        address: input.address?.trim() || null,
        lat: input.lat ?? null,
        lng: input.lng ?? null,
        radius_m: input.radius_m ?? 150,
      }, { onConflict: 'org_id,label' })
      .select('id,label,address,lat,lng,radius_m,visit_count,last_visit')
      .single();
    if (error) throw error;
    return data;
  }

  async updatePlace(orgId: string, id: string, input: { label?: string; address?: string; lat?: number; lng?: number; radius_m?: number }) {
    const patch: Record<string, unknown> = {};

    if (input.label !== undefined) {
      const label = input.label.trim();
      if (!label) throw new BadRequestException('Place label is required');
      patch.label = label;
    }
    if (input.address !== undefined) patch.address = input.address.trim() || null;
    if (input.lat !== undefined) patch.lat = input.lat;
    if (input.lng !== undefined) patch.lng = input.lng;
    if (input.radius_m !== undefined) patch.radius_m = input.radius_m;

    if (Object.keys(patch).length === 0) return { skipped: true, reason: 'empty_update' };

    const { data, error } = await this.db.admin
      .from('known_places')
      .update(patch)
      .eq('org_id', orgId)
      .eq('id', id)
      .select('id,label,address,lat,lng,radius_m,visit_count,last_visit,typical_days')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new NotFoundException('Known place not found');
    return data;
  }

  async deletePlace(orgId: string, id: string) {
    const { error } = await this.db.admin
      .from('known_places')
      .delete()
      .eq('org_id', orgId)
      .eq('id', id);
    if (error) throw error;
    return { deleted: true };
  }

  async addRelationship(orgId: string, input: { display_name: string; relation: string; contact_hint?: string; notes?: string }) {
    const current = await this.soul.getPersonaContext(orgId);
    const existing = Array.isArray(current.relationship_map) ? current.relationship_map : [];
    const entry = {
      id: crypto.randomUUID(),
      display_name: input.display_name.trim(),
      relation: input.relation.trim(),
      aliases: [] as string[],
      contact_hint: input.contact_hint?.trim() || undefined,
      notes: input.notes?.trim() || undefined,
      priority: existing.length,
    };
    await this.soul.updatePersonaContext(orgId, { relationship_map: [...existing, entry] });
    return entry;
  }

  async removeRelationship(orgId: string, relId: string) {
    const current = await this.soul.getPersonaContext(orgId);
    const existing = Array.isArray(current.relationship_map) ? current.relationship_map : [];
    const filtered = existing.filter((r) => r.id !== relId);
    await this.soul.updatePersonaContext(orgId, { relationship_map: filtered });
    return { deleted: true };
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
