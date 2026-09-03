import type { SupabaseClient } from '@supabase/supabase-js';

import type { InstructionRepository } from '../instructions/contracts';
import type {
  InstructionLayer,
  InstructionRole,
  InstructionSelection,
  InstructionTemplate,
  InstructionVersion,
  ProviderFamily,
} from '../instructions/types';
import { getSupabaseClient } from './client';
import type { Database } from './database.types';
import { assertNoAbsoluteLocalPaths } from './pathGuard';

type Tables = Database['public']['Tables'];
type TemplateRow = Tables['instruction_templates']['Row'];
type VersionRow = Tables['instruction_template_versions']['Row'];
type SelectionRow = Tables['project_instruction_selections']['Row'];

function dataOrThrow<T>(result: { data: T; error: Error | null }): NonNullable<T> {
  if (result.error) throw result.error;
  if (result.data === null) throw new Error('Supabase returned no data');
  return result.data as NonNullable<T>;
}

function toTemplate(row: TemplateRow): InstructionTemplate {
  return {
    id: row.id,
    ownerId: row.owner_id,
    role: row.role,
    provider: row.provider,
    layer: row.layer,
    projectId: row.project_id,
    name: row.name,
    isBase: row.is_base,
  };
}

function toVersion(row: VersionRow): InstructionVersion {
  return {
    id: row.id,
    templateId: row.template_id,
    ownerId: row.owner_id,
    version: row.version,
    content: row.content,
    restoredFromVersionId: row.restored_from_version_id,
    createdAt: row.created_at,
  };
}

function toSelection(row: SelectionRow): InstructionSelection {
  return {
    id: row.id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    role: row.role,
    provider: row.provider,
    sharedRoleVersionId: row.shared_role_version_id,
    providerVersionId: row.provider_version_id,
    overrideVersionId: row.override_version_id,
  };
}

/**
 * Supabase-backed `InstructionRepository`. Everything that touches Supabase
 * for the instruction domain lives here, behind `src/data/`, so React and
 * the `src/instructions/` domain module never construct queries directly.
 */
export class SupabaseInstructionRepository implements InstructionRepository {
  constructor(private readonly client: SupabaseClient<Database> = getSupabaseClient()) {}

  async getBaseVersion(params: {
    role: InstructionRole;
    provider: ProviderFamily | null;
    layer: 'shared_role' | 'provider';
  }): Promise<InstructionVersion> {
    let templateQuery = this.client
      .from('instruction_templates')
      .select('id')
      .eq('is_base', true)
      .eq('role', params.role)
      .eq('layer', params.layer);
    templateQuery = params.provider
      ? templateQuery.eq('provider', params.provider)
      : templateQuery.is('provider', null);
    const template = dataOrThrow(await templateQuery.single());

    const version = dataOrThrow(
      await this.client
        .from('instruction_template_versions')
        .select('*')
        .eq('template_id', template.id)
        .order('version', { ascending: true })
        .limit(1)
        .single(),
    );
    return toVersion(version);
  }

  async getOwnerTemplate(params: {
    role: InstructionRole;
    provider: ProviderFamily | null;
    layer: InstructionLayer;
    projectId: string | null;
  }): Promise<InstructionTemplate | null> {
    let query = this.client
      .from('instruction_templates')
      .select('*')
      .eq('is_base', false)
      .eq('role', params.role)
      .eq('layer', params.layer);
    query = params.provider ? query.eq('provider', params.provider) : query.is('provider', null);
    query = params.projectId
      ? query.eq('project_id', params.projectId)
      : query.is('project_id', null);
    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    return data ? toTemplate(data) : null;
  }

  async createOwnerTemplate(params: {
    role: InstructionRole;
    provider: ProviderFamily | null;
    layer: InstructionLayer;
    projectId: string | null;
    name: string;
  }): Promise<InstructionTemplate> {
    const insert: Tables['instruction_templates']['Insert'] = {
      role: params.role,
      provider: params.provider,
      layer: params.layer,
      project_id: params.projectId,
      name: params.name,
    };
    assertNoAbsoluteLocalPaths(insert);
    return toTemplate(
      dataOrThrow(await this.client.from('instruction_templates').insert(insert).select().single()),
    );
  }

  async insertVersion(params: {
    templateId: string;
    content: string;
    restoredFromVersionId?: string | null;
  }): Promise<InstructionVersion> {
    const insert: Tables['instruction_template_versions']['Insert'] = {
      template_id: params.templateId,
      content: params.content,
      restored_from_version_id: params.restoredFromVersionId ?? null,
    };
    assertNoAbsoluteLocalPaths(insert);
    return toVersion(
      dataOrThrow(
        await this.client.from('instruction_template_versions').insert(insert).select().single(),
      ),
    );
  }

  async listVersions(templateId: string): Promise<InstructionVersion[]> {
    const rows = dataOrThrow(
      await this.client
        .from('instruction_template_versions')
        .select('*')
        .eq('template_id', templateId)
        .order('version', { ascending: false }),
    );
    return rows.map(toVersion);
  }

  async getVersion(id: string): Promise<InstructionVersion> {
    return toVersion(
      dataOrThrow(
        await this.client.from('instruction_template_versions').select('*').eq('id', id).single(),
      ),
    );
  }

  async getVersionsByIds(ids: readonly string[]): Promise<InstructionVersion[]> {
    if (ids.length === 0) return [];
    const rows = dataOrThrow(
      await this.client.from('instruction_template_versions').select('*').in('id', Array.from(ids)),
    );
    return rows.map(toVersion);
  }

  async getSelection(params: {
    projectId: string;
    role: InstructionRole;
    provider: ProviderFamily;
  }): Promise<InstructionSelection | null> {
    const { data, error } = await this.client
      .from('project_instruction_selections')
      .select('*')
      .eq('project_id', params.projectId)
      .eq('role', params.role)
      .eq('provider', params.provider)
      .maybeSingle();
    if (error) throw error;
    return data ? toSelection(data) : null;
  }

  async upsertSelection(params: {
    projectId: string;
    role: InstructionRole;
    provider: ProviderFamily;
    sharedRoleVersionId: string;
    providerVersionId: string;
    overrideVersionId: string | null;
  }): Promise<InstructionSelection> {
    const insert: Tables['project_instruction_selections']['Insert'] = {
      project_id: params.projectId,
      role: params.role,
      provider: params.provider,
      shared_role_version_id: params.sharedRoleVersionId,
      provider_version_id: params.providerVersionId,
      override_version_id: params.overrideVersionId,
    };
    return toSelection(
      dataOrThrow(
        await this.client
          .from('project_instruction_selections')
          .upsert(insert, { onConflict: 'project_id,role,provider' })
          .select()
          .single(),
      ),
    );
  }
}
