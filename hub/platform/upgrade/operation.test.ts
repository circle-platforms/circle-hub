import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { runUpgrade, UpgradeFailure, type UpgradeHost, type UpgradeRollbackOutcome, type UpgradeStage } from './operation.ts';

const ORDER = ['current', 'backup', 'stop', 'archive', 'create', 'migrate', 'transfer', 'preflight', 'restart'] as const;
type HostStep = keyof UpgradeHost;

function fakeHost(options: {
  current?: boolean;
  failures?: ReadonlySet<HostStep>;
  before?: (step: HostStep) => Promise<void>;
} = {}): { host: UpgradeHost; calls: HostStep[] } {
  const calls: HostStep[] = [];
  async function call(step: HostStep): Promise<void> {
    calls.push(step);
    await options.before?.(step);
    if (options.failures?.has(step)) throw new Error(`synthetic-private-${step}`);
  }
  const host: UpgradeHost = {
    async current() { await call('current'); return options.current ?? false; },
    backup: () => call('backup'),
    stop: () => call('stop'),
    archive: () => call('archive'),
    create: () => call('create'),
    migrate: () => call('migrate'),
    transfer: () => call('transfer'),
    preflight: () => call('preflight'),
    restart: () => call('restart'),
    rollback: () => call('rollback'),
  };
  return { host, calls };
}

function assertFailure(error: unknown, stage: UpgradeStage, rollback: UpgradeRollbackOutcome): asserts error is UpgradeFailure {
  assert.ok(error instanceof UpgradeFailure);
  assert.equal(error.stage, stage);
  assert.equal(error.rollback, rollback);
  assert.match(error.message, /自动升级.*失败/);
  assert.doesNotMatch(inspect(error, { showHidden: true }), /synthetic-private-/);
}

test('an already current database needs no backup or service changes', async () => {
  const { host, calls } = fakeHost({ current: true });
  assert.deepEqual(await runUpgrade(host), { status: 'noop' });
  assert.deepEqual(calls, ['current']);
});

test('upgrade runs the complete ordered sequence once', async () => {
  const { host, calls } = fakeHost();
  assert.deepEqual(await runUpgrade(host), { status: 'upgraded' });
  assert.deepEqual(calls, ORDER);
});

for (const [index, stage] of ORDER.entries()) {
  const stopped = index >= ORDER.indexOf('stop');
  test(`a failure during ${stage} ${stopped ? 'rolls back after that stage' : 'leaves the service untouched'}`, async () => {
    const { host, calls } = fakeHost({ failures: new Set([stage]) });
    await assert.rejects(runUpgrade(host), (error: unknown) => {
      assertFailure(error, stage, stopped ? 'succeeded' : 'not-needed');
      return true;
    });
    assert.deepEqual(calls, [...ORDER.slice(0, index + 1), ...(stopped ? ['rollback'] : [])]);
  });
}

for (const [index, stage] of ORDER.entries()) {
  if (index < ORDER.indexOf('stop')) continue;
  test(`a rollback failure preserves the original ${stage} failure`, async () => {
    const { host, calls } = fakeHost({ failures: new Set<HostStep>([stage, 'rollback']) });
    await assert.rejects(runUpgrade(host), (error: unknown) => {
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
  const result = runUpgrade(host);
  for (const [index, stage] of ORDER.entries()) {
    const gate = gates.get(stage)!;
    await gate.entered.promise;
    assert.deepEqual(calls, ORDER.slice(0, index + 1));
    gate.release.resolve();
  }
  assert.deepEqual(await result, { status: 'upgraded' });
});

test('the failure is reported after automatic recovery finishes', { timeout: 10_000 }, async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { host, calls } = fakeHost({
    failures: new Set(['transfer']),
    async before(stage) {
      if (stage !== 'rollback') return;
      entered.resolve();
      await release.promise;
    },
  });
  let settled = false;
  const result = runUpgrade(host).then(
    () => { settled = true; return undefined; },
    (error: unknown) => { settled = true; return error; },
  );
  await entered.promise;
  assert.equal(settled, false);
  assert.deepEqual(calls, [...ORDER.slice(0, ORDER.indexOf('transfer') + 1), 'rollback']);
  release.resolve();
  assertFailure(await result, 'transfer', 'succeeded');
});

test('a synchronous exception while attempting to stop still triggers recovery', async () => {
  const { host, calls } = fakeHost();
  host.stop = () => {
    calls.push('stop');
    throw new Error('synthetic-private-stop');
  };
  await assert.rejects(runUpgrade(host), (error: unknown) => {
    assertFailure(error, 'stop', 'succeeded');
    return true;
  });
  assert.deepEqual(calls, ['current', 'backup', 'stop', 'rollback']);
});

test('failure reporting never reads or serializes a thrown value', async () => {
  const { host, calls } = fakeHost();
  const thrown = {
    get message() { assert.fail('the raw message must not be read'); },
    toString() { assert.fail('the raw value must not be converted to text'); },
  };
  host.migrate = () => { calls.push('migrate'); throw thrown; };
  host.rollback = () => { calls.push('rollback'); throw thrown; };
  await assert.rejects(runUpgrade(host), (error: unknown) => {
    assertFailure(error, 'migrate', 'failed');
    assert.equal(error.message, '自动升级在应用基线迁移阶段失败；自动恢复失败');
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.deepEqual(calls, [...ORDER.slice(0, ORDER.indexOf('migrate') + 1), 'rollback']);
});
