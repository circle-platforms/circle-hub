import {effectsDocument} from '../../hub/dispatch/testing/effects.ts';
// Scenario 25 (acceptance): the test-bed pack end to end through the real Hub and the MCP client. An admin publishes a
// synthetic inventory with `doc put` (the named document doc:doc:bed-topology); a user searches and acquires; the
// second user on the same device is refused with LEASE_UNAVAILABLE and the earliest free moment; the booking's lineage
// extends and releases it (the honest "你没有持有这个预订" without the predecessor), and another user books the freed
// device; a build requirement compares against the manifest's declared installs (声明，未核对; the FAMY alias counts
// as its base build; no record stays unknown); facts gives the listener and the blind address; a manifest with a
// duplicate address refuses the whole call with its pointer; a user the pack is not assigned to gets the neutral
// SOURCE_UNAVAILABLE. Synthetic addresses only (192.0.2.0/24).
import assert from 'node:assert/strict';
import {addSyntheticExecutor} from '../../hub/dispatch/testing/credentials.ts';
import { after, before, describe, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { INDEX } from '../../hub/runs/engine/store.ts';
import { openBed, type Bed } from './support/hub.ts';
import type { McpClient } from './support/mcp.ts';

/** The synthetic inventory: bed-a (full: lb, router, client, server, console) and bed-b (lb + client, afamx1 with a blind address). */
const INVENTORY = {
  schema: 'test-bed-manifest@1',
  beds: [
    {
      name: 'bed-a',
      devices: [
        { name: 'afamx0', type: 'load-balancer', ipv4: ['192.0.2.10/26', '192.0.2.74/26'], ipv6: [], installed: { build: 'Rel_FAMX_10_6_1_8' } },
        { name: 'router0', type: 'router', ipv4: ['192.0.2.1/26'], ipv6: [] },
        { name: 'client0', type: 'client', ipv4: ['192.0.2.80/26'], ipv6: [] },
        { name: 'server0', type: 'server', ipv4: ['192.0.2.90/26'], ipv6: [] },
        { name: 'console0', type: 'console', ipv4: ['192.0.2.140/26'], ipv6: [] },
      ],
      services: [{ host: 'server0', ip: '192.0.2.90', proto: 'tcp', port: 80 }],
      reserved: ['192.0.2.1-192.0.2.9', '192.0.2.65-192.0.2.69'],
    },
    {
      name: 'bed-b',
      devices: [
        { name: 'afamx1', type: 'load-balancer', ipv4: ['192.0.2.130/26', '192.0.2.194/26'], ipv6: [], installed: { build: 'Rel_FAMY_10_6_1_8', base: 'Rel_FAMX_10_6_1_8' } },
        { name: 'client1', type: 'client', ipv4: ['192.0.2.150/26'], ipv6: [] },
      ],
      services: [],
      reserved: [],
    },
  ],
};

/** A manifest with one address on two devices: refused as a whole. */
const DUPLICATE = {
  schema: 'test-bed-manifest@1',
  beds: [
    {
      name: 'bed-dup',
      devices: [
        { name: 'afamx0', type: 'load-balancer', ipv4: ['192.0.2.10/26'], ipv6: [] },
        { name: 'router0', type: 'router', ipv4: ['192.0.2.10/26'], ipv6: [] },
      ],
      services: [],
      reserved: [],
    },
  ],
};

interface Claim {
  statement: { text: string; data?: unknown; verdict?: string };
  qualifier?: { nature?: string };
  warrant?: Record<string, unknown>;
}

interface RunRecordBody {
  sources?: Array<{ external?: string | null }>;
  groups?: Array<Record<string, unknown>>;
  leases?: Array<{ lease: string; keys: string[]; until: string | null }>;
}

interface ResultBody {
  partitions?: Record<string, Array<{ requirements?: Array<{ claims?: Claim[] }> }>>;
  cross_item?: Claim[];
}

/** Every claim of the run's latest validation result: per-item claims from the partitions plus the cross-item ones. */
async function claimsOf(bed: Bed, run: string): Promise<Claim[]> {
  const page = await bed.hub.records.store.find({ key: INDEX.resultRun, value: run, kind: 'validation_result', limit: 10, newestFirst: true });
  assert.ok(page.items.length > 0, `a validation result of ${run}`);
  const body = page.items[0]!.body as ResultBody;
  const claims: Claim[] = [];
  for (const partition of Object.values(body.partitions ?? {})) {
    for (const bucket of partition) for (const requirement of bucket.requirements ?? []) claims.push(...(requirement.claims ?? []));
  }
  claims.push(...(body.cross_item ?? []));
  return claims;
}

describe('scenario 25: test-bed search, facts and acquire through the real Hub', () => {
  let postgres: TemporaryPostgres;
  let bed: Bed;
  let client: McpClient;

  before(async () => {
    postgres = await startPostgres();
    bed = await openBed({ postgres });
    // The administrator publishes the inventory as a named document.
    await bed.hub.hub.docs.put(bed.hub.admin.principal, 'bed-topology', new TextEncoder().encode(JSON.stringify(INVENTORY)), { fileName: 'bed-topology.json' });
    await bed.hub.hub.docs.put(bed.hub.admin.principal, 'bed-topology-dup', new TextEncoder().encode(JSON.stringify(DUPLICATE)), { fileName: 'bed-topology-dup.json' });
    const user = await bed.user('台架用户', ['test-bed']);
    client = await bed.connect(user, 'sess-s25');
  });

  after(async () => {
    await bed?.close();
    await postgres?.stop();
  });

  test('search: the beds get their conclusions with the exact "Hub 记录里" wording, the doc frozen with its digest', async () => {
    const started = await client.call('start_run', {
      pack: 'test-bed',
      inputs: { inventory: { external: 'doc:doc:bed-topology' } },
      parameters: { action: 'search', need: { devices: [{ type: 'load-balancer', count: 1 }, { type: 'client', count: 1 }] } },
    });
    assert.equal(started.isError, false, started.text.slice(0, 800));
    const run = (started.out as { run?: { run?: string; sources?: Array<{ external?: string | null }> } }).run;
    assert.ok(run?.run, 'the run id');
    const shown = await bed.hub.hub.docs.show('bed-topology');
    assert.ok(shown);
    const sha = shown.sha256;
    assert.ok(run.sources?.some((s) => s.external === `doc:doc:bed-topology@${sha}`), 'the inventory froze with its digest at start');
    const record = await bed.hub.records.store.find({ key: INDEX.runId, value: run.run, kind: 'run', limit: 1 });
    const body = record.items[0]!.body as RunRecordBody;
    const group = body.groups?.[0] as { action?: string; manifest?: unknown } | undefined;
    assert.equal(group?.action, 'search');
    assert.ok(group?.manifest, 'the manifest is frozen in the run groups');
    const claims = await claimsOf(bed, run.run);
    const statements = claims.map((c) => c.statement.text);
    assert.ok(statements.some((text) => text.includes('bed-a') && text.includes('Hub 记录里空闲（未排除本地操作）')), JSON.stringify(statements).slice(0, 400));
    assert.ok(statements.some((text) => text.includes('bed-b') && text.includes('Hub 记录里空闲（未排除本地操作）')), 'bed-b fits the need too');
    const short = await client.call('start_run', {
      pack: 'test-bed',
      inputs: { inventory: { external: 'doc:doc:bed-topology' } },
      parameters: { action: 'search', need: { devices: [{ type: 'load-balancer', count: 2 }] } },
    });
    assert.equal(short.isError, false);
    const shortRun = (short.out as { run?: { run?: string } }).run?.run;
    assert.ok(shortRun);
    const shortClaims = await claimsOf(bed, shortRun);
    assert.ok(shortClaims.some((c) => c.statement.text.includes('bed-b') && c.statement.text.includes('需要 2 台负载均衡，台架里有 1 台')), 'bed-b says what it lacks');
  });

  test('acquire: the lease is granted and frozen; the second user on the same device is refused with the earliest free moment', async () => {
    const started = await client.call('start_run', {
      pack: 'test-bed',
      inputs: { inventory: { external: 'doc:doc:bed-topology' } },
      parameters: { action: 'acquire', bed: 'bed-a', need: { devices: [{ type: 'load-balancer', count: 1 }, { type: 'client', count: 1 }] } },
    });
    assert.equal(started.isError, false, started.text.slice(0, 800));
    const run = (started.out as { run?: { run?: string } }).run?.run;
    assert.ok(run);
    const record = await bed.hub.records.store.find({ key: INDEX.runId, value: run, kind: 'run', limit: 1 });
    const body = record.items[0]!.body as RunRecordBody;
    assert.ok(body.leases !== undefined && body.leases.length > 0, 'the granted leases are in the run record');
    assert.deepEqual(body.leases.flatMap((l) => l.keys).sort(), ['bed/bed-a/afamx0', 'bed/bed-a/client0']);
    const until = body.leases[0]!.until;
    const view = await bed.hub.leases.view('bed/');
    assert.ok(view.entries.some((e) => e.key === 'bed/bed-a/afamx0' && e.until === until), 'the lease table holds the rows');

    const other = await bed.user('台架用户乙', ['test-bed']);
    const otherClient = await bed.connect(other, 'sess-s25-b');
    const refused = await otherClient.call('start_run', {
      pack: 'test-bed',
      inputs: { inventory: { external: 'doc:doc:bed-topology' } },
      parameters: { action: 'acquire', bed: 'bed-a', need: { devices: [{ type: 'load-balancer', count: 1 }] } },
    });
    assert.equal(refused.isError, true, 'the same device is held');
    const error = (refused.out as { errors?: Array<{ code: string; message: string }> }).errors?.[0];
    assert.ok(error, 'the refusal carries its error');
    assert.equal(error.code, 'LEASE_UNAVAILABLE');
    assert.match(error.message, /bed\/bed-a\/afamx0/);
    assert.equal(until,null);
    assert.ok(!error.message.includes('最早空闲'), 'an unbounded reservation never invents a release time');
  });

  test('legacy extension is rejected and a reservation releases only through its lineage',async()=>{
    const inputs={inventory:{external:'doc:doc:bed-topology'}};
    const booked=await client.call('start_run',{pack:'test-bed',inputs,parameters:{action:'acquire',bed:'bed-b',need:{devices:[{type:'load-balancer',count:1},{type:'client',count:1}]}}});
    assert.equal(booked.isError,false,booked.text);
    const booking=(booked.out as {run:{run:string}}).run.run;
    const row=(await bed.hub.records.store.find({key:INDEX.runId,value:booking,kind:'run'})).items[0]!.body as RunRecordBody;
    assert.equal(row.leases![0]!.until,null);
    for(const parameters of [{action:'extend',booking},{action:'acquire',hours:2}]){
      const legacy=await client.call('start_run',{pack:'test-bed',inputs,predecessor:booking,parameters});
      assert.equal(legacy.isError,true);assert.match(JSON.stringify(legacy.out),/台架预订不限时长，用完由运行释放/);
    }
    const unlinked=await client.call('start_run',{pack:'test-bed',inputs,parameters:{action:'release',booking}});
    assert.equal(unlinked.isError,true);assert.match(JSON.stringify(unlinked.out),/你没有持有这个预订/);
    const released=await client.call('start_run',{pack:'test-bed',inputs,predecessor:booking,parameters:{action:'release',booking}});
    assert.equal(released.isError,false,released.text);
    assert.ok(!(await bed.hub.leases.view('bed/')).entries.some(r=>r.key==='bed/bed-b/afamx1'));
    const other=await bed.user('合成后继预订人',['test-bed']);const next=await bed.connect(other,'s25-new-booking');
    const rebooked=await next.call('start_run',{pack:'test-bed',inputs,parameters:{action:'acquire',bed:'bed-b',need:{devices:[{type:'load-balancer',count:1}]}}});
    assert.equal(rebooked.isError,false,rebooked.text);
  });

  test('search with a build requirement: the declared installs answer 声明，未核对, an alias is the same build, no record stays unknown', async () => {
    const started = await client.call('start_run', {
      pack: 'test-bed',
      inputs: { inventory: { external: 'doc:doc:bed-topology' } },
      parameters: { action: 'search', need: { devices: [{ type: 'load-balancer', count: 1 }], build: 'Rel_FAMX_10_6_1_8' } },
    });
    assert.equal(started.isError, false, started.text.slice(0, 800));
    const run = (started.out as { run?: { run?: string } }).run?.run;
    assert.ok(run);
    const claims = await claimsOf(bed, run);
    const statements = claims.map((c) => c.statement.text);
    assert.ok(statements.some((text) => text.includes('bed-a') && text.includes('构建一致（Rel_FAMX_10_6_1_8，声明，未核对）')), JSON.stringify(statements).slice(0, 500));
    assert.ok(statements.some((text) => text.includes('bed-b') && text.includes('构建一致（Rel_FAMX_10_6_1_8，声明，未核对）')), 'bed-b’s FAMY name maps to its base FAMX build');

    // A need the deciding device has no record for: unknown, never a mismatch.
    const noRecord = await client.call('start_run', {
      pack: 'test-bed',
      inputs: { inventory: { external: 'doc:doc:bed-topology' } },
      parameters: { action: 'search', need: { devices: [{ type: 'client', count: 1 }], build: 'Rel_FAMX_10_6_1_8' } },
    });
    assert.equal(noRecord.isError, false);
    const noRecordRun = (noRecord.out as { run?: { run?: string } }).run?.run;
    assert.ok(noRecordRun);
    const noRecordClaims = await claimsOf(bed, noRecordRun);
    assert.ok(noRecordClaims.some((c) => c.statement.text.includes('bed-a') && c.statement.text.includes('没有记录（未知）')), 'client0 has no declared install: unknown');
    assert.ok(!noRecordClaims.some((c) => c.statement.text.includes('构建不一致')), 'no record is never a mismatch');

    // A mismatch names the upgrade, still declared and unchecked.
    const mismatch = await client.call('start_run', {
      pack: 'test-bed',
      inputs: { inventory: { external: 'doc:doc:bed-topology' } },
      parameters: { action: 'search', need: { devices: [{ type: 'load-balancer', count: 1 }], build: 'Rel_FAMX_10_6_1_9' } },
    });
    assert.equal(mismatch.isError, false);
    const mismatchRun = (mismatch.out as { run?: { run?: string } }).run?.run;
    assert.ok(mismatchRun);
    const mismatchClaims = await claimsOf(bed, mismatchRun);
    assert.ok(mismatchClaims.some((c) => c.statement.text.includes('bed-a') && c.statement.text.includes('需要升级到 Rel_FAMX_10_6_1_9，声明，未核对')), JSON.stringify(mismatchClaims.map((c) => c.statement.text)).slice(0, 500));
  });

  test('facts: the listener of bed-a and the blind address of bed-b, computed from the frozen manifest', async () => {
    const started = await client.call('start_run', {
      pack: 'test-bed',
      inputs: { inventory: { external: 'doc:doc:bed-topology' } },
      parameters: { action: 'facts' },
    });
    assert.equal(started.isError, false, started.text.slice(0, 800));
    const factsRun = (started.out as { run?: { run?: string } }).run?.run;
    assert.ok(factsRun);
    const claims = await claimsOf(bed, factsRun);
    const listening = claims.find((c) => c.statement.text.includes('bed-a'));
    assert.ok(listening, 'a claim of bed-a');
    const dataA = listening.statement.data as { listeners?: Array<{ address: string }>; blind?: unknown[] };
    assert.deepEqual((dataA.listeners ?? []).map((l) => l.address), ['192.0.2.10', '192.0.2.74'], 'both afamx0 addresses listen');
    assert.deepEqual(dataA.blind, [], 'no blind address on bed-a');
    const claimB = claims.find((c) => c.statement.text.includes('bed-b'));
    const dataB = (claimB === undefined ? {} : claimB.statement.data) as { blind?: Array<{ address: string; subnet: string }> };
    assert.deepEqual((dataB?.blind ?? []).map((b) => [b.address, b.subnet]), [['192.0.2.194', '192.0.2.192/26']], 'afamx1 has a blind address on the segment without a trigger');
  });

  test('a manifest with a duplicate address refuses the whole call with the pointer, and an unassigned user gets SOURCE_UNAVAILABLE', async () => {
    const dup = await client.call('start_run', {
      pack: 'test-bed',
      inputs: { inventory: { external: 'doc:doc:bed-topology-dup' } },
      parameters: { action: 'search' },
    });
    assert.equal(dup.isError, true, 'the invalid inventory refuses the call');
    const text = JSON.stringify(dup.out);
    assert.match(text, /test-bed.manifest_invalid|台架清单/);
    assert.match(text, /\/beds\/0\/devices\/1\/ipv4\/0/, 'the pointer of the duplicate address is named');
    const outsider = await bed.user('没分配的人', []);
    const outsideClient = await bed.connect(outsider, 'sess-s25-c');
    const neutral = await outsideClient.call('start_run', {
      pack: 'test-bed',
      inputs: { inventory: { external: 'doc:doc:bed-topology' } },
      parameters: { action: 'search' },
    });
    assert.equal(neutral.isError, true);
    assert.equal((neutral.out as { errors?: Array<{ code: string }> }).errors?.[0]?.code, 'SOURCE_UNAVAILABLE');
  });
  test('A registers, B books, C sees no holder identity, and owner release fences the former lineage',async()=>{
    const {adminCommands}=await import('../../hub/server/cli-admin.ts');
    const {memoryOperatorTokens}=await import('../../hub/server/assemble/operator-token.ts');
    const {newId,sha256Hex}=await import('../../hub/records/api.ts');
    const {DispatchService,ExecutorDefinition,verifyInput,registrationMissing}=await import('../../hub/dispatch/api.ts');
    const {definition}=await import('../../hub/dispatch/testing/definition.ts');
    const inventory={schema:'test-bed-manifest@1',beds:[{name:'owned',devices:[{name:'client',type:'client',ipv4:['192.0.2.20/26'],ipv6:[]}],services:[],reserved:[]}]};
    const admin=bed.hub.admin;
    await bed.hub.hub.docs.put(admin.principal,'ownership-topology',new TextEncoder().encode(JSON.stringify(inventory)),{fileName:'ownership.json'});
    const a=await bed.user('合成登记人',['test-bed']);const b=await bed.user('合成预订人',['test-bed']);const c=await bed.user('合成第三人',['test-bed']);
    const ca=await bed.connect(a,'ownership-a');const cb=await bed.connect(b,'ownership-b');const cc=await bed.connect(c,'ownership-c');
    const inputs={inventory:{external:'doc:doc:ownership-topology'}};
    const call=(client:McpClient,parameters:Record<string,unknown>)=>client.call('start_run',{pack:'test-bed',inputs,parameters});
    const stored=async(run:string)=>(await bed.hub.records.store.find({key:INDEX.runId,value:run,kind:'run',limit:1})).items[0]!;
    const runId=(answer:Awaited<ReturnType<McpClient['call']>>)=>{assert.equal(answer.isError,false,answer.text);return (answer.out as {run:{run:string}}).run.run;};
    runId(await call(ca,{action:'register',bed:'owned'}));
    const booking=runId(await call(cb,{action:'acquire',bed:'owned',need:{devices:[{type:'client',count:1}]}}));
    const booked=await stored(booking);const key='bed/owned/client';
    const before=(await bed.hub.leases.holderSnapshot([key]))[0]!;
    assert.equal(before.expires_at,null);
    const ownSearch=runId(await call(ca,{action:'search'}));const otherSearch=runId(await call(cc,{action:'search'}));
    const ownText=JSON.stringify(await claimsOf(bed,ownSearch));const otherText=JSON.stringify(await claimsOf(bed,otherSearch));
    assert.ok(ownText.includes(b.user.name)&&ownText.includes(booking)&&ownText.includes(before.run));
    assert.ok(otherText.includes(booking)&&!otherText.includes(b.user.name)&&!otherText.includes(b.user.id));
    const invoke=async(args:string[])=>{
      const out:string[]=[];
      const command=adminCommands({tokens:()=>memoryOperatorTokens(admin.token),assembly:{leases:bed.hub.leases}}).find(cmd=>cmd.name==='lease')!;
      await command.run(args,{io:{stdout:line=>out.push(line),stderr:()=>{},env:{},cwd:process.cwd()},config:()=>bed.hub.deps.config,records:async()=>bed.hub.records,deps:async()=>bed.hub.deps,actingAdmin:async()=>admin.principal});
      return out.join('\n');
    };
    const listing=await invoke(['list','--prefix','bed/owned/']);
    assert.ok(listing.includes(a.user.name)&&listing.includes(b.user.name)&&listing.includes(booking));
    assert.ok(!listing.includes('lse_')&&!listing.includes('fencing'));
    const refused=await call(cc,{action:'force_release',bed:'owned',reason:'合成第三人要求'});
    assert.equal(refused.isError,true);assert.match(refused.text,/不是你登记/);
    assert.equal((await call(cc,{action:'register',bed:'owned'})).isError,true);

    // Script only the already-verified proof port; bytes, principals, predecessor booking and resource enforcement
    // use this same assembled Hub. The loopback endpoint is never reached: release must refuse before connect.
    const payload=await bed.hub.records.artifacts.ingest({bytes:new TextEncoder().encode('synthetic ownership payload'),mediaType:'application/octet-stream',origin:{upload:{session:'ownership-proof'}},author:{user:b.user.id},provenanceType:'declared',visibility:{readers:[b.user.id],admins:true,packs:[],shareable:false}});
    const sha=(await bed.hub.hub.docs.show('ownership-topology'))!.sha256;
    const raw=definition('http://127.0.0.1:1/mcp');
    const {probes}=await import('../../hub/dispatch/testing/probes.ts');
    const d=ExecutorDefinition.parse({...raw,credential:'${secret:DEMO_OWNERSHIP_AUTH}',probes,refused_tools:['synthetic_admin_reset'],allowed_tools:[...raw.allowed_tools,'inspect_seat'],target:'owned',resources:[key],manifest_sha256:sha});
    assert.deepEqual(registrationMissing(d),[]);
    const verification=newId('run');const plan=newId('run');const digest=sha256Hex('synthetic ownership workflow');
    const fact={requirement:'workbook_verified',statement:{verdict:'support',text:'合成核验事实',data:{plan_run:plan,sha256:payload.body.sha256,autoids:['synthetic-case'],bed:{id:'owned',manifest_sha256:sha},build:'synthetic-10.6',generator:'synthetic-workflow@1.0.0'}},qualifier:{nature:'fact'},warrant:{producer:'function',id:'synthetic.verify@1'},validity:{status:'valid'}};
    const detail={run:{...(booked.body as object),run:verification,pack:'synthetic-workflow@1.0.0',pack_digest:digest,runner:b.user.id,predecessor:plan,items:[{id:'synthetic-item'}],sources:[{reference:`src:${payload.body.sha256}`,slot:'synthetic-artifact',role:'artifact_under_verification'},{reference:`src:${sha}`,role:'expected'}]},submissions:[],latest:{record:sha256Hex('synthetic validation'),result:{run:verification,acceptance:'accepted',errors:[],partitions:{delivered:[{item:'synthetic-item',requirements:[{requirement:'workbook_verified',status:'satisfied',claims:[fact]}]}],rejected:[],incomplete:[],quarantined:[]},cross_item:[]}}} as unknown as import('../../hub/ports.ts').RunDetail;
    const runs={getRun:async(by:import('../../hub/records/api.ts').Principal,id:string)=>id===verification?detail:id===plan?{...detail,run:{...detail.run,run:plan,predecessor:booking}}:bed.hub.hub.runs.getRun(by,id)};
    const allowed=effectsDocument({target:'owned',manifest_sha256:sha,build:'synthetic-10.6',sha256:payload.body.sha256,items:['synthetic-case'],generator:'synthetic-workflow@1.0.0'});
    const workflows={byDigest:async()=>({pack:{id:'synthetic-workflow',version:'1.0.0',digest},requirements:[{key:'workbook_verified',required:true,target:'item',accepted_producer:'fact'}],readJson:async()=>allowed}) as unknown as import('../../hub/ports.ts').LoadedWorkflow};
    const proof=await verifyInput(admin.principal,verification,d,bed.hub.records,runs,workflows,new Date());
    assert.ok(proof.ancestors.includes(booking));assert.equal(proof.user,b.user.id);
    const dispatcher=new DispatchService({records:bed.hub.records,leases:bed.hub.leases,runs,workflows});
    const executor=await addSyntheticExecutor(bed.hub.records,dispatcher.registry,admin.principal,d,'synthetic-ownership-key');
    const reason='  合成主人要求收回  ';
    runId(await call(ca,{action:'force_release',bed:'owned',reason}));
    const after=(await bed.hub.leases.holderSnapshot([key]))[0]!;
    assert.ok(after.released&&after.fencing>before.fencing);
    assert.equal((await stored(booking)).digest,booked.digest,'the original booking is immutable');
    const refusedDispatch=await dispatcher.dispatch(admin.principal,verification,executor.id);
    assert.equal(refusedDispatch.outcome,'not_dispatched');assert.match(refusedDispatch.missing_fact!,/血缘/);
    const dispatchEvents=await dispatcher.journal.events(refusedDispatch.job);const refusal=dispatchEvents.find(event=>event.body.detail.phase==='boundary_refused')!;
    assert.equal(refusal.body.detail.boundary_clause,5);assert.equal(refusal.body.error_code,'LEASE_UNAVAILABLE');assert.equal(dispatchEvents.some(event=>event.body.detail.phase==='intent'),false);
    assert.ok((await bed.hub.leases.actionLog('bed/owned/')).some(row=>row.op==='force_release'&&row.by===a.user.id&&row.reason===reason));
    await invoke(['register','bed/owned/','--owner',c.user.id,'--reason','合成管理员更正']);
    const nextBooking=runId(await call(cb,{action:'acquire',bed:'owned',need:{devices:[{type:'client',count:1}]}}));
    const oldOwnerSearch=runId(await call(ca,{action:'search'}));const newOwnerSearch=runId(await call(cc,{action:'search'}));
    assert.ok(!JSON.stringify(await claimsOf(bed,oldOwnerSearch)).includes(b.user.name));
    assert.ok(JSON.stringify(await claimsOf(bed,newOwnerSearch)).includes(b.user.name));
    const updated=await invoke(['list','--prefix','bed/owned/']);
    assert.ok(updated.includes(c.user.name)&&updated.includes(b.user.name)&&updated.includes(nextBooking));
    runId(await call(cc,{action:'force_release',bed:'owned',reason:'合成收尾'}));
    runId(await call(cc,{action:'unregister',bed:'owned',reason:'合成注销'}));
    assert.deepEqual(await bed.hub.leases.registrations('bed/owned/'),[]);
  });

});
