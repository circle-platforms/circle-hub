import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jobCommand, type JobCommandSession } from './cli-job.ts';
import type { EnvironmentReadiness } from '../dispatch/api.ts';

function fixture(verified = true) {
  const calls: unknown[][] = [], lines: string[] = [];
  const actor = { id: 'usr_' + '0'.repeat(26), name: '合成管理员', role: 'admin' };
  const report: EnvironmentReadiness = { target: 'synthetic-target', observed_at: '2026-11-14T00:00:00.000Z', executors: [{ ordinal: 1, occupancy: null, baseline_registrations: [], checks: [{ condition: 'manifest', label: '清单', satisfied: false, observed_at: '2026-11-14T00:00:00.000Z', references: [] }] }], limitations: ['未连接网关或设备'] };
  const state = { phase: 'precheck', outcome: 'unknown', job: 'a'.repeat(64), frozen: false, events: 0 };
  const dispatch = { options: {}, registry: { get: async (id: string) => { calls.push(['configuration', id]); return { definition: { target: 'synthetic-target' } }; } }, precheck: async (...args: unknown[]) => { calls.push(['precheck', ...args]); return state; }, dispatch: async (...args: unknown[]) => { calls.push(['dispatch', ...args]); return { ...state, outcome: 'effective' }; }, journal: { events: async () => [{ body: { detail: { readonly_verified: verified } } }] }, close: async () => { calls.push(['close']); } };
  const view = { readiness: async (...args: unknown[]) => { calls.push(['readiness', ...args]); return report; } };
  const session = { ctx: { io: { cwd: '/synthetic/commands' } }, options: {}, out: (line: string) => lines.push(line), err: (line: string) => lines.push(line), admin: async () => actor, hub: async () => ({ dispatch, deps: { dispatch: view } }) };
  return { session: session as unknown as JobCommandSession, view, calls, lines, state, actor };
}

test('manual precheck only appends local observations and preserves its original outcome and exit', async () => {
  for (const verified of [true, false]) {
    const f = fixture(verified);
    assert.equal(await jobCommand(f.session, ['precheck', '--executor=synthetic-executor']), verified ? 0 : 1);
    assert.deepEqual(f.calls, [['precheck', f.actor, 'synthetic-executor', undefined], ['configuration', 'synthetic-executor'], ['readiness', f.actor, 'synthetic-target'], ['close']]);
    assert.equal(f.state.outcome, 'unknown'); assert.equal(f.state.frozen, false);
    assert.ok(f.lines.some(line => line.startsWith('本地只读就绪报告（不作许可或拒绝）：')));
  }
});

test('missing or failed readiness does not alter old manual precheck success', async () => {
  const f = fixture(); f.view.readiness = async () => { throw new Error('private-report-error'); };
  assert.equal(await jobCommand(f.session, ['precheck', '--executor=synthetic-executor']), 0);
  assert.ok(f.lines.some(line => line.includes('只读就绪报告未知'))); assert.doesNotMatch(f.lines.join('\n'), /private-report-error/);
  const original = fixture(); const hub = await original.session.hub();
  original.session.hub = async () => ({ ...hub, deps: undefined });
  assert.equal(await jobCommand(original.session, ['precheck', '--executor=synthetic-executor']), 0);
  assert.ok(original.lines.some(line => line.includes('尚未接线')));
});

test('dispatch command never calls the readiness display port or adds a new admission condition', async () => {
  const f = fixture();
  f.view.readiness = async () => { throw new Error('dispatch must never use display readiness'); };
  assert.equal(await jobCommand(f.session, ['dispatch', '--executor=synthetic-executor', '--run=synthetic-run']), 0);
  assert.equal(f.calls.filter(call => call[0] === 'dispatch').length, 1);
  assert.equal(f.calls.filter(call => call[0] === 'configuration' || call[0] === 'readiness').length, 0);
  assert.ok(!f.lines.some(line => line.includes('只读就绪报告')));
});
