begin;
select plan(21);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at) values
('31111111-1111-4111-8111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'assign-owner-one@example.test', '', now(), now()),
('32222222-2222-4222-8222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'assign-owner-two@example.test', '', now(), now());

set local role authenticated;
select set_config('request.jwt.claim.sub', '31111111-1111-4111-8111-111111111111', true);

-- ---------------------------------------------------------------------------
-- Deterministic defaults: creating a project (the client omits owner_id, as
-- the real client does) seeds all three D-014 routing default assignments in
-- the same transaction. This is the exact code path the one-time historical
-- backfill in the migration also runs, so this doubles as behavioral proof
-- of that backfill logic.
-- ---------------------------------------------------------------------------

insert into public.projects (id, name) values ('e1111111-1111-4111-8111-111111111111', 'Owner one project 1');

select is(
  (select count(*)::integer from public.project_agent_assignments where project_id = 'e1111111-1111-4111-8111-111111111111'),
  3, 'creating a project seeds exactly three assignments, one per role'
);
select is(
  (select provider from public.project_agent_assignments where project_id = 'e1111111-1111-4111-8111-111111111111' and role = 'orchestrator'),
  'codex'::public.provider_family, 'orchestrator defaults to codex, matching D-014 routing'
);
select is(
  (select provider from public.project_agent_assignments where project_id = 'e1111111-1111-4111-8111-111111111111' and role = 'worker'),
  'claude_code'::public.provider_family, 'worker defaults to claude_code, matching D-014 routing'
);
select is(
  (select provider from public.project_agent_assignments where project_id = 'e1111111-1111-4111-8111-111111111111' and role = 'auditor'),
  'kilo_code'::public.provider_family, 'auditor defaults to kilo_code, matching D-014 routing'
);

-- ---------------------------------------------------------------------------
-- Correction: server-derived owner identity. A real client insert never
-- specifies owner_id on the project it creates; the resulting seeded
-- assignment rows must still carry auth.uid(), not null or a client value.
-- ---------------------------------------------------------------------------

select is(
  (select owner_id from public.project_agent_assignments where project_id = 'e1111111-1111-4111-8111-111111111111' and role = 'worker'),
  '31111111-1111-4111-8111-111111111111'::uuid,
  'a seeded assignment carries the creating owner''s auth.uid(), never null or client-supplied'
);

-- ---------------------------------------------------------------------------
-- Authenticated owner CRUD: the owner can read their assignments and change
-- which provider a role points at.
-- ---------------------------------------------------------------------------

update public.project_agent_assignments
  set provider = 'kilo_code'
  where project_id = 'e1111111-1111-4111-8111-111111111111' and role = 'worker';
select is(
  (select provider from public.project_agent_assignments where project_id = 'e1111111-1111-4111-8111-111111111111' and role = 'worker'),
  'kilo_code'::public.provider_family, 'the owner can reassign a role to a different execution provider'
);
select is(
  (select provider from public.project_agent_assignments where project_id = 'e1111111-1111-4111-8111-111111111111' and role = 'orchestrator'),
  'codex'::public.provider_family, 'reassigning one role leaves the other roles for the same project untouched'
);

-- ---------------------------------------------------------------------------
-- Uniqueness: exactly one assignment row per (project, role).
-- ---------------------------------------------------------------------------

select throws_ok(
  $$insert into public.project_agent_assignments (project_id, role, provider) values ('e1111111-1111-4111-8111-111111111111', 'worker', 'codex')$$,
  '23505', null, 'a second assignment for the same (project, role) is rejected as a duplicate'
);

-- ---------------------------------------------------------------------------
-- Spoofing: owner_id can never be set to anyone but the caller.
-- ---------------------------------------------------------------------------

select throws_ok(
  $$insert into public.project_agent_assignments (owner_id, project_id, role, provider) values ('32222222-2222-4222-8222-222222222222', 'e1111111-1111-4111-8111-111111111111', 'auditor', 'codex')$$,
  '42501', null, 'an owner cannot insert an assignment spoofing a different owner_id, even for their own project'
);
select throws_ok(
  $$update public.project_agent_assignments set owner_id = '32222222-2222-4222-8222-222222222222' where project_id = 'e1111111-1111-4111-8111-111111111111' and role = 'auditor'$$,
  '42501', null, 'an owner cannot reassign one of their own rows to a different owner_id'
);

-- ---------------------------------------------------------------------------
-- Cross-owner and cross-project isolation
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '32222222-2222-4222-8222-222222222222', true);
insert into public.projects (id, name) values ('e2222222-2222-4222-8222-222222222222', 'Owner two project');

select is(
  (select count(*)::integer from public.project_agent_assignments where project_id = 'e1111111-1111-4111-8111-111111111111'),
  0, 'owner two cannot see owner one''s project assignments'
);
select is(
  (select count(*)::integer from public.project_agent_assignments where owner_id = '31111111-1111-4111-8111-111111111111'),
  0, 'owner two cannot see owner one''s assignments by owner_id either'
);
select is(
  (select count(*)::integer from public.project_agent_assignments where project_id = 'e2222222-2222-4222-8222-222222222222'),
  3, 'owner two''s own project still seeded its own three default assignments'
);

-- An owner cannot point an assignment at a project they do not own (or that
-- does not exist): the composite (project_id, owner_id) foreign key to
-- public.projects requires a projects row matching BOTH the target project
-- id and the caller's own owner_id. A never-seen project id is used here
-- (rather than owner one's real, already-seeded project) so this isolates
-- the foreign key itself rather than colliding with the unique
-- (project_id, role) constraint, which every real project always satisfies
-- for all three roles from the moment it is created.
select throws_ok(
  $$insert into public.project_agent_assignments (project_id, role, provider) values ('e9999999-9999-4999-8999-999999999999', 'orchestrator', 'codex')$$,
  '23503', null, 'an assignment cannot reference a project id with no matching owned row in projects'
);

reset role;

-- ---------------------------------------------------------------------------
-- Zero anonymous access
-- ---------------------------------------------------------------------------

set local role anon;
select throws_ok($$select 1 from public.project_agent_assignments$$, '42501', null, 'anon has no select privilege on project_agent_assignments');
select throws_ok(
  $$insert into public.project_agent_assignments (project_id, role, provider) values ('e1111111-1111-4111-8111-111111111111', 'auditor', 'codex')$$,
  '42501', null, 'anon has no insert privilege on project_agent_assignments'
);
select throws_ok(
  $$update public.project_agent_assignments set provider = 'codex'$$,
  '42501', null, 'anon has no update privilege on project_agent_assignments'
);
reset role;

-- No delete privilege for the authenticated client either: every project
-- must always carry exactly one row per role.
set local role authenticated;
select set_config('request.jwt.claim.sub', '31111111-1111-4111-8111-111111111111', true);
select throws_ok(
  $$delete from public.project_agent_assignments where project_id = 'e1111111-1111-4111-8111-111111111111' and role = 'auditor'$$,
  '42501', null, 'the authenticated client has no delete privilege on project_agent_assignments'
);
reset role;

-- ---------------------------------------------------------------------------
-- RLS mutation proof: loosen the owner-isolation policy, prove the isolation
-- assertions above catch it, then restore it.
-- ---------------------------------------------------------------------------

alter policy project_agent_assignments_owner_all on public.project_agent_assignments using (true);
set local role authenticated;
select set_config('request.jwt.claim.sub', '32222222-2222-4222-8222-222222222222', true);
select isnt(
  (select count(*)::integer from public.project_agent_assignments where project_id = 'e1111111-1111-4111-8111-111111111111'),
  0, 'mutation proof: loosening the policy exposes owner one''s private assignments to owner two'
);
reset role;

alter policy project_agent_assignments_owner_all on public.project_agent_assignments
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);
set local role authenticated;
select set_config('request.jwt.claim.sub', '32222222-2222-4222-8222-222222222222', true);
select is(
  (select count(*)::integer from public.project_agent_assignments where project_id = 'e1111111-1111-4111-8111-111111111111'),
  0, 'restored policy isolates owner one''s assignments from owner two again'
);
select set_config('request.jwt.claim.sub', '31111111-1111-4111-8111-111111111111', true);
select is(
  (select count(*)::integer from public.project_agent_assignments where project_id = 'e1111111-1111-4111-8111-111111111111'),
  3, 'owner one still sees their own three assignments after the policy is restored'
);
reset role;

select * from finish();
rollback;
