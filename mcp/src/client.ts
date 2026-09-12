import { readCredentials } from './credentials.js';
import type { AgentAccessCredentials } from './credentials.js';

export interface OperationSummary {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface OperationErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

/** A clean, typed failure surfaced by Hammond's HTTP layer (never a raw network exception). */
export class HammondOperationError extends Error {
  readonly code: string;
  readonly details?: unknown;
  readonly httpStatus: number;

  constructor(httpStatus: number, body: OperationErrorBody) {
    super(body.message);
    this.name = 'HammondOperationError';
    this.code = body.code;
    this.details = body.details;
    this.httpStatus = httpStatus;
  }
}

/**
 * A thin HTTP client for Hammond's local agent-access API — the ONLY way this adapter reaches
 * Hammond. It implements no Hammond domain behavior itself; every operation name and input shape
 * comes straight from `GET /v1/operations`, which is itself generated from the same registry the
 * HTTP surface serves (see `src/agentAccess/registry.ts` in the main app).
 *
 * Credentials are cached after the first successful read, then refreshed exactly once whenever a
 * request fails at the connection level (ECONNREFUSED — Hammond restarted on a new ephemeral
 * port) or with 401 (the token was rotated) — never on a timeout, since a timed-out request's
 * effect on Hammond is unknown and must never be retried automatically.
 */
export class HammondClient {
  private cached: AgentAccessCredentials | null = null;

  private async credentials(forceRefresh: boolean): Promise<AgentAccessCredentials> {
    if (forceRefresh || !this.cached) {
      this.cached = await readCredentials();
    }
    return this.cached;
  }

  private async request(
    method: 'GET' | 'POST',
    urlPath: string,
    body: unknown,
    attempt = 0,
  ): Promise<{ status: number; json: unknown }> {
    const creds = await this.credentials(attempt > 0);
    const url = `http://127.0.0.1:${creds.port}${urlPath}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${creds.token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (networkError) {
      if (attempt === 0) {
        return this.request(method, urlPath, body, attempt + 1);
      }
      throw new Error(
        `Could not reach Hammond at ${url}: ${(networkError as Error).message}. Is the Hammond desktop app running and signed in?`,
        { cause: networkError },
      );
    }

    if (response.status === 401 && attempt === 0) {
      // The token on disk may have been rotated since we last read it.
      return this.request(method, urlPath, body, attempt + 1);
    }

    const json = await response.json().catch(() => null);
    return { status: response.status, json };
  }

  async listOperations(): Promise<OperationSummary[]> {
    const { status, json } = await this.request('GET', '/v1/operations', undefined);
    if (status !== 200) throw toOperationError(status, json);
    const result = (json as { result?: { operations?: OperationSummary[] } })?.result;
    return result?.operations ?? [];
  }

  async invokeOperation(name: string, input: unknown): Promise<unknown> {
    const { status, json } = await this.request(
      'POST',
      `/v1/operations/${encodeURIComponent(name)}`,
      input ?? {},
    );
    if (status !== 200) throw toOperationError(status, json);
    return (json as { result?: unknown })?.result ?? null;
  }
}

function toOperationError(status: number, json: unknown): HammondOperationError {
  const body = (json as { error?: OperationErrorBody } | null)?.error;
  if (body) return new HammondOperationError(status, body);
  return new HammondOperationError(status, {
    code: 'transport_error',
    message: `Hammond returned an unexpected ${status} response.`,
  });
}
