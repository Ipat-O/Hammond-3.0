begin;
select plan(32);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at) values
('41111111-1111-4111-8111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ham3014-owner-one@example.test', '', now(), now()),
('42222222-2222-4222-8222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ham3014-owner-two@example.test', '', now(), now());

set local role authenticated;
select set_config('request.jwt.claim.sub', '41111111-1111-4111-8111-111111111111', true);

insert into public.projects (id, name) values ('51111111-1111-4111-8111-111111111111', 'HAM3-014 project');

-- ---------------------------------------------------------------------------
-- Revision: starts at 1, bumps on every update (including a plain client update).
-- ---------------------------------------------------------------------------

select t.id, t.revision from public.tasks_create_checked(
  '51111111-1111-4111-8111-111111111111', 'Root', 'desc', null, 'ham3014-create-root'
) t \gset root_
select is((:'root_id')::text is not null, true, 'create returns a persisted row');
select is((:'root_revision')::integer, 1, 'a freshly created task starts at revision 1');

update public.tasks set title = 'Root (plain update)' where id = :'root_id';
select is(
  (select revision from public.tasks where id = :'root_id'), 2,
  'the revision trigger bumps on every update, even a plain client .update()'
);

-- ---------------------------------------------------------------------------
-- tasks_update_checked: expected-revision enforcement and idempotent replay.
-- ---------------------------------------------------------------------------

select t.revision from public.tasks_update_checked(
  :'root_id'::uuid, 2, 'Root v2', null, null, 'ham3014-update-1'
) t \gset u1_
select is((:'u1_revision')::integer, 3, 'a correctly-checked update bumps the revision');

select throws_ok(
  format(
    $$select public.tasks_update_checked(%L::uuid, 2, 'stale write', null, null, 'ham3014-update-stale')$$,
    :'root_id'
  ),
  '40001',
  null,
  'a stale expected_revision is rejected with the standard could-not-serialize SQLSTATE'
);

-- A true replay resends the IDENTICAL original request, expected_revision included (the caller
-- cannot yet know it was accepted) — same request id, same p_expected_revision (2, not the
-- resulting 3), same fields.
select t.revision from public.tasks_update_checked(
  :'root_id'::uuid, 2, 'Root v2', null, null, 'ham3014-update-1'
) t \gset replay_
select is(
  (:'replay_revision')::integer, 3,
  'replaying the exact same request id + payload returns the original result without a second mutation'
);

select throws_ok(
  format(
    $$select public.tasks_update_checked(%L::uuid, 2, 'a different title', null, null, 'ham3014-update-1')$$,
    :'root_id'
  ),
  '22023',
  null,
  'reusing a request id with a different payload is rejected'
);

-- ---------------------------------------------------------------------------
-- HAM3-014 correction 2 (F4): the payload hash is unambiguous, byte-exact framing --
-- not a delimiter-joined string a crafted value can shift the boundary of.
-- ---------------------------------------------------------------------------

-- The exact repro from the audit: title='a'||chr(31)||'b', description='c' and title='a',
-- description='b'||chr(31)||'c' used to join to the identical chr(31)-separated byte string, so
-- the second call would have silently "replayed" the first's result instead of being rejected as
-- a different payload. With length-prefixed framing they must hash differently.
select t.id from public.tasks_create_checked(
  '51111111-1111-4111-8111-111111111111', 'a' || chr(31) || 'b', 'c', null, 'ham3014-sep-collision'
) t \gset sep_
select is((:'sep_id')::text is not null, true, 'the first half of the boundary-shift repro succeeds');

select throws_ok(
  $$select public.tasks_create_checked('51111111-1111-4111-8111-111111111111', 'a', 'b' || chr(31) || 'c', null, 'ham3014-sep-collision')$$,
  '22023',
  null,
  'the boundary-shifted payload is correctly rejected as different, not silently replayed (F4)'
);

-- An absent field (sql null, "not supplied") and an explicit empty string both end up stored as
-- '' for a create's description, but they are still distinct *inputs* -- the hash must not treat
-- them as the same payload for dedup purposes.
select t.id from public.tasks_create_checked(
  '51111111-1111-4111-8111-111111111111', 'Null vs empty', null, null, 'ham3014-null-vs-empty'
) t \gset nve_
select is((:'nve_id')::text is not null, true, 'create with an absent (null) description succeeds');

select throws_ok(
  $$select public.tasks_create_checked('51111111-1111-4111-8111-111111111111', 'Null vs empty', '', null, 'ham3014-null-vs-empty')$$,
  '22023',
  null,
  'reusing the request id with an explicit empty-string description is a different payload, not a replay (F4)'
);

-- ---------------------------------------------------------------------------
-- Hierarchy: create under a live parent, refuse under an archived one.
-- ---------------------------------------------------------------------------

select t.id, t.parent_task_id from public.tasks_create_checked(
  '51111111-1111-4111-8111-111111111111', 'Child', '', :'root_id'::uuid, 'ham3014-create-child'
) t \gset child_
select is((:'child_parent_task_id')::text, :'root_id', 'a child create under a live parent succeeds');

select count(*) as n from public.tasks_archive_subtree_checked(:'root_id'::uuid, 3, 'ham3014-archive-1');
select is(
  (select count(*)::integer from public.tasks
    where id in (:'root_id'::uuid, :'child_id'::uuid) and archived_at is not null),
  2, 'archive-subtree archives the root and its child in one call'
);

-- HAM3-014 correction 2 (F4): tasks_archive_subtree_checked now carries the same durable
-- request-id dedup contract create/update/comment already had (docs/AGENT_ACCESS.md already
-- claimed this; the implementation had not caught up).
select count(*) as n from public.tasks_archive_subtree_checked(:'root_id'::uuid, 3, 'ham3014-archive-1') \gset replay_archive_
select is(
  (:'replay_archive_n')::integer, 2,
  'replaying the exact same archive request id + payload returns the original result, not a second mutation'
);

select throws_ok(
  format(
    $$select public.tasks_archive_subtree_checked(%L::uuid, 99, 'ham3014-archive-1')$$,
    :'root_id'
  ),
  '22023',
  null,
  'reusing an archive request id with a different expected_revision is rejected'
);

select throws_ok(
  format(
    $$select public.tasks_create_checked('51111111-1111-4111-8111-111111111111', 'Grandchild', '', %L::uuid, 'ham3014-create-under-archived')$$,
    :'child_id'
  ),
  '23514',
  null,
  'create under an archived parent is refused'
);

-- ---------------------------------------------------------------------------
-- Reparenting via tasks_update_checked: cycle/self-parent rejection, clearing to top-level.
-- ---------------------------------------------------------------------------

select t.id from public.tasks_create_checked(
  '51111111-1111-4111-8111-111111111111', 'A', '', null, 'ham3014-create-a'
) t \gset ta_
select t.id from public.tasks_create_checked(
  '51111111-1111-4111-8111-111111111111', 'B', '', null, 'ham3014-create-b'
) t \gset tb_

select t.parent_task_id, t.revision from public.tasks_update_checked(
  :'tb_id'::uuid, 1, null, null, null, 'ham3014-reparent-1', true, :'ta_id'::uuid
) t \gset rp_
select is((:'rp_parent_task_id')::text, :'ta_id', 'reparenting B under A succeeds and is checked server-side');

select throws_ok(
  format(
    $$select public.tasks_update_checked(%L::uuid, 1, null, null, null, 'ham3014-reparent-cycle', true, %L::uuid)$$,
    :'ta_id', :'tb_id'
  ),
  '23514',
  null,
  'reparenting an ancestor under its own descendant is rejected as a cycle'
);

select throws_ok(
  format(
    $$select public.tasks_update_checked(%L::uuid, %L::integer, null, null, null, 'ham3014-self-parent', true, %L::uuid)$$,
    :'tb_id', :'rp_revision', :'tb_id'
  ),
  '23514',
  null,
  'a task cannot be reparented under itself'
);

-- coalesce to a marker: \gset does not set a variable for a NULL column value, which would leave
-- :'clr_parent_task_id' undefined (and every later reference to it a bare, unsubstituted ":name").
select coalesce(t.parent_task_id::text, 'NULL_MARKER') as parent_task_id, t.revision from public.tasks_update_checked(
  :'tb_id'::uuid, :'rp_revision'::integer, null, null, null, 'ham3014-clear-parent', true, null
) t \gset clr_
select is(:'clr_parent_task_id'::text, 'NULL_MARKER', 'clearing parent_task_id to null makes the task top-level again');

select coalesce(t.parent_task_id::text, 'NULL_MARKER') as parent_task_id from public.tasks_update_checked(
  :'tb_id'::uuid, :'clr_revision'::integer, 'B plain rename', null, null, 'ham3014-plain-update-after-clear'
) t \gset st_
select is(
  :'st_parent_task_id'::text, 'NULL_MARKER',
  'an ordinary checked update (change_parent=false, what the MCP update_task tool always sends) never touches parent_task_id'
);

-- ---------------------------------------------------------------------------
-- Comments: idempotent add.
-- ---------------------------------------------------------------------------

select c.id from public.comments_add_checked(:'ta_id'::uuid, 'hello world', 'ham3014-comment-1') c \gset c1_
select c.id from public.comments_add_checked(:'ta_id'::uuid, 'hello world', 'ham3014-comment-1') c \gset c1r_
select is(:'c1r_id'::text, :'c1_id'::text, 'replaying a comment add with the same request id returns the same comment, not a duplicate');
select is(
  (select count(*)::integer from public.comments where task_id = :'ta_id'::uuid),
  1, 'exactly one comment row exists after the replay'
);

-- ---------------------------------------------------------------------------
-- HAM3-014 correction 2 (F4): record identity in replay keys -- the same request id + payload
-- aimed at a *different* task must never replay the wrong task's result.
-- ---------------------------------------------------------------------------

select t.id from public.tasks_create_checked(
  '51111111-1111-4111-8111-111111111111', 'Cross X', '', null, 'ham3014-create-cross-x'
) t \gset cx_
select t.id from public.tasks_create_checked(
  '51111111-1111-4111-8111-111111111111', 'Cross Y', '', null, 'ham3014-create-cross-y'
) t \gset cy_

select t.revision from public.tasks_update_checked(
  :'cx_id'::uuid, 1, 'Same title', null, null, 'ham3014-cross-task-update'
) t \gset cxu_
select is((:'cxu_revision')::integer, 2, 'the update on the first task succeeds');

select throws_ok(
  format(
    $$select public.tasks_update_checked(%L::uuid, 1, 'Same title', null, null, 'ham3014-cross-task-update')$$,
    :'cy_id'
  ),
  '22023',
  null,
  'reusing that exact request id + field payload against a DIFFERENT task is rejected, never replaying task X''s result as task Y''s (F4)'
);
select is(
  (select title from public.tasks where id = :'cy_id'::uuid), 'Cross Y',
  'the rejected cross-task replay attempt left task Y completely untouched'
);

select c.id from public.comments_add_checked(:'cx_id'::uuid, 'same body', 'ham3014-cross-task-comment') c \gset ccx_
select is((:'ccx_id')::text is not null, true, 'the comment on the first task succeeds');

select throws_ok(
  format(
    $$select public.comments_add_checked(%L::uuid, 'same body', 'ham3014-cross-task-comment')$$,
    :'cy_id'
  ),
  '22023',
  null,
  'reusing that exact comment request id + body against a DIFFERENT task is rejected, never attaching task X''s comment to task Y (F4)'
);
select is(
  (select count(*)::integer from public.comments where task_id = :'cy_id'::uuid),
  0, 'no comment was ever added to task Y from the rejected cross-task replay attempt'
);

-- ---------------------------------------------------------------------------
-- Cross-owner isolation.
-- ---------------------------------------------------------------------------

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '42222222-2222-4222-8222-222222222222', true);

select is(
  (select count(*)::integer from public.tasks where id = :'ta_id'::uuid),
  0, 'RLS hides another owner''s task entirely'
);

select throws_ok(
  format(
    $$select public.tasks_update_checked(%L::uuid, 1, 'hijack', null, null, 'ham3014-hijack')$$,
    :'ta_id'
  ),
  'P0002',
  null,
  'a cross-owner update is refused as task-not-found, never as a revision mismatch (no existence leak)'
);

select throws_ok(
  $$select public.tasks_create_checked('51111111-1111-4111-8111-111111111111', 'Hijack create', '', null, 'ham3014-hijack-create')$$,
  '23503',
  null,
  'creating into a project owned by someone else is refused (composite project_id/owner_id foreign key)'
);

reset role;

select * from finish();
rollback;
