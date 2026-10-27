import {createTestParserRegistry as createDefaultRegistry} from '../testing/parsers.ts';
import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {KnowledgeContributionView} from '../../contracts/src/contributions.ts';
import {RunRecord} from '../../contracts/src/run.ts';
import {KnowledgeStructureSchema} from '../../contracts/src/feeding.ts';
import {startPostgres, type TemporaryPostgres} from '../testing/postgres.ts';
import {makeWorld, catalogXml, BASE_CATALOG} from './test-support.ts';
import {createRunsService} from '../runs/engine/api.ts';
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

async function world(t: {after(fn: () => Promise<void>): void}) {
  const w = await makeWorld(postgres); t.after(() => w.close());
  const build = {name:'Rel_ACME_1_2_15', family:'ACME', line:'1.2', base:'Rel_ACME_1_2_15', platform:null, built_at:'2026-01-02T10:00:00.000Z', released_at:'2026-01-03T10:00:00.000Z', sources:{tree:'site:tree:Rel_ACME_1_2_15'}, root:null};
  w.external.set(build.sources.tree, {bytes:new TextEncoder().encode(catalogXml(BASE_CATALOG)), mediaType:'application/xml'});
  const produced = await w.knowledge.produceTree({product:w.product, build});
  assert.ok(produced.ok, produced.reason ?? '');
  const workflows = new FakeWorkflowStore();
  await workflows.add(fileURLToPath(new URL('../../packs/workflow/knowledge-contribution/', import.meta.url)));
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
  return {db, service:new LeaseService(db, {records:ctx.w.kit.store, ...(now ? {now} : {})})};
}

async function captureRun(ctx: Context, options: {author?: string; capturedAt?: string; text?: string; historicalFinding?: boolean} = {}): Promise<Context> {
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
        origin:{upload:{session:'operation-session', message:null}}, author:{user:author, declared:null}, captured_at:capturedAt,
        provenance_type:'client_captured', read_tier:'model_readable', requested_read_tier:'model_readable',
        visibility:{readers:[author, ctx.w.admin.id], admins:true, packs:[], shareable:false}, scan:{...scan, findings:[], clean:true},
      },
      index:[{key:'artifact.sha256', value:sha256}],
    });
    return artifact;
  })() : await ctx.w.kit.artifacts.ingest({
    bytes, mediaType:'text/plain', name:`operation-capture-${++captureSequence}.txt`, capturedAt,
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

function submit(ctx: Context, feeding: Record<string, unknown>, statement = '合成操作记录') {
  return ctx.service.submitResult(ctx.w.admin, {
    run:ctx.run.run, model:'integration-synthetic@1',
    items:[{item:'assertion', handling:'handled', slots:{contribution:[{code:'assertion', text:statement, data:{root:ctx.root, path, source:{reference:`src:${ctx.sha}/text@1/l/1`, quote}, feeding}}]}}],
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

  const earlyAnswer = await submit(ctx, {...observation(ctx, '采集后才取得'), device:'device0'}, '采集后才取得');
  const early = await stored(ctx, earlyAnswer);
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
  const released = await leases.release({keys:[key], holder:holder(ctx)});
  assert.ok(released.ok);
  const authorized = await stored(authorizedCapture, await submit(authorizedCapture, {...observation(authorizedCapture, '持有期间采集'), device:'device0'}, '持有期间采集'));
  assert.equal(authorized.feeding.lease, acquired.lease);
  assert.equal(authorized.receipt.lease, acquired.lease);
  assert.match(authorized.view.note ?? '', new RegExp(`设备 device0；租约 ${acquired.lease}`));
  assert.match(authorized.text, new RegExp(acquired.lease));

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
  assert.ok((await leases.forceRelease({keys:[key], by:ctx.w.admin.id, reason:'合成接管'})).ok);
  const other = await leases.acquire({keys:[key], holder:holder(ctx, ctx.w.user.id), prefix:'bed/'});
  assert.ok(other.ok);
  assert.notEqual(other.lease, first.lease);
  const retained = await stored(during, await submit(during, {...observation(during, '接管前的上传者'), device:'device0'}, '接管前的上传者'));
  assert.equal(retained.feeding.by, ctx.w.admin.id);
  assert.equal(retained.feeding.lease, first.lease);

  const afterTakeover = await captureRun(ctx);
  const refused = await stored(afterTakeover, await submit(afterTakeover, {...observation(afterTakeover, '接管后的原上传者'), device:'device0'}, '接管后的原上传者'));
  assert.equal(refused.feeding.lease, null);
  assert.match(refused.text, /无租约（未授权）/);

  const byOther = await captureRun(ctx, {author:ctx.w.user.id});
  const current = await stored(byOther, await submit(byOther, {...observation(byOther, '接管后的新上传者'), device:'device0'}, '接管后的新上传者'));
  const candidates = await byOther.w.kit.artifacts.records(byOther.sha);
  assert.equal(current.feeding.by, ctx.w.user.id, JSON.stringify({admin:ctx.w.admin.id, expected:ctx.w.user.id, sources:byOther.run.sources, captures:candidates.map(row => ({digest:row.digest, created_at:row.created_at, body:row.body}))}));
  assert.equal(current.feeding.lease, other.lease);
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
  assert.equal(extendedView.feeding.lease, renewed.lease);

  const current = new LeaseService(db, {records:ctx.w.kit.store});
  const orphanHolder = {user:ctx.w.admin.id, run:newId('run')};
  const orphanResource = 'bed/synthetic/orphan0';
  const orphan = await old.acquire({keys:[orphanResource], holder:orphanHolder, prefix:'bed/'});
  assert.ok(orphan.ok);
  const beforeReclaim = await captureRun(ctx);
  assert.equal(await current.reclaimOrphans(), 1);
  const reclaimed = await stored(beforeReclaim, await submit(beforeReclaim, {...observation(beforeReclaim, '接管记录前的采集'), device:'orphan0'}, '接管记录前的采集'));
  assert.equal(reclaimed.feeding.lease, orphan.lease);
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
    assert.equal(view.feeding.lease, acquired.lease);
  }
  const supplied = await submit(current, {...observation(current, '客户端租约'), device:'device0', lease:'lse_client_supplied'}, '客户端租约');
  assert.equal(supplied.acceptance, 'not_accepted');
  assert.equal(supplied.result?.contributions?.stored.length, 0);
  assert.match(JSON.stringify(supplied.errors), /租约由 Hub 填写，删掉该字段后重交/);
  const hubValues: Record<string, unknown> = {
    binding:{source:'run_lock', build:current.build.name, line:current.build.line}, version:'synthetic-version', build:'synthetic-build',
    line:'1.2', family:'ACME', by:ctx.w.admin.id, run:ctx.run.run, at:new Date().toISOString(), object:'a'.repeat(64),
  };
  for (const field of ['binding', 'version', 'build', 'line', 'family', 'by', 'run', 'at', 'object']) {
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
  const answer = await submit(current, {...observation(current, '同名设备候选不唯一'), device:'device0'}, '同名设备候选不唯一');
  assert.equal(answer.acceptance, 'not_accepted');
  assert.equal(answer.result?.contributions?.stored.length, 0);
  assert.ok(answer.errors.some(error => error.code === 'SOURCE_UNAVAILABLE' && error.message.includes('多份候选租约')));
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
  assert.ok((await current.forceRelease({keys, by:ctx.w.admin.id, reason:'合成批量强制释放'})).ok);
  for (const [index, device] of ['first0', 'second0'].entries()) {
    const expected: string = index === 0 ? first.lease : second.lease;
    const view = await stored(before, await submit(before, {...observation(before, `批量续租 ${device}`), device}, `批量续租 ${device}`));
    assert.equal(view.feeding.lease, expected);
  }
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
  assert.equal(late.feeding.lease, acquired.lease);
  assert.ok(Date.parse(String(early.feeding.at)) < Date.parse(String(late.feeding.at)));

  const plainAnswer = await submit(before, observation(before, '幂等无设备'), '幂等操作');
  const plain = await stored(before, plainAnswer);
  assert.equal(plain.feeding.device, undefined);
  const replayAnswer = await submit(after, {...observation(after, '幂等无设备'), device:'device0'}, '幂等操作');
  const replay = await stored(after, replayAnswer);
  assert.equal(replay.receipt.record, plain.receipt.record);
  assert.equal(replay.receipt.device, undefined);
  assert.equal(replay.receipt.lease, undefined);
  assert.equal(replay.feeding.lease, undefined);
  assert.equal(replay.view.note, null);
});

test('credential withholding keeps the device and unauthorized state without exposing the quote', async t => {
  const ctx = await world(t);
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
