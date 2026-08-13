alter type public.task_status add value if not exists 'merged';
alter type public.task_status add value if not exists 'shipped';

alter table public.projects add column archived_at timestamptz;

alter table public.tasks
  add column archived_at timestamptz,
  add column parent_task_id uuid;

alter table public.tasks
  add constraint tasks_not_self_parent check (parent_task_id is null or parent_task_id <> id),
  add constraint tasks_parent_project_owner_fkey
    foreign key (parent_task_id, owner_id, project_id)
    references public.tasks (id, owner_id, project_id)
    on delete restrict;

create index tasks_parent_task_idx on public.tasks (parent_task_id);
