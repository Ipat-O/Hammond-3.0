import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '../data';
import { ProjectMemoryRepository, ProjectRepository, TaskRepository } from '../data';
import { AssignmentsService } from '../assignments/service';
import {
  createFakeAssignmentRepository,
  createFakeAssignmentStore,
  seedProjectDefaults,
} from '../assignments/testFakes';
import type { FakeAssignmentStore } from '../assignments/testFakes';
import {
  createFakeHarnessAdapters,
  createFakeHarnessFilesystem,
  createFakeHarnessTargetReader,
} from '../harness/testFakes';
import type { FakeHarnessFilesystem } from '../harness/testFakes';
import { HarnessInjectionService } from '../harness/service';
import { InstructionsService } from '../instructions/service';
import { createFakeInstructionRepository } from '../instructions/testFakes';
import { DirectoryContextManager } from '../settings/directoryContextManager';
import { createFakeDirectoryContextServices } from '../settings/testFakes';
import type { DirectoryContextServices } from '../settings/contracts';
import type { AgentAccessDeps } from './deps';

type Row = Record<string, unknown> & { id: string };
type FakeTables = Record<string, Row[]>;

let idCounter = 0;
/**
 * A deterministic uuid-shaped id. Real Hammond rows always have `uuid` primary keys, and the
 * agent-access pagination layer now validates a continuation cursor's id half against exactly
 * that format (`src/data/pagination.ts`), so the fake client must mint the same shape.
 */
function nextId(): string {
  idCounter += 1;
  const hex = idCounter.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

/**
 * Splits `input` on `separator` at nesting depth 0 only, so `and(a,b)` inside a PostgREST `.or()`
 * filter string is kept intact rather than split on its own inner comma.
 */
function splitTopLevel(input: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of input) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === separator && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

function parseSimpleClause(clause: string): (row: Row) => boolean {
  const [column, op, ...rest] = clause.split('.');
  const value = rest.join('.');
  return (row) => {
    const rowValue = row[column];
    switch (op) {
      case 'eq':
        return String(rowValue) === value;
      case 'gt':
        return rowValue !== null && rowValue !== undefined && String(rowValue) > value;
      case 'lt':
        return rowValue !== null && rowValue !== undefined && String(rowValue) < value;
      default:
        throw new Error(`Unsupported operator in fake Supabase client: ${op}`);
    }
  };
}

/** Parses exactly the two `.or()` shapes this codebase's repositories generate — not general PostgREST syntax. */
function parseOrPredicate(predicate: string): (row: Row) => boolean {
  const clauses = splitTopLevel(predicate, ',').map((clause) => {
    const trimmed = clause.trim();
    if (trimmed.startsWith('and(') && trimmed.endsWith(')')) {
      const subClauses = splitTopLevel(trimmed.slice(4, -1), ',').map((sub) =>
        parseSimpleClause(sub.trim()),
      );
      return (row: Row) => subClauses.every((fn) => fn(row));
    }
    return parseSimpleClause(trimmed);
  });
  return (row) => clauses.some((fn) => fn(row));
}

type Filter =
  | { kind: 'eq'; column: string; value: unknown }
  | { kind: 'is'; column: string; value: null }
  | { kind: 'in'; column: string; values: unknown[] }
  | { kind: 'or'; test: (row: Row) => boolean };

class FakeQuery implements PromiseLike<{
  data: unknown;
  error: { code: string; message: string } | null;
}> {
  private filters: Filter[] = [];
  private orders: { column: string; ascending: boolean }[] = [];
  private limitCount: number | null = null;

  constructor(
    private readonly tables: FakeTables,
    private readonly table: string,
    private readonly op: 'select' | 'insert' | 'update' | 'delete',
    private readonly payload?: Record<string, unknown>,
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept to match Supabase's real `.select(columns)` call shape
  select(columns?: string): this {
    return this;
  }
  eq(column: string, value: unknown): this {
    this.filters.push({ kind: 'eq', column, value });
    return this;
  }
  is(column: string, value: null): this {
    this.filters.push({ kind: 'is', column, value });
    return this;
  }
  in(column: string, values: unknown[]): this {
    this.filters.push({ kind: 'in', column, values });
    return this;
  }
  or(predicate: string): this {
    this.filters.push({ kind: 'or', test: parseOrPredicate(predicate) });
    return this;
  }
  order(column: string, options?: { ascending?: boolean }): this {
    this.orders.push({ column, ascending: options?.ascending ?? true });
    return this;
  }
  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  single(): Promise<{ data: unknown; error: { code: string; message: string } | null }> {
    return this.execute().then((rows) => {
      if (rows.length !== 1) {
        // Real `@supabase/postgrest-js`, on the normal (non-`.throwOnError()`) path every
        // repository here uses, hands back `error` as a plain `JSON.parse`d response body —
        // never a `PostgrestError` class instance (that class is only ever constructed on the
        // `.throwOnError()` path, unused in this app). Matching that plain shape here is what
        // makes this fake an honest regression guard for `src/data/supabaseError.ts`'s
        // `instanceof Error` normalization (HAM3-015 Correction 2) — a fake that instead
        // constructed a real `Error` would pass even if that normalization were removed.
        return {
          data: null,
          error: { code: 'PGRST116', message: 'no matching row' },
        };
      }
      return { data: rows[0], error: null };
    });
  }

  then<T1, T2 = never>(
    onfulfilled?: ((value: { data: unknown; error: null }) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return this.execute()
      .then((rows) => ({ data: rows, error: null }) as const)
      .then(onfulfilled ?? undefined, onrejected ?? undefined) as PromiseLike<T1 | T2>;
  }

  private matchesAll(row: Row): boolean {
    return this.filters.every((filter) => {
      if (filter.kind === 'eq') return row[filter.column] === filter.value;
      if (filter.kind === 'is') return (row[filter.column] ?? null) === null;
      if (filter.kind === 'in') return filter.values.includes(row[filter.column]);
      return filter.test(row);
    });
  }

  /**
   * Drops `undefined`-valued keys, exactly like `JSON.stringify` does to a real PostgREST
   * request body — a caller passing `{ id: undefined }` (an omitted optional field flowing
   * through unconditionally) must behave identically to not having passed `id` at all, never
   * clobber a column with a literal `undefined`.
   */
  private cleanPayload(): Record<string, unknown> {
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this.payload ?? {})) {
      if (value !== undefined) clean[key] = value;
    }
    return clean;
  }

  private async execute(): Promise<Row[]> {
    const table = (this.tables[this.table] ??= []);

    if (this.op === 'insert') {
      const payload = this.cleanPayload();
      const row: Row = {
        id: (payload.id as string) ?? nextId(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...payload,
      } as Row;
      table.push(row);
      return [row];
    }

    if (this.op === 'update') {
      const payload = this.cleanPayload();
      const updated: Row[] = [];
      for (const row of table) {
        if (this.matchesAll(row)) {
          Object.assign(row, payload);
          updated.push(row);
        }
      }
      return updated;
    }

    if (this.op === 'delete') {
      const kept: Row[] = [];
      const removed: Row[] = [];
      for (const row of table) (this.matchesAll(row) ? removed : kept).push(row);
      this.tables[this.table] = kept;
      return removed;
    }

    let rows = table.filter((row) => this.matchesAll(row));
    for (const { column, ascending } of [...this.orders].reverse()) {
      rows = [...rows].sort((a, b) => {
        const left = String(a[column] ?? '');
        const right = String(b[column] ?? '');
        if (left === right) return 0;
        const cmp = left < right ? -1 : 1;
        return ascending ? cmp : -cmp;
      });
    }
    if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);
    return rows;
  }
}

/**
 * A minimal in-memory stand-in for a Supabase `SupabaseClient`, supporting exactly the query
 * shapes `src/data/repositories.ts` issues (`select`/`insert`/`update`/`delete`, `eq`/`is`/`in`,
 * the two `.or()` keyset/relation predicate shapes, multi-column `.order()`, `.limit()`,
 * `.single()`). This lets registry tests exercise the *real* `ProjectRepository`/`TaskRepository`/
 * `ProjectMemoryRepository` classes (their status/cycle validation and archive-subtree logic
 * included) rather than re-mocking that logic, matching how `src/data/repositories.test.ts`
 * already fakes the client for the same reason.
 */
export function createFakeSupabaseClient(seed: FakeTables = {}): SupabaseClient<Database> {
  const tables: FakeTables = seed;
  return {
    from(table: string) {
      return {
        select: (columns?: string) => new FakeQuery(tables, table, 'select').select(columns),
        insert: (payload: Record<string, unknown>) =>
          new FakeQuery(tables, table, 'insert', payload),
        update: (payload: Record<string, unknown>) =>
          new FakeQuery(tables, table, 'update', payload),
        delete: () => new FakeQuery(tables, table, 'delete'),
      };
    },
  } as unknown as SupabaseClient<Database>;
}

export interface TestDepsResult {
  deps: AgentAccessDeps;
  tables: FakeTables;
  ownerId: string;
  assignmentStore: FakeAssignmentStore;
  directoryServices: DirectoryContextServices;
  harnessFs: FakeHarnessFilesystem;
}

/** Wires a full `AgentAccessDeps` from fakes, reusing each domain's own existing test fakes. */
export function createTestDeps(
  seed: FakeTables = {},
  directoryServices: DirectoryContextServices = createFakeDirectoryContextServices(),
): TestDepsResult {
  const ownerId = 'owner-1';
  const client = createFakeSupabaseClient(seed);

  const assignmentStore = createFakeAssignmentStore();
  const assignmentRepo = createFakeAssignmentRepository(assignmentStore, ownerId);
  const assignments = new AssignmentsService(assignmentRepo);
  const instructions = new InstructionsService(createFakeInstructionRepository());
  const harnessFs = createFakeHarnessFilesystem();

  const deps: AgentAccessDeps = {
    projects: new ProjectRepository(client),
    tasks: new TaskRepository(client),
    memory: new ProjectMemoryRepository(client),
    instructions,
    assignments,
    harness: new HarnessInjectionService({
      assignments,
      instructions,
      adapters: createFakeHarnessAdapters(harnessFs, '/fake/root'),
      filesystem: createFakeHarnessTargetReader(harnessFs),
    }),
    directoryContext: new DirectoryContextManager(directoryServices),
  };

  return { deps, tables: seed, ownerId, assignmentStore, directoryServices, harnessFs };
}

export function seedProjectWithDefaults(result: TestDepsResult, projectId: string): void {
  seedProjectDefaults(result.assignmentStore, projectId, result.ownerId);
}
