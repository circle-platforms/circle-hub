import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planEnvironmentAssignmentUpgrade, type EnvironmentUpgradeSnapshot } from './environment-assignment-upgrade.ts';

const before = '2035-01-01T00:00:00.000Z', at = '2035-01-02T00:00:00.000Z', after = '2035-01-03T00:00:00.000Z';
function snapshot(): EnvironmentUpgradeSnapshot {
  return {
    boundary: 'synthetic-cutover', at,
    members: [{ id: 'synthetic-member', disabled: false, deleted_at: null, created_at: before, packs: ['synthetic-leasing-workflow'] }],
    workflows: [{ id: 'synthetic-leasing-workflow', digest: 'a'.repeat(64), kind: 'workflow', publishedAt: before, available: true, declaration: { leases: { prefix: 'synthetic/' }, context: ['leases'] } }],
    executors: [{ id: 'synthetic-executor', registeredAt: before, keys: ['synthetic/first', 'synthetic/second'] }],
    holdings: [], effectiveAssignments: [], revokedAssignments: [],
  };
}

test('effective workflow allocation at the cutover becomes a direct auditable assignment with no role shortcut', () => {
  const input = snapshot(), plan = planEnvironmentAssignmentUpgrade(input);
  assert.equal(plan.canApply, true);
  assert.equal(plan.alreadyCompleted, false);
  assert.deepEqual(plan.grants, [{ user: 'synthetic-member', executor: 'synthetic-executor', keys: ['synthetic/first', 'synthetic/second'], workflows: ['a'.repeat(64)], holdingRuns: [], note: '升级自动保权：依据固定切点的工作流分配与有效预订生成，非管理员手工授予' }]);
  assert.deepEqual(plan.missing, []);
  assert.deepEqual(planEnvironmentAssignmentUpgrade({ ...input, members: [{ ...input.members[0], packs: [] }] }).grants, []);
});

test('the verified effective union can represent direct or team allocations without granting future team members', () => {
  const input = snapshot();
  const plan = planEnvironmentAssignmentUpgrade({ ...input, members: [input.members[0], { ...input.members[0], id: 'synthetic-team-member' }, { ...input.members[0], id: 'synthetic-unassigned', packs: [] }] });
  assert.deepEqual(plan.grants.map(row => row.user), ['synthetic-member', 'synthetic-team-member']);
  assert.ok(plan.grants.every(row => row.user !== '*' && !row.user.startsWith('tm_')));
});

test('only published usable lease declarations authorize exact existing executor keys, independently of pack names', () => {
  const input = snapshot(), original = input.workflows[0];
  const alternatives: EnvironmentUpgradeSnapshot['workflows'][number][] = [
    { ...original, kind: 'skill' }, { ...original, space: 'synthetic-personal-owner' }, { ...original, available: false },
    { ...original, publishedAt: after }, { ...original, declaration: {} },
    { ...original, declaration: { leases: { prefix: 'synthetic/' }, context: [] } },
    { ...original, declaration: { leases: { prefix: 'different/' }, context: ['leases'] } },
  ];
  for (const workflow of alternatives) assert.deepEqual(planEnvironmentAssignmentUpgrade({ ...input, workflows: [workflow] }).grants, []);
  const renamed = 'synthetic-renamed-workflow';
  assert.equal(planEnvironmentAssignmentUpgrade({ ...input, members: [{ ...input.members[0], packs: [renamed] }], workflows: [{ ...original, id: renamed }] }).grants.length, 1);
  assert.deepEqual(planEnvironmentAssignmentUpgrade({ ...input, executors: [{ ...input.executors[0], keys: ['synthetic-other/key'] }] }).grants, []);
});

test('new executors and new members are outside the immutable cutover', () => {
  const input = snapshot();
  const plan = planEnvironmentAssignmentUpgrade({ ...input,
    members: [...input.members, { ...input.members[0], id: 'synthetic-new-member', created_at: after }],
    executors: [...input.executors, { ...input.executors[0], id: 'synthetic-new-executor', registeredAt: after }],
  });
  assert.deepEqual(plan.grants.map(row => [row.user, row.executor]), [['synthetic-member', 'synthetic-executor']]);
});

test('active holdings preserve their existing executor even without a currently assigned leasing workflow', () => {
  const input = snapshot(), run = 'synthetic-held-run';
  const plan = planEnvironmentAssignmentUpgrade({ ...input, members: [{ ...input.members[0], packs: [] }], holdingBindings: [{ user: input.members[0].id, run, executor: input.executors[0].id, record: 'b'.repeat(64) }], holdings: input.executors[0].keys.map(key => ({ key, user: input.members[0].id, run, released: false, expires_at: null })) });
  assert.equal(plan.canApply, true);
  assert.deepEqual(plan.grants[0].holdingRuns, [run]);
  assert.deepEqual(plan.grants[0].workflows, []);
  assert.deepEqual(plan.grants[0].keys, [...input.executors[0].keys]);
});

test('expired and released holdings do not generate assignments', () => {
  const input = snapshot(), holding = { key: 'synthetic/first', user: input.members[0].id, run: 'synthetic-run', released: false, expires_at: at };
  const plan = planEnvironmentAssignmentUpgrade({ ...input, members: [{ ...input.members[0], packs: [] }], holdings: [holding, { ...holding, expires_at: null, released: true }] });
  assert.deepEqual(plan.grants, []);
  assert.deepEqual(plan.missing, []);
});

test('partial executor coverage and unmapped holdings block completion instead of widening permission', () => {
  const input = snapshot();
  const partial = planEnvironmentAssignmentUpgrade({ ...input, executors: [{ ...input.executors[0], keys: ['synthetic/first', 'different/second'] }] });
  assert.equal(partial.canApply, false);
  assert.deepEqual(partial.grants, []);
  assert.match(partial.missing[0].fact, /扩大范围/);
  const unmapped = planEnvironmentAssignmentUpgrade({ ...input, holdings: [{ key: 'unknown/key', user: input.members[0].id, run: 'synthetic-run', released: false, expires_at: after }] });
  assert.equal(unmapped.canApply, false);
  assert.equal(unmapped.missing[0].key, 'unknown/key');
});

test('disabled, deleted or unknown holders are reported rather than resurrected', () => {
  const input = snapshot(), held = { key: 'synthetic/first', user: input.members[0].id, run: 'synthetic-run', released: false, expires_at: null };
  for (const member of [{ ...input.members[0], disabled: true }, { ...input.members[0], deleted_at: before }]) {
    const plan = planEnvironmentAssignmentUpgrade({ ...input, members: [member], holdings: [held] });
    assert.equal(plan.canApply, false);
    assert.deepEqual(plan.grants, []);
  }
  assert.equal(planEnvironmentAssignmentUpgrade({ ...input, members: [], holdings: [held] }).canApply, false);
});

test('existing grants are not duplicated and an explicit revocation is never automatically overwritten', () => {
  const input = snapshot(), assignment = { user: input.members[0].id, executor: input.executors[0].id };
  assert.deepEqual(planEnvironmentAssignmentUpgrade({ ...input, effectiveAssignments: [assignment] }).grants, []);
  const revoked = planEnvironmentAssignmentUpgrade({ ...input, revokedAssignments: [assignment] });
  assert.equal(revoked.canApply, false);
  assert.deepEqual(revoked.grants, []);
  assert.match(revoked.missing[0].fact, /撤回/);
});

test('completion is bound to one cutover and suppresses restarts even after an administrator revokes assignments', () => {
  const input = snapshot(), assignment = { user: input.members[0].id, executor: input.executors[0].id };
  const plan = planEnvironmentAssignmentUpgrade({ ...input, revokedAssignments: [assignment] }, input.boundary);
  assert.equal(plan.alreadyCompleted, true);
  assert.equal(plan.canApply, false);
  assert.deepEqual(plan.grants, []);
  assert.deepEqual(plan.missing, []);
  assert.throws(() => planEnvironmentAssignmentUpgrade(input, 'different-cutover'), /切点不一致/);
});

test('plans are deterministic, duplicate keys and evidence are collapsed, and input objects are unchanged', () => {
  const input = snapshot();
  const duplicated = { ...input, workflows: [...input.workflows, ...input.workflows], executors: [{ ...input.executors[0], keys: ['synthetic/second', 'synthetic/first', 'synthetic/first'] }] };
  const before = JSON.stringify(duplicated);
  assert.deepEqual(planEnvironmentAssignmentUpgrade(duplicated), planEnvironmentAssignmentUpgrade(input));
  assert.equal(JSON.stringify(duplicated), before);
  assert.throws(() => planEnvironmentAssignmentUpgrade({ ...input, at: 'invalid' }), /时间无效/);
});


test('legacy holdings without executor identity never infer ownership from overlapping keys or previous grants', () => {
  const input = snapshot(), holding = { key: 'synthetic/first', user: input.members[0].id, run: 'synthetic-held-run', released: false, expires_at: null };
  const plan = planEnvironmentAssignmentUpgrade({ ...input, members: [{ ...input.members[0], packs: [] }],
    executors: [{ ...input.executors[0], keys: [holding.key] }, { ...input.executors[0], id: 'synthetic-never-assigned', keys: [holding.key] }],
    holdings: [holding], effectiveAssignments: [{ user: input.members[0].id, executor: input.executors[0].id }],
  });
  assert.equal(plan.canApply, false);
  assert.deepEqual(plan.grants, []);
  assert.match(plan.missing[0].fact, /归属/);
});

test('only a verified unique run-executor binding can preserve held use, never the overlapping executor', () => {
  const input = snapshot(), run = 'synthetic-held-run', key = 'synthetic/first';
  const data = { ...input, members: [{ ...input.members[0], packs: [] }],
    executors: [{ ...input.executors[0], keys: [key] }, { ...input.executors[0], id: 'synthetic-never-assigned', keys: [key] }],
    holdings: [{ key, user: input.members[0].id, run, released: false, expires_at: null }],
    holdingBindings: [{ user: input.members[0].id, run, executor: input.executors[0].id, record: 'b'.repeat(64) }],
  };
  const plan = planEnvironmentAssignmentUpgrade(data);
  assert.equal(plan.canApply, true);
  assert.deepEqual(plan.grants.map(row => row.executor), [input.executors[0].id]);
  const ambiguous = planEnvironmentAssignmentUpgrade({ ...data, holdingBindings: [...data.holdingBindings, { ...data.holdingBindings[0], executor: 'synthetic-never-assigned' }] });
  assert.equal(ambiguous.canApply, false);
  assert.deepEqual(ambiguous.grants, []);
});
