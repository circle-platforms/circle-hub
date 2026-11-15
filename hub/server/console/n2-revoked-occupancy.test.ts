import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EnvironmentFacts } from '../../dispatch/api.ts';
import type { ExecutorView } from '../api.ts';
import { commands } from './commands.ts';
import { html } from './html.ts';
import {
  NO_ASSIGNMENT_LABEL,
  environmentIsOccupied,
  environmentLacksAssignment,
  heldLeaseKeysForEnvironment,
  heldOccupancyForEnvironment,
  noAssignmentMark,
  unassignOccupancyFields,
} from './connections.ts';
import { ACTIONS } from './manage.ts';
import { commandModal } from './presentation.ts';
import type { PageContext } from './context.ts';

const state = (facts: Partial<EnvironmentFacts> = {}): EnvironmentFacts => ({
  executor: 'x',
  enabled: true,
  registration: { digest: 'd'.repeat(64), decided_at: '2026-11-01T00:00:00.000Z' },
  known: { occupancy: true, latest: true, version: true },
  holding: [],
  bed_hold: null,
  latest: null,
  reported_version: null,
  missing: [],
  ...facts,
});

test('occupied without assignment is marked 已无分配; assigned occupancy is not', () => {
  const occupied: ExecutorView = {
    id: 'exe_' + '1'.repeat(26),
    target: '合成实验室',
    endpoint: 'https://192.0.2.10/mcp',
    enabled: true,
    resources: [],
    state: state({
      holding: [{ job: 'a'.repeat(64), run: null, frozen: false, outcome: 'issued', phase: 'intent' }],
    }),
  };
  assert.equal(environmentIsOccupied(occupied), true);
  assert.equal(environmentLacksAssignment({ assigned: false, can_use: false }), true);
  assert.match(String(noAssignmentMark({ assigned: false, can_use: false })), new RegExp(NO_ASSIGNMENT_LABEL));
  assert.equal(environmentLacksAssignment({ assigned: true, can_use: true }), false);
  assert.equal(String(noAssignmentMark({ assigned: true, can_use: true })), '');
  assert.equal(environmentIsOccupied({ ...occupied, state: state({ holding: [] }) }), false);
});

test('lease-release confirmation dialog follows bed-hold commandModal pattern', () => {
  const dialog = commands.leaseRelease(
    { id: 'exe_' + '2'.repeat(26), target: '合成实验室' },
    '当前占用：上机验证 aaaaaaaaaaaa。',
  );
  assert.match(dialog.id, /lease-release/);
  assert.match(dialog.title, /强制释放预订/);
  assert.match(html`${dialog.text}`.text, /当前占用/);
  assert.match(html`${dialog.text}`.text, /原持有者/);
  assert.match(dialog.command, /circle-hub lease release/);
  assert.match(dialog.command, /--reason=/);
  assert.match(dialog.command, /租约键/);
  assert.equal(dialog.choices, undefined);
  assert.doesNotMatch(html`${dialog.text}`.text, /未知/);
});

test('lease-release confirmation offers held keys as a single choice instead of a blank placeholder', () => {
  const dialog = commands.leaseRelease(
    { id: 'exe_' + '3'.repeat(26), target: '合成实验室' },
    '当前占用：上机验证 bbbbbbbbbbbb。',
    ['synthetic/zone/a', 'synthetic/zone/b'],
  );
  assert.ok(dialog.choices);
  assert.equal(dialog.choices.length, 2);
  assert.deepEqual(dialog.choices.map((choice) => choice.label), ['synthetic/zone/a', 'synthetic/zone/b']);
  for (const choice of dialog.choices) {
    assert.match(choice.command, /circle-hub lease release synthetic\/zone\//);
    assert.match(choice.command, /--reason=/);
    assert.doesNotMatch(choice.command, /租约键/);
  }
  assert.equal(dialog.command, dialog.choices[0]!.command);
  assert.match(html`${dialog.text}`.text, /请选择要释放的持有键/);
  const modal = html`${commandModal(dialog)}`.text;
  assert.match(modal, /持有的键/);
  assert.match(modal, /type="radio"/);
  assert.match(modal, /synthetic\/zone\/a/);
  assert.doesNotMatch(modal, /租约键/);
});

test('heldLeaseKeysForEnvironment returns exact matches from leases.view and null when the port is absent', async () => {
  const view: ExecutorView = {
    id: 'exe_' + '4'.repeat(26),
    target: '合成实验室',
    endpoint: 'https://192.0.2.10/mcp',
    enabled: true,
    resources: ['synthetic/zone/a', 'synthetic/zone/b'],
  };
  assert.equal(await heldLeaseKeysForEnvironment({ deps: {} } as unknown as PageContext, view), null);
  const ctx = {
    deps: {
      leases: {
        view: async () => ({
          entries: [
            { key: 'synthetic/zone/a', since: '2026-11-01T00:00:00.000Z', until: null, run: 'run_a', user: 'usr_a' },
            { key: 'other/zone', since: '2026-11-01T00:00:00.000Z', until: null, run: 'run_b', user: 'usr_b' },
            { key: 'synthetic/zone/b', since: '2026-11-01T00:00:00.000Z', until: null, run: 'run_c', user: 'usr_c' },
          ],
        }),
      },
    },
  } as unknown as PageContext;
  assert.deepEqual(await heldLeaseKeysForEnvironment(ctx, view), ['synthetic/zone/a', 'synthetic/zone/b']);
});

test('heldOccupancyForEnvironment keeps only the named holders and names the 测试环境', async () => {
  const view: ExecutorView = {
    id: 'exe_' + '5'.repeat(26),
    target: '合成实验室',
    endpoint: 'https://192.0.2.10/mcp',
    enabled: true,
    resources: ['synthetic/zone/a', 'synthetic/zone/b'],
  };
  assert.equal(await heldOccupancyForEnvironment({ deps: {} } as unknown as PageContext, view, new Set(['usr_a'])), null);
  const ctx = {
    userName: async (id: string) => (id === 'usr_a' ? '合成成员甲' : id),
    deps: {
      leases: {
        view: async () => ({
          entries: [
            { key: 'synthetic/zone/a', since: '2026-11-01T08:00:00.000Z', until: null, run: 'run_a', user: 'usr_a' },
            { key: 'synthetic/zone/b', since: '2026-11-01T09:00:00.000Z', until: null, run: 'run_b', user: 'usr_b' },
            { key: 'other/zone', since: '2026-11-01T07:00:00.000Z', until: null, run: 'run_c', user: 'usr_a' },
          ],
        }),
      },
    },
  } as unknown as PageContext;
  const rows = await heldOccupancyForEnvironment(ctx, view, new Set(['usr_a']));
  assert.deepEqual(rows, [{
    key: 'synthetic/zone/a',
    environment: '合成实验室',
    since: '2026-11-01T08:00:00.000Z',
    holderId: 'usr_a',
    holderName: '合成成员甲',
  }]);
});

test('unassign confirmation lists 测试环境, since, and force_release checkboxes', () => {
  const empty = html`${unassignOccupancyFields([])}`.text;
  assert.match(empty, /没有读到/);
  assert.doesNotMatch(empty, /运行环境/);
  const unknown = html`${unassignOccupancyFields(null)}`.text;
  assert.match(unknown, /占用暂不可读/);
  const held = html`${unassignOccupancyFields([{
    key: 'synthetic/zone/a',
    environment: '合成实验室',
    since: '2026-11-01T08:00:00.000Z',
    holderId: 'usr_a',
    holderName: '合成成员甲',
  }])}`.text;
  assert.match(held, /测试环境「合成实验室」/);
  assert.match(held, /合成成员甲/);
  assert.match(held, /force_release/);
  assert.match(held, /synthetic\/zone\/a/);
  assert.match(held, /自 /);
  assert.doesNotMatch(held, /运行环境/);
  assert.match(commands.executorUnassignConsequence, /预订仍留在持有人名下/);
});

test('executor-unassign build chains lease-release for checked force_release keys', () => {
  const formOf = (values: Record<string, string>) => ({ get: (name: string) => values[name] ?? '' });
  const alone = ACTIONS['executor-unassign'].build(formOf({
    executor: 'exe_' + '6'.repeat(26),
    team: 'tm_' + '6'.repeat(26),
  }));
  assert.ok(!Array.isArray(alone));
  assert.deepEqual(alone.argv.slice(0, 2), ['executor', 'unassign']);
  const chained = ACTIONS['executor-unassign'].build(formOf({
    executor: 'exe_' + '6'.repeat(26),
    team: 'tm_' + '6'.repeat(26),
    force_release: 'synthetic/zone/a\nsynthetic/zone/b',
  }));
  assert.ok(Array.isArray(chained));
  assert.equal(chained.length, 3);
  assert.deepEqual(chained[0]!.argv.slice(0, 2), ['executor', 'unassign']);
  assert.deepEqual(chained[1]!.argv.slice(0, 3), ['lease', 'release', 'synthetic/zone/a']);
  assert.deepEqual(chained[2]!.argv.slice(0, 3), ['lease', 'release', 'synthetic/zone/b']);
  assert.ok(chained[1]!.argv.some((word) => word.startsWith('--reason=')));
});
