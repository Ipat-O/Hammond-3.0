begin;
select plan(8);
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at) values
('11111111-1111-4111-8111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-one@example.test', '', now(), now()),
('22222222-2222-4222-8222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-two@example.test', '', now(), now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
insert into public.projects (id, name) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Owner one project');
select is((select count(*)::integer from public.projects), 1, 'owner one can read their project');
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
select is((select count(*)::integer from public.projects), 0, 'owner two cannot read owner one project');
select throws_ok($$insert into public.projects (id, owner_id, name) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111', 'Spoofed')$$, '42501', null, 'owner two cannot insert for owner one');
select is((select count(*)::integer from public.instruction_templates where is_base), 9, 'all role/provider base categories are readable');
reset role;
alter policy projects_owner_all on public.projects using (true);
set local role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
select isnt((select count(*)::integer from public.projects), 0, 'mutation proof: loosened policy exposes owner one project');
reset role;
alter policy projects_owner_all on public.projects using ((select auth.uid()) = owner_id);
set local role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
select is((select count(*)::integer from public.projects), 0, 'restored policy isolates owner one project');
select is((select count(*)::integer from public.tasks), 0, 'owner two sees no owner one tasks');
select is((select count(*)::integer from public.activity), 0, 'owner two sees no owner one activity');
select * from finish();
rollback;
