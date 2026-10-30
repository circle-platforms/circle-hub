import {createTestParserRegistry as createDefaultRegistry} from '../testing/parsers.ts';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {KnowledgeContributionView} from '../../contracts/src/contributions.ts';
import {RunRecord} from '../../contracts/src/run.ts';
import {KnowledgeStructureSchema} from '../../contracts/src/feeding.ts';
import {startPostgres, type TemporaryPostgres} from '../testing/postgres.ts';
import {makeWorld, catalogXml, BASE_CATALOG} from './test-support.ts';
import {createRunsService} from '../runs/engine/api.ts';
import {putRun} from '../runs/engine/store.ts';
import {manifestDigest} from '../runs/api.ts';
import {FakeWorkflowStore} from '../runs/engine/testing/workflows.ts';
import {toolText} from '../server/text.ts';
import {RECORD_SCHEMAS, scanForCredentials, sha256Hex} from '../records/api.ts';
import {newId} from '../records/ids.ts';
import {osIsolationAvailable} from '../rules/api.ts';
import {FROZEN_KNOWLEDGE_CONTRIBUTION, copyFrozenKnowledgeContribution} from './testing/frozen/knowledge-contribution.ts';

const skip = (await osIsolationAvailable()) ? false : 'no OS network isolation on this machine (sandbox-exec)';
const call = {traceId:'4bf92f3577b34da6a3ce929d0e0e4736', sessionId:'operation-session'};
let trace = 100;
let captureSequence = 0;
const diagnostics: string[] = [];
const nextCall = () => ({...call, traceId:(++trace).toString(16).padStart(32, '0'), adminNote:(reason:string) => { diagnostics.push(reason); }});
const echo = '合成回显：状态正常\n';
const quote = '合成回显';
const path = '/commands/system/show';
let postgres: TemporaryPostgres;
before(async () => { postgres = await startPostgres(); });
after(async () => { await postgres?.stop(); });

async function world(t: {after(fn: () => Promise<void>): void}, packDirectory?: string) {
  const w = await makeWorld(postgres); t.after(() => w.close());
  const build = {name:'Rel_ACME_1_2_15', family:'ACME', line:'1.2', base:'Rel_ACME_1_2_15', platform:null, built_at:'2026-01-02T10:00:00.000Z', released_at:'2026-01-03T10:00:00.000Z', sources:{tree:'site:tree:Rel_ACME_1_2_15'}, root:null};
  w.external.set(build.sources.tree, {bytes:new TextEncoder().encode(catalogXml(BASE_CATALOG)), mediaType:'application/xml'});
  const produced = await w.knowledge.produceTree({product:w.product, build});
  assert.ok(produced.ok, produced.reason ?? '');
  const workflows = new FakeWorkflowStore();
  await workflows.add(packDirectory ?? fileURLToPath(new URL('../../packs/workflow/knowledge-contribution/', import.meta.url)));
  workflows.assign(w.user.id, 'knowledge-contribution');
  const service = createRunsService({records:w.kit, packs:w.packs, knowledge:w.knowledge, external:w.external, workflows, parsers:createDefaultRegistry()});
  const manifest = await w.kit.artifacts.ingest({bytes:new TextEncoder().encode(JSON.stringify({items:[{id:'assertion', title:'assertion'}]})), mediaType:'application/json', origin:{upload:{session:'operation-session', message:null}}, author:{user:w.admin.id}, provenanceType:'declared', visibility:{readers:[w.admin.id], admins:true, packs:[], shareable:false}});
  const captured = await w.kit.artifacts.ingest({bytes:new TextEncoder().encode(echo), mediaType:'text/plain', origin:{upload:{session:'operation-session', message:null}}, author:{user:w.admin.id}, provenanceType:'client_captured', visibility:{readers:[w.admin.id], admins:true, packs:[], shareable:false}});
  const composition = produced.composition!;
  const original = (await w.knowledge.store.composition(composition))!.sources[0].sha256;
  const started = await service.startRun(w.admin, {pack:'knowledge-contribution', product:'Acme', build:build.name, inputs:{subject:{reference:`src:${manifest.body.sha256}`}, originals:[{reference:`src:${original}`}, {reference:`src:${captured.body.sha256}`}]}}, call);
  assert.equal(started.call_result, 'ok', JSON.stringify(started.errors));
  const run = RunRecord.parse((await service.getRun(w.admin, started.run!.run))!.run);
  return {w, service, run, root: produced.root!, sha: captured.body.sha256, build};
}

type Context = Awaited<ReturnType<typeof world>> & {capture?: {digest:string}};

async function captureRun(ctx: Context, options: {author?: string; capturedAt?: string; text?: string; historicalFinding?: boolean; declareCaptureTime?: boolean; predecessor?: string} = {}): Promise<Context> {
  const author = options.author ?? ctx.w.admin.id;
  const capturedAt = options.capturedAt ?? new Date(Date.now() + captureSequence + 1).toISOString();
  const bytes = new TextEncoder().encode(options.text ?? echo);
  // Current upload admission refuses credential-bearing uploads; this historical fixture exercises the read-side hold.
  const captured = options.historicalFinding ? await (async () => {
    const sha256 = sha256Hex(bytes);
    const scan = scanForCredentials(bytes);
    await ctx.w.kit.objects.put(bytes, 'text/plain');
    const artifact = await ctx.w.kit.store.put({
      kind:'source_artifact', schema:RECORD_SCHEMAS.source_artifact, provenance:'client_captured', created_at:capturedAt,
      body:{
        sha256, size:bytes.byteLength, media_type:'text/plain', name:`operation-capture-${++captureSequence}.txt`,
        origin:{upload:{session:'operation-session', message:null}}, author:{user:author, declared:null}, captured_at:capturedAt, captured_at_declared:true,
        provenance_type:'client_captured', read_tier:'model_readable', requested_read_tier:'model_readable',
        visibility:{readers:[author, ctx.w.admin.id], admins:true, packs:[], shareable:false}, scan:{...scan, findings:[], clean:true},
      },
      index:[{key:'artifact.sha256', value:sha256}],
    });
    return artifact;
  })() : await ctx.w.kit.artifacts.ingest({
    bytes, mediaType:'text/plain', name:`operation-capture-${++captureSequence}.txt`, ...(options.declareCaptureTime === false ? {} : {capturedAt}),
    origin:{upload:{session:'operation-session', message:null}}, author:{user:author}, provenanceType:'client_captured',
    visibility:{readers:[author, ctx.w.admin.id], admins:true, packs:[], shareable:false},
  });
  const tree = ctx.run.sources.find(source => source.slot === 'originals' && source.reference !== `src:${ctx.sha}`)!.reference;
  const principal = author === ctx.w.user.id ? ctx.w.user : ctx.w.admin;
  const own = principal === ctx.w.user;
  const subject = own ? await ctx.w.kit.artifacts.ingest({
    bytes:new TextEncoder().encode(JSON.stringify({items:[{id:'assertion', title:'assertion'}]})), mediaType:'application/json',
    origin:{upload:{session:'operation-session', message:null}}, author:{user:author}, provenanceType:'declared',
    visibility:{readers:[author], admins:true, packs:[], shareable:false},
  }) : null;
  const started = await ctx.service.startRun(principal, {
    pack:'knowledge-contribution', product:'Acme', build:ctx.build.name,
    ...(options.predecessor === undefined ? {} : {predecessor:options.predecessor}),
    inputs:{
      subject:{reference:own ? `src:${subject!.body.sha256}` : ctx.run.sources.find(source => source.slot === 'subject')!.reference},
      originals:[...(own ? [] : [{reference:tree}]), {reference:`src:${captured.body.sha256}`, artifact:captured.digest}],
    },
  }, nextCall());
  assert.equal(started.call_result, 'ok', JSON.stringify(started.errors));
  const run = RunRecord.parse((await ctx.service.getRun(ctx.w.admin, started.run!.run))!.run);
  return {...ctx, run, sha:captured.body.sha256, capture:{digest:captured.digest}};
}

function observation(ctx: Context, action: string) {
  return {schema:'fed-observation@1', product:ctx.run.product, root:ctx.root, path, source:{system:'upload', bytes:ctx.sha, ...(ctx.capture?{artifact:ctx.capture.digest}:{})}, action, result:{reference:`src:${ctx.sha}/text@1/l/1`, text:quote}};
}

function submit(ctx: Context, feeding: Record<string, unknown>, statement = '合成操作记录', fixture: {missingBed?: boolean} = {}) {
  const declared = feeding.device !== undefined && feeding.bed === undefined && fixture.missingBed !== true ? {...feeding, bed:'synthetic'} : feeding;
  return ctx.service.submitResult(ctx.w.admin, {
    run:ctx.run.run, model:'integration-synthetic@1',
    items:[{item:'assertion', handling:'handled', slots:{contribution:[{code:'assertion', text:statement, data:{root:ctx.root, path, source:{reference:`src:${ctx.sha}/text@1/l/1`, quote}, feeding:declared}}]}}],
  }, nextCall());
}

async function stored(ctx: Context, answer: Awaited<ReturnType<typeof submit>>) {
  assert.equal(answer.acceptance, 'accepted', JSON.stringify({errors:answer.errors, diagnostics:diagnostics.slice(-12)}));
  const receipt = answer.result!.contributions!.stored[0]!;
  const page = await ctx.w.knowledge.getNodes({root:ctx.root, paths:[path], depth:0}, ctx.w.admin);
  const view = page!.nodes[0].contributions!.map(row => KnowledgeContributionView.parse(row)).find(row => row.record === receipt.record)!;
  assert.ok('statement' in view.contribution);
  const feeding = KnowledgeStructureSchema.parse(view.contribution.feeding) as Record<string, unknown>;
  const text = toolText('get_nodes', {call_result:'ok', errors:[], trace:call.traceId, root:ctx.root, nodes:page!.nodes});
  const list = await ctx.w.knowledge.layers.contributions.list(ctx.root, [path], ctx.w.admin);
  return {receipt, view, feeding, text, list};
}

async function booking(ctx: Context, beds: Array<{name:string; devices:string[]}>) {
  const {run:_run, predecessor:_predecessor, groups:_groups, leases:_leases, feeding_offset:_feedingOffset, ...base} = ctx.run;
  return putRun(ctx.w.kit.store, {
    ...base, run:newId('run'), pack:'test-bed@1.0.0',
    groups:[{manifest:{schema:'test-bed-manifest@1', beds:beds.map(bed => ({name:bed.name, devices:bed.devices.map(name => ({name, type:'router', ipv4:[], ipv6:[]}))}))}}],
  }, ctx.run.started_at);
}

test('all three operation structures carry device and bed, and every client-supplied Hub field is refused', {skip}, async t => {
  const current = await captureRun(await world(t));
  const procedure = {schema:'fed-procedure@1', product:current.run.product, root:current.root, path, source:{system:'upload', bytes:current.sha, artifact:current.capture!.digest}, goal:'合成步骤', steps:[{text:'执行', quote:{reference:`src:${current.sha}/text@1/l/1`, text:quote}}], device:'device0'};
  const pitfall = {schema:'fed-pitfall@1', product:current.run.product, root:current.root, path, source:{system:'upload', bytes:current.sha, artifact:current.capture!.digest}, phenomenon:'合成现象', suggestion:'合成建议', quote:{reference:`src:${current.sha}/text@1/l/1`, text:quote}, device:'device0'};
  for (const feeding of [{...observation(current, '三类设备记录'), device:'device0'}, procedure, pitfall]) {
    const view = await stored(current, await submit(current, feeding, `三类设备记录 ${feeding.schema}`));
    assert.equal(view.feeding.device, 'device0');
    assert.equal(view.feeding.bed, 'synthetic');
    assert.ok(!('lease' in view.feeding) && !('lease_id' in view.feeding));
    assert.match(view.view.note ?? '', /设备 device0（台架 synthetic）/);
    assert.deepEqual(Object.keys(view.receipt).sort(), ['item', 'record']);
  }
  const hubValues: Record<string, unknown> = {
    binding:{source:'run_lock', build:current.build.name, line:current.build.line}, version:'synthetic-version', build:'synthetic-build',
    line:'1.2', family:'ACME', by:current.w.admin.id, run:current.run.run, at:new Date().toISOString(), object:'a'.repeat(64),
    received_at:new Date().toISOString(), captured_at_declared:true, lease:'lse_client_supplied',
  };
  for (const field of Object.keys(hubValues)) {
    const answer = await submit(current, {...observation(current, `客户端字段 ${field}`), device:'device0', [field]:hubValues[field]}, `客户端字段 ${field}`);
    assert.equal(answer.acceptance, 'not_accepted', field);
    assert.equal(answer.result?.contributions?.stored.length ?? 0, 0, field);
    assert.match(JSON.stringify(answer.errors), new RegExp(field));
  }
});

test('without a bed manifest the device and bed are kept as declared', {skip}, async t => {
  const current = await captureRun(await world(t));
  const device = await stored(current, await submit(current, {...observation(current, '只声明设备'), device:'device0'}, '只声明设备', {missingBed:true}));
  assert.equal(device.feeding.device, 'device0');
  assert.ok(!('bed' in device.feeding));
  assert.match(device.view.note ?? '', /设备 device0(?!（)/);
  const bed = await stored(current, await submit(current, {...observation(current, '声明设备和台架'), device:'device0', bed:'first'}, '声明设备和台架'));
  assert.equal(bed.feeding.bed, 'first');
  const orphan = await submit(current, {...observation(current, '只声明台架'), bed:'first'}, '只声明台架');
  assert.equal(orphan.acceptance, 'not_accepted');
  assert.match(JSON.stringify(orphan.errors), /台架声明必须同时带设备声明/);
});

test('a frozen bed manifest checks the device and bed and names the bed only when one bed has the device', {skip}, async t => {
  const ctx = await world(t);
  const booked = await booking(ctx, [{name:'first', devices:['device0', 'device1']}, {name:'second', devices:['device0']}]);
  const current = await captureRun(ctx, {predecessor:booked.body.run});
  const unique = await stored(current, await submit(current, {...observation(current, '唯一台架'), device:'device1'}, '唯一台架', {missingBed:true}));
  assert.equal(unique.feeding.bed, 'first');
  for (const [feeding, message] of [
    [{device:'device0'}, /同时属于台架 first、second/],
    [{device:'device9'}, /设备 device9 不在运行绑定的台架清单里/],
    [{device:'device1', bed:'second'}, /设备 device1 不在台架 second 里/],
    [{device:'device0', bed:'third'}, /台架 third 不在运行绑定的清单里/],
  ] as const) {
    const answer = await submit(current, {...observation(current, `清单核对 ${JSON.stringify(feeding)}`), ...feeding}, `清单核对 ${JSON.stringify(feeding)}`, {missingBed:true});
    assert.equal(answer.acceptance, 'not_accepted', JSON.stringify(feeding));
    assert.match(JSON.stringify(answer.errors), message);
  }
  const named = await stored(current, await submit(current, {...observation(current, '指明台架'), device:'device0', bed:'second'}, '指明台架'));
  assert.equal(named.feeding.bed, 'second');
});

test('equal-byte captures keep their own artifacts and an identical submission reads the stored operation', {skip}, async t => {
  const ctx = await world(t);
  const before = await captureRun(ctx);
  const after = await captureRun(ctx);
  assert.equal(before.sha, after.sha);
  const artifactOf = (value: Context) => value.run.sources.find(source => source.slot === 'originals' && source.reference === `src:${value.sha}`)?.artifact;
  assert.notEqual(artifactOf(before), artifactOf(after));
  const early = await stored(before, await submit(before, {...observation(before, '同字节'), device:'device0'}, '同字节'));
  const late = await stored(after, await submit(after, {...observation(after, '同字节'), device:'device0'}, '同字节'));
  assert.notEqual(late.receipt.record, early.receipt.record);
  assert.ok(Date.parse(String(early.feeding.at)) < Date.parse(String(late.feeding.at)));
  const identical = await submit(after, {...observation(after, '同字节'), device:'device0'}, '同字节');
  assert.equal(identical.acceptance, 'accepted', JSON.stringify(identical.errors));
  assert.equal(identical.result?.contributions?.stored[0]?.record, late.receipt.record);
});

test('credential withholding keeps the device without exposing the quote', {skip}, async t => {
  const ctx = await world(t);
  const current = await captureRun(ctx, {text:['合成回显：状态正常', ['SECRET', 'KEY'].join('_') + '=' + ['Synth3tic', 'key', '42'].join('-'), ''].join('\n'), historicalFinding:true});
  const saved = await stored(current, await submit(current, {...observation(current, '扣留的设备操作'), device:'device0'}, '扣留的设备操作'));
  const bytes = await current.w.kit.objects.get(current.sha);
  assert.ok(bytes);
  await current.w.kit.store.put({
    kind:'source_artifact', schema:RECORD_SCHEMAS.source_artifact, provenance:'observed',
    body:{
      sha256:current.sha, size:bytes.byteLength, media_type:'text/plain', name:'synthetic-observation.txt',
      origin:{read:{object:'synthetic:echo:history'}}, author:{user:null,declared:null}, captured_at:new Date().toISOString(),
      provenance_type:'observed', read_tier:'retain_only', requested_read_tier:'retain_only',
      visibility:{readers:[], admins:true, packs:[], shareable:false}, scan:scanForCredentials(bytes),
    },
    index:[{key:'artifact.sha256', value:current.sha}],
  });
  const view = await ctx.w.knowledge.layers.contributions.readView(saved.receipt.record, ctx.w.admin);
  assert.equal(view?.status, 'credential_unreadable');
  assert.match(view?.note ?? '', /设备 device0（台架 synthetic）/);
  const listed = await ctx.w.knowledge.layers.contributions.list(ctx.root, [path], ctx.w.admin);
  assert.match(listed.find(row => row.record === saved.receipt.record)?.note ?? '', /设备 device0（台架 synthetic）/);
  const page = await ctx.w.knowledge.getNodes({root:ctx.root, paths:[path], depth:0}, ctx.w.admin);
  const text = toolText('get_nodes', {call_result:'ok', errors:[], trace:call.traceId, root:ctx.root, nodes:page!.nodes});
  assert.match(text, /设备 device0（台架 synthetic）/);
  assert.doesNotMatch(text, /合成回显：状态正常/);
});

test('an artifact from another capture is refused instead of rebinding equal bytes', {skip}, async t => {
  const ctx = await world(t);
  const started = await ctx.service.startRun(ctx.w.admin, {
    pack:'knowledge-contribution', product:'Acme', build:ctx.build.name,
    inputs:{
      subject:{reference:ctx.run.sources.find(source => source.slot === 'subject')!.reference},
      originals:[{reference:`src:${ctx.sha}`, artifact:'0'.repeat(64)}],
    },
  }, nextCall());
  assert.equal(started.call_result, 'error');
  assert.ok(started.errors.some(error => error.message.includes('artifact 与 src')));
});

test('omitted artifacts and a manifest-derived bed identify equal-byte captures without breaking replay', {skip}, async t => {
  const ctx = await world(t);
  const booked = await booking(ctx, [{name:'synthetic', devices:['device0']}]);
  const before = await captureRun(ctx, {predecessor:booked.body.run});
  const after = await captureRun(ctx, {predecessor:booked.body.run});
  assert.equal(before.sha, after.sha);
  const feeding = (current: Context) => {
    const raw = {...observation(current, '省略原件并推导床'), device:'device0'};
    delete raw.source.artifact;
    return raw;
  };
  const first = await stored(before, await submit(before, feeding(before), '省略原件并推导床', {missingBed:true}));
  const second = await stored(after, await submit(after, feeding(after), '省略原件并推导床', {missingBed:true}));
  assert.notEqual(second.receipt.record, first.receipt.record);
  assert.equal(first.feeding.bed, 'synthetic');
  assert.equal(second.feeding.bed, 'synthetic');
  assert.equal((first.feeding.source as {artifact?:string}).artifact, before.capture!.digest);
  assert.equal((second.feeding.source as {artifact?:string}).artifact, after.capture!.digest);
  const replay = await submit(after, {...feeding(after), bed:'synthetic'}, '省略原件并推导床', {missingBed:true});
  assert.equal(replay.acceptance, 'accepted', JSON.stringify(replay.errors));
  assert.equal(replay.result?.contributions?.stored[0]?.record, second.receipt.record);
});

test('a bed derived from the frozen manifest stays in the record and its identity when the capture time is not declared', {skip}, async t => {
  const ctx = await world(t);
  const booked = await booking(ctx, [{name:'synthetic', devices:['device0']}]);
  const current = await captureRun(ctx, {predecessor:booked.body.run, declareCaptureTime:false});
  const raw = {...observation(current, '推导床但未声明采集时间'), device:'device0'};
  delete raw.source.artifact;
  const saved = await stored(current, await submit(current, raw, '推导床但未声明采集时间', {missingBed:true}));
  assert.equal(saved.feeding.bed, 'synthetic');
  assert.equal(saved.feeding.captured_at_declared, false);
  assert.match(saved.view.note ?? '', /采集时间未声明，记录里没有采集时刻/);
  // The bed takes part in the identity: the same capture declared on the same bed is the same record.
  const replay = await submit(current, {...raw, bed:'synthetic'}, '推导床但未声明采集时间', {missingBed:true});
  assert.equal(replay.acceptance, 'accepted', JSON.stringify(replay.errors));
  assert.equal(replay.result?.contributions?.stored[0]?.record, saved.receipt.record);
  // And a different bed is a different record (round five, item 6).
  const {operationIdentity} = await import('./feeding.ts');
  const identity = (bed: string) => JSON.stringify(operationIdentity({...saved.feeding, bed} as Record<string, unknown>));
  assert.equal(identity('synthetic'), JSON.stringify(operationIdentity(saved.feeding as Record<string, unknown>)));
  assert.notEqual(identity('synthetic'), identity('synthetic-other'));
});

test('non-string or malformed device and bed values are refused without echoing them', {skip}, async t => {
  const ctx = await world(t);
  const secret = ['SECRET', 'KEY'].join('_') + '=' + ['Synth3tic', 'key', '42'].join('-');
  for (const [key, value] of [['device', {value:secret}], ['bed', {value:secret}], ['device', ' device0'], ['bed', 'first\u0000']] as const) {
    const answer = await submit(ctx, {...observation(ctx, `畸形 ${key}`), device:'device0', [key]:value}, `畸形 ${key}`);
    assert.equal(answer.acceptance, 'not_accepted', `${key} ${JSON.stringify(value)}`);
    assert.ok(answer.errors.some(error => error.code === 'SUBMISSION_SCHEMA_VIOLATION'), JSON.stringify(answer.errors));
    assert.equal(JSON.stringify(answer.errors).includes(secret), false);
  }
});

test('a frozen old pack replays a legacy operation without device or bed fields', {skip}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'operation-frozen-pack-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const packDirectory = join(directory, 'knowledge-contribution');
  await copyFrozenKnowledgeContribution(packDirectory);
  const manifest = JSON.parse(await readFile(join(packDirectory, 'pack.json'), 'utf8')) as {id:string; version:string};
  const digest = manifestDigest(manifest);
  assert.equal(digest, FROZEN_KNOWLEDGE_CONTRIBUTION.digest);
  const ctx = await world(t, packDirectory);
  assert.equal(ctx.run.pack, `${manifest.id}@${manifest.version}`);
  assert.equal(ctx.run.pack_digest, digest);

  const legacy = observation(ctx, '冻结旧包操作');
  delete legacy.source.artifact;
  assert.ok(!('device' in legacy) && !('bed' in legacy));
  const answer = await submit(ctx, legacy, '冻结旧包操作');
  const saved = await stored(ctx, answer);
  for (const field of ['device', 'bed']) assert.ok(!(field in saved.feeding), field);
  assert.equal(saved.view.status, 'valid');
  // An old client declares no capture time; the view discloses that, as for any operation record (round-four review, item 8).
  assert.match(saved.view.note ?? '', /^采集时间未声明，记录里没有采集时刻；Hub 收到 /);
  const first = await ctx.w.knowledge.layers.contributions.readView(saved.receipt.record, ctx.w.admin);
  const second = await ctx.w.knowledge.layers.contributions.readView(saved.receipt.record, ctx.w.admin);
  assert.deepEqual(second, first);
  const replay = await submit(ctx, legacy, '冻结旧包操作');
  assert.equal(replay.acceptance, 'accepted', JSON.stringify(replay.errors));
  assert.equal(replay.result?.contributions?.stored[0]?.record, saved.receipt.record);
  assert.deepEqual(await ctx.w.knowledge.layers.contributions.readView(saved.receipt.record, ctx.w.admin), first);
});
