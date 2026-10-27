import {createTestParserRegistry as createDefaultRegistry} from '../testing/parsers.ts';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
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
import {Database, createPool} from '../records/db.ts';
import {RECORD_SCHEMAS, scanForCredentials, sha256Hex} from '../records/api.ts';
import {newId} from '../records/ids.ts';
import {LeaseService} from '../leases/api.ts';

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

function leasesOf(t: {after(fn: () => Promise<void>): void}, ctx: Context, now?: () => Promise<Date>) {
  const db = new Database(createPool(ctx.w.kit.database, 2));
  t.after(() => db.end());
  const service = new LeaseService(db, {records:ctx.w.kit.store, ...(now ? {now} : {})});
  ctx.w.knowledge.__context.leases = service;
  return {db, service};
}

async function captureRun(ctx: Context, options: {author?: string; capturedAt?: string; text?: string; historicalFinding?: boolean; declareCaptureTime?: boolean; predecessor?: string} = {}): Promise<Context> {
  const author = options.author ?? ctx.w.admin.id;
  const latest = options.capturedAt === undefined ? (await ctx.w.kit.store.find({key:'action.kind', value:'lease', kind:'action', newestFirst:true, limit:1})).items[0] : undefined;
  const capturedAt = options.capturedAt ?? (latest ? new Date(Date.parse((latest.body as {started_at:string}).started_at) + 1).toISOString() : new Date(Date.now() + captureSequence + 1).toISOString());
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

function holder(ctx: Context, user = ctx.w.admin.id) { return {user, run:ctx.run.run}; }

async function justAfter(ctx: Context, lease: string) {
  const action = (await ctx.w.kit.store.find({key:'lease.id', value:lease, kind:'action', newestFirst:true, limit:1})).items[0]!;
  return new Date(Date.parse((action.body as {started_at:string}).started_at) + 1).toISOString();
}

test('capture time decides absent, acquired and released leases without changing lease history', async t => {
  const ctx = await world(t);
  const {service:leases} = leasesOf(t, ctx);
  const history = () => leases.actionLog('bed/');
  assert.deepEqual(await history(), []);
  const plain = await stored(ctx, await submit(ctx, observation(ctx, '无设备声明')));
  assert.equal(plain.receipt.device, undefined);
  assert.equal(plain.receipt.lease, undefined);
  assert.equal(plain.feeding.lease, undefined);
  assert.equal(plain.view.note, null);
  assert.doesNotMatch(plain.text, /无租约|设备 device0/);

  const earlyCapture = await captureRun(ctx);
  const earlyAnswer = await submit(earlyCapture, {...observation(earlyCapture, '采集后才取得'), device:'device0'}, '采集后才取得');
  const early = await stored(earlyCapture, earlyAnswer);
  assert.equal(early.receipt.device, 'device0');
  assert.equal(early.receipt.lease, null);
  assert.equal(early.feeding.lease, null);
  assert.match(early.view.note ?? '', /设备 device0；无租约（未授权）/);
  assert.match(early.list.find(row => row.record === early.receipt.record)?.note ?? '', /无租约（未授权）/);
  assert.match(toolText('submit_result', {...earlyAnswer, trace:call.traceId}), /设备 device0；无租约（未授权）/);

  const key = 'bed/synthetic/device0';
  const acquired = await leases.acquire({keys:[key], holder:holder(ctx), prefix:'bed/'});
  assert.ok(acquired.ok);
  const authorizedCapture = await captureRun(ctx);
  const authorized = await stored(authorizedCapture, await submit(authorizedCapture, {...observation(authorizedCapture, '持有期间采集'), device:'device0'}, '持有期间采集'));
  assert.equal(authorized.feeding.lease, key);
  assert.equal(authorized.feeding.lease_id, acquired.lease);
  assert.equal(authorized.receipt.lease, key);
  assert.match(authorized.view.note ?? '', new RegExp(`设备 device0；租约 ${key}（记录 ${acquired.lease}）`));
  assert.match(authorized.text, new RegExp(acquired.lease));
  const released = await leases.release({keys:[key], holder:holder(ctx)});
  assert.ok(released.ok);

  const later = await captureRun(ctx);
  const afterFixture = await history();
  const unauthorized = await stored(later, await submit(later, {...observation(later, '释放后采集'), device:'device0'}, '释放后采集'));
  assert.equal(unauthorized.feeding.lease, null);
  assert.match(unauthorized.text, /无租约（未授权）/);
  assert.deepEqual(await history(), afterFixture);
});

test('takeover and renewal use the uploader and the capture-time history', async t => {
  const ctx = await world(t);
  const {service:leases} = leasesOf(t, ctx);
  const key = 'bed/synthetic/device0';
  const first = await leases.acquire({keys:[key], holder:holder(ctx), prefix:'bed/'});
  assert.ok(first.ok);
  const during = await captureRun(ctx);
  const retained = await stored(during, await submit(during, {...observation(during, '接管前的上传者'), device:'device0'}, '接管前的上传者'));
  assert.equal(retained.feeding.by, ctx.w.admin.id);
  assert.equal(retained.feeding.lease, key);
  assert.equal(retained.feeding.lease_id, first.lease);
  assert.ok((await leases.forceRelease({keys:[key], by:ctx.w.admin.id, reason:'合成接管'})).ok);
  const other = await leases.acquire({keys:[key], holder:holder(ctx, ctx.w.user.id), prefix:'bed/'});
  assert.ok(other.ok);
  assert.notEqual(other.lease, first.lease);

  const afterTakeover = await captureRun(ctx);
  const refused = await stored(afterTakeover, await submit(afterTakeover, {...observation(afterTakeover, '接管后的原上传者'), device:'device0'}, '接管后的原上传者'));
  assert.equal(refused.feeding.lease, null);
  assert.match(refused.text, /无租约（未授权）/);

  const byOther = await captureRun(ctx, {author:ctx.w.user.id});
  const current = await stored(byOther, await submit(byOther, {...observation(byOther, '接管后的新上传者'), device:'device0'}, '接管后的新上传者'));
  const candidates = await byOther.w.kit.artifacts.records(byOther.sha);
  assert.equal(current.feeding.by, ctx.w.user.id, JSON.stringify({admin:ctx.w.admin.id, expected:ctx.w.user.id, sources:byOther.run.sources, captures:candidates.map(row => ({digest:row.digest, created_at:row.created_at, body:row.body}))}));
  assert.equal(current.feeding.lease, key);
  assert.equal(current.feeding.lease_id, other.lease);
});

test('expiry and the extended window are evaluated at capture time, including orphan takeover records', async t => {
  const ctx = await world(t);
  const now = Date.now();
  const past = new Date(now - 120000);
  const {db, service:old} = leasesOf(t, ctx, async () => past);
  const expiredKey = 'bed/synthetic/expired0';
  assert.ok((await old.acquire({keys:[expiredKey], holder:holder(ctx), prefix:'bed/', ttlSeconds:1, maxTtlSeconds:120})).ok);
  const expired = await captureRun(ctx);
  const expiredView = await stored(expired, await submit(expired, {...observation(expired, '过期的租约'), device:'expired0'}, '过期的租约'));
  assert.equal(expiredView.feeding.lease, null);

  const renewedResource = 'bed/synthetic/renew0';
  const renewer = new LeaseService(db, {records:ctx.w.kit.store, now:async () => new Date(now - 4000)});
  const renewed = await renewer.acquire({keys:[renewedResource], holder:holder(ctx), prefix:'bed/', ttlSeconds:1, maxTtlSeconds:600});
  assert.ok(renewed.ok);
  const extending = new LeaseService(db, {records:ctx.w.kit.store, now:async () => new Date(now - 3500)});
  const extended = await extending.extend({keys:[renewedResource], holder:holder(ctx), ttlSeconds:60, maxTtlSeconds:600});
  assert.ok(extended.ok);
  const within = await captureRun(ctx);
  const extendedView = await stored(within, await submit(within, {...observation(within, '续租期内'), device:'renew0'}, '续租期内'));
  assert.equal(extendedView.feeding.lease, renewedResource);
  assert.equal(extendedView.feeding.lease_id, renewed.lease);

  const current = new LeaseService(db, {records:ctx.w.kit.store});
  const orphanHolder = {user:ctx.w.admin.id, run:newId('run')};
  const orphanResource = 'bed/synthetic/orphan0';
  const orphan = await old.acquire({keys:[orphanResource], holder:orphanHolder, prefix:'bed/'});
  assert.ok(orphan.ok);
  const beforeReclaim = await captureRun(ctx);
  const reclaimed = await stored(beforeReclaim, await submit(beforeReclaim, {...observation(beforeReclaim, '接管记录前的采集'), device:'orphan0'}, '接管记录前的采集'));
  assert.equal(reclaimed.feeding.lease, orphanResource);
  assert.equal(reclaimed.feeding.lease_id, orphan.lease);
  assert.equal(await current.reclaimOrphans(), 1);
  const afterReclaim = await captureRun(ctx);
  const noOrphan = await stored(afterReclaim, await submit(afterReclaim, {...observation(afterReclaim, '接管记录后的采集'), device:'orphan0'}, '接管记录后的采集'));
  assert.equal(noOrphan.feeding.lease, null);
});

test('all three operation structures carry device and every client-supplied Hub field is refused', async t => {
  const ctx = await world(t);
  const {service:leases} = leasesOf(t, ctx);
  const acquired = await leases.acquire({keys:['bed/synthetic/device0'], holder:holder(ctx), prefix:'bed/'});
  assert.ok(acquired.ok);
  const current = await captureRun(ctx);
  const procedure = {schema:'fed-procedure@1', product:current.run.product, root:current.root, path, source:{system:'upload', bytes:current.sha, artifact:current.capture!.digest}, goal:'合成步骤', steps:[{text:'执行', quote:{reference:`src:${current.sha}/text@1/l/1`, text:quote}}], device:'device0'};
  const pitfall = {schema:'fed-pitfall@1', product:current.run.product, root:current.root, path, source:{system:'upload', bytes:current.sha, artifact:current.capture!.digest}, phenomenon:'合成现象', suggestion:'合成建议', quote:{reference:`src:${current.sha}/text@1/l/1`, text:quote}, device:'device0'};
  for (const feeding of [{...observation(current, '三类设备记录'), device:'device0'}, procedure, pitfall]) {
    const view = await stored(current, await submit(current, feeding, `三类设备记录 ${feeding.schema}`));
    assert.equal(view.feeding.device, 'device0');
    assert.equal(view.feeding.lease, 'bed/synthetic/device0');
    assert.equal(view.feeding.lease_id, acquired.lease);
  }
  const supplied = await submit(current, {...observation(current, '客户端租约'), device:'device0', lease:'lse_client_supplied'}, '客户端租约');
  assert.equal(supplied.acceptance, 'not_accepted');
  assert.equal(supplied.result?.contributions?.stored.length, 0);
  assert.match(JSON.stringify(supplied.errors), /租约由 Hub 填写，删掉该字段后重交/);
  const hubValues: Record<string, unknown> = {
    binding:{source:'run_lock', build:current.build.name, line:current.build.line}, version:'synthetic-version', build:'synthetic-build',
    line:'1.2', family:'ACME', by:ctx.w.admin.id, run:ctx.run.run, at:new Date().toISOString(), object:'a'.repeat(64),
    received_at:new Date().toISOString(), captured_at_declared:true,
  };
  for (const field of ['binding', 'version', 'build', 'line', 'family', 'by', 'run', 'at', 'object', 'received_at', 'captured_at_declared']) {
    const answer = await submit(current, {...observation(current, `客户端字段 ${field}`), device:'device0', [field]:hubValues[field]}, `客户端字段 ${field}`);
    assert.equal(answer.acceptance, 'not_accepted', field);
    assert.equal(answer.result?.contributions?.stored.length, 0, field);
    assert.match(JSON.stringify(answer.errors), new RegExp(field));
  }
});

test('an unbound run accepts a device declaration but never picks one of several current leases', async t => {
  const ctx = await world(t);
  const {service:leases} = leasesOf(t, ctx);
  for (const key of ['bed/first/device0', 'bed/second/device0']) assert.ok((await leases.acquire({keys:[key], holder:holder(ctx), prefix:'bed/'})).ok);
  const current = await captureRun(ctx);
  const answer = await submit(current, {...observation(current, '同名设备候选不唯一'), device:'device0'}, '同名设备候选不唯一', {missingBed:true});
  const missing = await stored(current, answer);
  assert.equal(missing.feeding.lease, null);
  assert.equal(missing.feeding.lease_id, null);
  assert.match(JSON.stringify(missing.feeding.lease_unconfirmed), /床|台架/);
  assert.doesNotMatch(missing.view.note ?? '', /无租约（未授权）/);
  const first = await stored(current, await submit(current, {...observation(current, '明确床身份'), device:'device0', bed:'first'}, '明确床身份'));
  assert.equal(first.feeding.lease, 'bed/first/device0');
  assert.notEqual(first.feeding.lease_id, null);
});

test('mixed-lease batch extension and force release replay every affected key', async t => {
  const ctx = await world(t);
  const now = Date.now();
  const {db, service:old} = leasesOf(t, ctx, async () => new Date(now - 4000));
  const keys = ['bed/synthetic/first0', 'bed/synthetic/second0'];
  const first = await old.acquire({keys:[keys[0]], holder:holder(ctx), prefix:'bed/', ttlSeconds:1, maxTtlSeconds:600});
  const second = await old.acquire({keys:[keys[1]], holder:holder(ctx), prefix:'bed/', ttlSeconds:1, maxTtlSeconds:600});
  assert.ok(first.ok);
  assert.ok(second.ok);
  const extending = new LeaseService(db, {records:ctx.w.kit.store, now:async () => new Date(now - 3500)});
  assert.ok((await extending.extend({keys, holder:holder(ctx), ttlSeconds:60, maxTtlSeconds:600})).ok);
  const before = await captureRun(ctx);
  const current = new LeaseService(db, {records:ctx.w.kit.store});
  for (const [index, device] of ['first0', 'second0'].entries()) {
    const expected: string = index === 0 ? first.lease : second.lease;
    const view = await stored(before, await submit(before, {...observation(before, `批量续租 ${device}`), device}, `批量续租 ${device}`));
    assert.equal(view.feeding.lease, keys[index]);
    assert.equal(view.feeding.lease_id, expected);
  }
  assert.ok((await current.forceRelease({keys, by:ctx.w.admin.id, reason:'合成批量强制释放'})).ok);
  const after = await captureRun(ctx);
  for (const device of ['first0', 'second0']) {
    const view = await stored(after, await submit(after, {...observation(after, `批量释放 ${device}`), device}, `批量释放 ${device}`));
    assert.equal(view.feeding.lease, null);
    assert.match(view.text, /无租约（未授权）/);
  }
});

test('equal-byte captures keep their own timestamps and idempotent receipts read the stored operation', async t => {
  const ctx = await world(t);
  const before = await captureRun(ctx);
  const {service:leases} = leasesOf(t, ctx);
  const acquired = await leases.acquire({keys:['bed/synthetic/device0'], holder:holder(ctx), prefix:'bed/'});
  assert.ok(acquired.ok);
  const after = await captureRun(ctx);
  assert.equal(before.sha, after.sha);
  const artifactOf = (value: Context) => value.run.sources.find(source => source.slot === 'originals' && source.reference === `src:${value.sha}`)?.artifact;
  assert.notEqual(artifactOf(before), artifactOf(after));

  const early = await stored(before, await submit(before, {...observation(before, '同字节前态'), device:'device0'}, '同字节前态'));
  const late = await stored(after, await submit(after, {...observation(after, '同字节后态'), device:'device0'}, '同字节后态'));
  assert.equal(early.feeding.lease, null);
  assert.equal(late.feeding.lease, 'bed/synthetic/device0');
  assert.equal(late.feeding.lease_id, acquired.lease);
  assert.ok(Date.parse(String(early.feeding.at)) < Date.parse(String(late.feeding.at)));

  const plainAnswer = await submit(before, observation(before, '幂等无设备'), '幂等操作');
  const plain = await stored(before, plainAnswer);
  assert.equal(plain.feeding.device, undefined);
  const replayAnswer = await submit(after, {...observation(after, '幂等无设备'), device:'device0'}, '幂等操作');
  const replay = await stored(after, replayAnswer);
  assert.notEqual(replay.receipt.record, plain.receipt.record);
  assert.equal(replay.receipt.device, 'device0');
  assert.equal(replay.receipt.lease, 'bed/synthetic/device0');
  assert.equal((replay.receipt as Record<string, unknown>).lease_id, acquired.lease);
  assert.equal(replay.feeding.lease, 'bed/synthetic/device0');
  assert.equal(replay.feeding.lease_id, acquired.lease);
  assert.match(replay.view.note ?? '', /租约 bed\/synthetic\/device0/);
  const identical = await submit(after, {...observation(after, '幂等无设备'), device:'device0'}, '幂等操作');
  assert.equal(identical.acceptance, 'accepted', JSON.stringify(identical.errors));
  assert.equal(identical.result?.contributions?.stored[0]?.record, replay.receipt.record);
});

test('credential withholding keeps the device and unauthorized state without exposing the quote', async t => {
  const ctx = await world(t);
  leasesOf(t, ctx);
  const current = await captureRun(ctx, {text:['合成回显：状态正常', ['SECRET', 'KEY'].join('_') + '=' + ['Synth3tic', 'key', '42'].join('-'), ''].join('\n'), historicalFinding:true});
  const saved = await stored(current, await submit(current, {...observation(current, '扣留的设备操作'), device:'device0'}, '扣留的设备操作'));
  assert.equal(saved.feeding.lease, null);
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
  assert.match(view?.note ?? '', /设备 device0；无租约（未授权）/);
  const listed = await ctx.w.knowledge.layers.contributions.list(ctx.root, [path], ctx.w.admin);
  assert.match(listed.find(row => row.record === saved.receipt.record)?.note ?? '', /设备 device0；无租约（未授权）/);
  const page = await ctx.w.knowledge.getNodes({root:ctx.root, paths:[path], depth:0}, ctx.w.admin);
  const text = toolText('get_nodes', {call_result:'ok', errors:[], trace:call.traceId, root:ctx.root, nodes:page!.nodes});
  assert.match(text, /设备 device0；无租约（未授权）/);
  assert.doesNotMatch(text, /合成回显：状态正常/);
});

test('an artifact from another capture is refused instead of rebinding equal bytes', async t => {
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

test('lease proof covers the declared capture through Hub receipt and exposes its resource key and id', async t => {
  const ctx = await world(t);
  const {service:leases} = leasesOf(t, ctx);
  const acquired = await leases.acquire({keys:['bed/synthetic/device0'], holder:holder(ctx), prefix:'bed/'});
  assert.ok(acquired.ok);
  const acquiredRecord = (await ctx.w.kit.store.find({key:'lease.id', value:acquired.lease, kind:'action', limit:1})).items[0]!;
  const declaredAt = new Date(Date.parse((acquiredRecord.body as {started_at:string}).started_at) + 1).toISOString();
  const current = await captureRun(ctx, {capturedAt:declaredAt});
  const held = await stored(current, await submit(current, {...observation(current, '延迟上传的连续租约'), device:'device0'}, '延迟上传的连续租约'));
  assert.equal(held.feeding.lease, 'bed/synthetic/device0');
  assert.equal(held.feeding.lease_id, acquired.lease);
  assert.equal(held.receipt.lease, 'bed/synthetic/device0');
  assert.equal((held.receipt as Record<string, unknown>).lease_id, acquired.lease);

  const changedAt = new Date().toISOString();
  assert.ok((await leases.release({keys:['bed/synthetic/device0'], holder:holder(ctx)})).ok);
  const changed = await captureRun(ctx, {capturedAt:changedAt});
  const uncertain = await stored(changed, await submit(changed, {...observation(changed, '区间内发生变化'), device:'device0'}, '区间内发生变化'));
  assert.equal(uncertain.feeding.lease, null);
  assert.equal(uncertain.feeding.lease_id, null);
  assert.ok(uncertain.feeding.lease_unconfirmed);
  assert.match(uncertain.view.note ?? '', /未能确认/);
});

test('continuous coverage permits the same lease renewal but not an interval expiry', async t => {
  const ctx = await world(t);
  const {db, service:leases} = leasesOf(t, ctx, async () => new Date('2026-10-27T09:59:00.000Z'));
  const acquired = await leases.acquire({keys:['bed/synthetic/device0'], holder:holder(ctx), prefix:'bed/', ttlSeconds:600, maxTtlSeconds:600});
  assert.ok(acquired.ok);
  const extending = new LeaseService(db, {records:ctx.w.kit.store, now:async () => new Date('2026-10-27T10:00:05.000Z')});
  assert.ok((await extending.extend({keys:['bed/synthetic/device0'], holder:holder(ctx), ttlSeconds:60, maxTtlSeconds:600})).ok);
  const {operationLease} = await import('./feeding-leases.ts');
  const renewed = await operationLease(ctx.w.kit.store, {key:'bed/synthetic/device0', device:'device0', user:ctx.w.admin.id, capturedAt:'2026-10-27T10:00:00.000Z', receivedAt:'2026-10-27T10:00:10.000Z'}, leases);
  assert.deepEqual(renewed, {lease:'bed/synthetic/device0', lease_id:acquired.lease});

  const expiring = await leases.acquire({keys:['bed/synthetic/expiring0'], holder:holder(ctx), prefix:'bed/', ttlSeconds:60, maxTtlSeconds:600});
  assert.ok(expiring.ok);
  const expired = await operationLease(ctx.w.kit.store, {key:'bed/synthetic/expiring0', device:'expiring0', user:ctx.w.admin.id, capturedAt:'2026-10-27T09:59:30.000Z', receivedAt:'2026-10-27T10:00:10.000Z'}, leases);
  assert.equal(expired.lease, null);
  assert.equal(expired.lease_id, null);
  assert.match(expired.lease_unconfirmed?.missing ?? '', /到期/);
});

test('a shared device name never borrows a lease from another bed', async t => {
  const ctx = await world(t);
  const {service:leases} = leasesOf(t, ctx);
  const acquired = await leases.acquire({keys:['bed/first/device0'], holder:holder(ctx), prefix:'bed/'});
  assert.ok(acquired.ok);
  const current = await captureRun(ctx);
  const missing = await stored(current, await submit(current, {...observation(current, '缺台架身份'), device:'device0'}, '缺台架身份', {missingBed:true}));
  assert.equal(missing.feeding.lease, null);
  assert.equal(missing.feeding.lease_id, null);
  assert.ok(missing.feeding.lease_unconfirmed);
  assert.match(JSON.stringify(missing.feeding.lease_unconfirmed), /床|台架/);
  const identified = await stored(current, await submit(current, {...observation(current, '明确台架与设备'), device:'device0', bed:'first'}, '明确台架与设备'));
  assert.equal(identified.feeding.lease, 'bed/first/device0');
  assert.equal(identified.feeding.lease_id, acquired.lease);
});

test('capture and lease acquisition in the same millisecond is unconfirmed', async t => {
  const ctx = await world(t);
  const {service:leases} = leasesOf(t, ctx);
  const acquired = await leases.acquire({keys:['bed/synthetic/device0'], holder:holder(ctx), prefix:'bed/'});
  assert.ok(acquired.ok);
  const action = (await ctx.w.kit.store.find({key:'action.kind', value:'lease', kind:'action', limit:1})).items[0]!;
  const current = await captureRun(ctx, {capturedAt:(action.body as {started_at:string}).started_at});
  const view = await stored(current, await submit(current, {...observation(current, '同毫秒采集'), device:'device0'}, '同毫秒采集'));
  assert.ok(view.feeding.lease_unconfirmed);
  assert.match(view.view.note ?? '', /未能确认/);
});

test('a damaged acquire record is unconfirmed rather than a confirmed absence', async t => {
  const ctx = await world(t);
  const lease = 'lse_synthetic_missing_keys';
  await ctx.w.kit.store.put({
    kind:'action', schema:RECORD_SCHEMAS.action, provenance:'observed', created_at:'2026-01-01T00:00:00.000Z',
    body:{
      action:'lease', run:ctx.run.run, item:null, inputs:[], component:'leases@1', lease:{lease, fencing:1},
      started_at:'2026-01-01T00:00:00.000Z', ended_at:'2026-01-01T00:00:00.000Z', result:'completed', error_code:null, acceptance:null, codes:[],
      detail:{op:'acquire', lease, holder:holder(ctx), until:null, token:1},
    },
    index:[{key:'action.kind', value:'lease'}],
  });
  const current = await captureRun(ctx);
  const view = await stored(current, await submit(current, {...observation(current, '损坏租约记录'), device:'device0'}, '损坏租约记录'));
  assert.ok(view.feeding.lease_unconfirmed);
  assert.match(JSON.stringify(view.feeding.lease_unconfirmed), /keys|管理员/);
});

test('credential-shaped device text is refused before the raw submission is persisted', async t => {
  const ctx = await world(t);
  const before = (await ctx.w.kit.store.list({kind:'submission', limit:500})).items.length;
  const device = ['SECRET', 'KEY'].join('_') + '=' + ['Synth3tic', 'key', '42'].join('-');
  const answer = await submit(ctx, {...observation(ctx, '设备字段凭据'), device}, '设备字段凭据');
  const after = (await ctx.w.kit.store.list({kind:'submission', limit:500})).items.length;
  assert.equal(after, before);
  assert.ok(answer.errors.some(error => error.code === 'CREDENTIAL_IN_UPLOAD'));
});

test('thousands of historical lease records use bounded database calls and returned rows', async t => {
  const ctx = await world(t);
  for (let index = 0; index < 3000; index++) {
    const lease = `lse_synthetic_history_${index}`;
    await ctx.w.kit.store.put({
      kind:'action', schema:RECORD_SCHEMAS.action, provenance:'observed', created_at:'2026-01-01T00:00:00.000Z',
      body:{
        action:'lease', run:ctx.run.run, item:null, inputs:[], component:'leases@1', lease:{lease, fencing:1},
        started_at:'2026-01-01T00:00:00.000Z', ended_at:'2026-01-01T00:00:00.000Z', result:'completed', error_code:null, acceptance:null, codes:[],
        detail:{op:'acquire', lease, keys:[`bed/history/${index % 64}`], holder:holder(ctx), until:null, token:1},
      },
      index:[{key:'action.kind', value:'lease'}],
    });
  }
  const {db, service:leases} = leasesOf(t, ctx);
  const granted = await leases.acquire({keys:['bed/synthetic/device0'], holder:holder(ctx), prefix:'bed/'});
  assert.ok(granted.ok);
  const originalQuery = db.query.bind(db);
  const plans: string[] = [];
  const queries = t.mock.method(db, 'query', async (text: string, values?: readonly unknown[], tx?: import('../records/api.ts').Transaction) => {
    if (text.startsWith('SELECT r.digest FROM record_index')) {
      const plan = await originalQuery(`EXPLAIN (ANALYZE, COSTS OFF, SUMMARY OFF) ${text}`, values, tx);
      plans.push(plan.rows.map(row => String(Object.values(row)[0])).join('\n'));
    }
    return originalQuery(text, values, tx);
  });
  const {operationLease} = await import('./feeding-leases.ts');
  const capturedAt = await justAfter(ctx, granted.lease);
  const result = await operationLease(ctx.w.kit.store, {bed:'synthetic', device:'device0', user:ctx.w.admin.id, capturedAt, receivedAt:new Date().toISOString()}, leases);
  assert.deepEqual(result, {lease:'bed/synthetic/device0', lease_id:granted.lease});
  const limited = await leases.history({key:'bed/history/0', from:'2026-01-01T00:00:00.000Z', to:new Date().toISOString(), limit:32});
  assert.equal(limited.complete, false, JSON.stringify({complete:limited.complete, events:limited.events.length, first:limited.events[0]?.body.detail}));
  assert.equal(limited.events.length, 32);
  assert.equal(queries.mock.calls.length, 6);
  const returned: number[] = [];
  let scanned = 0;
  for (const call of queries.mock.calls) {
    const answer = await call.result as {rows:unknown[]};
    returned.push(answer.rows.length);
  }
  for (const plan of plans) for (const match of plan.matchAll(/Rows Removed by (?:Filter|Index Recheck): (\d+)/g)) scanned += Number(match[1]);
  assert.equal(returned.length, 6);
  assert.equal(plans.length, 6);
  assert.ok(returned.every(count => count <= 1025), JSON.stringify(returned));
  assert.ok(returned.reduce((sum, count) => sum + count, 0) < 100, JSON.stringify(returned));
  assert.ok(scanned < 3000, `rows removed by filter/index recheck: ${scanned}`);
});

test('an upload without a declared capture time keeps its record but cannot prove a lease', async t => {
  const ctx = await world(t);
  const {service:leases} = leasesOf(t, ctx);
  const acquired = await leases.acquire({keys:['bed/synthetic/device0'], holder:holder(ctx), prefix:'bed/'});
  assert.ok(acquired.ok);
  const current = await captureRun(ctx, {declareCaptureTime:false});
  const artifact = await ctx.w.kit.store.get<import('../records/api.ts').SourceArtifactBody>(current.capture!.digest);
  assert.equal(artifact?.body.captured_at_declared, false);
  const saved = await stored(current, await submit(current, {...observation(current, '旧客户端缺采集时刻'), device:'device0'}, '旧客户端缺采集时刻'));
  assert.equal(saved.feeding.at, undefined);
  assert.equal(saved.feeding.captured_at_declared, false);
  assert.equal(saved.feeding.received_at, artifact?.created_at);
  assert.match(saved.view.note ?? '', /采集时间未声明（取自上传时刻）/);
  assert.match(saved.text, /采集时间未声明（取自上传时刻）/);
  assert.equal(saved.feeding.lease, null);
  assert.equal(saved.feeding.lease_id, null);
  assert.match(JSON.stringify(saved.feeding.lease_unconfirmed), /没有明确声明采集时刻/);
  assert.match(JSON.stringify(saved.feeding.lease_unconfirmed), /captured_at/);
  assert.match(saved.view.note ?? '', /租约未能确认/);
  assert.doesNotMatch(saved.view.note ?? '', /无租约（未授权）/);
});

test('omitted artifacts and a manifest-derived bed identify equal-byte captures without breaking replay', async t => {
  const ctx = await world(t);
  const {run:_run, predecessor:_predecessor, groups:_groups, leases:_leases, feeding_offset:_feedingOffset, ...base} = ctx.run;
  const booking = await putRun(ctx.w.kit.store, {
    ...base, run:newId('run'), pack:'test-bed@1.0.0',
    groups:[{manifest:{schema:'test-bed-manifest@1', beds:[{name:'synthetic', devices:[{name:'device0', type:'router', ipv4:[], ipv6:[]}]}]}}],
  }, ctx.run.started_at);
  const before = await captureRun(ctx, {predecessor:booking.body.run});
  const {service:leases} = leasesOf(t, ctx);
  const acquired = await leases.acquire({keys:['bed/synthetic/device0'], holder:holder(ctx), prefix:'bed/'});
  assert.ok(acquired.ok);
  const after = await captureRun(ctx, {predecessor:booking.body.run});
  assert.equal(before.sha, after.sha);
  const feeding = (current: Context) => {
    const raw = {...observation(current, '省略原件并推导床'), device:'device0'};
    delete raw.source.artifact;
    return raw;
  };
  const first = await stored(before, await submit(before, feeding(before), '省略原件并推导床', {missingBed:true}));
  const second = await stored(after, await submit(after, feeding(after), '省略原件并推导床', {missingBed:true}));
  assert.notEqual(second.receipt.record, first.receipt.record);
  assert.equal(first.feeding.lease, null);
  assert.equal(second.feeding.lease, 'bed/synthetic/device0');
  assert.equal(second.feeding.lease_id, acquired.lease);
  assert.equal(first.feeding.bed, 'synthetic');
  assert.equal(second.feeding.bed, 'synthetic');
  assert.equal((first.feeding.source as {artifact?:string}).artifact, before.capture!.digest);
  assert.equal((second.feeding.source as {artifact?:string}).artifact, after.capture!.digest);
  const replay = await submit(after, {...feeding(after), bed:'synthetic'}, '省略原件并推导床', {missingBed:true});
  assert.equal(replay.acceptance, 'accepted', JSON.stringify(replay.errors));
  assert.equal(replay.result?.contributions?.stored[0]?.record, second.receipt.record);
});

test('another holders expiry inside the interval is a change rather than a confirmed absence', async t => {
  const ctx = await world(t);
  const {service:leases} = leasesOf(t, ctx, async () => new Date('2026-10-27T09:59:00.000Z'));
  const foreign = await leases.acquire({keys:['bed/synthetic/device0'], holder:holder(ctx, ctx.w.user.id), prefix:'bed/', ttlSeconds:60, maxTtlSeconds:600});
  assert.ok(foreign.ok);
  const {operationLease} = await import('./feeding-leases.ts');
  const result = await operationLease(ctx.w.kit.store, {key:'bed/synthetic/device0', device:'device0', user:ctx.w.admin.id, capturedAt:'2026-10-27T09:59:30.000Z', receivedAt:'2026-10-27T10:00:10.000Z'}, leases);
  assert.equal(result.lease, null);
  assert.equal(result.lease_id, null);
  assert.match(result.lease_unconfirmed?.missing ?? '', /到期/);
});

test('non-string device and bed values are refused before raw submission persistence', async t => {
  const ctx = await world(t);
  const before = (await ctx.w.kit.store.list({kind:'submission', limit:500})).items.length;
  const secret = ['SECRET', 'KEY'].join('_') + '=' + ['Synth3tic', 'key', '42'].join('-');
  for (const key of ['device', 'bed']) {
    const answer = await submit(ctx, {...observation(ctx, `非字符串 ${key}`), [key]:{value:secret}}, `非字符串 ${key}`);
    assert.equal(answer.acceptance, 'not_accepted');
    assert.ok(answer.errors.some(error => error.code === 'SUBMISSION_SCHEMA_VIOLATION'));
    assert.equal(JSON.stringify(answer.errors).includes(secret), false);
    assert.equal((await ctx.w.kit.store.list({kind:'submission', limit:500})).items.length, before);
  }
});

async function coveredOperation(ctx: Context, feeding: Record<string, unknown>, statement: string, key: string, leaseId: string) {
  const saved = await stored(ctx, await submit(ctx, feeding, statement));
  assert.equal(saved.feeding.lease, key);
  assert.equal(saved.feeding.lease_id, leaseId);
  assert.equal(saved.feeding.lease_unconfirmed, undefined);
  return saved;
}

test('release after Hub receipt and before submission keeps the completed interval proof', async t => {
  const ctx = await world(t);
  const {service:leases} = leasesOf(t, ctx);
  const acquired = await leases.acquire({keys:['bed/synthetic/device0'], holder:holder(ctx), prefix:'bed/'});
  assert.ok(acquired.ok);
  const current = await captureRun(ctx);
  assert.ok((await leases.release({keys:['bed/synthetic/device0'], holder:holder(ctx)})).ok);
  await coveredOperation(current, {...observation(current, '收到后提交前释放'), device:'device0'}, '收到后提交前释放', 'bed/synthetic/device0', acquired.lease);
});

test('takeover after Hub receipt and before submission keeps the completed interval proof', async t => {
  const ctx = await world(t);
  const {service:leases} = leasesOf(t, ctx);
  const first = await leases.acquire({keys:['bed/synthetic/device0'], holder:holder(ctx), prefix:'bed/'});
  assert.ok(first.ok);
  const current = await captureRun(ctx);
  assert.ok((await leases.forceRelease({keys:['bed/synthetic/device0'], by:ctx.w.admin.id, reason:'合成接管'})).ok);
  const other = await leases.acquire({keys:['bed/synthetic/device0'], holder:holder(ctx, ctx.w.user.id), prefix:'bed/'});
  assert.ok(other.ok);
  await coveredOperation(current, {...observation(current, '收到后提交前接管'), device:'device0'}, '收到后提交前接管', 'bed/synthetic/device0', first.lease);
});

test('orphan reclamation after Hub receipt and before submission keeps the completed interval proof', async t => {
  const ctx = await world(t);
  const {db, service:old} = leasesOf(t, ctx, async () => new Date(Date.now() - 120000));
  const orphan = await old.acquire({keys:['bed/synthetic/orphan0'], holder:{user:ctx.w.admin.id, run:newId('run')}, prefix:'bed/'});
  assert.ok(orphan.ok);
  const current = await captureRun(ctx);
  const latest = new LeaseService(db, {records:ctx.w.kit.store});
  assert.equal(await latest.reclaimOrphans(), 1);
  await coveredOperation(current, {...observation(current, '收到后提交前回收'), device:'orphan0'}, '收到后提交前回收', 'bed/synthetic/orphan0', orphan.lease);
});

test('batch force release after Hub receipt and before submission keeps every completed interval proof', async t => {
  const ctx = await world(t);
  const now = Date.now();
  const {db, service:old} = leasesOf(t, ctx, async () => new Date(now - 4000));
  const keys = ['bed/synthetic/first0', 'bed/synthetic/second0'];
  const first = await old.acquire({keys:[keys[0]], holder:holder(ctx), prefix:'bed/', ttlSeconds:1, maxTtlSeconds:600});
  const second = await old.acquire({keys:[keys[1]], holder:holder(ctx), prefix:'bed/', ttlSeconds:1, maxTtlSeconds:600});
  assert.ok(first.ok && second.ok);
  const extending = new LeaseService(db, {records:ctx.w.kit.store, now:async () => new Date(now - 3500)});
  assert.ok((await extending.extend({keys, holder:holder(ctx), ttlSeconds:60, maxTtlSeconds:600})).ok);
  const current = await captureRun(ctx);
  const latest = new LeaseService(db, {records:ctx.w.kit.store});
  assert.ok((await latest.forceRelease({keys, by:ctx.w.admin.id, reason:'合成批量强制释放'})).ok);
  for (const [index, device] of ['first0', 'second0'].entries()) {
    await coveredOperation(current, {...observation(current, `收到后提交前强制释放 ${device}`), device}, `收到后提交前强制释放 ${device}`, keys[index]!, index === 0 ? first.lease : second.lease);
  }
});

test('a frozen old pack replays a legacy operation without device or lease fields', async t => {
  const revision = '886d9f4c8a04630fcb70257becbec0589684500c';
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'operation-frozen-pack-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const archive = execFileSync('git', ['archive', revision, 'packs/workflow/knowledge-contribution'], {cwd:repository, maxBuffer:32 * 1024 * 1024});
  execFileSync('tar', ['-x', '-C', directory], {input:archive});
  const packDirectory = join(directory, 'packs/workflow/knowledge-contribution');
  const manifest = JSON.parse(await readFile(join(packDirectory, 'pack.json'), 'utf8')) as {id:string; version:string};
  const digest = manifestDigest(manifest);
  const ctx = await world(t, packDirectory);
  assert.equal(ctx.run.pack, `${manifest.id}@${manifest.version}`);
  assert.equal(ctx.run.pack_digest, digest);

  const legacy = observation(ctx, '冻结旧包操作');
  delete legacy.source.artifact;
  assert.ok(!('device' in legacy) && !('bed' in legacy) && !('lease' in legacy) && !('lease_id' in legacy));
  const answer = await submit(ctx, legacy, '冻结旧包操作');
  const saved = await stored(ctx, answer);
  for (const field of ['device', 'bed', 'lease', 'lease_id', 'lease_unconfirmed']) assert.ok(!(field in saved.feeding), field);
  assert.equal(saved.receipt.device, undefined);
  assert.equal(saved.receipt.lease, undefined);
  assert.equal(saved.view.status, 'valid');
  assert.equal(saved.view.note, null);
  const first = await ctx.w.knowledge.layers.contributions.readView(saved.receipt.record, ctx.w.admin);
  const second = await ctx.w.knowledge.layers.contributions.readView(saved.receipt.record, ctx.w.admin);
  assert.deepEqual(second, first);
  const replay = await submit(ctx, legacy, '冻结旧包操作');
  assert.equal(replay.acceptance, 'accepted', JSON.stringify(replay.errors));
  assert.equal(replay.result?.contributions?.stored[0]?.record, saved.receipt.record);
  assert.deepEqual(await ctx.w.knowledge.layers.contributions.readView(saved.receipt.record, ctx.w.admin), first);
});
