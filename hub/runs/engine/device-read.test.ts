import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { DeviceReadResult, DeviceReadTarget } from '../../../contracts/src/pack.ts';
import type { RunRecord } from '../../../contracts/src/run.ts';
import { toolText } from '../../server/text.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { INDEX } from './store.ts';
import { openHarness, sandboxSkip, type Harness } from './testing/harness.ts';
import { standardDocument, toyMap } from './testing/mindmap.ts';
import { writePack, type PackSpec } from './testing/packs.ts';

const skip = await sandboxSkip();
const INVENTORY = 'e'.repeat(64);
const WORDS = 'peers:\nname      address\npeer-1    192.0.2.7';
const LINE = 'inspect peers';

let postgres: TemporaryPostgres;
let h: Harness;
let map: string;
let packRoot: string;
const read: Array<{ user: string; run: string; targets: DeviceReadTarget[] }> = [];
let port: (targets: ReadonlyArray<DeviceReadTarget>) => Promise<DeviceReadResult[]>;

const answered = (target: DeviceReadTarget, output: string | null = WORDS): DeviceReadResult => ({
  inventory: target.inventory, device: target.device, label: target.label, line: target.line, sent: true,
  answer: { has_output: output !== null, output, truncated: false, withheld: false, anomaly: null, observed_at: '2026-10-22T08:00:31.000Z', reference: `src:${'a'.repeat(64)}`, text_reference: output === null ? null : `src:${'b'.repeat(64)}` },
  missing: null,
});

const bookProjection = (key: string): string => `export default function project(_input: unknown): unknown {
  return { items: [], warnings: [], lease_requests: [{ keys: ['${key}'], ttl_seconds: 300 }] };
}
`;
const releaseProjection = (key: string): string => `export default function project(_input: unknown): unknown {
  return { items: [], warnings: [], lease_requests: [{ op: 'release', keys: ['${key}'] }] };
}
`;
const readProjection = (entries: unknown[]): string => `export default function project(_input: unknown): unknown {
  return { items: [], warnings: [], read: ${JSON.stringify(entries)} };
}
`;
const entry = (key: string, extra: Record<string, unknown> = {}) => ({ inventory: INVENTORY, device: '/devices/0', label: `bed/${key}`, line: LINE, keys: [key], ...extra });

const ECHO_SUBJECT = `export default function subject(_input: unknown): unknown { return { items: [], context: {} }; }
`;
const ECHO_CHECK = `export default function echo(_input: unknown): unknown {
  return [{ verdict: 'support', statement: '探针（合成）', grounds: [], tier: 'advisory' }];
}
`;

function pack(id: string, projection: string, declare = true): PackSpec {
  return {
    id, version: '1.0.0', kind: 'workflow', title: `合成读设备包 ${id}`, description: '读设备接线（合成）',
    files: {
      'workflow.json': { json: {
        schema: 'workflow@1',
        inputs: [{ slot: 'map', role: 'subject', description: '被评审的脑图', accepts: ['application/json', 'toy:mindmap'], required: true, many: false }],
        parameters: [], product: { catalogs: [] }, subject: 'map', projection: { module: 'functions/project.ts' },
        ...(declare ? { leases: { prefix: 'meadow/', max_ttl_seconds: 600 } } : {}), context: ['leases'],
      } },
      'requirements.json': { json: { schema: 'requirements@1', requirements: [{ key: 'probe', name: '探针', description: '合成', target: 'run', required: true, done_rule: 'bookkeeping', layers: ['static'], accepted_producer: 'fact', checks: ['probe'], error_handling: [] }] } },
      'checks.json': { json: { schema: 'checks@1', checks: [{ id: 'probe', function: { module: 'functions/echo.ts' }, applies: 'run', subject: { module: 'functions/subject.ts' }, judges: 'subject', tier: 'advisory' }] } },
      'slots.schema.json': { json: { schema: 'slots@1', item: {}, run: {} } },
      'SKILL.md': '# 合成读设备包\n\n探测用。\n',
      'functions/project.ts': projection,
      'functions/echo.ts': ECHO_CHECK,
      'functions/subject.ts': ECHO_SUBJECT,
    },
  };
}

before(async () => {
  if (skip) return;
  postgres = await startPostgres();
  h = await openHarness(postgres, { leases: true, observations: {
    latest: async () => [],
    observe: async () => ({ observed: [], missing: null }),
    read: async (user, run, targets) => { read.push({ user: user.id, run, targets: [...targets] }); return port(targets); },
  } });
  map = await h.upload(h.alice, toyMap(standardDocument()));
  packRoot = await mkdtemp(join(tmpdir(), 'circle-hub-device-read-'));
});
after(async () => {
  await h?.close();
  if (packRoot) await rm(packRoot, { recursive: true, force: true });
  await postgres?.stop();
});

const add = async (id: string, projection: string, declare = true): Promise<void> => {
  await h.workflows.add(await writePack(packRoot, pack(id, projection, declare)));
  h.workflows.assign(h.alice.id, id);
  h.workflows.assign(h.bob.id, id);
};
const start = (user: typeof h.alice, id: string, session: string, predecessor?: string) =>
  h.service.startRunDetailed(user, { pack: id, inputs: { map: { reference: map } }, ...(predecessor === undefined ? {} : { predecessor }) }, h.call(session));
const book = async (key: string, session: string): Promise<string> => {
  await add(`toy-book-${session}`, bookProjection(key));
  const booked = await start(h.alice, `toy-book-${session}`, session);
  assert.equal(booked.answer.call_result, 'ok', JSON.stringify(booked.answer.errors));
  return booked.answer.run!.run;
};
const storedRun = async (run: string): Promise<RunRecord> => {
  const found = await h.kit.store.find({ key: INDEX.runId, value: run, kind: 'run' });
  assert.equal(found.items.length, 1);
  return found.items[0]!.body as RunRecord;
};

describe('a run that reads a device its lineage holds', { skip }, () => {
  it('hands the port what the projection named, records the answer as one observation and shows the device words as received', async () => {
    port = async (targets) => targets.map((t) => answered(t));
    read.length = 0;
    const booking = await book('meadow/dev/1', 's-read-1a');
    await add('toy-read-1', readProjection([entry('meadow/dev/1')]));
    const detail = await start(h.alice, 'toy-read-1', 's-read-1b', booking);
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    const run = detail.answer.run!;
    assert.deepEqual(read.map((r) => [r.user, r.run, r.targets]), [[h.alice.id, run.run, [entry('meadow/dev/1')]]], 'read once, for what the projection named');
    const claims = run.device_reads!;
    assert.equal(claims.length, 1, 'one observation per request');
    const [claim] = claims;
    assert.equal(claim!.statement.text, '在 bed/meadow/dev/1 上读“inspect peers”：设备输出 3 行');
    assert.deepEqual(claim!.statement.data, { label: 'bed/meadow/dev/1', inventory: INVENTORY, device: '/devices/0', line: LINE, has_output: true, output: WORDS, truncated: false, withheld: false });
    assert.deepEqual([claim!.qualifier.nature, claim!.qualifier.provenance, claim!.qualifier.collected_at], ['fact', 'observed', '2026-10-22T08:00:31.000Z']);
    assert.deepEqual(claim!.qualifier.marks, ['target_reported', 'local_ops_not_excluded']);
    assert.deepEqual(claim!.grounds, [`src:${'a'.repeat(64)}`, `src:${'b'.repeat(64)}`], 'the stored answer and the text the model may read');
    assert.deepEqual(claim!.warrant, { producer: 'function', id: 'dispatch.device_read@1' });
    assert.match(claim!.validity.premises.join(''), /不是运行的来源，不能作为期望值的依据/, 'the claim says what its words may not be used for');
    assert.deepEqual((await storedRun(run.run)).device_reads, claims, 'the record keeps them');
    assert.equal(run.device_help, undefined);
    assert.ok(!run.sources.some((source) => /[ab]{64}/.test(source.reference)), 'the device words are no source of the run: nothing can take them as an expected value');
    const text = toolText('start_run', detail.answer);
    assert.equal(text.split('设备输出仅供参考，不能作为原始用例的期望依据。').length, 2, 'said once');
    assert.match(text, /设备输出\npeers:\nname      address\npeer-1    192\.0\.2\.7(?:\n|$)/, 'the device output keeps its line breaks and its columns');
  });

  it('a device the lineage does not hold is never read: no predecessor, someone else\'s booking, a key outside the prefix', async () => {
    port = async (targets) => targets.map((t) => answered(t));
    read.length = 0;
    await book('meadow/dev/2', 's-read-2a');
    await add('toy-read-2', readProjection([entry('meadow/dev/2')]));
    const without = await start(h.alice, 'toy-read-2', 's-read-2b');
    assert.equal(without.answer.call_result, 'error');
    assert.equal(without.answer.errors[0]!.code, 'LEASE_UNAVAILABLE');
    assert.match(without.answer.errors[0]!.message, /不能往它发命令/);
    assert.match(without.answer.errors[0]!.fix ?? '', /predecessor/);
    const bobMap = await h.upload(h.bob, toyMap(standardDocument()));
    const bob = await h.service.startRunDetailed(h.bob, { pack: 'toy-read-2', inputs: { map: { reference: bobMap } } }, h.call('s-read-2c'));
    assert.equal(bob.answer.errors[0]!.code, 'LEASE_UNAVAILABLE');
    await add('toy-read-2o', readProjection([entry('river/dev/2')]));
    const outside = await start(h.alice, 'toy-read-2o', 's-read-2d');
    assert.equal(outside.answer.errors[0]!.code, 'LEASE_PREFIX');
    assert.deepEqual(read, [], 'the port was not reached');
  });

  it('a released booking cannot be read', async () => {
    port = async (targets) => targets.map((t) => answered(t));
    read.length = 0;
    const booking = await book('meadow/dev/3', 's-read-3a');
    await add('toy-release-r3', releaseProjection('meadow/dev/3'));
    const released = await start(h.alice, 'toy-release-r3', 's-read-3b', booking);
    assert.equal(released.answer.call_result, 'ok', JSON.stringify(released.answer.errors));
    await add('toy-read-3', readProjection([entry('meadow/dev/3')]));
    const late = await start(h.alice, 'toy-read-3', 's-read-3c', booking);
    assert.equal(late.answer.call_result, 'error');
    assert.ok(['LEASE_UNAVAILABLE', 'LEASE_EXPIRED'].includes(late.answer.errors[0]!.code), late.answer.errors[0]!.code);
    assert.deepEqual(read, []);
  });

  it('what could not be read is an unknown that names what is missing and the next step; the run still starts', async () => {
    read.length = 0;
    const booking = await book('meadow/dev/4', 's-read-4a');
    await add('toy-read-4', readProjection([entry('meadow/dev/4')]));
    port = async (targets) => targets.map((t) => ({ inventory: t.inventory, device: t.device, label: t.label, line: t.line, sent: false, answer: null, missing: { fact: `${t.label}：这台执行器没有声明可以按请求读设备`, next_action: '管理员加上声明后再读' } }));
    const refused = await start(h.alice, 'toy-read-4', 's-read-4b', booking);
    assert.equal(refused.answer.call_result, 'ok', JSON.stringify(refused.answer.errors));
    assert.equal(refused.answer.run!.device_reads!.length, 1);
    const [unknown] = refused.answer.run!.device_reads!;
    assert.equal(unknown!.qualifier.nature, 'unknown');
    assert.equal(unknown!.statement.verdict, 'unknown');
    assert.equal(unknown!.statement.reason, 'missing_input');
    assert.equal(unknown!.statement.text, '没有读设备：bed/meadow/dev/4：这台执行器没有声明可以按请求读设备。下一步：管理员加上声明后再读');
    assert.deepEqual([unknown!.statement.data?.line, unknown!.statement.data?.device, unknown!.statement.data?.sent], [LINE, '/devices/0', false]);
    assert.deepEqual(unknown!.grounds, []);
    assert.match(toolText('start_run', refused.answer), /没有读设备：bed\/meadow\/dev\/4：这台执行器没有声明可以按请求读设备。下一步：管理员加上声明后再读/);
    port = async () => { throw new Error('synthetic port failure'); };
    h.logs.length = 0;
    const broken = await start(h.alice, 'toy-read-4', 's-read-4c', booking);
    assert.equal(broken.answer.call_result, 'ok');
    assert.match(broken.answer.run!.device_reads![0]!.statement.text, /Hub 这次没能读设备/);
    assert.equal(broken.answer.run!.device_reads![0]!.statement.data?.line, LINE, 'the line as given');
    assert.ok(h.logs.some((l) => l.what === 'device_read' && /synthetic port failure/.test(l.detail)));
    assert.ok(!JSON.stringify(broken.answer).includes('synthetic port failure'), 'the cause is for the administrator');
  });

  it('a read that was sent and brought nothing presentable says so: an unknown with the next step, never a refusal', async () => {
    const booking = await book('meadow/dev/5', 's-read-5a');
    await add('toy-read-5', readProjection([entry('meadow/dev/5')]));
    port = async (targets) => targets.map((t) => ({ ...answered(t), answer: null, missing: { fact: '“inspect peers”这一读连续三次没有取得完整应答', next_action: '稍后再读一次' } }));
    const stopped = await start(h.alice, 'toy-read-5', 's-read-5b', booking);
    assert.equal(stopped.answer.call_result, 'ok', JSON.stringify(stopped.answer.errors));
    const [claim] = stopped.answer.run!.device_reads!;
    assert.equal(claim!.statement.text, '没有读成：“inspect peers”这一读连续三次没有取得完整应答。下一步：稍后再读一次');
    assert.deepEqual([claim!.qualifier.nature, claim!.statement.reason, claim!.statement.data?.sent], ['unknown', 'missing_input', true]);
    port = async (targets) => targets.map((t) => { const r = answered(t, null); return { ...r, answer: { ...r.answer!, anomaly: '设备输出的文本原件没有存下来', has_output: true }, missing: { fact: '“inspect peers”的输出没能存成原件，所以不呈现', next_action: '管理员检查本地存储后再读' } }; });
    const unstored = await start(h.alice, 'toy-read-5', 's-read-5c', booking);
    const [held] = unstored.answer.run!.device_reads!;
    assert.deepEqual([held!.qualifier.nature, held!.statement.reason], ['unknown', 'integrity_unproven']);
    assert.deepEqual(held!.grounds, [`src:${'a'.repeat(64)}`]);
    assert.equal(held!.statement.data?.output, undefined, 'nothing of the device is presented');
    assert.doesNotMatch(toolText('start_run', unstored.answer), /peer-1/);
  });

  it('no output, a held text and a cut text are each said in the observation', async () => {
    const booking = await book('meadow/dev/8', 's-read-8a');
    await add('toy-read-8', readProjection([entry('meadow/dev/8')]));
    port = async (targets) => targets.map((t) => answered(t, null));
    const silent = (await start(h.alice, 'toy-read-8', 's-read-8b', booking)).answer.run!.device_reads![0]!;
    assert.equal(silent.statement.text, '在 bed/meadow/dev/8 上读“inspect peers”：设备没有输出文字');
    assert.deepEqual([silent.qualifier.nature, silent.statement.data?.has_output, silent.statement.data?.output], ['fact', false, null]);
    port = async (targets) => targets.map((t) => { const r = answered(t); return { ...r, answer: { ...r.answer!, output: null, withheld: true } }; });
    const withheld = (await start(h.alice, 'toy-read-8', 's-read-8c', booking)).answer.run!.device_reads![0]!;
    assert.match(withheld.statement.text, /凭据扫描扣住了这一段，这里不引用；管理员能在原件里看/);
    assert.deepEqual([withheld.statement.data?.withheld, withheld.statement.data?.output], [true, null]);
    port = async (targets) => targets.map((t) => { const r = answered(t); return { ...r, answer: { ...r.answer!, truncated: true } }; });
    const cut = (await start(h.alice, 'toy-read-8', 's-read-8d', booking)).answer.run!.device_reads![0]!;
    assert.equal(cut.statement.text, '在 bed/meadow/dev/8 上读“inspect peers”：设备输出 3 行，这里只列了前一部分，全文见原件');
    assert.equal(cut.statement.data?.truncated, true);
  });

  it('control characters in the device words are written out in the answer; the record keeps the words as received', async () => {
    const raw = 'name\r\n\u001b[1mbold\u001b[0m\r\nend';
    port = async (targets) => targets.map((t) => answered(t, raw));
    const booking = await book('meadow/dev/7', 's-read-7a');
    await add('toy-read-7', readProjection([entry('meadow/dev/7')]));
    const detail = await start(h.alice, 'toy-read-7', 's-read-7b', booking);
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    assert.equal(detail.answer.run!.device_reads![0]!.statement.data?.output, raw, 'as received');
    assert.match(toolText('start_run', detail.answer), /\nname\n\\x1b\[1mbold\\x1b\[0m\nend(?:\n|$)/);
  });

  it('a pack that reads without declaring leases, or names more than one line, is refused before anything is read', async () => {
    read.length = 0;
    await add('toy-read-6', readProjection([entry('meadow/dev/6')]), false);
    const refused = await start(h.alice, 'toy-read-6', 's-read-6a');
    assert.equal(refused.answer.call_result, 'error');
    assert.match(refused.answer.errors[0]!.message, /没有声明 leases/);
    await add('toy-read-6b', readProjection([entry('meadow/dev/1'), entry('meadow/dev/1', { line: 'inspect units' })]));
    const two = await start(h.alice, 'toy-read-6b', 's-read-6b');
    assert.equal(two.answer.call_result, 'error', 'one line per run: the projection contract takes no batch');
    assert.deepEqual(read, []);
  });
});
