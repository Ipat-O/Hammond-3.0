begin;
select plan(38);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at) values
('11111111-1111-4111-8111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'instr-owner-one@example.test', '', now(), now()),
('22222222-2222-4222-8222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'instr-owner-two@example.test', '', now(), now());

set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);

insert into public.projects (id, owner_id, name) values
  ('c1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'Owner one project 1'),
  ('c2222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'Owner one project 2');

-- Owner-one creates one editable template per layer for role=worker/provider=claude_code,
-- plus a second project's override template (used later for a cross-project mismatch check).
insert into public.instruction_templates (id, owner_id, role, provider, layer, project_id, name) values
  ('a0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'worker', null, 'shared_role', null, 'Owner shared / worker'),
  ('a0000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'worker', 'claude_code', 'provider', null, 'Owner provider / worker / claude_code'),
  ('a0000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 'worker', 'claude_code', 'project_override', 'c1111111-1111-4111-8111-111111111111', 'Owner override / project 1'),
  ('a0000000-0000-4000-8000-000000000004', '11111111-1111-4111-8111-111111111111', 'worker', 'claude_code', 'project_override', 'c2222222-2222-4222-8222-222222222222', 'Owner override / project 2');

insert into public.instruction_template_versions (id, template_id, owner_id, content) values
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'owner shared v1'),
  ('b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'owner provider v1'),
  ('b0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 'owner override v1'),
  ('b0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000004', '11111111-1111-4111-8111-111111111111', 'owner override project 2 v1');

-- ---------------------------------------------------------------------------
-- Correction 1: server-derived owner identity. A real client insert never
-- specifies owner_id (see src/data/instructionsRepository.ts) — it must be
-- filled in by the database, not left null and rejected by RLS.
-- ---------------------------------------------------------------------------

insert into public.instruction_templates (id, role, provider, layer, project_id, name) values
  ('a0000000-0000-4000-8000-000000000005', 'auditor', 'kilo_code', 'provider', null, 'Owner provider / auditor / kilo_code');
select is((select owner_id from public.instruction_templates where id = 'a0000000-0000-4000-8000-000000000005'), '11111111-1111-4111-8111-111111111111'::uuid, 'a template insert that omits owner_id (as the real client does) still stores auth.uid()');

insert into public.instruction_template_versions (id, template_id, content) values
  ('b0000000-0000-4000-8000-000000000007', 'a0000000-0000-4000-8000-000000000005', 'owner content, no owner_id supplied');
select is((select owner_id from public.instruction_template_versions where id = 'b0000000-0000-4000-8000-000000000007'), '11111111-1111-4111-8111-111111111111'::uuid, 'a version insert that omits owner_id (as the real client does) still stores auth.uid() and the insert succeeds');

-- ---------------------------------------------------------------------------
-- Append-only version allocation
-- ---------------------------------------------------------------------------

select is((select version from public.instruction_template_versions where id = 'b0000000-0000-4000-8000-000000000001'), 1, 'first save on a fresh template gets version 1');

-- A client-supplied version number must never be trusted: the trigger overwrites it.
insert into public.instruction_template_versions (id, template_id, owner_id, content, version) values
  ('b0000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'owner provider v2', 999);
select is((select version from public.instruction_template_versions where id = 'b0000000-0000-4000-8000-000000000005'), 2, 'server-assigned version ignores a client-supplied value and continues the sequence');

-- Restore: a new version carrying an earlier version's exact content and provenance.
insert into public.instruction_template_versions (id, template_id, owner_id, content, restored_from_version_id) values
  ('b0000000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'owner shared v1', 'b0000000-0000-4000-8000-000000000001');
select is((select version from public.instruction_template_versions where id = 'b0000000-0000-4000-8000-000000000006'), 2, 'a restore still allocates the next sequential version, never reusing one');
select is((select restored_from_version_id from public.instruction_template_versions where id = 'b0000000-0000-4000-8000-000000000006'), 'b0000000-0000-4000-8000-000000000001'::uuid, 'restore provenance records the exact source version');
select is((select content from public.instruction_template_versions where id = 'b0000000-0000-4000-8000-000000000006'), (select content from public.instruction_template_versions where id = 'b0000000-0000-4000-8000-000000000001'), 'restored content matches the source version byte for byte');
select is((select count(*)::integer from public.instruction_template_versions where id = 'b0000000-0000-4000-8000-000000000001'), 1, 'restoring never mutates or removes the historical source row');

-- A restore's provenance must point at a version of the SAME template.
select throws_ok(
  $$insert into public.instruction_template_versions (template_id, owner_id, content, restored_from_version_id) values ('a0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'cross-template restore', 'b0000000-0000-4000-8000-000000000002')$$,
  '23514', null, 'restoring from a version that belongs to a different template is rejected'
);

-- ---------------------------------------------------------------------------
-- Historical rows and base content are append-only / immutable
-- ---------------------------------------------------------------------------

select throws_ok($$update public.instruction_template_versions set content = 'tampered' where id = 'b0000000-0000-4000-8000-000000000001'$$, '42501', null, 'an owner cannot update a historical version through the client');
select throws_ok($$delete from public.instruction_template_versions where id = 'b0000000-0000-4000-8000-000000000001'$$, '42501', null, 'an owner cannot delete a historical version through the client');
select throws_ok($$update public.instruction_templates set name = 'tampered' where id = 'a0000000-0000-4000-8000-000000000001'$$, '42501', null, 'an owner cannot update their own template row after creation');
select throws_ok($$delete from public.instruction_templates where id = 'a0000000-0000-4000-8000-000000000001'$$, '42501', null, 'a template with history cannot be hard-deleted through the client');

select throws_ok(
  $$update public.instruction_template_versions set content = 'tampered' where template_id in (select id from public.instruction_templates where is_base and role = 'worker' and layer = 'provider')$$,
  '42501', null, 'a base version rejects update through the exposed authenticated role'
);
select throws_ok(
  $$delete from public.instruction_templates where is_base and role = 'worker' and layer = 'provider'$$,
  '42501', null, 'a base template rejects delete through the exposed authenticated role'
);
select throws_ok(
  $$insert into public.instruction_template_versions (template_id, owner_id, content) select id, '11111111-1111-4111-8111-111111111111', 'sneaking onto base' from public.instruction_templates where is_base and role = 'worker' and layer = 'provider'$$,
  '42501', null, 'an owner cannot append a version onto a base template'
);

-- ---------------------------------------------------------------------------
-- Selections: valid composition, provider independence, and cross-checks
-- ---------------------------------------------------------------------------

-- Base-only selection for a role/provider pair the owner never customized.
insert into public.project_instruction_selections (project_id, role, provider, shared_role_version_id, provider_version_id, override_version_id)
values (
  'c1111111-1111-4111-8111-111111111111', 'auditor', 'codex',
  (select v.id from public.instruction_template_versions v join public.instruction_templates t on t.id = v.template_id where t.is_base and t.role = 'auditor' and t.layer = 'shared_role'),
  (select v.id from public.instruction_template_versions v join public.instruction_templates t on t.id = v.template_id where t.is_base and t.role = 'auditor' and t.provider = 'codex' and t.layer = 'provider'),
  null
);
select ok(true, 'a selection built entirely from base versions is accepted');

-- Fully owner-customized selection with a project override for worker/claude_code.
insert into public.project_instruction_selections (project_id, role, provider, shared_role_version_id, provider_version_id, override_version_id)
values (
  'c1111111-1111-4111-8111-111111111111', 'worker', 'claude_code',
  'b0000000-0000-4000-8000-000000000006', 'b0000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-000000000003'
);
select ok(true, 'a selection composed of the owner''s own shared/provider/override versions is accepted');

-- Independent selection for the SAME project/role but a DIFFERENT provider.
insert into public.project_instruction_selections (project_id, role, provider, shared_role_version_id, provider_version_id, override_version_id)
values (
  'c1111111-1111-4111-8111-111111111111', 'worker', 'codex',
  (select v.id from public.instruction_template_versions v join public.instruction_templates t on t.id = v.template_id where t.is_base and t.role = 'worker' and t.layer = 'shared_role'),
  (select v.id from public.instruction_template_versions v join public.instruction_templates t on t.id = v.template_id where t.is_base and t.role = 'worker' and t.provider = 'codex' and t.layer = 'provider'),
  null
);
select is((select count(*)::integer from public.project_instruction_selections where project_id = 'c1111111-1111-4111-8111-111111111111' and role = 'worker'), 2, 'the same project/role keeps one row per provider, not one shared row');

-- Changing one provider's selection must not touch the other provider's row.
-- (Switches the claude_code row from the owner's v2 provider version back to
-- their v1, a different but still claude_code-tagged version.)
update public.project_instruction_selections
  set provider_version_id = 'b0000000-0000-4000-8000-000000000002'
  where project_id = 'c1111111-1111-4111-8111-111111111111' and role = 'worker' and provider = 'claude_code';
select is((select provider_version_id from public.project_instruction_selections where project_id = 'c1111111-1111-4111-8111-111111111111' and role = 'worker' and provider = 'claude_code'),
  'b0000000-0000-4000-8000-000000000002'::uuid,
  'the claude_code selection reflects the update');
select is((select provider_version_id from public.project_instruction_selections where project_id = 'c1111111-1111-4111-8111-111111111111' and role = 'worker' and provider = 'codex'),
  (select v.id from public.instruction_template_versions v join public.instruction_templates t on t.id = v.template_id where t.is_base and t.role = 'worker' and t.provider = 'codex' and t.layer = 'provider'),
  'updating the claude_code selection leaves the independent codex selection for the same project/role untouched');

-- Wrong layer: a provider-layer version used where a shared-role version is required.
select throws_ok(
  $$insert into public.project_instruction_selections (project_id, role, provider, shared_role_version_id, provider_version_id) values ('c1111111-1111-4111-8111-111111111111', 'worker', 'claude_code', 'b0000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-000000000005')$$,
  '23514', null, 'a provider-layer version is rejected as a shared-role selection'
);

-- Wrong role: a shared-role version for a different role.
select throws_ok(
  $$insert into public.project_instruction_selections (project_id, role, provider, shared_role_version_id, provider_version_id) values ('c1111111-1111-4111-8111-111111111111', 'worker', 'claude_code', (select v.id from public.instruction_template_versions v join public.instruction_templates t on t.id = v.template_id where t.is_base and t.role = 'orchestrator' and t.layer = 'shared_role'), 'b0000000-0000-4000-8000-000000000005')$$,
  '23514', null, 'a shared-role version for the wrong role is rejected'
);

-- Wrong provider: the provider version's own provider does not match the selection's provider column.
select throws_ok(
  $$insert into public.project_instruction_selections (project_id, role, provider, shared_role_version_id, provider_version_id) values ('c1111111-1111-4111-8111-111111111111', 'worker', 'codex', 'b0000000-0000-4000-8000-000000000006', 'b0000000-0000-4000-8000-000000000005')$$,
  '23514', null, 'a provider version whose provider does not match the selection column is rejected'
);

-- Wrong project: an override scoped to project 2 used in a project-1 selection.
select throws_ok(
  $$insert into public.project_instruction_selections (project_id, role, provider, shared_role_version_id, provider_version_id, override_version_id) values ('c1111111-1111-4111-8111-111111111111', 'worker', 'claude_code', 'b0000000-0000-4000-8000-000000000006', 'b0000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-000000000004')$$,
  '23514', null, 'an override version scoped to a different project is rejected'
);

-- ---------------------------------------------------------------------------
-- Owner isolation and spoofing
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
insert into public.projects (id, owner_id, name) values ('d1111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'Owner two project');

select is((select count(*)::integer from public.instruction_templates where owner_id = '11111111-1111-4111-8111-111111111111'), 0, 'owner two cannot see owner one''s private templates');
select is((select count(*)::integer from public.instruction_template_versions where owner_id = '11111111-1111-4111-8111-111111111111'), 0, 'owner two cannot see owner one''s private versions');
select is((select count(*)::integer from public.project_instruction_selections where project_id = 'c1111111-1111-4111-8111-111111111111'), 0, 'owner two cannot see owner one''s project selections');
select is((select count(*)::integer from public.instruction_templates where is_base), 12, 'base templates (9 provider + 3 shared-role) remain readable to every authenticated owner');

select throws_ok(
  $$insert into public.instruction_templates (owner_id, role, provider, layer, name) values ('11111111-1111-4111-8111-111111111111', 'worker', 'codex', 'provider', 'Spoofed')$$,
  '42501', null, 'owner two cannot insert a template spoofing owner one as owner_id'
);
select throws_ok(
  $$insert into public.project_instruction_selections (owner_id, project_id, role, provider, shared_role_version_id, provider_version_id) values ('11111111-1111-4111-8111-111111111111', 'd1111111-1111-4111-8111-111111111111', 'worker', 'codex', (select v.id from public.instruction_template_versions v join public.instruction_templates t on t.id = v.template_id where t.is_base and t.role = 'worker' and t.layer = 'shared_role'), (select v.id from public.instruction_template_versions v join public.instruction_templates t on t.id = v.template_id where t.is_base and t.role = 'worker' and t.provider = 'codex' and t.layer = 'provider'))$$,
  '42501', null, 'owner two cannot insert a selection spoofing owner one as owner_id'
);

-- A version reference owner two cannot see at all (owner one's private version) is rejected the
-- same way as a structurally wrong one: RLS makes it invisible before the trigger even runs.
select throws_ok(
  $$insert into public.project_instruction_selections (project_id, role, provider, shared_role_version_id, provider_version_id) values ('d1111111-1111-4111-8111-111111111111', 'worker', 'claude_code', 'b0000000-0000-4000-8000-000000000006', 'b0000000-0000-4000-8000-000000000005')$$,
  '23514', null, 'a selection cannot reference another owner''s inaccessible version'
);

reset role;

-- ---------------------------------------------------------------------------
-- Zero anonymous access
-- ---------------------------------------------------------------------------

set local role anon;
select throws_ok($$select 1 from public.instruction_templates$$, '42501', null, 'anon has no select privilege on instruction_templates');
select throws_ok($$select 1 from public.instruction_template_versions$$, '42501', null, 'anon has no select privilege on instruction_template_versions');
select throws_ok($$select 1 from public.project_instruction_selections$$, '42501', null, 'anon has no select privilege on project_instruction_selections');
reset role;

-- ---------------------------------------------------------------------------
-- RLS mutation proof: loosen a policy, prove the isolation test catches it, restore it.
-- ---------------------------------------------------------------------------

alter policy templates_read_base_or_owner on public.instruction_templates using (true);
set local role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
select isnt((select count(*)::integer from public.instruction_templates where owner_id = '11111111-1111-4111-8111-111111111111'), 0, 'mutation proof: loosening the templates policy exposes owner one''s private templates');
reset role;

alter policy templates_read_base_or_owner on public.instruction_templates using (is_base or (select auth.uid()) = owner_id);
set local role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
select is((select count(*)::integer from public.instruction_templates where owner_id = '11111111-1111-4111-8111-111111111111'), 0, 'restored policy isolates owner one''s private templates again');
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select is((select count(*)::integer from public.instruction_templates where owner_id = '11111111-1111-4111-8111-111111111111'), 5, 'owner one still sees their own five templates after the policy is restored');
reset role;

select * from finish();
rollback;
