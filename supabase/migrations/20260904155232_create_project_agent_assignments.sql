-- HAM3-006: project agent assignment (D-017).
--
-- Persists an explicit, owner-scoped execution-provider assignment per
-- (project, role) for orchestrator/worker/auditor. This is deliberately
-- separate from public.project_instruction_selections (HAM3-005), which
-- pins instruction *versions* for a role/provider combination once a
-- provider is already chosen. This table answers "which AI performs this
-- role", not "which instruction content it runs with".
--
-- Every project always carries exactly one row per role: a trigger seeds
-- the D-014 routing defaults (orchestrator -> codex, worker -> claude_code,
-- auditor -> kilo_code) at project-creation time, and a one-time backfill
-- below does the same for every project that already existed. Owners then
-- change an assignment with an ordinary UPDATE; the unique (project_id,
-- role) constraint guarantees the invariant never lapses back to zero or
-- multiple providers for the same role.

create table public.project_agent_assignments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  project_id uuid not null,
  role public.instruction_role not null,
  provider public.provider_family not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, role),
  foreign key (project_id, owner_id) references public.projects (id, owner_id) on delete cascade
);

create index project_agent_assignments_owner_idx on public.project_agent_assignments (owner_id);

create trigger project_agent_assignments_set_updated_at
  before update on public.project_agent_assignments
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Deterministic defaults: seed the three D-014 routing defaults whenever a
-- project is created, so "which AI performs this role" always has an answer
-- with no nullable fallback logic required in the client or service layer.
-- SECURITY INVOKER: runs as the same authenticated owner who is creating the
-- project, subject to the exact same RLS policy and grants as any other
-- client insert into this table (no privilege escalation).
-- ---------------------------------------------------------------------------

create function public.project_agent_assignments_seed_defaults()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  insert into public.project_agent_assignments (owner_id, project_id, role, provider)
  values
    (new.owner_id, new.id, 'orchestrator', 'codex'),
    (new.owner_id, new.id, 'worker', 'claude_code'),
    (new.owner_id, new.id, 'auditor', 'kilo_code')
  on conflict (project_id, role) do nothing;
  return new;
end;
$$;

revoke all on function public.project_agent_assignments_seed_defaults() from public, anon, authenticated;

create trigger project_agent_assignments_seed_defaults
  after insert on public.projects
  for each row execute function public.project_agent_assignments_seed_defaults();

-- One-time backfill for every project that already existed before this
-- migration, using the identical D-014 defaults the trigger above applies
-- to every project from now on.
insert into public.project_agent_assignments (owner_id, project_id, role, provider)
select p.owner_id, p.id, v.role, v.provider
from public.projects p
cross join (
  values
    ('orchestrator'::public.instruction_role, 'codex'::public.provider_family),
    ('worker'::public.instruction_role, 'claude_code'::public.provider_family),
    ('auditor'::public.instruction_role, 'kilo_code'::public.provider_family)
) as v (role, provider)
on conflict (project_id, role) do nothing;

-- ---------------------------------------------------------------------------
-- RLS: owner isolation, enforced in both the policy and the composite
-- project/owner foreign key above (an owner can never point an assignment
-- at a project they do not own, and can never see another owner's rows).
-- ---------------------------------------------------------------------------

alter table public.project_agent_assignments enable row level security;

create policy project_agent_assignments_owner_all on public.project_agent_assignments
  for all to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

-- Grants: zero anon access. No delete grant for the authenticated client —
-- every project must always carry exactly one row per role, so the only
-- supported owner action is changing which provider a role points at
-- (UPDATE); rows are only ever removed via the projects cascade delete.
revoke all on public.project_agent_assignments from anon;
revoke all on public.project_agent_assignments from authenticated;
grant select, insert, update on public.project_agent_assignments to authenticated;
