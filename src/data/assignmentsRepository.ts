import type { SupabaseClient } from '@supabase/supabase-js';

import type { AssignmentRepository } from '../assignments/contracts';
import { AGENT_ASSIGNMENT_ROLES } from '../assignments/types';
import type { AgentAssignment, InstructionRole, ProviderFamily } from '../assignments/types';
import { getSupabaseClient } from './client';
import type { Database } from './database.types';

type Tables = Database['public']['Tables'];
type AssignmentRow = Tables['project_agent_assignments']['Row'];

function dataOrThrow<T>(result: { data: T; error: Error | null }): NonNullable<T> {
  if (result.error) throw result.error;
  if (result.data === null) throw new Error('Supabase returned no data');
  return result.data as NonNullable<T>;
}

function toAssignment(row: AssignmentRow): AgentAssignment {
  return {
    id: row.id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    role: row.role,
    provider: row.provider,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Supabase-backed `AssignmentRepository`. Everything that touches Supabase
 * for the agent-assignment domain lives here, behind `src/data/`, so React
 * and `src/assignments/` never construct queries directly.
 */
export class SupabaseAssignmentRepository implements AssignmentRepository {
  constructor(private readonly client: SupabaseClient<Database> = getSupabaseClient()) {}

  async listForProject(projectId: string): Promise<AgentAssignment[]> {
    const rows = dataOrThrow(
      await this.client.from('project_agent_assignments').select('*').eq('project_id', projectId),
    );
    const byRole = new Map(rows.map((row) => [row.role, row]));
    return AGENT_ASSIGNMENT_ROLES.map((role) => byRole.get(role))
      .filter((row): row is AssignmentRow => row !== undefined)
      .map(toAssignment);
  }

  async getAssignment(params: {
    projectId: string;
    role: InstructionRole;
  }): Promise<AgentAssignment | null> {
    const { data, error } = await this.client
      .from('project_agent_assignments')
      .select('*')
      .eq('project_id', params.projectId)
      .eq('role', params.role)
      .maybeSingle();
    if (error) throw error;
    return data ? toAssignment(data) : null;
  }

  async updateAssignment(params: {
    projectId: string;
    role: InstructionRole;
    provider: ProviderFamily;
  }): Promise<AgentAssignment> {
    return toAssignment(
      dataOrThrow(
        await this.client
          .from('project_agent_assignments')
          .update({ provider: params.provider })
          .eq('project_id', params.projectId)
          .eq('role', params.role)
          .select()
          .single(),
      ),
    );
  }
}
