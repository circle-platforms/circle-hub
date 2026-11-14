import assert from 'node:assert/strict';
import { test } from 'node:test';
import { labelOf } from '../../contracts/generated/vocabulary.ts';
import type { JobStatus } from '../dispatch/api.ts';
import { jobCommand, type JobCommandSession } from './cli-job.ts';

const job = 'a'.repeat(64);
const scope = { job };

async function show(state: JobStatus, sub: 'status' | 'resume' = 'status', json = false) {
  const lines: string[] = [];
  let closed = false;
  const session = {
    ctx: { io: { cwd: '/synthetic/commands' } }, options: {},
    out: (line: string) => lines.push(line), err: () => {},
    admin: async () => ({ id: 'usr_' + '0'.repeat(26), role: 'admin', name: '合成管理员' }),
    hub: async () => ({ dispatch: { options: {}, status: async () => state, resume: async () => state, close: async () => { closed = true; } } }),
  } as unknown as JobCommandSession;
  const code = await jobCommand(session, [sub, job, ...(json ? ['--json'] : [])]);
  assert.equal(closed, true);
  return { code, text: lines.join('\n') };
}

test('CLI distinguishes the unsent second round from a retained earlier job report', async () => {
  const report = 'src:' + 'b'.repeat(64);
  const { code, text } = await show({ job, events: 8, job_facts: { scope, operation: 'dispatch', frozen: false, result: report }, dispatch_attempt: { scope: { operation: 'dispatch', job, round: 2 }, outcome: 'not_dispatched', not_sent: true, next_action: '仅核对本轮原因' } });
  assert.equal(code, 0);
  assert.match(text, /第2轮正式派发：/);
  assert.match(text, /第2轮正式派发下一步：仅核对本轮原因/);
  assert.ok(text.includes('作业报告引用 ' + report));
  assert.doesNotMatch(text, /作业未执行|第1轮.*没有发出/);
});

test('CLI preserves missing scope as unknown and returns a non-success status', async () => {
  const { code, text } = await show({ job, events: 2, job_facts: { scope, operation: 'dispatch', frozen: true } });
  assert.equal(code, 1);
  assert.match(text, /尚无可核对的按范围派发结局/);
  assert.doesNotMatch(text, /第1轮|没有发出/);
});

test('CLI gives failed release diagnostics the same scope as their dispatch attempt', async () => {
  const { text } = await show({ job, events: 3, job_facts: { scope, operation: 'dispatch' }, dispatch_attempt: { scope: { operation: 'dispatch', job, round: 2 }, outcome: 'not_dispatched', not_sent: true, failed_checks: [{ step: 'manifest', missing_fact: '本轮清单未匹配', next_action: '核对本轮清单' }] } });
  assert.match(text, /第2轮正式派发未满足核对：步骤 "manifest"；缺事实：本轮清单未匹配；下一步：核对本轮清单/);
});

test('CLI does not return success for an observed round whose effect outcome is still absent', async () => {
  const { code } = await show({ job, events: 1, job_facts: { scope, operation: 'dispatch', frozen: false }, dispatch_attempt: { scope: { operation: 'dispatch', job, round: 1 } } });
  assert.equal(code, 1);
});

test('CLI names a readonly conformance observation without fabricating a physical dispatch', async () => {
  const { code, text } = await show({ job, events: 2, job_facts: { scope, operation: 'conformance', conformance_verified: true, frozen: false } });
  assert.equal(code, 0);
  assert.ok(text.includes(labelOf('dispatch_operation', 'conformance') + '：已取得全部条件通过的核对'));
  assert.doesNotMatch(text, /第1轮|尚无可核对的按范围派发结局/);
});

test('CLI does not return success for a readonly check whose verified conclusion is absent or false', async () => {
  for (const operation of ['precheck', 'conformance'] as const) {
    const { code } = await show({ job, events: 2, job_facts: { scope, operation, readonly_verified: false, conformance_verified: false, frozen: false } });
    assert.equal(code, 1);
  }
});


test('CLI JSON status exposes the exact scoped object without human text or flat effect aliases', async () => {
  const state: JobStatus = { job, events: 7, job_facts: { scope, operation: 'dispatch', result: 'src:' + 'b'.repeat(64) }, dispatch_attempt: { scope: { operation: 'dispatch', job, round: 2 }, outcome: 'not_dispatched', not_sent: true } };
  const { code, text } = await show(state, 'status', true);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(text), state);
  assert.equal(text.split('\n').length, 1);
  for (const field of ['outcome', 'not_sent', 'frozen', 'result']) assert.equal(Object.hasOwn(JSON.parse(text), field), false);
});

test('CLI JSON resume keeps missing scope explicit and preserves the unknown exit code', async () => {
  const state: JobStatus = { job, events: 1, job_facts: { scope, operation: 'dispatch', frozen: true } };
  const { code, text } = await show(state, 'resume', true);
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(text), state);
  assert.equal(Object.hasOwn(JSON.parse(text), 'dispatch_attempt'), false);
});
