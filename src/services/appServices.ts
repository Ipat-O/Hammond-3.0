import { nativeFilesystem, nativeHarness, nativeLocalSettings } from '../api/native';
import {
  ownerAuth,
  ProjectMemoryRepository,
  ProjectRepository,
  SupabaseAssignmentRepository,
  SupabaseInstructionRepository,
  TaskRepository,
} from '../data';
import { AssignmentsService } from '../assignments/service';
import { createNativeHarnessAdapters } from '../harness/adapter';
import { HarnessInjectionService } from '../harness/service';
import { InstructionsService } from '../instructions/service';
import { getSharedDirectoryContextManager } from '../settings/directoryContextManager';
import type { TrackerServices } from '../tracker/contracts';

/**
 * Builds the one set of repositories/services the whole app runs on. Extracted out of `App.tsx`
 * so it can be constructed once, independently of which screen (auth vs. tracker) is currently
 * rendered — the agent-access dispatcher (`src/agentAccess/`) needs the exact same service
 * instances the UI uses, not a second independently-constructed copy, so a local API/MCP write
 * is immediately visible to the UI and vice versa.
 */
export function createDefaultServices(): TrackerServices {
  const assignments = new AssignmentsService(new SupabaseAssignmentRepository());
  const instructions = new InstructionsService(new SupabaseInstructionRepository());
  return {
    auth: ownerAuth,
    repositories: {
      projects: new ProjectRepository(),
      tasks: new TaskRepository(),
      memory: new ProjectMemoryRepository(),
    },
    directoryContext: {
      filesystem: nativeFilesystem,
      settings: nativeLocalSettings,
    },
    instructions,
    assignments,
    harness: new HarnessInjectionService({
      assignments,
      instructions,
      adapters: createNativeHarnessAdapters(nativeHarness),
      filesystem: nativeFilesystem,
    }),
  };
}

/** The single shared `DirectoryContextManager` for these services — see `getSharedDirectoryContextManager`. */
export function directoryContextManagerFor(services: TrackerServices) {
  return getSharedDirectoryContextManager(services.directoryContext);
}
