import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import type { AgentAccessPermission } from './types';

export interface ConnectionInfo {
  profileId: string;
  projectId: string;
  projectName: string;
  permission: AgentAccessPermission;
  generation: number;
  createdAt: string;
  launchConfig: unknown;
}

export interface FacadeRequestPayload {
  correlationId: string;
  generation: number;
  projectId: string;
  permission: AgentAccessPermission;
  tool: string;
  args: unknown;
}

export type FacadeResponsePayload =
  | { correlationId: string; generation: number; ok: true; result: unknown }
  | {
      correlationId: string;
      generation: number;
      ok: false;
      error: { code: string; message: string };
    };

/** Thin, typed wrappers over the Tauri commands `src-tauri/src/agent_access/commands.rs`
 * registers. No business logic lives here — see `facadeHandler.ts` for what actually executes a
 * relayed request. */
export const nativeAgentAccess = {
  enable: (projectId: string, projectName: string, permission: AgentAccessPermission) =>
    invoke<ConnectionInfo>('agent_access_enable', { projectId, projectName, permission }),
  disable: () => invoke<void>('agent_access_disable'),
  status: () => invoke<ConnectionInfo | null>('agent_access_status'),
  revoke: () => invoke<ConnectionInfo>('agent_access_revoke'),
  respond: (response: FacadeResponsePayload) =>
    invoke<boolean>('agent_access_respond', { response }),
  onFacadeRequest: (handler: (payload: FacadeRequestPayload) => void): Promise<UnlistenFn> =>
    listen<FacadeRequestPayload>('agent-facade-request', (event) => handler(event.payload)),
};
