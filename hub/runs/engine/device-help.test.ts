import { MemberEnvironments } from '../../dispatch/member-environments.ts';
import { ExecutorRegistry } from '../../dispatch/executors.ts';
import { definition as executorDefinition } from '../../dispatch/testing/definition.ts';
import { canUseEnvironment } from '../../records/environment-permissions.ts';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { DeviceHelpResult, DeviceHelpTarget } from '../../../contracts/src/pack.ts';
import type { RunRecord } from '../../../contracts/src/run.ts';
import { toolText } from '../../server/text.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { INDEX } from './store.ts';
import { openHarness, sandboxSkip, type Harness } from './testing/harness.ts';
import { standardDocument, toyMap } from './testing/mindmap.ts';
import { writePack, type PackSpec } from './testing/packs.ts';

const skip = await sandboxSkip();
const INVENTORY = 'e'.repeat(64);
const WORDS = '<1-9>   a number\n<cr>';

let postgres: TemporaryPostgres;
let h: Harness;
let environments: MemberEnvironments;
let map: string;
let packRoot: string;
const asked: Array<{ user: string; run: string; targets: DeviceHelpTarget[] }> = [];
let port: (targets: ReadonlyArray<DeviceHelpTarget>) => Promise<DeviceHelpResult[]>;

const described = (target: DeviceHelpTarget): DeviceHelpResult => ({
  inventory: target.inventory, device: target.device, label: target.label, line: 'widget set demo 5', mode: null, words: 4,
  positions: [
    { prefix: 'widget set demo 5', words: 4, next_word: null, described: false, caret_only: true, text: null, truncated: false, withheld: false, anomaly: null, observed_at: '2026-10-22T08:00:31.000Z', reference: `src:${'a'.repeat(64)}`, text_reference: null },
    { prefix: 'widget set demo', words: 3, next_word: '5', described: true, caret_only: false, text: WORDS, truncated: false, withheld: false, anomaly: null, observed_at: '2026-10-22T08:00:32.000Z', reference: `src:${'b'.repeat(64)}`, text_reference: `src:${'c'.repeat(64)}` },
  ],
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
const askProjection = (entries: unknown[]): string => `export default function project(_input: unknown): unknown {
  return { items: [], warnings: [], ask: ${JSON.stringify(entries)} };
}
`;
const entry = (key: string, extra: Record<string, unknown> = {}) => ({ inventory: INVENTORY, device: '/devices/0', label: `bed/${key}`, line: 'widget set demo 5', keys: [key], ...extra });

const ECHO_SUBJECT = `export default function subject(_input: unknown): unknown { return { items: [], context: {} }; }
`;
const ECHO_CHECK = `export default function echo(_input: unknown): unknown {
  return [{ verdict: 'support', statement: '探针（合成）', grounds: [], tier: 'advisory' }];
}
`;

function pack(id: string, projection: string, declare = true): PackSpec {
  return {
    id, version: '1.0.0', kind: 'workflow', title: `合成问设备包 ${id}`, description: '问设备接线（合成）',
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
      'SKILL.md': '# 合成问设备包\n\n探测用。\n',
      'functions/project.ts': projection,
      'functions/echo.ts': ECHO_CHECK,
      'functions/subject.ts': ECHO_SUBJECT,
    },
  };
}

before(async () => {
  if (skip) return;
  postgres = await startPostgres();
  h = await openHarness(postgres, { leases: true, environmentAccess: { authorizeKeys: (actor, keys) => environments.authorizeKeys(actor, keys) }, observations: {
    latest: async () => [],
    observe: async () => ({ observed: [], missing: null }),
    ask: async (user, run, targets) => { asked.push({ user: user.id, run, targets: [...targets] }); return port(targets); },
  } });
  const registry = new ExecutorRegistry(h.kit);
  const environment = await registry.add(h.admin, {
    ...executorDefinition('http://127.0.0.1:1/mcp'), target: 'synthetic-device-help',
    resources: ['meadow/dev/1', 'meadow/dev/2', 'meadow/dev/3', 'meadow/dev/4', 'meadow/dev/5', 'meadow/dev/7'],
  });
  for (const actor of [h.alice, h.bob]) await h.kit.authorizations.assignResource(h.admin, environment.id, actor.id);
  environments = new MemberEnvironments(h.kit, registry, h.leases!, (actor, id) => canUseEnvironment(h.kit, actor, id));
  map = await h.upload(h.alice, toyMap(standardDocument()));
  packRoot = await mkdtemp(join(tmpdir(), 'circle-hub-device-help-'));
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

describe('a run that asks the devices its lineage holds', { skip }, () => {
  it('hands the port what the projection named, records the answers as claims and shows the device words as received', async () => {
    port = async (targets) => targets.map(described);
    asked.length = 0;
    const booking = await book('meadow/dev/1', 's-help-1a');
    await add('toy-ask-1', askProjection([entry('meadow/dev/1')]));
    const detail = await start(h.alice, 'toy-ask-1', 's-help-1b', booking);
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    const run = detail.answer.run!;
    assert.deepEqual(asked.map((a) => [a.user, a.run, a.targets]), [[h.alice.id, run.run, [entry('meadow/dev/1')]]], 'asked once, for what the projection named, after the checks');
    const claims = run.device_help!;
    assert.deepEqual(claims.map((c) => c.statement.data?.kind), ['summary', 'position', 'position']);
    assert.equal(claims[0]!.statement.text, 'bed/meadow/dev/1 上问“widget set demo 5”：设备给出说明的最长前缀是“widget set demo”；它后面的词是“5”，设备在“widget set demo 5 ?”处没有给出说明（设备只回了一个插入符，没有文字）');
    assert.equal(claims[1]!.statement.data?.help, null);
    assert.equal(claims[2]!.statement.data?.help, WORDS, 'the words as received, the lines kept');
    assert.deepEqual(claims[2]!.grounds, [`src:${'b'.repeat(64)}`, `src:${'c'.repeat(64)}`], 'the stored answer and the text the model may read');
    for (const claim of claims) assert.ok(claim.qualifier.marks.includes('target_reported') && claim.qualifier.marks.includes('local_ops_not_excluded'), claim.statement.text);
    assert.deepEqual(claims.slice(1).map((c) => [c.qualifier.nature, c.qualifier.provenance, c.qualifier.collected_at]), [['fact', 'observed', '2026-10-22T08:00:31.000Z'], ['fact', 'observed', '2026-10-22T08:00:32.000Z']]);
    assert.deepEqual((await storedRun(run.run)).device_help, claims, 'the record keeps them');
    assert.ok(!run.sources.some((source) => /[abc]{64}/.test(source.reference)), 'the device words are no source of the run: nothing can take them as an expected value');
    const text = toolText('start_run', detail.answer);
    assert.match(text, /设备输出\n/);
    assert.match(text, /\n<1-9>   a number\n<cr>(?:\n|$)/, 'the device output keeps its line breaks');
  });

  it('a device the lineage does not hold is never asked: no predecessor, someone else\'s booking, a key outside the prefix', async () => {
    port = async (targets) => targets.map(described);
    asked.length = 0;
    await book('meadow/dev/2', 's-help-2a');
    await add('toy-ask-2', askProjection([entry('meadow/dev/2')]));
    const without = await start(h.alice, 'toy-ask-2', 's-help-2b');
    assert.equal(without.answer.call_result, 'error');
    assert.equal(without.answer.errors[0]!.code, 'LEASE_UNAVAILABLE');
    assert.match(without.answer.errors[0]!.fix ?? '', /predecessor/);
    const bobMap = await h.upload(h.bob, toyMap(standardDocument()));
    const bob = await h.service.startRunDetailed(h.bob, { pack: 'toy-ask-2', inputs: { map: { reference: bobMap } } }, h.call('s-help-2c'));
    assert.equal(bob.answer.errors[0]!.code, 'LEASE_UNAVAILABLE');
    await add('toy-ask-2o', askProjection([entry('river/dev/2')]));
    const outside = await start(h.alice, 'toy-ask-2o', 's-help-2d');
    assert.equal(outside.answer.errors[0]!.code, 'LEASE_PREFIX');
    assert.deepEqual(asked, [], 'the port was not reached');
  });

  it('a released booking cannot be asked', async () => {
    port = async (targets) => targets.map(described);
    asked.length = 0;
    const booking = await book('meadow/dev/3', 's-help-3a');
    await add('toy-release-3', releaseProjection('meadow/dev/3'));
    const released = await start(h.alice, 'toy-release-3', 's-help-3b', booking);
    assert.equal(released.answer.call_result, 'ok', JSON.stringify(released.answer.errors));
    await add('toy-ask-3', askProjection([entry('meadow/dev/3')]));
    const late = await start(h.alice, 'toy-ask-3', 's-help-3c', booking);
    assert.equal(late.answer.call_result, 'error');
    assert.ok(['LEASE_UNAVAILABLE', 'LEASE_EXPIRED'].includes(late.answer.errors[0]!.code), late.answer.errors[0]!.code);
    assert.deepEqual(asked, []);
  });

  it('what could not be asked is an unknown that names what is missing and the next step; the run still starts', async () => {
    asked.length = 0;
    const booking = await book('meadow/dev/4', 's-help-4a');
    await add('toy-ask-4', askProjection([entry('meadow/dev/4')]));
    port = async (targets) => targets.map((t) => ({ inventory: t.inventory, device: t.device, label: t.label, line: '', mode: null, words: 0, positions: [], missing: { fact: `${t.label}：目标这一版没有认证`, next_action: '管理员登记认证后再问' } }));
    const refused = await start(h.alice, 'toy-ask-4', 's-help-4b', booking);
    assert.equal(refused.answer.call_result, 'ok', JSON.stringify(refused.answer.errors));
    const [unknown] = refused.answer.run!.device_help!;
    assert.equal(refused.answer.run!.device_help!.length, 1);
    assert.equal(unknown!.qualifier.nature, 'unknown');
    assert.equal(unknown!.statement.verdict, 'unknown');
    assert.equal(unknown!.statement.reason, 'missing_input');
    assert.equal(unknown!.statement.text, '没有向设备问：bed/meadow/dev/4：目标这一版没有认证。下一步：管理员登记认证后再问');
    assert.deepEqual(unknown!.grounds, []);
    assert.match(toolText('start_run', refused.answer), /没有向设备问：bed\/meadow\/dev\/4：目标这一版没有认证。下一步：管理员登记认证后再问/);
    // A port that throws is the same: an unknown, a line in the administrator's log, a run that starts.
    port = async () => { throw new Error('synthetic port failure'); };
    h.logs.length = 0;
    const broken = await start(h.alice, 'toy-ask-4', 's-help-4c', booking);
    assert.equal(broken.answer.call_result, 'ok');
    assert.match(broken.answer.run!.device_help![0]!.statement.text, /Hub 这次没能向设备问/);
    assert.equal(broken.answer.run!.device_help![0]!.statement.data?.line, 'widget set demo 5', 'the line as given');
    assert.ok(h.logs.some((l) => l.what === 'device_help' && /synthetic port failure/.test(l.detail)));
    assert.ok(!JSON.stringify(broken.answer).includes('synthetic port failure'), 'the cause is for the administrator');
  });

  it('a questioning that stopped says where: the positions asked, then an unknown with the next step', async () => {
    port = async (targets) => targets.map((t) => ({ ...described(t), positions: [described(t).positions[0]!], missing: { fact: '对“widget set demo”的这一问连续三次没有取得完整应答，不再往下问', next_action: '稍后再问一次' } }));
    const booking = await book('meadow/dev/5', 's-help-5a');
    await add('toy-ask-5', askProjection([entry('meadow/dev/5')]));
    const detail = await start(h.alice, 'toy-ask-5', 's-help-5b', booking);
    const claims = detail.answer.run!.device_help!;
    assert.deepEqual(claims.map((c) => c.statement.data?.kind ?? 'stopped'), ['summary', 'position', 'stopped']);
    assert.equal(claims[0]!.statement.text, 'bed/meadow/dev/5 上问“widget set demo 5”：问了 1 个位置，最短的“widget set demo 5 ?”处设备也没有给出说明');
    assert.equal(claims[2]!.qualifier.nature, 'unknown');
    assert.match(claims[2]!.statement.text, /没有问完：对“widget set demo”的这一问连续三次没有取得完整应答，不再往下问。下一步：稍后再问一次/);
  });

  it('control characters in the device words are written out in the answer; the record keeps the words as received', async () => {
    const raw = 'name\r\n\u001b[1mbold\u001b[0m\r\n<cr>';
    port = async (targets) => targets.map((t) => { const r = described(t); return { ...r, positions: [{ ...r.positions[1]!, text: raw }] }; });
    const booking = await book('meadow/dev/7', 's-help-7a');
    await add('toy-ask-7', askProjection([entry('meadow/dev/7')]));
    const detail = await start(h.alice, 'toy-ask-7', 's-help-7b', booking);
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    const claims = detail.answer.run!.device_help!;
    assert.equal(claims.at(-1)!.statement.data?.help, raw, 'as received');
    assert.equal(claims[0]!.statement.text, 'bed/meadow/dev/7 上问“widget set demo 5”：设备给出说明的最长的被问前缀是“widget set demo”（比它长的前缀没有问）');
    assert.match(toolText('start_run', detail.answer), /\nname\n\\x1b\[1mbold\\x1b\[0m\n<cr>(?:\n|$)/);
  });

  it('a pack that asks without declaring leases is refused before anything is asked', async () => {
    asked.length = 0;
    await add('toy-ask-6', askProjection([entry('meadow/dev/6')]), false);
    const refused = await start(h.alice, 'toy-ask-6', 's-help-6a');
    assert.equal(refused.answer.call_result, 'error');
    assert.match(refused.answer.errors[0]!.message, /没有声明 leases/);
    assert.deepEqual(asked, []);
  });
});
