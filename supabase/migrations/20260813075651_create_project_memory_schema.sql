create extension if not exists pgcrypto with schema extensions;

create type public.task_status as enum ('backlog', 'ready', 'in_progress', 'blocked', 'done', 'cancelled');
create type public.task_relation_kind as enum ('depends_on', 'blocks', 'relates_to', 'duplicates');
create type public.instruction_role as enum ('orchestrator', 'worker', 'auditor');
create type public.provider_family as enum ('codex', 'claude_code', 'kilo_code');

create table public.projects (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 200), description text not null default '',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique (id, owner_id)
);
create table public.tasks (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id uuid not null, title text not null check (length(btrim(title)) between 1 and 300), description text not null default '',
  status public.task_status not null default 'backlog', priority smallint not null default 0 check (priority between 0 and 4), due_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique (id, owner_id, project_id),
  foreign key (project_id, owner_id) references public.projects(id, owner_id) on delete cascade
);
create table public.task_relations (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id uuid not null, task_id uuid not null, related_task_id uuid not null, kind public.task_relation_kind not null,
  created_at timestamptz not null default now(), check (task_id <> related_task_id), unique (owner_id, task_id, related_task_id, kind),
  foreign key (task_id, owner_id, project_id) references public.tasks(id, owner_id, project_id) on delete cascade,
  foreign key (related_task_id, owner_id, project_id) references public.tasks(id, owner_id, project_id) on delete cascade
);
create table public.comments (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id uuid not null, task_id uuid not null, body text not null check (length(btrim(body)) > 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key (task_id, owner_id, project_id) references public.tasks(id, owner_id, project_id) on delete cascade
);
create table public.instruction_templates (
  id uuid primary key default gen_random_uuid(), owner_id uuid references auth.users(id) on delete cascade,
  role public.instruction_role not null, provider public.provider_family not null, name text not null check (length(btrim(name)) between 1 and 200),
  is_base boolean not null default false, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check ((is_base and owner_id is null) or (not is_base and owner_id is not null))
);
create unique index instruction_templates_base_category_key on public.instruction_templates (role, provider) where is_base;
create unique index instruction_templates_owner_name_key on public.instruction_templates (owner_id, name) where not is_base;
create table public.instruction_template_versions (
  id uuid primary key default gen_random_uuid(), template_id uuid not null references public.instruction_templates(id) on delete cascade,
  owner_id uuid references auth.users(id) on delete cascade, version integer not null check (version > 0), content text not null default '',
  created_at timestamptz not null default now(), unique (template_id, version)
);
create table public.project_instruction_selections (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id uuid not null, role public.instruction_role not null,
  template_version_id uuid not null references public.instruction_template_versions(id) on delete restrict,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique (project_id, role),
  foreign key (project_id, owner_id) references public.projects(id, owner_id) on delete cascade
);
create table public.task_evidence (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id uuid not null, task_id uuid not null, kind text not null check (length(btrim(kind)) between 1 and 100), summary text not null default '',
  source_url text check (source_url is null or source_url ~ '^https?://'), metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(), foreign key (task_id, owner_id, project_id) references public.tasks(id, owner_id, project_id) on delete cascade
);
create table public.activity (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id uuid not null, task_id uuid, event_type text not null check (length(btrim(event_type)) between 1 and 100),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'), created_at timestamptz not null default now(),
  foreign key (project_id, owner_id) references public.projects(id, owner_id) on delete cascade,
  foreign key (task_id, owner_id, project_id) references public.tasks(id, owner_id, project_id) on delete cascade
);

create index tasks_project_status_idx on public.tasks (project_id, status);
create index task_relations_related_task_idx on public.task_relations (related_task_id);
create index comments_task_created_idx on public.comments (task_id, created_at);
create index instruction_template_versions_template_idx on public.instruction_template_versions (template_id, version desc);
create index project_instruction_selections_project_idx on public.project_instruction_selections (project_id);
create index task_evidence_task_created_idx on public.task_evidence (task_id, created_at);
create index activity_project_created_idx on public.activity (project_id, created_at desc);
create index activity_task_created_idx on public.activity (task_id, created_at desc) where task_id is not null;

create function public.set_updated_at() returns trigger language plpgsql security invoker set search_path = '' as $$
begin new.updated_at = now(); return new; end; $$;
revoke all on function public.set_updated_at() from public, anon, authenticated;
create trigger projects_set_updated_at before update on public.projects for each row execute function public.set_updated_at();
create trigger tasks_set_updated_at before update on public.tasks for each row execute function public.set_updated_at();
create trigger comments_set_updated_at before update on public.comments for each row execute function public.set_updated_at();
create trigger instruction_templates_set_updated_at before update on public.instruction_templates for each row execute function public.set_updated_at();
create trigger project_instruction_selections_set_updated_at before update on public.project_instruction_selections for each row execute function public.set_updated_at();

insert into public.instruction_templates (role, provider, name, is_base)
select role, provider, initcap(replace(role::text, '_', ' ')) || ' / ' || initcap(replace(provider::text, '_', ' ')), true
from unnest(enum_range(null::public.instruction_role)) role cross join unnest(enum_range(null::public.provider_family)) provider;
insert into public.instruction_template_versions (template_id, version, content) select id, 1, '' from public.instruction_templates where is_base;

alter table public.projects enable row level security;
alter table public.tasks enable row level security;
alter table public.task_relations enable row level security;
alter table public.comments enable row level security;
alter table public.instruction_templates enable row level security;
alter table public.instruction_template_versions enable row level security;
alter table public.project_instruction_selections enable row level security;
alter table public.task_evidence enable row level security;
alter table public.activity enable row level security;

create policy projects_owner_all on public.projects for all to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
create policy tasks_owner_all on public.tasks for all to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
create policy task_relations_owner_all on public.task_relations for all to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
create policy comments_owner_all on public.comments for all to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
create policy templates_read_base_or_owner on public.instruction_templates for select to authenticated using (is_base or (select auth.uid()) = owner_id);
create policy templates_owner_insert on public.instruction_templates for insert to authenticated with check (not is_base and (select auth.uid()) = owner_id);
create policy templates_owner_update on public.instruction_templates for update to authenticated using (not is_base and (select auth.uid()) = owner_id) with check (not is_base and (select auth.uid()) = owner_id);
create policy templates_owner_delete on public.instruction_templates for delete to authenticated using (not is_base and (select auth.uid()) = owner_id);
create policy template_versions_read_base_or_owner on public.instruction_template_versions for select to authenticated using (owner_id is null or (select auth.uid()) = owner_id);
create policy template_versions_owner_insert on public.instruction_template_versions for insert to authenticated with check ((select auth.uid()) = owner_id and exists (select 1 from public.instruction_templates t where t.id = template_id and t.owner_id = (select auth.uid()) and not t.is_base));
create policy template_versions_owner_update on public.instruction_template_versions for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
create policy template_versions_owner_delete on public.instruction_template_versions for delete to authenticated using ((select auth.uid()) = owner_id);
create policy project_instruction_selections_owner_all on public.project_instruction_selections for all to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
create policy task_evidence_owner_all on public.task_evidence for all to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
create policy activity_owner_all on public.activity for all to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);

revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;
grant select, insert, update, delete on public.projects, public.tasks, public.task_relations, public.comments,
  public.instruction_templates, public.instruction_template_versions, public.project_instruction_selections, public.task_evidence, public.activity to authenticated;
