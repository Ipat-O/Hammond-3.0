import { ProjectMemoryRepository, ProjectRepository, TaskRepository } from '../data';
import type { AssignmentsService } from '../assignments/service';
import type { HarnessInjectionService } from '../harness/service';
import type { InstructionsService } from '../instructions/service';
import { getSharedDirectoryContextManager } from '../settings/directoryContextManager';
import type { DirectoryContextManager } from '../settings/directoryContextManager';
import type { TrackerServices } from '../tracker/contracts';

/**
 * Everything an operation handler needs. Repositories are constructed fresh here rather than
 * reused from `TrackerServices.repositories` (whose type is deliberately narrowed to the UI's
 * own needs) — they are stateless wrappers over the one memoized `getSupabaseClient()`, so a
 * second instance is exactly as authoritative as the UI's, unlike `DirectoryContextManager`
 * (which does hold real in-memory state, and is threaded through via
 * `getSharedDirectoryContextManager` for exactly that reason).
 */
export interface AgentAccessDeps {
  projects: ProjectRepository;
  tasks: TaskRepository;
  memory: ProjectMemoryRepository;
  instructions: InstructionsService;
  assignments: AssignmentsService;
  harness: HarnessInjectionService;
  directoryContext: DirectoryContextManager;
}

export function createAgentAccessDeps(services: TrackerServices): AgentAccessDeps {
  return {
    projects: new ProjectRepository(),
    tasks: new TaskRepository(),
    memory: new ProjectMemoryRepository(),
    instructions: services.instructions,
    assignments: services.assignments,
    harness: services.harness,
    directoryContext: getSharedDirectoryContextManager(services.directoryContext),
  };
}
