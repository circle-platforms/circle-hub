import assert from 'node:assert/strict';
import { test } from 'node:test';
import { labelOf } from '../../contracts/generated/vocabulary.ts';
import { secretNameOf } from '../../contracts/src/variables.ts';
import { setup } from '../dispatch/testing/context.ts';
import { jobCommand, type JobCommandSession } from './cli-job.ts';
import { CliError } from './errors.ts';

type Context = Awaited<ReturnType<typeof setup>>;
function session(c: Context) {
  const lines: string[] = [];
  const command = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line), admin: async () => c.admin, records: async () => c.kit,
    hub: async () => ({ dispatch: c.service, records: c.kit }), options: {}, ctx: { io: { cwd: c.kit.dataDir } } } as unknown as JobCommandSession;
  return { command, lines };
}
async function draft(c: Context) {
  await c.kit.teams.remove(c.admin, c.environmentTeam.id, c.admin.id);
  assert.equal(await c.environmentAccess.canUse(c.admin, c.executor.id), false);
  return c.registry.update(c.admin, c.executor.id, { ...c.executor.source, resources: [], manifest_sha256: null, conditions: [], capture_pointers: ['/topology'] });
}

test('the actual dispatch CLI turns the typed missing registration into registry-backed administrator guidance', { timeout: 60000 }, async t => {
  const c = await setup(); t.after(() => c.close()); await draft(c);
  const s = session(c);
  await assert.rejects(jobCommand(s.command, ['dispatch', '--run', c.run, '--executor', c.executor.id]), error => {
    assert.ok(error instanceof CliError, 'the command boundary must render the typed refusal');
    assert.ok(error.message.startsWith(labelOf('call_error_category', 'not_found') + '：'));
    assert.match(error.message, /尚未声明资源清单/);
    assert.match(error.hint ?? '', /circle-hub.*precheck/);
    assert.match(error.hint ?? '', /executor update/);
    assert.ok(error.hint?.includes(c.executor.id));
    return true;
  });
  assert.deepEqual(c.calls, []); assert.equal(c.submitted.length, 0);
});

test('successful CLI capture returns its readable report without claiming registration or repeating the capture step', { timeout: 60000 }, async t => {
  const c = await setup({ alter: (name, reply) => name === 'inspect_slot' ? { ...reply, topology: { synthetic: true } } : reply }); t.after(() => c.close()); await draft(c);
  const before = await c.leases.view('', true), s = session(c);
  assert.equal(await jobCommand(s.command, ['precheck', '--executor', c.executor.id]), 0);
  const events = await c.kit.store.findMany<import('../records/api.ts').ActionBody>({ kind: 'action', key: 'dispatch.executor', values: [c.executor.id] });
  const complete = events.findLast(event => event.body.detail.phase === 'complete' && event.body.detail.bootstrap_capture === true);
  const result = events.findLast(event => event.body.detail.phase === 'result' && event.body.detail.bootstrap_capture === true);
  assert.equal(complete?.body.detail.capture_completed, true); assert.equal(complete?.body.detail.registration_ready, false);
  const reference = result?.body.detail.reference; assert.equal(typeof reference, 'string'); assert.ok(typeof reference === 'string');
  const source = await c.kit.artifacts.source(c.admin, reference.slice(4)); assert.ok(source?.bytes);
  const text = s.lines.join('\n'); assert.ok(text.includes(reference)); assert.match(text, /只读采集已完成/); assert.match(text, /登记尚未完成/);
  const next = s.lines.find(line => line.startsWith('下一步：')); assert.ok(next);
  assert.match(next, /executor update/); assert.doesNotMatch(next, /先只读采集|只读采集：.*precheck/);
  assert.equal(c.submitted.length, 0); assert.deepEqual(await c.leases.view('', true), before);
  assert.equal(events.some(event => event.body.detail.phase === 'intent'), false);
});

test('failed CLI capture preserves the recorded credential recovery action instead of covering it with registration guidance', { timeout: 60000 }, async t => {
  const c = await setup(); t.after(() => c.close()); await draft(c);
  const name = secretNameOf(c.executor.definition.credential!); assert.ok(name);
  await c.kit.variables.unsetSecret(c.admin, name, 'SYNTHETIC_REVOKE');
  const s = session(c); assert.equal(await jobCommand(s.command, ['precheck', '--executor', c.executor.id]), 1);
  const events = await c.kit.store.findMany<import('../records/api.ts').ActionBody>({ kind: 'action', key: 'dispatch.executor', values: [c.executor.id] });
  const gap = events.findLast(event => event.body.detail.phase === 'session_unavailable'); assert.ok(gap);
  const action = gap.body.detail.next_action; assert.ok(typeof action === 'string'); assert.match(action, /secret set --name/);
  assert.ok(s.lines.join('\n').includes(action), 'the actual source-selected recovery action remains available');
  assert.match(s.lines.join('\n'), /没有完整的只读采集观察/); assert.doesNotMatch(s.lines.join('\n'), /只读采集已完成/);
  assert.deepEqual(c.calls, []); assert.equal(c.submitted.length, 0);
});
