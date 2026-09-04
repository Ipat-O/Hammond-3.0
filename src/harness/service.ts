import type {
  FilesystemCommands,
  HarnessInjectOutcome,
  HarnessRemoveOutcome,
} from '../api/contracts';
import type { AssignmentsService } from '../assignments/service';
import type { AgentAssignment } from '../assignments/types';
import type { InstructionsService } from '../instructions/service';
import type { InstructionRole, InstructionVersion, ProviderFamily } from '../instructions/types';
import type { HarnessAdapter } from './contracts';
import { deriveAction } from './types';
import type { InjectionPreview } from './types';

export interface HarnessInjectionServiceDeps {
  assignments: AssignmentsService;
  instructions: InstructionsService;
  adapters: Record<ProviderFamily, HarnessAdapter>;
  filesystem: Pick<FilesystemCommands, 'readTextFile'>;
  /** Injectable for tests; defaults to `new Date().toISOString()`. */
  now?: () => string;
}

/**
 * Composes and injects instructions for one project role (HAM3-006 section 4): resolves the
 * project's assigned execution provider for the role, loads the exact active shared-role,
 * assigned-provider, and project-override versions through the HAM3-005 instructions domain,
 * composes them in the existing deterministic order, and passes only the resulting managed
 * document to the matching harness adapter. Never polls, launches a provider, or shells out to
 * Git/GitHub.
 */
export class HarnessInjectionService {
  private readonly assignments: AssignmentsService;
  private readonly instructions: InstructionsService;
  private readonly adapters: Record<ProviderFamily, HarnessAdapter>;
  private readonly filesystem: Pick<FilesystemCommands, 'readTextFile'>;
  private readonly now: () => string;

  constructor(deps: HarnessInjectionServiceDeps) {
    this.assignments = deps.assignments;
    this.instructions = deps.instructions;
    this.adapters = deps.adapters;
    this.filesystem = deps.filesystem;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  private adapterFor(provider: ProviderFamily): HarnessAdapter {
    return this.adapters[provider];
  }

  /** The assigned role/provider for a project, resolved through the agent-assignment domain — never a client-guessed default. */
  private async resolveAssignment(
    projectId: string,
    role: InstructionRole,
  ): Promise<AgentAssignment> {
    return this.assignments.requireAssignment({ projectId, role });
  }

  /**
   * Full preview for one project role: assigned role/provider, effective composed content,
   * exact relative target path, ownership classification, and the action Inject/Update would
   * take right now.
   */
  async preview(params: {
    root: string;
    projectId: string;
    role: InstructionRole;
  }): Promise<InjectionPreview> {
    const assignment = await this.resolveAssignment(params.projectId, params.role);
    const effectiveContent = await this.instructions.composePreview({
      projectId: params.projectId,
      role: params.role,
      provider: assignment.provider,
    });
    const adapter = this.adapterFor(assignment.provider);
    const classified = await adapter.classify(params.root);
    return {
      role: params.role,
      provider: assignment.provider,
      relativePath: classified.relativePath,
      classification: classified.classification,
      effectiveContent,
      action: deriveAction(classified.classification),
    };
  }

  /**
   * Injects (creates or updates) the managed document for one project role. Resolves the
   * assignment and composes content first — a failure at either step never reaches the local
   * filesystem, so a successful local write is never reported for a failed assignment or
   * composition. Conversely, once the Supabase assignment/instruction state is saved, this
   * method's own failure (or an earlier call's) never rolls it back: a saved assignment survives
   * a local injection failure.
   */
  async inject(params: {
    root: string;
    projectId: string;
    role: InstructionRole;
    forceReplace?: boolean;
  }): Promise<HarnessInjectOutcome> {
    const assignment = await this.resolveAssignment(params.projectId, params.role);
    const active = await this.instructions.resolveActiveVersionIds({
      projectId: params.projectId,
      role: params.role,
      provider: assignment.provider,
    });
    const composedContent = await this.instructions.composePreview({
      projectId: params.projectId,
      role: params.role,
      provider: assignment.provider,
    });
    const adapter = this.adapterFor(assignment.provider);
    return adapter.inject(
      params.root,
      {
        projectId: params.projectId,
        role: params.role,
        sharedRoleVersionId: active.sharedRoleVersionId,
        providerVersionId: active.providerVersionId,
        overrideVersionId: active.overrideVersionId,
        generatedAt: this.now(),
      },
      composedContent,
      params.forceReplace ?? false,
    );
  }

  /** Removes the currently assigned provider's target for one role. */
  async remove(params: {
    projectId: string;
    role: InstructionRole;
    root: string;
  }): Promise<HarnessRemoveOutcome> {
    const assignment = await this.resolveAssignment(params.projectId, params.role);
    return this.adapterFor(assignment.provider).remove(params.root);
  }

  /**
   * Import: preserves an Unmanaged target's existing content by saving it as the project's
   * override-layer instructions before any managed rewrite, then replaces the target. If the
   * import save fails, nothing is written locally — the owner's file is untouched and the
   * failure is reported rather than a fabricated success.
   */
  async importThenReplace(params: {
    root: string;
    projectId: string;
    role: InstructionRole;
  }): Promise<{ importedVersion: InstructionVersion; injected: HarnessInjectOutcome }> {
    const assignment = await this.resolveAssignment(params.projectId, params.role);
    const relativePath = await this.adapterFor(assignment.provider).targetPath();
    const rawContent = await this.filesystem.readTextFile(params.root, relativePath);
    const { version: importedVersion } = await this.instructions.saveAndActivate({
      projectId: params.projectId,
      role: params.role,
      provider: assignment.provider,
      layer: 'project_override',
      content: rawContent,
    });
    const injected = await this.inject({ ...params, forceReplace: true });
    return { importedVersion, injected };
  }

  /**
   * Changes which execution provider a role points at, then injects into the new target.
   * Removes the prior provider's target only when it is still verifiably Hammond-managed *and*
   * was written for this exact role — so a different role legitimately sharing that provider's
   * target is never touched, and one linked directory never accumulates Hammond duplicates.
   */
  async switchProviderAndInject(params: {
    root: string;
    projectId: string;
    role: InstructionRole;
    newProvider: ProviderFamily;
    forceReplace?: boolean;
  }): Promise<{
    assignment: AgentAssignment;
    removedPrior: HarnessRemoveOutcome | null;
    injected: HarnessInjectOutcome;
  }> {
    const previous = await this.assignments.getAssignment({
      projectId: params.projectId,
      role: params.role,
    });

    const assignment = await this.assignments.updateAssignment({
      projectId: params.projectId,
      role: params.role,
      provider: params.newProvider,
    });

    let removedPrior: HarnessRemoveOutcome | null = null;
    if (previous && previous.provider !== params.newProvider) {
      const priorAdapter = this.adapterFor(previous.provider);
      const priorClassification = await priorAdapter.classify(params.root);
      if (
        priorClassification.classification.kind === 'ManagedValid' &&
        priorClassification.classification.header.role === params.role
      ) {
        removedPrior = await priorAdapter.remove(params.root);
      }
    }

    const injected = await this.inject({
      root: params.root,
      projectId: params.projectId,
      role: params.role,
      forceReplace: params.forceReplace,
    });
    return { assignment, removedPrior, injected };
  }
}
