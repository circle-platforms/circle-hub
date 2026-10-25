import assert from 'node:assert/strict';
import { PROTOCOL_CODES } from '../../../contracts/generated/protocol.ts';
import { after, before, test } from 'node:test';
import { RunRecord } from '../../../contracts/src/run.ts';
import { StartRunOutput } from '../../../contracts/src/tools.ts';
import type { ActionBody } from '../../records/api.ts';
import { resolveReference, createDefaultRegistry, recognize } from '../../refs/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { sourceReader } from './readers.ts';
import { INDEX } from './store.ts';
import { openHarness, sandboxSkip, traceId, type Harness } from './testing/harness.ts';
import { ROOTS } from './testing/knowledge.ts';
import { ITEM, standardDocument, toyMap } from './testing/mindmap.ts';

let postgres: TemporaryPostgres;
let h: Harness;
let map: string;
const skip = await sandboxSkip();

before(async () => {
  postgres = await startPostgres();
  if (skip) return;
  h = await openHarness(postgres);
  map = await h.upload(h.alice, toyMap(standardDocument()));
});
after(async () => {
  await h?.close();
  await postgres?.stop();
});

const TRACE = '0af7651916cd43dd8448eb211c80319c';
const valid = (answer: object): void => {
  const checked = StartRunOutput.safeParse({ ...answer, trace: TRACE });
  assert.ok(checked.success, checked.success ? '' : JSON.stringify(checked.error.issues.slice(0, 3)));
};

test('a review run: target, sources, items, slots, the frozen record and the action', { skip }, async () => {
  const answer = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'PASTURE', version: '3.2', inputs: { map: { reference: map } }, parameters: { strict: true } }, h.call('sess-start'));
  valid(answer);
  assert.equal(answer.call_result, 'ok');
  const run = answer.run!;
  assert.equal(run.product, 'meadow');
  assert.equal(run.version, '3.2');
  assert.equal(run.build, 'Rel_MEADOW_3_2_9');
  assert.equal(run.root, ROOTS.meadow329);
  assert.equal(run.session, 'sess-start');
  // one basis claim each: the product named by the caller (declared), the build chosen by the product pack rule (projected)
  const [product, version, build] = run.target_basis;
  assert.deepEqual([product.statement.data?.field, product.qualifier.provenance, product.warrant.producer], ['product', 'declared', 'human']);
  assert.deepEqual([version.statement.data?.field, version.qualifier.provenance], ['version', 'declared']);
  assert.deepEqual([build.statement.data?.field, build.qualifier.provenance, build.warrant.producer], ['build', 'projected', 'function']);
  assert.deepEqual(build.statement.data?.alternatives, ['Rel_MEADOW_3_2_7']);
  assert.match(build.statement.text, /Rel_MEADOW_3_2_9/);
  assert.ok(build.validity.bound.includes(ROOTS.meadow329));
  // the input and the expected sources the pack bound: roles, labels, external ids with the revision read
  const roles = run.sources.map((s) => [s.role, s.external ?? s.slot]);
  assert.deepEqual(roles, [
    ['subject', 'map'],
    ['expected', 'toy:story:4021@1'],
    ['expected', 'toy:manual:zone@1'],
    ['hint', 'toy:history:zone-list@1'],
  ]);
  assert.equal(run.sources[1].label, '需求 4021 分区浇灌');
  // items: located in the bound source, fingerprinted, with the pack's summary
  assert.deepEqual(run.items.map((i) => i.id), [ITEM.c1, ITEM.c2, ITEM.c3, ITEM.c4]);
  const sha = map.slice('src:'.length);
  assert.equal(run.items[0].location, `src:${sha}/kityminder@1/n/c1aaaaaaaaaa`);
  assert.match(run.items[0].summary ?? '', /优先级 1/);
  assert.ok(run.items.every((i) => /^[0-9a-f]{64}$/.test(i.digest ?? '')));
  const located = await resolveReference(run.items[2].location, { reader: { user: h.alice.id, role: 'user' }, parsers: createDefaultRegistry(), sources: sourceReader(h.kit.artifacts, 'model') });
  assert.ok(located.resolved && located.text === '设置 9 区应报错');
  assert.deepEqual(run.items[2].fields.negative, true);
  assert.equal(run.requirements.find((r) => r.key === 'findings')?.repair_rounds, 2);
  assert.equal(run.instructions, h.review.instructions);
  assert.equal(run.instructions_digest, h.review.instructionsDigest);
  assert.ok(run.slots);
  // the run record is the summary plus the runner, host, trigger, frozen parameters and groups
  const stored = await h.kit.store.find<RunRecord>({ key: INDEX.runId, value: run.run, kind: 'run' });
  const record = RunRecord.parse(stored.items[0].body);
  assert.deepEqual([record.runner, record.host, record.trigger], [h.alice.id, 'local_circle', 'session']);
  assert.deepEqual(record.parameters, { strict: true });
  assert.deepEqual(record.groups?.map((g) => g.text), ['基本功能', '异常']);
  // the source no resource could read is recorded as unavailable; the real reason is only in the admin log
  const actions = await h.kit.store.find<ActionBody>({ key: INDEX.actionRun, value: run.run, kind: 'action' });
  const parse = actions.items.find((a) => a.body.action === 'parse')!;
  assert.deepEqual(parse.body.detail.unavailable, [{ external: 'toy:broken:offline', role: 'expected', reason: '对你不可用' }]);
  const internalReason = 'synthetic system answered 404 for toy:broken:offline';
  assert.ok(h.logs.some((l) => l.run === run.run && l.detail === internalReason));
  assert.ok(!JSON.stringify(parse.body).includes(internalReason), 'opaque references may contain 404; the internal reason stays private');
  // reads used the caller's principal
  assert.ok(h.external.reads.filter((r) => r.id.startsWith('toy:story')).every((r) => r.principal === h.alice.id));
});

test('a declared build of the second name family locks the root of the build it is based on', { skip }, async () => {
  const answer = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'meadow', build: 'rel_pasture_3_2_9', inputs: { map: { reference: map } } }, h.call());
  assert.equal(answer.call_result, 'ok');
  const run = answer.run!;
  assert.equal(run.build, 'rel_pasture_3_2_9');
  assert.equal(run.root, ROOTS.meadow329);
  const build = run.target_basis.find((c) => c.statement.data?.field === 'build')!;
  assert.deepEqual([build.qualifier.provenance, build.statement.data?.base], ['declared', 'Rel_MEADOW_3_2_9']);
  assert.equal(run.target_basis.find((c) => c.statement.data?.field === 'version')?.qualifier.provenance, 'projected');
});

test('without select_build the newest released build of the line with a root is chosen, with alternatives', { skip }, async () => {
  const answer = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Grove', inputs: { map: { reference: map } } }, h.call());
  assert.equal(answer.call_result, 'ok');
  const run = answer.run!;
  assert.equal(run.build, 'Rel_GROVE_1_0_4');
  assert.equal(run.root, ROOTS.grove104);
  const build = run.target_basis.find((c) => c.statement.data?.field === 'build')!;
  assert.equal(build.warrant.id, 'runs.newest_released@1');
  assert.deepEqual(build.statement.data?.alternatives, ['Rel_GROVE_1_0_2']);
});

test('an unknown build, a build of another line, a build or line without a root, and an ambiguous product are refused with options', { skip }, async () => {
  const start = (extra: Record<string, unknown>) => h.service.startRun(h.alice, { pack: 'toy-review', inputs: { map: { reference: map } }, ...extra }, h.call());
  const unknownBuild = await start({ product: 'Meadow', build: 'Rel_MEADOW_9_9_9' });
  valid(unknownBuild);
  assert.equal(unknownBuild.errors[0].code, 'REFERENCE_UNRESOLVED');
  assert.equal(unknownBuild.errors[0].path, '/build');
  assert.ok(unknownBuild.errors[0].options?.includes('Rel_MEADOW_3_2_9'));
  const otherLine = await start({ product: 'Meadow', version: '3.3', build: 'Rel_MEADOW_3_2_7' });
  assert.equal(otherLine.errors[0].code, 'REFERENCE_UNRESOLVED');
  const noRoot = await start({ product: 'Meadow', build: 'Rel_MEADOW_3_1_5' });
  assert.match(noRoot.errors[0].message, /还没有知识根/);
  const lineWithoutRoot = await start({ product: 'Meadow', version: '3.1' });
  assert.equal(lineWithoutRoot.errors[0].path, '/version');
  assert.deepEqual(lineWithoutRoot.errors[0].options, ['Rel_MEADOW_3_1_5']);
  const ambiguous = await start({});
  assert.equal(ambiguous.errors[0].path, '/product');
  assert.deepEqual(ambiguous.errors[0].options, ['Meadow', 'Pasture', 'Grove']);
  const unknownProduct = await start({ product: 'Orchard' });
  assert.equal(unknownProduct.errors[0].code, 'REFERENCE_UNRESOLVED');
  assert.equal(unknownProduct.run, undefined);
});

test('absent and forbidden look the same: an unknown pack and an unassigned pack give one answer', { skip }, async () => {
  const before = h.logs.length;
  const unknown = await h.service.startRun(h.alice, { pack: 'no-such-pack', inputs: {} }, h.call());
  const unassigned = await h.service.startRun(h.bob, { pack: 'toy-review', inputs: { map: { reference: map } } }, h.call());
  assert.deepEqual(unknown, unassigned);
  assert.deepEqual(unknown, { call_result: 'error', errors: [{ code: 'SOURCE_UNAVAILABLE', message: '对你不可用', fix: PROTOCOL_CODES.SOURCE_UNAVAILABLE.fix, path: '/pack' }] });
  valid(unknown);
  assert.equal(h.logs.length, before + 2);
  // a predecessor the caller may not see is unavailable too
  const theirs = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', inputs: { map: { reference: map } }, predecessor: 'run_01m5h9zh07x7amhg4bwmye5yhw' }, h.call());
  assert.deepEqual(theirs.errors.map((e) => [e.code, e.path]), [['SOURCE_UNAVAILABLE', '/predecessor']]);
});

test('inputs: required slots, unknown slots, accepted types, readable references, whole sources', { skip }, async () => {
  const start = (inputs: Record<string, unknown>) => h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', inputs: inputs as never }, h.call());
  const missing = await start({});
  assert.deepEqual(missing.errors.map((e) => [e.code, e.path]), [['SUBMISSION_SCHEMA_VIOLATION', '/inputs/map']]);
  const extra = await start({ map: { reference: map }, other: { reference: map } });
  assert.deepEqual(extra.errors.map((e) => e.path), ['/inputs/other']);
  const text = await h.upload(h.alice, new TextEncoder().encode('just text'), 'text/plain');
  const wrongType = await start({ map: { reference: text } });
  assert.match(wrongType.errors[0].message, /不接受媒体类型 text\/plain/);
  const bobs = await h.upload(h.bob, toyMap({ ...standardDocument(), id: 'docbob' }));
  const forbidden = await start({ map: { reference: bobs } });
  assert.deepEqual(forbidden.errors.map((e) => [e.code, e.path]), [['SOURCE_UNAVAILABLE', '/inputs/map']]);
  const fragment = await start({ map: { reference: `${map}/kityminder@1/n/c1aaaaaaaaaa` } });
  assert.match(fragment.errors[0].message, /整份源文件/);
  const many = await start({ map: [{ reference: map }, { reference: map }] });
  assert.match(many.errors[0].message, /只接受一个/);
  const notMap = await h.upload(h.alice, new TextEncoder().encode('{"not":"a map"}'));
  // parsed by the core JSON parser, then refused by the pack's projection with its own code
  const refused = await start({ map: { reference: notMap } });
  assert.deepEqual(refused.errors.map((e) => [e.code, e.path]), [['toy-review.invalid_input', '/inputs/map']]);
  assert.match(refused.errors[0].message, /不是脑图/);
  const garbageBytes=new TextEncoder().encode('{ not json');
  let parserFix:string|undefined;
  recognize(createDefaultRegistry(),garbageBytes,'application/json',{},error=>{parserFix=error.fix;});
  assert.ok(parserFix,'the refusing parser supplies the remedy');
  const garbage = await h.upload(h.alice, garbageBytes);
  const unparsed = await start({ map: { reference: garbage } });
  assert.deepEqual(unparsed.errors.map((e) => [e.code, e.path]), [['SOURCE_UNPARSEABLE', '/inputs/map']]);
  assert.match(unparsed.errors[0].message, /json@1.*不是有效的 JSON/);
  assert.equal(unparsed.errors[0].fix, parserFix);
  // a slot that takes many sources binds each with the slot's role
  const one = await h.upload(h.alice, new TextEncoder().encode('# 历史清单一\n\n设置 2 区浇灌。\n'), 'text/markdown');
  const two = await h.upload(h.alice, new TextEncoder().encode('历史清单二：查看分区。\n'), 'text/plain');
  const notes = await start({ map: { reference: map }, notes: [{ reference: one }, { reference: two }] });
  assert.equal(notes.call_result, 'ok', JSON.stringify(notes.errors));
  assert.deepEqual(notes.run!.sources.filter((s) => s.slot === 'notes').map((s) => [s.reference, s.role, s.media_type]), [
    [one, 'hint', 'text/markdown'],
    [two, 'hint', 'text/plain'],
  ]);
  const badNote = await start({ map: { reference: map }, notes: [{ reference: one }, { reference: bobs }] });
  assert.deepEqual(badNote.errors.map((e) => [e.code, e.path]), [['SOURCE_UNAVAILABLE', '/inputs/notes/1']]);
});

test('an external object input is read as the caller; its meta is handed to the projection', { skip }, async () => {
  const answer = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', inputs: { map: { external: 'toy:mindmap:docq7' } } }, h.call());
  assert.equal(answer.call_result, 'ok');
  const run = answer.run!;
  assert.deepEqual([run.sources[0].external, run.sources[0].label], ['toy:mindmap:docq7@1', '分区浇灌用例']);
  assert.ok(h.external.reads.some((r) => r.id === 'toy:mindmap:docq7' && r.principal === h.alice.id));
  const wrong = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', inputs: { map: { external: 'toy:story:4021' } } }, h.call());
  assert.match(wrong.errors[0].message, /不接受 toy:story 类型/);
  const missing = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', inputs: { map: { external: 'toy:mindmap:gone' } } }, h.call());
  assert.deepEqual(missing.errors.map((e) => e.code), ['SOURCE_UNAVAILABLE']);
});

test('parameters are checked against the workflow and frozen', { skip }, async () => {
  const start = (parameters: Record<string, unknown>) => h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', inputs: { map: { reference: map } }, parameters }, h.call());
  assert.deepEqual((await start({ strict: 'yes' })).errors.map((e) => e.path), ['/parameters/strict']);
  assert.deepEqual((await start({ unknown: 1 })).errors.map((e) => e.path), ['/parameters/unknown']);
  assert.equal((await start({ strict: false })).call_result, 'ok');
});

test('a projection that yields no item refuses the whole start_run with the pack fix', { skip }, async () => {
  const outline = await h.upload(h.alice, toyMap({ id: 'docout', title: '只有提纲', groups: [{ id: 'g1outline000', text: '提纲', cases: [] }] }));
  const answer = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', inputs: { map: { reference: outline } } }, h.call());
  valid(answer);
  assert.deepEqual(answer.errors, [{ code: 'toy-review.no_case', message: '文档里没有用例节点（docout）', fix: '给用例节点加上 resource 标签', path: '/inputs/map' }]);
  assert.equal(answer.run, undefined);
});

test('a client key returns the same run inside its window; other content is IDEMPOTENCY_MISMATCH; an expired key starts a new run', { skip }, async () => {
  const request = { pack: 'toy-review', product: 'Meadow', inputs: { map: { reference: map } }, client_key: 'key-1' };
  const first = await h.service.startRun(h.alice, request, h.call());
  const again = await h.service.startRun(h.alice, request, h.call('another-session'));
  assert.equal(again.run?.run, first.run?.run);
  assert.deepEqual(again, first);
  const changed = await h.service.startRun(h.alice, { ...request, parameters: { strict: true } }, h.call());
  assert.deepEqual(changed.errors.map((e) => [e.code, e.path]), [['IDEMPOTENCY_MISMATCH', '/client_key']]);
  // another user's key is another key
  h.workflows.assign(h.bob.id, 'toy-review');
  const bobMap = await h.upload(h.bob, toyMap(standardDocument()));
  const bob = await h.service.startRun(h.bob, { ...request, inputs: { map: { reference: bobMap } } }, h.call());
  assert.notEqual(bob.run?.run, first.run?.run);
  h.workflows.unassign(h.bob.id, 'toy-review');
  h.advance(24 * 60 * 60 * 1000 + 1);
  const later = await h.service.startRun(h.alice, request, h.call());
  assert.equal(later.call_result, 'ok');
  assert.notEqual(later.run?.run, first.run?.run);
  const stored = await h.kit.store.find<RunRecord>({ key: INDEX.runId, value: later.run!.run, kind: 'run' });
  assert.equal(stored.items[0].body.client_key, 'key-1');
});

test('the Hub executes only packs whose requirements are all facts; its runs are visible to admins only', { skip }, async () => {
  const refused = await h.service.startHubRun(h.admin, { pack: 'toy-review', product: 'Meadow', inputs: { map: { reference: map } } }, h.call(null));
  assert.match(refused.answer.errors[0].message, /W09 R\[3\]/);
  const notAdmin = await h.service.startHubRun(h.alice, { pack: 'toy-locate', inputs: { map: { reference: map } } }, h.call(null));
  assert.deepEqual(notAdmin.answer.errors.map((e) => e.code), ['SOURCE_UNAVAILABLE']);
  const adminMap = await h.upload(h.admin, toyMap(standardDocument()));
  const hub = await h.service.startHubRun(h.admin, { pack: 'toy-locate', inputs: { map: { reference: adminMap } } }, h.call(null));
  assert.equal(hub.answer.call_result, 'ok');
  assert.ok(hub.production);
  const id = hub.answer.run!.run;
  const record = (await h.service.getRun(h.admin, id))!.run;
  assert.deepEqual([record.host, record.trigger, record.runner, record.configurer], ['hub', 'standing_obligation', undefined, h.admin.id]);
  assert.equal(await h.service.getRun(h.alice, id), null);
  assert.ok(!(await h.service.listRuns(h.alice)).items.some((r) => r.run === id));
  assert.ok((await h.service.listRuns(h.admin)).items.some((r) => r.run === id));
});

test('malformed arguments are refused with paths, and a valid answer always matches the tool output schema', { skip }, async () => {
  const bad = await h.service.startRun(h.alice, { pack: '', inputs: {} } as never, { traceId: traceId(), sessionId: null });
  valid(bad);
  assert.equal(bad.errors[0].code, 'SUBMISSION_SCHEMA_VIOLATION');
  assert.equal(bad.errors[0].path, '/pack');
});

test('arguments the records cannot hold are refused at their path before anything is read or stored', { skip }, async () => {
  const runs = async () => (await h.service.listRuns(h.alice, { limit: 500 })).items.length;
  const before = { runs: await runs(), reads: h.external.reads.length };
  const base = { pack: 'toy-review', product: 'Meadow', inputs: { map: { external: 'toy:mindmap:docq7' } } };
  const cases: [string, Record<string, unknown>, string][] = [
    ['a client key with NUL', { ...base, client_key: 'key\u0000one' }, '/client_key'],
    ['a client key with a lone surrogate', { ...base, client_key: 'key\ud800' }, '/client_key'],
    ['a parameter with a lone surrogate', { ...base, parameters: { strict: 'x\ud800y' } }, '/parameters/strict'],
    ['an unknown key with a lone surrogate', { ...base, ['x\ud800']: 1 }, ''],
  ];
  for (const [name, input, path] of cases) {
    const answer = await h.service.startRun(h.alice, input as never, h.call());
    valid(answer);
    assert.deepEqual(answer.errors.map((e) => [e.code, e.path]), [['SUBMISSION_SCHEMA_VIOLATION', path]], name);
    assert.ok(!JSON.stringify(answer).includes('\\ud800'), `${name}: the bad text is not echoed`);
  }
  assert.deepEqual({ runs: await runs(), reads: h.external.reads.length }, before, 'no external read, no run');
});

test('a repeated client key inside its window returns the run even after the pack was unassigned (D05 R[5])', { skip }, async () => {
  h.workflows.assign(h.bob.id, 'toy-review');
  const bobMap = await h.upload(h.bob, toyMap(standardDocument()));
  const request = { pack: 'toy-review', product: 'Meadow', inputs: { map: { reference: bobMap } }, client_key: 'retry-1' };
  const first = await h.service.startRun(h.bob, request, h.call());
  assert.equal(first.call_result, 'ok', JSON.stringify(first.errors));
  h.workflows.unassign(h.bob.id, 'toy-review');
  const again = await h.service.startRun(h.bob, request, h.call());
  assert.deepEqual(again, first);
  assert.ok(await h.service.getRun(h.bob, first.run!.run));
  // other content under the key is still a mismatch; a fresh start needs the pack
  assert.deepEqual((await h.service.startRun(h.bob, { ...request, parameters: { strict: true } }, h.call())).errors.map((e) => e.code), ['IDEMPOTENCY_MISMATCH']);
  assert.deepEqual((await h.service.startRun(h.bob, { ...request, client_key: 'retry-2' }, h.call())).errors.map((e) => [e.code, e.path]), [['SOURCE_UNAVAILABLE', '/pack']]);
});

test('the target composition and canonical build are passed to input and expected-source reads before the run is stored', {skip}, async()=>{
  const read=h.external.read.bind(h.external),resolve=h.knowledge.rootOfBuild.bind(h.knowledge),contexts:Array<{composition?:string|null;build?:string}> = [];
  let selected:string|null=null;
  h.knowledge.rootOfBuild=async(product,name)=>{const root=await resolve(product,name);selected=root?.composition??null;return root;};
  h.external.read=async(id,context)=>{contexts.push(context);return read(id,context);};
  try{
    const answer=await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',inputs:{map:{external:'toy:mindmap:docq7'}}},h.call());
    assert.equal(answer.call_result,'ok');assert.ok(selected);assert.ok(contexts.length>1);assert.ok(contexts.every(context=>context.composition===selected));assert.ok(contexts.every(context=>context.build===answer.run!.build));
  }finally{h.external.read=read;h.knowledge.rootOfBuild=resolve;}
});
