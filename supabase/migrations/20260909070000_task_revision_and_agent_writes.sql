-- HAM3-014: monotonic task revision, durable request deduplication, and concurrency-safe
-- create/update/archive RPCs shared by the desktop UI and the new MCP agent-access facade.
--
-- Two writers now exist for the same task rows (the owner's UI and an agent connection), so the
-- prior single-writer assumption (plain `update ... where id = $1`, a client-computed subtree
-- list for archive) is no longer sufficient:
--
-- 1. `revision` is a monotonic per-task counter, bumped unconditionally by a trigger on every
--    update regardless of which column changed or which path wrote it, so it is always accurate
--    even for a write that does not go through one of the RPCs below.
-- 2. `tasks_update_checked`/`tasks_archive_subtree_checked` take an `expected_revision` and fail
--    with a distinguishable, standard "could not serialize" SQLSTATE (40001) instead of silently
--    overwriting a newer row -- optimistic concurrency, not a lock held across a network round
--    trip.
-- 3. `agent_request_log` gives every write RPC durable, atomic request-id deduplication: the same
--    request id and payload replays the original result; the same id with a different payload is
--    rejected; a lost response is safely retried by resubmitting the identical request.
-- 4. Hierarchy-affecting operations (create-under-a-parent, archive-a-subtree) serialize per
--    project behind a single advisory lock (the same pattern `instructions_save_and_activate`
--    already uses), so a UI archive of an ancestor and an agent create of a new child can never
--    interleave into an active child left under an archived parent -- whichever transaction
--    acquires the lock first runs its entire check-then-mutate sequence to completion before the
--    other even starts evaluating.

-- ---------------------------------------------------------------------------
-- 1. Monotonic revision
-- ---------------------------------------------------------------------------

alter table public.tasks add column revision integer not null default 1;

create function public.tasks_bump_revision()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.revision := old.revision + 1;
  return new;
end;
$$;

revoke all on function public.tasks_bump_revision() from public, anon, authenticated;

-- Unconditional: every update to a task row bumps its revision, whether it went through one of
-- the checked RPCs below or an ordinary client `.update()` -- revision correctness never depends
-- on every call site remembering to set it.
create trigger tasks_bump_revision
  before update on public.tasks
  for each row execute function public.tasks_bump_revision();

-- ---------------------------------------------------------------------------
-- 2. Durable request deduplication
-- ---------------------------------------------------------------------------

create table public.agent_request_log (
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  project_id uuid not null,
  operation text not null,
  request_id text not null check (length(request_id) between 1 and 200),
  payload_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, project_id, operation, request_id)
);

create index agent_request_log_owner_idx on public.agent_request_log (owner_id);

alter table public.agent_request_log enable row level security;

create policy agent_request_log_owner_select on public.agent_request_log
  for select to authenticated
  using ((select auth.uid()) = owner_id);
create policy agent_request_log_owner_insert on public.agent_request_log
  for insert to authenticated
  with check ((select auth.uid()) = owner_id);

revoke all on public.agent_request_log from anon;
revoke all on public.agent_request_log from authenticated;
-- Append-only: no update/delete grant. A row is retired only via the owner's own account
-- deletion cascade, never edited or removed through the client.
grant select, insert on public.agent_request_log to authenticated;

-- Looks up an existing log entry for (owner, project, operation, request_id):
--  - not found: returns null (caller proceeds with the real mutation, then records it via
--    `agent_request_record`);
--  - found with a matching payload hash: returns the stored result (caller returns this
--    unchanged -- an idempotent replay, not a second mutation);
--  - found with a different payload hash: raises, so a request id is never silently reused for a
--    different operation.
create function public.agent_request_dedupe_check(
  p_owner uuid,
  p_project_id uuid,
  p_operation text,
  p_request_id text,
  p_payload_hash text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_existing public.agent_request_log;
begin
  select * into v_existing
    from public.agent_request_log
    where owner_id = p_owner and project_id = p_project_id
      and operation = p_operation and request_id = p_request_id;

  if not found then
    return null;
  end if;

  if v_existing.payload_hash <> p_payload_hash then
    raise exception 'request id % was already used for a different % payload', p_request_id, p_operation
      using errcode = '22023';
  end if;

  return v_existing.result;
end;
$$;

-- Called directly (not just via a trigger) by every checked RPC below, which run SECURITY
-- INVOKER -- so `authenticated` needs EXECUTE here too, not just on the RPCs themselves. This is
-- safe to call directly as well: `agent_request_log` carries its own owner-scoped RLS, so a
-- caller cannot use a spoofed `p_owner` to see another owner's log entries (the row is only ever
-- visible when `owner_id` in the row also equals the caller's own `auth.uid()`, regardless of
-- what `p_owner` claims).
revoke all on function public.agent_request_dedupe_check(uuid, uuid, text, text, text)
  from public, anon;
grant execute on function public.agent_request_dedupe_check(uuid, uuid, text, text, text)
  to authenticated;

create function public.agent_request_record(
  p_owner uuid,
  p_project_id uuid,
  p_operation text,
  p_request_id text,
  p_payload_hash text,
  p_result jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  insert into public.agent_request_log (owner_id, project_id, operation, request_id, payload_hash, result)
  values (p_owner, p_project_id, p_operation, p_request_id, p_payload_hash, p_result);
end;
$$;

-- Same reasoning as `agent_request_dedupe_check` above: called directly by SECURITY INVOKER RPCs,
-- and safe to call directly too since it can only ever insert a row owned by the caller's own
-- `auth.uid()` (the insert policy's `with check` enforces that regardless of `p_owner`).
revoke all on function public.agent_request_record(uuid, uuid, text, text, text, jsonb)
  from public, anon;
grant execute on function public.agent_request_record(uuid, uuid, text, text, text, jsonb)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Checked task create/update/archive and comment-add RPCs
--
-- SECURITY INVOKER throughout: every insert/update inside runs as the calling role, subject to
-- the exact same RLS policies and grants a direct client write already goes through (tasks_owner_all,
-- comments_owner_all) -- these functions grant no privilege beyond what those policies already
-- allow; they only add the expected-revision check, the hierarchy lock, and request deduplication.
-- ---------------------------------------------------------------------------

create function public.tasks_create_checked(
  p_project_id uuid,
  p_title text,
  p_description text,
  p_parent_task_id uuid,
  p_request_id text
)
returns public.tasks
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_payload_hash text;
  v_cached jsonb;
  v_row public.tasks;
begin
  if v_owner is null then
    raise exception 'tasks_create_checked requires an authenticated caller' using errcode = '42501';
  end if;

  v_payload_hash := md5(coalesce(p_title, '') || chr(31) || coalesce(p_description, '') || chr(31)
    || coalesce(p_parent_task_id::text, ''));

  v_cached := public.agent_request_dedupe_check(
    v_owner, p_project_id, 'tasks_create', p_request_id, v_payload_hash
  );
  if v_cached is not null then
    return jsonb_populate_record(null::public.tasks, v_cached);
  end if;

  if p_parent_task_id is not null then
    -- Serializes every hierarchy-affecting operation (create-under-a-parent,
    -- archive-a-subtree) for this project so a concurrent archive of the exact
    -- parent this create targets can never interleave with it.
    perform pg_advisory_xact_lock(hashtextextended(p_project_id::text, 1));

    if not exists (
      select 1 from public.tasks
      where id = p_parent_task_id and owner_id = v_owner and project_id = p_project_id
        and archived_at is null
    ) then
      raise exception 'parent task not found, archived, or in a different project'
        using errcode = '23514';
    end if;
  end if;

  insert into public.tasks (owner_id, project_id, title, description, parent_task_id)
  values (v_owner, p_project_id, p_title, coalesce(p_description, ''), p_parent_task_id)
  returning * into v_row;

  perform public.agent_request_record(
    v_owner, p_project_id, 'tasks_create', p_request_id, v_payload_hash, to_jsonb(v_row)
  );

  return v_row;
end;
$$;

revoke all on function public.tasks_create_checked(uuid, text, text, uuid, text)
  from public, anon;
grant execute on function public.tasks_create_checked(uuid, text, text, uuid, text) to authenticated;

-- `p_change_parent` disambiguates "leave parent_task_id alone" from "set it to null (make this a
-- top-level task)" -- `p_parent_task_id` alone cannot carry that distinction, since null is also
-- its own meaningful target value. The MCP `update_task` tool never sets `p_change_parent`
-- (reparenting is outside that tool's first version); the desktop editor's own "Parent task"
-- field does, so this one checked path covers both without a second, unchecked update route.
create function public.tasks_update_checked(
  p_task_id uuid,
  p_expected_revision integer,
  p_title text,
  p_description text,
  p_status public.task_status,
  p_request_id text,
  p_change_parent boolean default false,
  p_parent_task_id uuid default null
)
returns public.tasks
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_project_id uuid;
  v_payload_hash text;
  v_cached jsonb;
  v_row public.tasks;
  v_current_revision integer;
begin
  if v_owner is null then
    raise exception 'tasks_update_checked requires an authenticated caller' using errcode = '42501';
  end if;

  select project_id into v_project_id from public.tasks where id = p_task_id and owner_id = v_owner;
  if not found then
    raise exception 'task not found' using errcode = 'P0002';
  end if;

  -- chr(1) (SOH) marks "this field was not supplied" -- distinct from an explicit empty string or
  -- any real value, and (unlike chr(0)/NUL) legal inside a Postgres `text` value.
  v_payload_hash := md5(coalesce(p_title, chr(1)) || chr(31) || coalesce(p_description, chr(1))
    || chr(31) || coalesce(p_status::text, chr(1)) || chr(31) || p_expected_revision::text
    || chr(31) || p_change_parent::text || chr(31) || coalesce(p_parent_task_id::text, chr(1)));

  v_cached := public.agent_request_dedupe_check(
    v_owner, v_project_id, 'tasks_update', p_request_id, v_payload_hash
  );
  if v_cached is not null then
    return jsonb_populate_record(null::public.tasks, v_cached);
  end if;

  if p_change_parent then
    -- Same per-project hierarchy lock create/archive take, so a reparent can never interleave
    -- with a concurrent archive of the exact new parent (or of an ancestor in the cycle check
    -- below) into an inconsistent result.
    perform pg_advisory_xact_lock(hashtextextended(v_project_id::text, 1));

    if p_parent_task_id is not null then
      if p_parent_task_id = p_task_id then
        raise exception 'a task cannot be its own parent' using errcode = '23514';
      end if;
      if not exists (
        select 1 from public.tasks
        where id = p_parent_task_id and owner_id = v_owner and project_id = v_project_id
          and archived_at is null
      ) then
        raise exception 'parent task not found, archived, or in a different project'
          using errcode = '23514';
      end if;
      if exists (
        with recursive chain as (
          select id, parent_task_id from public.tasks
          where id = p_parent_task_id and owner_id = v_owner
          union all
          select t.id, t.parent_task_id from public.tasks t
          join chain c on t.id = c.parent_task_id
          where t.owner_id = v_owner
        )
        select 1 from chain where id = p_task_id
      ) then
        raise exception 'parent relationship would create a cycle' using errcode = '23514';
      end if;
    end if;
  end if;

  update public.tasks
  set title = coalesce(p_title, title),
      description = coalesce(p_description, description),
      status = coalesce(p_status, status),
      parent_task_id = case when p_change_parent then p_parent_task_id else parent_task_id end
  where id = p_task_id and owner_id = v_owner and revision = p_expected_revision
  returning * into v_row;

  if not found then
    select revision into v_current_revision from public.tasks where id = p_task_id and owner_id = v_owner;
    raise exception 'task revision mismatch: expected %, found %', p_expected_revision, v_current_revision
      using errcode = '40001';
  end if;

  perform public.agent_request_record(
    v_owner, v_project_id, 'tasks_update', p_request_id, v_payload_hash, to_jsonb(v_row)
  );

  return v_row;
end;
$$;

revoke all on function public.tasks_update_checked(
  uuid, integer, text, text, public.task_status, text, boolean, uuid
) from public, anon;
grant execute on function public.tasks_update_checked(
  uuid, integer, text, text, public.task_status, text, boolean, uuid
) to authenticated;

create function public.tasks_archive_subtree_checked(
  p_root_task_id uuid,
  p_expected_revision integer
)
returns setof public.tasks
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_project_id uuid;
  v_current_revision integer;
  v_archived_at timestamptz := now();
begin
  if v_owner is null then
    raise exception 'tasks_archive_subtree_checked requires an authenticated caller' using errcode = '42501';
  end if;

  select project_id, revision into v_project_id, v_current_revision
    from public.tasks where id = p_root_task_id and owner_id = v_owner;
  if not found then
    raise exception 'task not found' using errcode = 'P0002';
  end if;

  -- Same per-project hierarchy lock `tasks_create_checked` takes: whichever transaction acquires
  -- it first runs its whole check-then-mutate sequence to completion before the other proceeds,
  -- so a concurrent create under any task in this subtree either fails (parent already archived
  -- by the time it checks) or succeeds and is included below (recomputed fresh, never a
  -- client-supplied snapshot).
  perform pg_advisory_xact_lock(hashtextextended(v_project_id::text, 1));

  select revision into v_current_revision
    from public.tasks where id = p_root_task_id and owner_id = v_owner;
  if v_current_revision <> p_expected_revision then
    raise exception 'task revision mismatch: expected %, found %', p_expected_revision, v_current_revision
      using errcode = '40001';
  end if;

  return query
    with recursive subtree as (
      select t.id from public.tasks t where t.id = p_root_task_id and t.owner_id = v_owner
      union all
      select t.id from public.tasks t
      join subtree s on t.parent_task_id = s.id
      where t.owner_id = v_owner
    )
    update public.tasks
    set archived_at = v_archived_at
    where id in (select id from subtree)
    returning *;
end;
$$;

revoke all on function public.tasks_archive_subtree_checked(uuid, integer) from public, anon;
grant execute on function public.tasks_archive_subtree_checked(uuid, integer) to authenticated;

create function public.comments_add_checked(
  p_task_id uuid,
  p_body text,
  p_request_id text
)
returns public.comments
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_project_id uuid;
  v_payload_hash text;
  v_cached jsonb;
  v_row public.comments;
begin
  if v_owner is null then
    raise exception 'comments_add_checked requires an authenticated caller' using errcode = '42501';
  end if;

  select project_id into v_project_id from public.tasks where id = p_task_id and owner_id = v_owner;
  if not found then
    raise exception 'task not found' using errcode = 'P0002';
  end if;

  v_payload_hash := md5(coalesce(p_body, ''));

  v_cached := public.agent_request_dedupe_check(
    v_owner, v_project_id, 'comments_add', p_request_id, v_payload_hash
  );
  if v_cached is not null then
    return jsonb_populate_record(null::public.comments, v_cached);
  end if;

  insert into public.comments (owner_id, project_id, task_id, body)
  values (v_owner, v_project_id, p_task_id, p_body)
  returning * into v_row;

  perform public.agent_request_record(
    v_owner, v_project_id, 'comments_add', p_request_id, v_payload_hash, to_jsonb(v_row)
  );

  return v_row;
end;
$$;

revoke all on function public.comments_add_checked(uuid, text, text) from public, anon;
grant execute on function public.comments_add_checked(uuid, text, text) to authenticated;
