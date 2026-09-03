-- HAM3-005: versioned instruction template domain.
--
-- Evolves the HAM3-002 instruction_templates / instruction_template_versions /
-- project_instruction_selections foundation into three composable, append-only
-- layers (shared role, provider variant, project override) with a per
-- (project, role, provider) selection that independently pins an exact
-- version of each layer. Existing base rows and any owner data are backfilled
-- deterministically; nothing is dropped and recreated.

create type public.instruction_layer as enum ('shared_role', 'provider', 'project_override');

-- ---------------------------------------------------------------------------
-- instruction_templates: add layer/project scoping
-- ---------------------------------------------------------------------------

alter table public.instruction_templates
  add column layer public.instruction_layer not null default 'provider',
  add column project_id uuid;

alter table public.instruction_templates
  alter column layer drop default;

alter table public.instruction_templates
  alter column provider drop not null;

alter table public.instruction_templates
  add constraint instruction_templates_layer_provider_check
    check (
      (layer = 'shared_role' and provider is null)
      or (layer in ('provider', 'project_override') and provider is not null)
    ),
  add constraint instruction_templates_layer_project_check
    check (
      (layer = 'project_override' and project_id is not null)
      or (layer in ('shared_role', 'provider') and project_id is null)
    ),
  add constraint instruction_templates_base_layer_check
    check (not (is_base and layer = 'project_override'));

alter table public.instruction_templates
  add constraint instruction_templates_project_owner_fkey
    foreign key (project_id, owner_id) references public.projects (id, owner_id) on delete cascade;

drop index public.instruction_templates_base_category_key;
drop index public.instruction_templates_owner_name_key;

-- Exactly one base template per (role) for the shared-role layer and per
-- (role, provider) for the provider layer; project_override is never base.
create unique index instruction_templates_base_shared_role_key
  on public.instruction_templates (role)
  where is_base and layer = 'shared_role';
create unique index instruction_templates_base_provider_key
  on public.instruction_templates (role, provider)
  where is_base and layer = 'provider';

-- Exactly one owner-editable template per slot, so "create/edit owner
-- content" always resolves to a single growing version history instead of
-- requiring the caller to disambiguate between several same-slot templates.
create unique index instruction_templates_owner_shared_role_key
  on public.instruction_templates (owner_id, role)
  where not is_base and layer = 'shared_role';
create unique index instruction_templates_owner_provider_key
  on public.instruction_templates (owner_id, role, provider)
  where not is_base and layer = 'provider';
create unique index instruction_templates_owner_override_key
  on public.instruction_templates (owner_id, project_id, role, provider)
  where not is_base and layer = 'project_override';

create index instruction_templates_owner_idx
  on public.instruction_templates (owner_id)
  where owner_id is not null;

-- Seed the three base shared-role templates (one per role, independent of
-- provider) alongside the nine base provider templates seeded by HAM3-002.
insert into public.instruction_templates (role, provider, layer, name, is_base)
select role, null, 'shared_role', initcap(replace(role::text, '_', ' ')) || ' / Shared', true
from unnest(enum_range(null::public.instruction_role)) role;

insert into public.instruction_template_versions (template_id, version, content)
select id, 1, ''
from public.instruction_templates
where is_base and layer = 'shared_role';

-- Templates are immutable metadata once created: content changes only ever
-- happen by inserting a new version, never by mutating the template row, and
-- history-bearing rows must never be destroyed through the exposed client.
drop policy templates_owner_update on public.instruction_templates;
drop policy templates_owner_delete on public.instruction_templates;
drop trigger instruction_templates_set_updated_at on public.instruction_templates;

-- ---------------------------------------------------------------------------
-- instruction_template_versions: append-only, server-assigned version numbers
-- ---------------------------------------------------------------------------

alter table public.instruction_template_versions
  add column restored_from_version_id uuid references public.instruction_template_versions (id),
  alter column version set default 0;

create index instruction_template_versions_restored_from_idx
  on public.instruction_template_versions (restored_from_version_id)
  where restored_from_version_id is not null;

-- Serializes version allocation in Postgres instead of trusting a
-- client-computed max(version)+1: a transaction-scoped advisory lock keyed by
-- the template id forces concurrent inserts for the same template to queue,
-- so no two versions can ever be allocated the same number and no in-flight
-- save can be skipped. An advisory lock (rather than `select ... for update`
-- on the template row) is used deliberately: row locking requires the UPDATE
-- privilege on the locked table, which authenticated intentionally does not
-- have on instruction_templates (templates are immutable once created).
-- Restore provenance is validated here too, rather than in the INSERT policy
-- below: a WITH CHECK clause that subqueries the very table it protects trips
-- Postgres's "infinite recursion detected in policy" guard, but a trigger's
-- SPI query against the same table is a separate statement and does not.
create function public.instruction_template_versions_assign_version()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  next_version integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.template_id::text, 0));

  select coalesce(max(version), 0) + 1
    into next_version
    from public.instruction_template_versions
    where template_id = new.template_id;

  new.version := next_version;

  if new.restored_from_version_id is not null and not exists (
    select 1 from public.instruction_template_versions src
    where src.id = new.restored_from_version_id and src.template_id = new.template_id
  ) then
    raise exception 'restored_from_version_id must reference a version of the same template'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.instruction_template_versions_assign_version() from public, anon, authenticated;

create trigger instruction_template_versions_assign_version
  before insert on public.instruction_template_versions
  for each row execute function public.instruction_template_versions_assign_version();

drop policy template_versions_owner_update on public.instruction_template_versions;
drop policy template_versions_owner_delete on public.instruction_template_versions;

drop policy template_versions_owner_insert on public.instruction_template_versions;
create policy template_versions_owner_insert on public.instruction_template_versions
  for insert to authenticated
  with check (
    (select auth.uid()) = owner_id
    and exists (
      select 1 from public.instruction_templates t
      where t.id = template_id and t.owner_id = (select auth.uid()) and not t.is_base
    )
  );

-- ---------------------------------------------------------------------------
-- project_instruction_selections: one row per (project, role, provider),
-- pinning the exact active version of each composed layer.
-- ---------------------------------------------------------------------------

alter table public.project_instruction_selections
  add column provider public.provider_family,
  add column shared_role_version_id uuid references public.instruction_template_versions (id) on delete restrict,
  add column provider_version_id uuid references public.instruction_template_versions (id) on delete restrict,
  add column override_version_id uuid references public.instruction_template_versions (id) on delete restrict;

-- Backfill: derive each existing (project, role) selection's provider from
-- the template it already pointed at, carry that exact version forward as
-- the provider-layer pick, default the shared-role layer to the base
-- shared-role version, and fill in the two providers the old row could not
-- express with base provider content so every project keeps all three
-- provider selections populated after the migration.
with base_shared_first as (
  select distinct on (t.role) t.role, v.id as version_id
  from public.instruction_templates t
  join public.instruction_template_versions v on v.template_id = t.id
  where t.is_base and t.layer = 'shared_role'
  order by t.role, v.version asc
),
base_provider_first as (
  select distinct on (t.role, t.provider) t.role, t.provider, v.id as version_id
  from public.instruction_templates t
  join public.instruction_template_versions v on v.template_id = t.id
  where t.is_base and t.layer = 'provider'
  order by t.role, t.provider, v.version asc
),
existing_selection_provider as (
  select s.id as selection_id, s.role, t.provider as source_provider
  from public.project_instruction_selections s
  join public.instruction_template_versions v on v.id = s.template_version_id
  join public.instruction_templates t on t.id = v.template_id
)
update public.project_instruction_selections s
set provider = esp.source_provider,
    shared_role_version_id = bsf.version_id,
    provider_version_id = s.template_version_id
from existing_selection_provider esp
join base_shared_first bsf on bsf.role = esp.role
where s.id = esp.selection_id;

with base_shared_first as (
  select distinct on (t.role) t.role, v.id as version_id
  from public.instruction_templates t
  join public.instruction_template_versions v on v.template_id = t.id
  where t.is_base and t.layer = 'shared_role'
  order by t.role, v.version asc
),
base_provider_first as (
  select distinct on (t.role, t.provider) t.role, t.provider, v.id as version_id
  from public.instruction_templates t
  join public.instruction_template_versions v on v.template_id = t.id
  where t.is_base and t.layer = 'provider'
  order by t.role, t.provider, v.version asc
)
insert into public.project_instruction_selections
  (owner_id, project_id, role, provider, shared_role_version_id, provider_version_id, override_version_id)
select s.owner_id, s.project_id, s.role, bp.provider, bsf.version_id, bp.version_id, null
from public.project_instruction_selections s
join base_shared_first bsf on bsf.role = s.role
cross join base_provider_first bp
where bp.role = s.role
  and s.provider is distinct from bp.provider
  and not exists (
    select 1 from public.project_instruction_selections s2
    where s2.project_id = s.project_id and s2.role = s.role and s2.provider = bp.provider
  );

alter table public.project_instruction_selections
  drop column template_version_id;

alter table public.project_instruction_selections
  alter column provider set not null,
  alter column shared_role_version_id set not null,
  alter column provider_version_id set not null;

alter table public.project_instruction_selections
  drop constraint project_instruction_selections_project_id_role_key;
alter table public.project_instruction_selections
  add constraint project_instruction_selections_project_role_provider_key
    unique (project_id, role, provider);

create index project_instruction_selections_owner_idx
  on public.project_instruction_selections (owner_id);

-- Enforces cross-layer/role/provider/project/owner referential integrity for
-- every selection in Postgres: RLS on instruction_template_versions makes an
-- inaccessible version simply invisible to this SELECT, so a reference to
-- another owner's private version is rejected the same way as one pointing
-- at the wrong layer, role, provider, or project.
create function public.project_instruction_selections_validate()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  shared_layer public.instruction_layer;
  shared_role public.instruction_role;
  shared_owner uuid;
  shared_is_base boolean;
  provider_layer public.instruction_layer;
  provider_role public.instruction_role;
  provider_provider public.provider_family;
  provider_owner uuid;
  provider_is_base boolean;
  override_layer public.instruction_layer;
  override_role public.instruction_role;
  override_provider public.provider_family;
  override_project uuid;
  override_owner uuid;
begin
  select t.layer, t.role, t.owner_id, t.is_base
    into shared_layer, shared_role, shared_owner, shared_is_base
    from public.instruction_template_versions v
    join public.instruction_templates t on t.id = v.template_id
    where v.id = new.shared_role_version_id;
  if not found or shared_layer <> 'shared_role' or shared_role <> new.role
     or not (shared_is_base or shared_owner = new.owner_id) then
    raise exception 'invalid shared_role_version_id for project instruction selection'
      using errcode = '23514';
  end if;

  select t.layer, t.role, t.provider, t.owner_id, t.is_base
    into provider_layer, provider_role, provider_provider, provider_owner, provider_is_base
    from public.instruction_template_versions v
    join public.instruction_templates t on t.id = v.template_id
    where v.id = new.provider_version_id;
  if not found or provider_layer <> 'provider' or provider_role <> new.role
     or provider_provider <> new.provider
     or not (provider_is_base or provider_owner = new.owner_id) then
    raise exception 'invalid provider_version_id for project instruction selection'
      using errcode = '23514';
  end if;

  if new.override_version_id is not null then
    select t.layer, t.role, t.provider, t.project_id, t.owner_id
      into override_layer, override_role, override_provider, override_project, override_owner
      from public.instruction_template_versions v
      join public.instruction_templates t on t.id = v.template_id
      where v.id = new.override_version_id;
    if not found or override_layer <> 'project_override' or override_role <> new.role
       or override_provider <> new.provider or override_project <> new.project_id
       or override_owner <> new.owner_id then
      raise exception 'invalid override_version_id for project instruction selection'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.project_instruction_selections_validate() from public, anon, authenticated;

create trigger project_instruction_selections_validate
  before insert or update on public.project_instruction_selections
  for each row execute function public.project_instruction_selections_validate();

-- ---------------------------------------------------------------------------
-- Grants: keep anon at zero privileges and remove authenticated UPDATE/DELETE
-- on the two append-only tables (templates are immutable post-create, and
-- version history must never be edited or removed through the client).
-- ---------------------------------------------------------------------------

revoke all on public.instruction_templates, public.instruction_template_versions,
  public.project_instruction_selections from anon;
revoke all on public.instruction_templates, public.instruction_template_versions,
  public.project_instruction_selections from authenticated;

grant select, insert on public.instruction_templates to authenticated;
grant select, insert on public.instruction_template_versions to authenticated;
grant select, insert, update, delete on public.project_instruction_selections to authenticated;
