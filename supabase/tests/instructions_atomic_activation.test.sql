-- HAM3-005 Correction 1: proves instructions_save_and_activate is genuinely
-- atomic. A version-then-selection write composed as two separate client
-- requests could commit the version and then fail to activate it, leaving
-- an orphaned "ghost" version that a naive retry would compound. This file
-- forces that exact failure (a selection write rejected by a foreign key,
-- after the version has already been prepared inside the same statement)
-- and proves nothing survives; a subsequent retry then succeeds cleanly.
begin;
select plan(19);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at) values
('11111111-1111-4111-8111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rpc-owner@example.test', '', now(), now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);

insert into public.projects (id, owner_id, name) values ('c1111111-1111-4111-8111-111111111111'::uuid, '11111111-1111-4111-8111-111111111111'::uuid, 'RPC test project');

-- ---------------------------------------------------------------------------
-- Basic save / repeat-save / restore behavior through the atomic RPC.
-- ---------------------------------------------------------------------------

select * from public.instructions_save_and_activate(
  'c1111111-1111-4111-8111-111111111111'::uuid, 'worker'::public.instruction_role, 'claude_code'::public.provider_family,
  'provider'::public.instruction_layer, 'atomic save v1'::text, null::uuid
) \gset r1_
select is(:r1_version_number, 1, 'atomic RPC creates version 1 for a fresh slot');
select is(:'r1_version_content'::text, 'atomic save v1'::text, 'atomic RPC stores the given content');
select is(:'r1_selection_provider_version_id'::uuid, :'r1_version_id'::uuid, 'atomic RPC activates the new version for the provider selection');
select is(:'r1_version_owner_id'::uuid, '11111111-1111-4111-8111-111111111111'::uuid, 'atomic RPC sets owner_id on the created version');

select * from public.instructions_save_and_activate(
  'c1111111-1111-4111-8111-111111111111'::uuid, 'worker'::public.instruction_role, 'claude_code'::public.provider_family,
  'provider'::public.instruction_layer, 'atomic save v2'::text, null::uuid
) \gset r2_
select is(:r2_version_number, 2, 'atomic RPC appends version 2 on the second save, not a fresh template');
select is(:'r2_selection_shared_role_version_id'::uuid, :'r1_selection_shared_role_version_id'::uuid, 'a provider-layer save leaves the shared-role selection field untouched');
select is((select count(*)::integer from public.instruction_templates where owner_id = '11111111-1111-4111-8111-111111111111'::uuid and role='worker' and provider='claude_code' and layer='provider'), 1, 'still exactly one owner template for this slot after two saves');

select * from public.instructions_save_and_activate(
  'c1111111-1111-4111-8111-111111111111'::uuid, 'worker'::public.instruction_role, 'claude_code'::public.provider_family,
  'provider'::public.instruction_layer, null::text, :'r1_version_id'::uuid
) \gset r3_
select is(:r3_version_number, 3, 'restore via atomic RPC allocates the next sequential version');
select is(:'r3_version_content'::text, 'atomic save v1'::text, 'restore via atomic RPC derives content server-side from the source, ignoring any client content');
select is(:'r3_version_restored_from_version_id'::uuid, :'r1_version_id'::uuid, 'restore via atomic RPC records provenance');
select is(:'r3_selection_provider_version_id'::uuid, :'r3_version_id'::uuid, 'restore via atomic RPC activates the restored version');

-- Restoring a version into the wrong layer slot is rejected before anything persists.
select throws_ok(
  format(
    $q$select * from public.instructions_save_and_activate('c1111111-1111-4111-8111-111111111111'::uuid, 'worker'::public.instruction_role, 'claude_code'::public.provider_family, 'shared_role'::public.instruction_layer, null::text, %L::uuid)$q$,
    :'r1_version_id'
  ),
  '23514', null, 'restoring a provider-layer version into the shared-role slot is rejected'
);

-- ---------------------------------------------------------------------------
-- Genuine atomicity proof: force the FINAL step (selection upsert) to fail
-- via a foreign-key violation on a nonexistent project, on a slot that has
-- never been touched before (auditor/codex/provider), and prove the version
-- (and the template it would have needed to create) never persisted.
-- ---------------------------------------------------------------------------

select is((select count(*)::integer from public.instruction_templates where owner_id = '11111111-1111-4111-8111-111111111111'::uuid and role='auditor' and provider='codex' and layer='provider'), 0, 'sanity: no owner template exists yet for the rollback-probe slot');
select throws_ok(
  $$select * from public.instructions_save_and_activate('99999999-9999-4999-8999-999999999999'::uuid, 'auditor'::public.instruction_role, 'codex'::public.provider_family, 'provider'::public.instruction_layer, 'should never persist'::text, null::uuid)$$,
  '23503', null, 'activation against a nonexistent project is rejected by the selection foreign key'
);
select is((select count(*)::integer from public.instruction_templates where owner_id = '11111111-1111-4111-8111-111111111111'::uuid and role='auditor' and provider='codex' and layer='provider'), 0, 'atomic rollback: the template created mid-transaction did not survive the later failure');
select is((select count(*)::integer from public.instruction_template_versions where content = 'should never persist'), 0, 'atomic rollback: the version inserted mid-transaction did not survive the later failure');

-- Retry after the rollback succeeds cleanly and creates exactly one version for that slot.
insert into public.projects (id, owner_id, name) values ('c2222222-2222-4222-8222-222222222222'::uuid, '11111111-1111-4111-8111-111111111111'::uuid, 'Retry project');
select * from public.instructions_save_and_activate(
  'c2222222-2222-4222-8222-222222222222'::uuid, 'auditor'::public.instruction_role, 'codex'::public.provider_family,
  'provider'::public.instruction_layer, 'retry succeeds'::text, null::uuid
) \gset r4_
select is(:r4_version_number, 1, 'retry after a rolled-back attempt allocates version 1, not version 2 - nothing from the failed attempt survived');
select is((select count(*)::integer from public.instruction_template_versions v join public.instruction_templates t on t.id = v.template_id where t.owner_id = '11111111-1111-4111-8111-111111111111'::uuid and t.role='auditor' and t.provider='codex' and t.layer='provider'), 1, 'exactly one version exists for the slot after the failed attempt plus one successful retry');

-- Unauthenticated call is rejected outright.
reset role;
set local role anon;
select throws_ok(
  $$select * from public.instructions_save_and_activate('c1111111-1111-4111-8111-111111111111'::uuid, 'worker'::public.instruction_role, 'claude_code'::public.provider_family, 'provider'::public.instruction_layer, 'anon attempt'::text, null::uuid)$$,
  null, null, 'anon cannot call the RPC at all (no execute grant)'
);
reset role;

select * from finish();
rollback;
