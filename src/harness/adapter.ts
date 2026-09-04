import type { HarnessCommands, ManagedHeaderFields } from '../api/contracts';
import type { HarnessAdapter } from './contracts';
import { MANAGED_HEADER_FORMAT_VERSION } from './types';
import type { ProviderFamily } from '../instructions/types';

/** `HarnessAdapter` backed by the native Tauri harness commands, bound to one provider. */
export class NativeHarnessAdapter implements HarnessAdapter {
  constructor(
    private readonly commands: HarnessCommands,
    private readonly provider: ProviderFamily,
  ) {}

  targetPath(): Promise<string> {
    return this.commands.targetPath(this.provider);
  }

  classify(root: string) {
    return this.commands.classify(root, this.provider);
  }

  inject(
    root: string,
    fields: Omit<ManagedHeaderFields, 'provider' | 'formatVersion'>,
    composedContent: string,
    forceReplace: boolean,
  ) {
    const header: ManagedHeaderFields = {
      ...fields,
      provider: this.provider,
      formatVersion: MANAGED_HEADER_FORMAT_VERSION,
    };
    return this.commands.inject(root, header, composedContent, forceReplace);
  }

  remove(root: string) {
    return this.commands.remove(root, this.provider);
  }
}

/** One `NativeHarnessAdapter` per provider, sharing the same underlying native command surface. */
export function createNativeHarnessAdapters(
  commands: HarnessCommands,
): Record<ProviderFamily, HarnessAdapter> {
  return {
    codex: new NativeHarnessAdapter(commands, 'codex'),
    claude_code: new NativeHarnessAdapter(commands, 'claude_code'),
    kilo_code: new NativeHarnessAdapter(commands, 'kilo_code'),
  };
}
