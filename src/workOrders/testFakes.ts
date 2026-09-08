import { vi } from 'vitest';

import type { FilesystemCommands, LocalSettingsStore } from '../api/contracts';
import { AssignmentsService } from '../assignments/service';
import { createFakeAssignmentRepository, seedProjectDefaults } from '../assignments/testFakes';
import { InstructionsService } from '../instructions/service';
import { createFakeInstructionRepository } from '../instructions/testFakes';
import { createFakeLocalSettings } from '../settings/testFakes';
import { WorkOrderInjectionService } from './injection';
import { WorkOrderLocalStore } from './localStore';
import { WorkOrdersService } from './service';

function fileKey(root: string, relativePath: string): string {
  return `${root} ${relativePath}`;
}

/** A `LocalSettingsStore` fake that can be told to fail specific writes on demand — used to
 * reproduce a partial write (the document key succeeds, the index key fails, or vice versa) and
 * to prove recovery on a later call without depending on anything but the persisted store state
 * itself (a fresh `WorkOrderLocalStore` wrapping the same `store` sees the exact same data). */
export interface ControlledLocalSettings extends LocalSettingsStore {
  store: Map<string, unknown>;
  /** The next `count` (default: unlimited) `write()` calls whose key matches `match` throw
   * `error` instead of persisting. Call again to layer additional rules; the first matching rule
   * with attempts remaining wins. */
  failWritesMatching(
    match: (key: string) => boolean,
    options?: { count?: number; error?: Error },
  ): void;
}

export function createControlledLocalSettings(): ControlledLocalSettings {
  const store = new Map<string, unknown>();
  const rules: { match: (key: string) => boolean; remaining: number; error: Error }[] = [];

  return {
    store,
    read: vi.fn(async (key: string) =>
      store.has(key) ? store.get(key) : null,
    ) as LocalSettingsStore['read'],
    write: vi.fn(async (key: string, value: unknown) => {
      const rule = rules.find((candidate) => candidate.remaining > 0 && candidate.match(key));
      if (rule) {
        rule.remaining -= 1;
        throw rule.error;
      }
      store.set(key, value);
    }) as LocalSettingsStore['write'],
    remove: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    failWritesMatching(match, options = {}) {
      rules.push({
        match,
        remaining: options.count ?? Infinity,
        error: options.error ?? new Error('write failed'),
      });
    },
  };
}

/** In-memory `FilesystemCommands` fake that actually tracks per-(root, relativePath) file
 * content — unlike `settings/testFakes.ts`'s `createFakeFilesystem`, which only tracks whether a
 * *root* is known (built for directory-reachability checks, not file-level read/write). Work
 * order injection needs real file-content semantics to exercise classify/inject/remove. */
export function createFakeWorkOrderFilesystem(): FilesystemCommands & {
  files: Map<string, string>;
} {
  const files = new Map<string, string>();
  return {
    files,
    selectDirectory: vi.fn().mockResolvedValue(null),
    readTextFile: vi.fn(async (root: string, relativePath: string) => {
      const value = files.get(fileKey(root, relativePath));
      if (value === undefined)
        throw new Error(`ENOENT: no such file ${relativePath} under ${root}`);
      return value;
    }),
    writeTextFile: vi.fn(async (root: string, relativePath: string, contents: string) => {
      files.set(fileKey(root, relativePath), contents);
    }),
    removePath: vi.fn(async (root: string, relativePath: string) => {
      files.delete(fileKey(root, relativePath));
    }),
    pathExists: vi.fn(async (root: string, relativePath: string) =>
      files.has(fileKey(root, relativePath)),
    ),
    revealDirectory: vi.fn().mockResolvedValue(undefined),
  };
}

/** Wires a full `WorkOrdersService` over real service classes and in-memory fakes for every
 * downstream port (local settings, filesystem, assignments, instructions) — the same "real
 * service wiring, fake persistence boundary" level `App.test.tsx` uses for other domains. */
export interface WorkOrdersTestHarness {
  ownerId: string;
  localSettings: LocalSettingsStore;
  filesystem: FilesystemCommands & { files: Map<string, string> };
  assignments: AssignmentsService;
  instructions: InstructionsService;
  localStore: WorkOrderLocalStore;
  injection: WorkOrderInjectionService;
  service: WorkOrdersService;
  /** Seeds the D-014 default role assignments for a project, mirroring the real project-create trigger. */
  seedProject(projectId: string): void;
}

export function createWorkOrdersTestHarness(
  ownerId = 'owner-1',
  overrides: { localSettings?: LocalSettingsStore } = {},
): WorkOrdersTestHarness {
  const localSettings = overrides.localSettings ?? createFakeLocalSettings();
  const filesystem = createFakeWorkOrderFilesystem();
  const assignmentRepo = createFakeAssignmentRepository(undefined, ownerId);
  const assignments = new AssignmentsService(assignmentRepo);
  const instructions = new InstructionsService(createFakeInstructionRepository(undefined, ownerId));
  const localStore = new WorkOrderLocalStore(localSettings);
  const injection = new WorkOrderInjectionService({ filesystem });
  const service = new WorkOrdersService({ localStore, injection, assignments, instructions });

  return {
    ownerId,
    localSettings,
    filesystem,
    assignments,
    instructions,
    localStore,
    injection,
    service,
    seedProject(projectId: string) {
      seedProjectDefaults(assignmentRepo.store, projectId, ownerId);
    },
  };
}
