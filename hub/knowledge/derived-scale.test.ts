// Synthetic scale guard: 3,000 actual composition sources, 20 admitted sources and 200 credential-bearing entries.
// Instrument SQL executions and scanner byte counts, never SQL values, source bytes or match text.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { TreeRootBody, type RootSource } from '../../contracts/src/knowledge.ts';
import { IndexView } from '../../contracts/src/views.ts';
import type { KnownBuild } from '../../contracts/src/product.ts';
import { canonicalBytes, openRecords, sha256Hex, type ActionBody } from '../records/index.ts';
import { createKnowledgeReader } from './api.ts';
import { INDEX, SCHEMAS } from './store.ts';
import { DEFAULT_PRODUCERS, BASE_CATALOG, casesProducer, catalogXml, makeWorld, mindMap, startPostgres } from './test-support.ts';
import { mapLimited } from './concurrency.ts';
import type { TemporaryPostgres } from '../testing/postgres.ts';

let postgres: TemporaryPostgres;
before(async () => { postgres = await startPostgres(); });
after(() => postgres?.stop());

test('one view prepares its 3000-source graph once and budgets 200 covered entries without truncation', {timeout:120_000}, async t => {
  const started = performance.now();
  const phases: Record<string, { queries: number; ms: number ;}> = {};
  let stage = 'setup';
  let mark = started;
  const switchStage = (next: string) => { (phases[stage] ??= { queries: 0, ms: 0 }).ms += performance.now() - mark; stage = next; mark = performance.now(); };
  const rawQuery = pg.Client.prototype.query;
  t.mock.method(pg.Client.prototype, 'query', function (this: pg.Client, ...args: unknown[]) {
    (phases[stage] ??= { queries: 0, ms: 0 }).queries++;
    return Reflect.apply(rawQuery, this, args);
  });
  t.after(() => { switchStage('done'); t.diagnostic(JSON.stringify({ phases, wallMs: performance.now() - started, maxRSS: process.resourceUsage().maxRSS })); });
  const w = await makeWorld(postgres,{pack:{declaration:{producers:[DEFAULT_PRODUCERS[0],casesProducer({batch:20})]}},knowledge:{limits:{inlineRows:1}}});
  let counted: Awaited<ReturnType<typeof openRecords>> | undefined;
  t.after(async () => { await counted?.close(); await w.close(); });
  const build: KnownBuild = { name: 'Rel_ACME_10_6_15', family: 'ACME', line: '10.6', base: 'Rel_ACME_10_6_15', platform: null, built_at: null, released_at: null, sources: { tree: 'site:tree:scale', cases: [] }, root: null };
  w.external.set('site:tree:scale',{bytes:catalogXml(BASE_CATALOG),mediaType:'application/xml'});
  const oldPins = new Map<string,string>();
  let admittedBytes = 0;
  for (let d=0; d<20; d++) {
    const id = `store:mindmap:hit-${d}`;
    const text = mindMap({id:`hit-${d}`,module:'synthetic-module'},Array.from({length:10},(_,c) => ({id:`case-${d}-${c}`,text:`[cmd: system reboot] synthetic case ${d}-${c} password = FtpScale${d}7349`,expected:['ok']})));
    w.external.set(id,{bytes:text,mediaType:'application/json'});
    (build.sources.cases as string[]).push(id);
    const held = await w.kit.artifacts.ingest({bytes:Buffer.from(text),mediaType:'application/json',origin:{read:{object:id}},author:{user:null},provenanceType:'observed',visibility:{readers:[],admins:true,packs:[],shareable:false}});
    oldPins.set(held.body.sha256,held.digest);
    await w.kit.artifacts.acceptFindings(w.admin,held.body.sha256,'合成用例中的虚构口令');
    admittedBytes += Buffer.byteLength(text);
  }
  const produced = await w.knowledge.produceTree({product:w.product,build});
  assert.equal(produced.ok,true,produced.reason ?? '');
  assert.ok(produced.root && produced.composition && produced.action);
  const root = TreeRootBody.parse((await w.kit.store.get(produced.composition))?.body);
  assert.ok(root.parts);
  const currentCasePart = await w.kit.store.get<{rows:RootSource[]}>(root.parts.sources[0].record);
  assert.ok(currentCasePart);
  // Keep the actual historical held records as pins. Current acceptance, not their stored tier, must decide eligibility.
  for (const row of currentCasePart.body.rows) if (oldPins.has(row.sha256)) { row.artifact = oldPins.get(row.sha256)!; row.read_tier = 'retain_only'; }
  switchStage('empty-source-ingest');
  const empty: RootSource[] = [];
  await mapLimited(Array.from({ length: 2979 }, (_, i) => i), 32, async i => {
    const id = `store:mindmap:empty-${i}`, bytes = Buffer.from(mindMap({id:`empty-${i}`},[]));
    const artifact = await w.kit.artifacts.ingest({bytes,mediaType:'application/json',origin:{read:{object:id}},author:{user:null},provenanceType:'observed',visibility:{readers:[],admins:true,packs:[],shareable:false}});
    empty.push({...currentCasePart.body.rows[0],external:id,sha256:artifact.body.sha256,artifact:artifact.digest,size:bytes.length,read_tier:'model_readable'});
  });
  switchStage('composition-and-getNodes');
  empty.sort((a,b) => a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0);
  const allSources = [...currentCasePart.body.rows,...empty].sort((a,b) => a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0);
  root.parts.sources = [];
  for (let i=0;i<allSources.length;i+=500) {
    const rows = allSources.slice(i,i+500), part = await w.kit.store.put({kind:'tree_root',schema:SCHEMAS.sourcesPart,provenance:'projected',body:{rows}});
    root.parts.sources.push({record:part.digest,rows:rows.length,first:rows[0].sha256,last:rows.at(-1)!.sha256});
  }
  const sourceList=canonicalBytes([...build!.sources.cases as string[],...empty.map(row=>row.external)]);
  await w.kit.objects.put(sourceList,'application/json');
  root.build!.sources.cases={list:sha256Hex(sourceList),count:2999};
  const composition = await w.kit.store.withTransaction(tx => w.knowledge.store.putRoot(root,tx));
  const action = await w.kit.store.get<ActionBody>(produced.action); assert.ok(action);
  await w.knowledge.store.putAction({...action.body,detail:{...action.body.detail,build:root.build,composition:composition.digest}},[{key:INDEX.produceRoot,value:produced.root},{key:INDEX.produce,value:`acme/${build.name.toLowerCase()}`},{key:INDEX.produceProduct,value:'acme'}]);
  const node = await w.knowledge.getNodes({root:produced.root,paths:['/commands/system/reboot'],depth:0},w.user);
  assert.ok(node);
  const all = node.nodes[0].entries.filter(e => e.kind === 'case');
  assert.equal(all.length,200);
  assert.equal(root.sources.length + root.parts.sources.reduce((n,p) => n+p.rows,0),3000);
  const expected = all.map(e => e.entry).sort();
  let phase: 'setup' | 'view' | 'read' = 'setup';
  const stats = {view:{queries:0,scans:0,bytes:0},read:{queries:0,scans:0,bytes:0}};
  const query = pg.Client.prototype.query;
  t.mock.method(pg.Client.prototype,'query',function(this: pg.Client,...args: unknown[]) {
    // 67 is the measured view: source parts, two scope chunks, the feeding-layer lookup, the answer, coverage refresh and the answer's acceptance lookup.
    if (phase !== 'setup') { const s=stats[phase]; if (++s.queries > (phase === 'view' ? 67 : 16)) throw new Error('synthetic query budget exceeded'); }
    return Reflect.apply(query,this,args);
  });
  counted = await openRecords({ dataDir: w.kit.config.dataDir, logDir: w.kit.config.logDir, database: w.kit.database, limits: w.kit.config.limits }, {
migrate: false, keyProvider: w.kit.keyProvider, onCredentialScan: length => {
    if (phase === 'setup') return;
    const s=stats[phase]; s.scans++; s.bytes+=length;
    if (phase === 'read') throw new Error('a read rescanned credential bytes');
    if (s.scans > 226) throw new Error('synthetic scanner-call budget exceeded');
  }});
  w.kit.artifacts = counted.artifacts;
  switchStage('view');
  phase = 'view';
  const result = await createKnowledgeReader(w.knowledge).read(`knowledge:index:acme:${build.name}?kind=case&key=module`,{principal:w.user,run:null,purpose:'合成规模验证'});
  switchStage('read-and-withdraw');
  phase = 'setup';
  assert.equal(result.ok,true,result.ok ? '' : result.reason); if (!result.ok) return;
  const output = result.artifacts[0].artifact;
  assert.equal(output.body.read_tier,'model_readable'); assert.equal(output.body.scan.truncated,false);
  assert.equal(output.body.scan.findings.length,200);
  phase = 'read';
  const read = await w.kit.artifacts.source(w.user,output.body.sha256,{record:output.digest});
  phase = 'setup';
  assert.ok(read?.bytes);
  const view = IndexView.parse(JSON.parse(Buffer.from(read.bytes).toString()));
  assert.deepEqual(Object.keys(view.entries).sort(),expected);
  assert.ok(view.notes.some(n => /200 个条目.*来源的受理覆盖/.test(n)));
  assert.ok(!view.notes.some(n => /命中上限没有留下/.test(n)));
  const scopeParts=[...new Set(Object.values(view.scope??{}).flatMap(value=>typeof value==='object'&&value!==null&&'parts' in value?(value as {parts:Array<{sha256:string}>}).parts.map(part=>part.sha256):[]))];
  const scopeBytes=(await Promise.all(scopeParts.map(sha=>w.kit.objects.get(sha)))).reduce((sum,bytes)=>sum+(bytes?.byteLength??0),0);
  assert.equal(scopeParts.length,2,'the 3000-source scope is stored in two bounded chunks');
  assert.equal(stats.view.scans,226,'20 sources + 200 entries + index key, skeleton, final answer, meta and two scope chunks');
  assert.ok(stats.view.bytes <= admittedBytes + 4*canonicalBytes(all).length + 2*output.body.size + scopeBytes + 4096);
  assert.deepEqual([stats.read.scans,stats.read.bytes],[0,0]);
  assert.ok(performance.now() - started < 60_000, 'loose wall-clock regression allowance; controlled measurements establish the 30-second target');
  t.diagnostic(JSON.stringify({sources:3000,admitted:20,entries:200,kept:200,limited:0,sourceScanBytes:admittedBytes,view:stats.view,read:stats.read}));
  // Withdrawal is visible without re-scanning; the immutable coverage fact must not be recalculated on a read.
  assert.ok(output.body.scan.derived?.sources.length);
  await w.kit.artifacts.revokeFindings(w.admin,output.body.scan.derived.sources[0].sha256);
  phase='read'; stats.read.queries=0;
  const withdrawn = await w.kit.artifacts.source(w.user,output.body.sha256,{record:output.digest});
  phase='setup';
  assert.equal(withdrawn?.bytes,null);
  assert.equal(stats.read.bytes,0);
});
