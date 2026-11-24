import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExecutorView } from '../api.ts';
import { commands } from './commands.ts';
import { html } from './html.ts';
import { heldOccupancyForEnvironment, unassignOccupancyFields } from './connections.ts';
import { ACTIONS } from './manage.ts';
import type { PageContext } from './context.ts';

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
