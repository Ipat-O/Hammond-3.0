import type { AssignmentRepository } from './contracts';
import { AGENT_ASSIGNMENT_ROLES, DEFAULT_AGENT_ASSIGNMENTS } from './types';
import type { AgentAssignment } from './types';

let uidCounter = 0;
function nextId(prefix: string): string {
  uidCounter += 1;
  return `${prefix}-${uidCounter}`;
}

function postgresError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export interface FakeAssignmentStore {
  assignments: Map<string, AgentAssignment>;
  projectOwners: Map<string, string>;
}

function assignmentKey(projectId: string, role: string): string {
  return `${projectId}|${role}`;
}

export function createFakeAssignmentStore(): FakeAssignmentStore {
  return { assignments: new Map(), projectOwners: new Map() };
}

/**
 * Seeds the D-014 defaults for one project, mirroring the real
 * `project_agent_assignments_seed_defaults` trigger that fires when a
 * project is created.
 */
export function seedProjectDefaults(
  store: FakeAssignmentStore,
  projectId: string,
  ownerId: string,
): void {
  store.projectOwners.set(projectId, ownerId);
  const now = new Date().toISOString();
  for (const role of AGENT_ASSIGNMENT_ROLES) {
    const assignment: AgentAssignment = {
      id: nextId('assignment'),
      ownerId,
      projectId,
      role,
      provider: DEFAULT_AGENT_ASSIGNMENTS[role],
      createdAt: now,
      updatedAt: now,
    };
    store.assignments.set(assignmentKey(projectId, role), assignment);
  }
}

/**
 * In-memory `AssignmentRepository` fake mirroring the load-bearing server
 * invariants: every project always has exactly one row per role (rows are
 * never created or deleted through this repository, only updated), and a
 * write against a project the caller does not own (or that does not
 * exist) is rejected the same way the real foreign key/RLS combination
 * rejects it.
 */
export function createFakeAssignmentRepository(
  store: FakeAssignmentStore = createFakeAssignmentStore(),
  ownerId = 'owner-1',
): AssignmentRepository & { store: FakeAssignmentStore } {
  const repo: AssignmentRepository = {
    async listForProject(projectId) {
      return AGENT_ASSIGNMENT_ROLES.map((role) =>
        store.assignments.get(assignmentKey(projectId, role)),
      ).filter((assignment): assignment is AgentAssignment => assignment !== undefined);
    },

    async getAssignment({ projectId, role }) {
      return store.assignments.get(assignmentKey(projectId, role)) ?? null;
    },

    async updateAssignment({ projectId, role, provider }) {
      if (store.projectOwners.get(projectId) !== ownerId) {
        throw postgresError('23503', 'no matching owned project for this assignment');
      }
      const key = assignmentKey(projectId, role);
      const existing = store.assignments.get(key);
      if (!existing) {
        throw postgresError('PGRST116', 'JSON object requested, multiple (or no) rows returned');
      }
      const updated: AgentAssignment = {
        ...existing,
        provider,
        updatedAt: new Date().toISOString(),
      };
      store.assignments.set(key, updated);
      return updated;
    },
  };

  return Object.assign(repo, { store });
}
