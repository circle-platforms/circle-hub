import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { runReset, ResetFailure, type ResetHost, type ResetRollbackOutcome, type ResetStage } from './operation.ts';

const ORDER = ['inspect', 'backup', 'stop', 'exportConfiguration', 'archive', 'create', 'prepare', 'restoreConfiguration', 'preflight', 'restart'] as const;
type HostStep = keyof ResetHost;

function fakeHost(options: {
  failures?: ReadonlySet<HostStep>;
  before?: (step: HostStep) => Promise<void>;
} = {}): { host: ResetHost; calls: HostStep[] } {
  const calls: HostStep[] = [];
  async function call(step: HostStep): Promise<void> {
    calls.push(step);
    await options.before?.(step);
    if (options.failures?.has(step)) throw new Error(`synthetic-private-${step}`);
  }
  const host: ResetHost = {
    inspect: () => call('inspect'),
    backup: () => call('backup'),
    stop: () => call('stop'),
    exportConfiguration: () => call('exportConfiguration'),
    archive: () => call('archive'),
    create: () => call('create'),
    prepare: () => call('prepare'),
    restoreConfiguration: () => call('restoreConfiguration'),
    preflight: () => call('preflight'),
    restart: () => call('restart'),
    rollback: () => call('rollback'),
  };
  return { host, calls };
}

function assertFailure(error: unknown, stage: ResetStage, rollback: ResetRollbackOutcome): asserts error is ResetFailure {
  assert.ok(error instanceof ResetFailure);
  assert.equal(error.stage, stage);
  assert.equal(error.rollback, rollback);
  assert.match(error.message, /重置.*失败/);
  assert.doesNotMatch(inspect(error, { showHidden: true }), /synthetic-private-/);
}

test('reset runs every stage once and exports configuration only after stopping', async () => {
  const { host, calls } = fakeHost();
  assert.deepEqual(await runReset(host), { completed: true });
  assert.deepEqual(calls, ORDER);
});

for (const [index, stage] of ORDER.entries()) {
  const stopAttempted = index >= ORDER.indexOf('stop');
  test(`a failure during ${stage} ${stopAttempted ? 'rolls back after that stage' : 'leaves the service untouched'}`, async () => {
    const { host, calls } = fakeHost({ failures: new Set([stage]) });
    await assert.rejects(runReset(host), (error: unknown) => {
      assertFailure(error, stage, stopAttempted ? 'succeeded' : 'not-needed');
      return true;
    });
    assert.deepEqual(calls, [...ORDER.slice(0, index + 1), ...(stopAttempted ? ['rollback'] : [])]);
  });
}

for (const [index, stage] of ORDER.entries()) {
  if (index < ORDER.indexOf('stop')) continue;
  test(`a rollback failure preserves the original ${stage} failure`, async () => {
    const { host, calls } = fakeHost({ failures: new Set<HostStep>([stage, 'rollback']) });
    await assert.rejects(runReset(host), (error: unknown) => {
      assertFailure(error, stage, 'failed');
      assert.match(error.message, /自动恢复失败/);
      return true;
    });
    assert.deepEqual(calls, [...ORDER.slice(0, index + 1), 'rollback']);
  });
}

test('each asynchronous stage completes before the next one starts', { timeout: 10_000 }, async () => {
  const gates = new Map<HostStep, {
    entered: ReturnType<typeof Promise.withResolvers<void>>;
    release: ReturnType<typeof Promise.withResolvers<void>>;
  }>(ORDER.map((stage) => [stage, { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }]));
  const { host, calls } = fakeHost({
    async before(stage) {
      const gate = gates.get(stage);
      assert.ok(gate);
      gate.entered.resolve();
      await gate.release.promise;
    },
  });
  const result = runReset(host);
  for (const [index, stage] of ORDER.entries()) {
    const gate = gates.get(stage)!;
    await gate.entered.promise;
    assert.deepEqual(calls, ORDER.slice(0, index + 1));
    gate.release.resolve();
  }
  assert.deepEqual(await result, { completed: true });
});

test('the failure is reported after automatic recovery finishes', { timeout: 10_000 }, async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { host, calls } = fakeHost({
    failures: new Set(['restoreConfiguration']),
    async before(stage) {
      if (stage !== 'rollback') return;
      entered.resolve();
      await release.promise;
    },
  });
  let settled = false;
  const result = runReset(host).then(
    () => { settled = true; return undefined; },
    (error: unknown) => { settled = true; return error; },
  );
  await entered.promise;
  assert.equal(settled, false);
  assert.deepEqual(calls, [...ORDER.slice(0, ORDER.indexOf('restoreConfiguration') + 1), 'rollback']);
  release.resolve();
  assertFailure(await result, 'restoreConfiguration', 'succeeded');
});

test('a synchronous exception while attempting to stop still triggers recovery', async () => {
  const { host, calls } = fakeHost();
  host.stop = () => {
    calls.push('stop');
    throw new Error('synthetic-private-stop');
  };
  await assert.rejects(runReset(host), (error: unknown) => {
    assertFailure(error, 'stop', 'succeeded');
    return true;
  });
  assert.deepEqual(calls, ['inspect', 'backup', 'stop', 'rollback']);
});

test('failure reporting never reads or serializes a thrown value', async () => {
  const { host, calls } = fakeHost();
  const thrown = {
    get message(): never { return assert.fail('the raw message must not be read'); },
    toString() { assert.fail('the raw value must not be converted to text'); },
  };
  host.prepare = () => { calls.push('prepare'); throw thrown; };
  host.rollback = () => { calls.push('rollback'); throw thrown; };
  await assert.rejects(runReset(host), (error: unknown) => {
    assertFailure(error, 'prepare', 'failed');
    assert.equal(error.message, '重置在准备重置数据阶段失败；自动恢复失败');
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.deepEqual(calls, [...ORDER.slice(0, ORDER.indexOf('prepare') + 1), 'rollback']);
});
