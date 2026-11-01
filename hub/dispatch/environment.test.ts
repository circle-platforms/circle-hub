// The state of a runtime environment as the journal establishes it (environment.ts, DispatchService.environment): free
// before any dispatch, held while a dispatch is under way, free again after an effective one with its latest dispatch and
// the version the target reported, frozen while a result is unconfirmed or a bed is left unrestored, disabled when the
// registration says so; administrators only, and nothing for an id that is not an executor. Synthetic endpoint only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newestOf, reportedVersion, scanNewest, type EnvironmentFacts } from './environment.ts';
import { setup } from './testing/context.ts';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

test('the reported version is read from an initialize answer as kept: JSON, a batch or server-sent events', () => {
  assert.equal(reportedVersion(encode(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'g', version: '2.4.1' } } }))), '2.4.1');
  assert.equal(reportedVersion(encode(JSON.stringify([{ jsonrpc: '2.0', id: 1, result: { serverInfo: { version: '3' } } }]))), '3');
  assert.equal(reportedVersion(encode(`event: message\ndata: ${JSON.stringify({ result: { serverInfo: { version: 'sse-1' } } })}\n\n`)), 'sse-1');
  assert.equal(reportedVersion(encode(JSON.stringify({ result: { serverInfo: { name: 'g' } } }))), null, 'not reported');
  assert.equal(reportedVersion(encode('not json')), null);
  assert.equal(reportedVersion(encode(JSON.stringify({ result: { serverInfo: { version: 'a\nb' } } }))), null, 'a control character is not a version');
});

test('the newest non-read-only reservation and the newest initialize answer are picked from newest-first events', () => {
  const event = (phase: string, extra: Record<string, unknown> = {}) => ({ body: { detail: { phase, ...extra } } }) as never;
  const events = [event('complete'), event('initialize.response'), event('reservation', { read_only: true }), event('reservation', { job: 'b' }), event('initialize.response', { old: true })];
  const found = newestOf(events);
  assert.equal(found.reservation?.body.detail.job, 'b');
  assert.equal(found.initialize?.body.detail.old, undefined);
  assert.deepEqual(newestOf([]), { reservation: null, initialize: null });
});

test('the latest dispatch and session are searched page by page; what lies past the pages read stays unknown', async () => {
  const event = (phase: string, extra: Record<string, unknown> = {}) => ({ body: { detail: { phase, ...extra } } }) as never;
  const pages = [[event('complete')], [event('reservation', { job: 'old' })], [event('initialize.response')]];
  const read = async (cursor: string | null) => {
    const at = cursor === null ? 0 : Number(cursor);
    return { items: pages[at], next: at + 1 < pages.length ? String(at + 1) : null };
  };
  const one = await scanNewest(read, 1);
  assert.deepEqual([one.reservation, one.initialize, one.exhausted], [null, null, false], 'not found within the pages read: unknown, not none');
  const two = await scanNewest(read, 2);
  assert.equal(two.reservation?.body.detail.job, 'old');
  assert.deepEqual([two.initialize, two.exhausted], [null, false]);
  const all = await scanNewest(read);
  assert.ok(all.reservation && all.initialize);
  assert.equal(all.exhausted, true);
  const empty = await scanNewest(async () => ({ items: [], next: null }));
  assert.deepEqual(empty, { reservation: null, initialize: null, exhausted: true }, 'an executor never dispatched to has none');
});

test('an environment is free, then held during a dispatch, then free with its latest dispatch and the version it reported', async (t) => {
  let during: EnvironmentFacts | null = null;
  let service: Awaited<ReturnType<typeof setup>>['service'] | undefined;
  let admin: Awaited<ReturnType<typeof setup>>['admin'] | undefined;
  let executor = '';
  const c = await setup({
    serverVersion: () => 'synthetic-gateway 2.4.1',
    onSubmit: async () => {
      during = await service!.environment(admin!, executor);
    },
  });
  t.after(() => c.close());
  service = c.service;
  admin = c.admin;
  executor = c.executor.id;

  const before = await c.service.environment(c.admin, c.executor.id);
  assert.ok(before);
  assert.equal(before.enabled, true);
  assert.deepEqual(before.known, { occupancy: true, latest: true, version: true });
  assert.deepEqual(before.holding, []);
  assert.equal(before.bed_hold, null);
  assert.equal(before.latest, null);
  assert.equal(before.reported_version, null, 'no session yet');
  assert.deepEqual(before.missing, []);
  assert.match(before.registration.digest, /^[0-9a-f]{64}$/);
  assert.ok(before.registration.decided_at);

  const done = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(done.outcome, 'effective');
  // During the submit the job held the environment, and nothing was frozen.
  const held = during as EnvironmentFacts | null;
  assert.ok(held);
  assert.deepEqual(held.holding?.map((job) => [job.job, job.frozen]), [[done.job, false]]);
  assert.equal(held.holding?.[0]?.run, c.run);

  const after = await c.service.environment(c.admin, c.executor.id);
  assert.ok(after);
  assert.deepEqual(after.holding, [], 'an effective dispatch holds nothing');
  assert.equal(after.latest?.job, done.job);
  assert.equal(after.latest?.run, c.run);
  assert.equal(after.latest?.outcome, 'effective');
  assert.equal(after.latest?.frozen, false);
  assert.equal(after.reported_version, 'synthetic-gateway 2.4.1');

  // Disabled by its registration.
  await c.registry.disable(c.admin, c.executor.id);
  assert.equal((await c.service.environment(c.admin, c.executor.id))?.enabled, false);
});

test('an unconfirmed result freezes the environment; an open bed hold is shown until it is cleared', async (t) => {
  const c = await setup({ mode: 'disconnect' });
  t.after(() => c.close());
  const lost = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(lost.outcome, 'unknown');
  assert.equal(lost.frozen, true);
  const frozen = await c.service.environment(c.admin, c.executor.id);
  assert.ok(frozen);
  assert.deepEqual(frozen.holding?.map((job) => [job.job, job.frozen, job.outcome]), [[lost.job, true, 'unknown']]);
  assert.equal(frozen.latest?.frozen, true);

  // A bed left unrestored by the job, as the bed gate records it, until an administrator clears it.
  const binding = await c.service.journal.binding(lost.job);
  await c.service.journal.append(binding, 'bed_hold', 'validate', 'completed', { bed: 'synthetic-bed', state: 'open', pre: {} });
  assert.deepEqual((await c.service.environment(c.admin, c.executor.id))?.bed_hold, { job: lost.job, bed: 'synthetic-bed' });
  assert.deepEqual(await c.service.clearBedHold(c.admin, c.executor.id, '合成：床面已恢复'), { cleared: true, job: lost.job, bed: 'synthetic-bed' });
  assert.equal((await c.service.environment(c.admin, c.executor.id))?.bed_hold, null);
});

test('only administrators read an environment, and an id that is not an executor has none', async (t) => {
  const c = await setup();
  t.after(() => c.close());
  await assert.rejects(c.service.environment({ id: c.owner.id, name: c.owner.name, role: 'user' }, c.executor.id));
  assert.equal(await c.service.environment(c.admin, 'exe_00000000000000000000000000'), null);
  assert.equal(await c.service.environment(c.admin, 'not-an-id'), null);
});
