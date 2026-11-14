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
  noAssignmentMark,
} from './connections.ts';
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
    '当前占用：作业 aaaaaaaaaaaa。',
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
    '当前占用：作业 bbbbbbbbbbbb。',
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
