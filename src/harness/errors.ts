import type { InstructionVersion } from '../instructions/types';

/**
 * Thrown by `HarnessInjectionService.importThenReplace` when the preservation save (writing the
 * unmanaged file's existing content into the project's override layer) already succeeded before
 * the subsequent local write failed. Carries the version that was durably saved, so a caller can
 * tell this apart from every other import failure (assignment resolution, classification, file
 * read, or the save itself) — those happen *before* anything is preserved, so retrying them means
 * safely re-attempting the whole import from scratch. Once this error is thrown, retrying must
 * never re-run the save (that would silently create a duplicate version); it may only retry the
 * local write.
 */
export class ImportPostSaveFailure extends Error {
  readonly importedVersion: InstructionVersion;

  constructor(importedVersion: InstructionVersion, cause: unknown) {
    super(
      cause instanceof Error
        ? cause.message
        : 'The import saved successfully, but the local write failed.',
      { cause },
    );
    this.name = 'ImportPostSaveFailure';
    this.importedVersion = importedVersion;
  }
}
