import {createServer} from 'node:http';
import {createTestHub} from '../../hub/server/testing-real.ts';
// Scenario 29: real Hub, temporary PostgreSQL, published deterministic fixture, loopback-only endpoints.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, after, describe, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { RECORD_KINDS } from '../../contracts/generated/protocol.ts';
import { createHash } from 'node:crypto';
import { canonicalBytes, sha256Hex } from '../../hub/records/api.ts';
import { variableCommand, namedSecretCommand, type VariableCommandSession } from '../../hub/server/variables.ts';
import { writePack } from '../../hub/runs/engine/testing/packs.ts';
import { definition } from '../../hub/dispatch/testing/definition.ts';
import { probes } from '../../hub/dispatch/testing/probes.ts';
import { startEndpoint } from '../../hub/dispatch/testing/server.ts';
import { AGILE_ACCOUNT, ROOTS, DOCUMENTS } from '../fixtures/agile/index.ts';
import { openBed, type Bed } from './support/hub.ts';
import type { McpClient } from './support/mcp.ts';
describe('deployment variables',()=>{
const PACK = 'demo-variables-proof', PASSWORD = 'Demo!PortalPassword42', WRONG = 'Demo!WrongPassword43', AUTH = 'Demo!ExecutionAuth42';
let pg: TemporaryPostgres, bed: Bed, client: McpClient, directory: string;
const output: string[] = [];
function adminSession(value = '', by = bed.hub.admin.principal): VariableCommandSession {
    return { ctx: { io: { cwd: bed.hub.records.dataDir } }, options: { readSecret: async () => value }, admin: async () => by, records: async () => bed.hub.records, hub: async () => bed.hub.hub, out: s => output.push(s), err: s => output.push(s) };
}
async function set(name: string, value: string) { return namedSecretCommand(adminSession(value), ['set', '--name', name, '--reason', 'DEMO_ROTATION']); }
const project = `export default function(input:any){const p=input.inputs.find((v:any)=>v.slot==='proof').model.p;return {items:[{id:'demo-item',label:'DEMO',location:{slot:'proof',parser:'json@1',selector:'p'},fields:p}],warnings:[]};}`;
const check = `import {createHash} from 'node:crypto';
export default function(input:any){
 const p=input.subject?.fields??{};const sources=input.sources??{};
 const bad=()=>[{verdict:'refute',code:'${PACK}.mismatch',statement:'合成绑定不一致',grounds:[],tier:'blocking'}];
 if(p.invalid)return bad();
 const payload=sources['src:'+p.sha256],manifest=sources['src:'+p.bed?.manifest_sha256];
 const hash=(s:string)=>createHash(input.table.hash).update(s).digest('hex');
 if(typeof payload!=='string'||typeof manifest!=='string'||hash(payload)!==p.sha256||hash(manifest)!==p.bed.manifest_sha256)return bad();
 let m;try{m=JSON.parse(manifest);}catch{return bad();}if(m.id!==p.bed.id)return bad();
 let plan:any=null;if(p.mode==='verify'){
  for(const text of Object.values(sources)){try{const data=JSON.parse(text as string);const b=data.kind==='validation_result'?data.body:data;if(b.run===p.plan_run&&b.acceptance==='accepted'&&b.partitions?.delivered?.length&&['rejected','incomplete','quarantined'].every(k=>!b.partitions[k]?.length))plan=b;}catch{}}
  if(!plan)return bad();
 }
 return [{verdict:'support',statement:'合成字节与清单已逐项核对',grounds:input.subject?.location?[input.subject.location]:[],tier:'blocking',data:{sha256:p.sha256,autoids:['demo-case'],bed:p.bed,build:p.build,generator:'${PACK}@1.0.0',...(plan?{plan_run:plan.run}:{})}}];
}`;
const payloadSample = 'DEMO_SAMPLE_BYTES', manifestSample = JSON.stringify({ id: 'demo-bed' });
const sampleData = { mode: 'plan', sha256: sha256Hex(payloadSample), bed: { id: 'demo-bed', manifest_sha256: sha256Hex(manifestSample) }, build: 'DEMO_BUILD' };
before(async () => {
    pg = await startPostgres();
    bed = await openBed({ postgres: pg });
    client = await bed.connect(bed.reviewer, 'demo-variables');
    directory = await mkdtemp(join(tmpdir(), 'circle-hub-variables-'));
    const pack = await writePack(directory, { id: PACK, version: '1.0.0', kind: 'workflow', title: '合成变量核验', description: '确定性合成绑定核验，不生成产物', files: {
            'workflow.json': { json: { schema: 'workflow@1', inputs: [{ slot: 'proof', role: 'subject', description: '合成声明', accepts: ['application/json'], required: true, many: false }, { slot: 'payload', role: 'artifact_under_verification', description: '合成产物', accepts: ['text/plain'], required: true, many: false }, { slot: 'manifest', role: 'expected', description: '合成清单', accepts: ['application/json'], required: true, many: false }, { slot: 'plan', role: 'artifact_under_verification', description: '前驱核验结果', accepts: ['application/json'], required: false, many: false }], parameters: [], product: { id: bed.product.line, catalogs: [] }, subject: 'proof', projection: { module: 'functions/project.ts' } } },
            'requirements.json': { json: { schema: 'requirements@1', requirements: [{ key: 'verified', name: '绑定', description: '合成逐项绑定', target: 'item', required: true, done_rule: 'bookkeeping', layers: ['static'], accepted_producer: 'fact', checks: ['verified'], error_handling: [] }], effects: [{
                id: 'submit_demo', resource_kind: 'executor', action: 'submit', effect_class: 'job',
                parameters: { values: { target: ['demo-bed'], manifest_sha256: [sha256Hex(canonicalBytes({ id: 'demo-bed', devices: [1, 2].map(n => ({ interfaces: [{ address: '192.0.2.' + n + '/24' }] })) }))], build: [bed.site.RELEASED], sha256: [sha256Hex('DEMO_EXECUTABLE_BYTES')], items: [['demo-case']], generator: [PACK + '@1.0.0'] } },
                release: { requirements: ['verified'], artifact: 'verified' }, trigger: 'hub_template',
                budget: { count: 1, duration_ms: { executor_max_run_ms: true } }, deadline_ms: 86400000,
                optional: false, policy_checks: ['verified'],
            }] } },
            'policies/binding.json': { json: { schema: 'demo-variables.binding-policy@1', hash: 'sha256' } },
            'checks.json': { json: { schema: 'checks@1', checks: [{ id: 'verified', function: { module: 'functions/check.ts' }, table: 'policies/binding.json', reads: { roles: ['subject', 'artifact_under_verification', 'expected'] }, applies: 'item', judges: 'artifact_under_verification', tier: 'blocking', basis: '合成验收合同：绑定的产物摘要、清单及已满足前驱必须逐项相同' }] } },
            'slots.schema.json': { json: { schema: 'slots@1', item: {}, run: {} } }, 'SKILL.md': '# 合成绑定核验\n\n脚本化客户端提供字节；Hub 只核验绑定。\n', 'functions/project.ts': project, 'functions/check.ts': check,
            'samples/positive/ok.json': { json: { id: 'demo_positive', source: 'author', check: 'verified', note: '正例', subject: { fields: sampleData }, sources: { ['src:' + sampleData.sha256]: payloadSample, ['src:' + sampleData.bed.manifest_sha256]: manifestSample }, expect: [{ verdict: 'support', tier: 'blocking' }] } },
            'samples/negative/no.json': { json: { id: 'demo_negative', source: 'author', check: 'verified', note: '反例', subject: { fields: { invalid: true } }, expect: [{ verdict: 'refute', code: PACK + '.mismatch', tier: 'blocking' }] } },
        } });
    await bed.hub.publishPack(pack);
    await bed.hub.assignPack(bed.reviewer.principal, PACK);
});
after(async () => { await client?.close(); await bed?.close(); await pg?.stop(); if (directory)
    await rm(directory, { recursive: true, force: true }); });
test('two real resources share enrolled names and a rotation reaches both without restarting', async () => {
    const c = bed.hub.hub.connectors, by = bed.reviewer.principal, stub = bed.hub.stubs!.agile;
    const reads = () => Promise.all([c.executeRead(bed.resources.agile.id, 'tree', { id: ROOTS.first }, { principal: by, purpose: 'DEMO' }), c.executeRead(bed.resources.plm!.id, 'story', { id: '31057' }, { principal: by, purpose: 'DEMO' })]);
    await set('DEMO_PORTAL_PASSWORD', AGILE_ACCOUNT.password);
    let before = stub.logins;
    assert.ok((await reads()).every(r => r.ok));
    assert.equal(stub.logins, before + 2);
    stub.setPassword(PASSWORD);
    stub.expireTokens();
    await set('DEMO_PORTAL_PASSWORD', PASSWORD);
    before = stub.logins;
    assert.ok((await reads()).every(r => r.ok));
    assert.equal(stub.logins, before + 2);
    await namedSecretCommand(adminSession(), ['unset', '--name', 'DEMO_PORTAL_PASSWORD', '--reason', 'DEMO_REVOKE']);
    const refused = await client.call('start_run', { pack: 'case-review', product: bed.product.names[0], version: bed.site.LINE, inputs: { subject: { external: 'agile:mindmap:' + DOCUMENTS.review } } });
    assert.equal(refused.isError, true);
    assert.match(JSON.stringify(refused.out), /对你不可用/);
    assert.ok(!JSON.stringify(refused.out).includes('DEMO_PORTAL_PASSWORD'));
    const calls = await bed.hub.records.callLog.query(bed.hub.admin.principal, { tool: 'start_run', limit: 1 });
    assert.match((calls.items[0].admin_reasons ?? []).join('\n'), /secret set --name DEMO_PORTAL_PASSWORD/);
    await set('DEMO_PORTAL_PASSWORD', PASSWORD);
    assert.ok((await reads()).every(r => r.ok));
    await set('DEMO_PORTAL_PASSWORD', WRONG);
    before = stub.logins;
    assert.ok((await reads()).every(r => !r.ok));
    assert.equal(stub.logins, before + 1, 'one refused login across both resources');
    const sent = stub.requests.length;
    assert.ok((await reads()).every(r => !r.ok));
    assert.equal(stub.requests.length, sent);
    await set('DEMO_PORTAL_PASSWORD', PASSWORD);
    assert.ok((await reads()).every(r => r.ok));
});
test('real runs record their own ordinary-variable decisions and metadata listing agrees', async () => {
    const k = bed.hub.records, by = bed.hub.admin.principal;
    const one = await k.variables.setVariable(by, 'DEMO_ROOTS', [ROOTS.first], 'DEMO_ROOTS');
    await bed.hub.hub.connectors.admin.updateResource(by, bed.resources.agile.id, { settings: { roots: '${var:DEMO_ROOTS}' } });
    const start = () => client.call('start_run', { pack: 'case-review', product: bed.product.names[0], version: bed.site.LINE, inputs: { subject: { external: 'agile:mindmap:' + DOCUMENTS.review } } });
    const a = await start();
    assert.equal(a.isError, false, JSON.stringify(a.out.errors));
    const two = await k.variables.setVariable(by, 'DEMO_ROOTS', [ROOTS.first, ROOTS.second], 'DEMO_ROOTS');
    const b = await start();
    assert.equal(b.isError, false);
    for (const [run, decision] of [[a.out.run!.run, one.value.decision.digest], [b.out.run!.run, two.value.decision.digest]]) {
        const actions = (await k.store.find<any>({ key: 'action.run', value: run!, kind: 'action', limit: 500 })).items;
        const uses = actions.flatMap(r => r.schema === 'read-manifest@1' ? r.body.variables ?? [] : []).filter(v => v.name === 'DEMO_ROOTS');
        assert.ok(uses.length);
        assert.ok(uses.every(v => v.decision === decision));
        output.length = 0;
        await variableCommand(adminSession(), ['list', '--run', run!]);
        assert.ok(output.some(line => line.includes('DEMO_ROOTS')));
    }
});
test('a real verification run refuses drift before intent and a fresh verification dispatches once', async (t) => {
    const k = bed.hub.records, by = bed.hub.admin.principal, owner = bed.reviewer.principal, dispatch = bed.hub.hub.dispatch!;
    const manifest = { id: 'demo-bed', devices: [1, 2].map(n => ({ interfaces: [{ address: '192.0.2.' + n + '/24' }] })) };
    const manifestBytes = canonicalBytes(manifest), payload = Buffer.from('DEMO_EXECUTABLE_BYTES');
    const m = await client.upload(manifestBytes, 'demo-manifest.json'), p = await client.upload(payload, 'demo-payload.txt', 'text/plain');
    const msha = sha256Hex(manifestBytes), psha = sha256Hex(payload);
    const start = async (mode: string, plan?: {
        run: string;
        result: string;
    }) => { const data = { mode, sha256: psha, bed: { id: 'demo-bed', manifest_sha256: msha }, build: bed.site.RELEASED, ...(plan ? { plan_run: plan.run } : {}) }; const proof = await client.upload(canonicalBytes({ p: data }), 'demo-proof.json'); const answer = await client.call('start_run', { pack: PACK, product: bed.product.names[0], build: bed.site.RELEASED, inputs: { proof: { reference: proof }, payload: { reference: p }, manifest: { reference: m }, ...(plan ? { plan: { reference: plan.result } } : {}) }, ...(plan ? { predecessor: plan.run } : {}) }); assert.equal(answer.isError, false, JSON.stringify(answer.out.errors)); assert.ok(answer.out.result); return { run: answer.out.run!.run, result: answer.out.result!.reference }; };
    const plan = await start('plan');
    const verified = await start('verify', plan);
    const detail=await bed.hub.deps.runs.getRun(owner,verified.run);assert.ok(detail?.latest);
    assert.deepEqual(detail.latest.result.errors,[],JSON.stringify(detail.latest.result.errors));
    let submissions = 0;
    let submitted: any;
    let targetVarChanges = false;
    const endpoint = await startEndpoint([...definition('x').allowed_tools, 'inspect_seat'], async (name, args) => {
        if (name === 'open_slot' || name === 'touch_slot')
            return { ok: true, ticket: 'demo-ticket', token: 'demo-fence', ttl: 60000 };
        if (name === 'inspect_slot') {
            if (targetVarChanges) {
                targetVarChanges = false;
                await k.variables.setVariable(by, 'DEMO_TARGET', 'demo-other', 'DEMO_DRIFT');
            }
            return { build: bed.site.RELEASED, seats: 2, reachable: true };
        }
        if (name === 'inspect_seat')
            return { output: args.command === 'inspect version' ? 'version: ' + bed.site.RELEASED : 'address: 192.0.2.' + (Number(args.seat) + 1) + '/24' };
        if (name === 'send_blob') {
            submissions++;
            submitted = { request: args.request, key: 'demo-remote', digest: args.digest, ids: args.ids, submitted: new Date().toISOString() };
            return { ...submitted, ok: true };
        }
        if (name === 'inspect_blob')
            return { state: 'ended', exit: 0 };
        if (name === 'read_blob')
            return { ...submitted, rows: [{ id: 'demo-case', outcome: 'good' }], complete: true };
        return { ok: true };
    });
    t.after(() => endpoint.close());
    await k.variables.setVariable(by, 'DEMO_TARGET', 'demo-bed', 'DEMO_TARGET');
    await k.variables.setVariable(by, 'DEMO_MANIFEST', msha, 'DEMO_MANIFEST');
    const base = definition(endpoint.endpoint), raw = { ...base, target: '${var:DEMO_TARGET}', manifest_sha256: '${var:DEMO_MANIFEST}', credential: '${secret:DEMO_EXEC_AUTH}', allowed_tools: [...base.allowed_tools, 'inspect_seat'], refused_tools: ['demo_admin_reset'], probes, proof: { ...base.proof, package: PACK, requirement: 'verified', warrant_id: PACK + '.verified@1.0.0', slot: 'payload' } };
    const executor = await dispatch.registry.add(by, raw);
    await set('DEMO_EXEC_AUTH', AUTH);
    const leased = await bed.hub.leases.acquire({ keys: base.resources, prefix: 'synthetic/', ttlSeconds: 3600, maxTtlSeconds: 3600, holder: { user: owner.id, run: plan.run } });
    assert.equal(leased.ok, true);
    targetVarChanges = true;
    const refused = await dispatch.dispatch(by, verified.run, executor.id);
    assert.equal(refused.outcome, 'not_dispatched');
    assert.equal(submissions, 0);
    await k.variables.setVariable(by, 'DEMO_TARGET', 'demo-bed', 'DEMO_RESTORE');
    const fresh = await start('verify', plan);
    const result = await dispatch.dispatch(by, fresh.run, executor.id);
    assert.equal(result.outcome, 'effective', JSON.stringify(result));
    assert.equal(submissions, 1);
    assert.ok(endpoint.calls.every(c => c.headers.authorization === 'Bearer ' + AUTH));
    await bed.hub.leases.release({ keys: base.resources, holder: { user: owner.id, run: plan.run } });
});
test('a historical resource refuses every request until explicit credential migration succeeds', async () => {
    const k = bed.hub.records, by = bed.hub.admin.principal, c = bed.hub.hub.connectors, id = bed.resources.agile.id;
    const current = await k.authorizations.resourceConfig(id);
    const body = JSON.parse(Buffer.from((await k.objects.get(current!.body.bound!))!).toString());
    const username = `connector.${id}.username`, password = `connector.${id}.password`;
    const legacy = { ...body, credentials: { username, password } };
    const object = await k.objects.put(canonicalBytes(legacy), 'application/json');
    await k.authorizations.configureResource(by, id, object.sha256, 'DEMO_LEGACY');
    await k.vault.put(username, AGILE_ACCOUNT.username);
    await k.vault.put(password, createHash('sha512').update(PASSWORD).digest('base64'));
    const count = bed.hub.stubs!.agile.requests.length;
    const before = await c.executeRead(id, 'tree', { id: ROOTS.first }, { principal: bed.reviewer.principal, purpose: 'DEMO_LEGACY' });
    assert.equal(before.ok, false);
    assert.match(before.ok ? '' : before.reason, /resource update/);
    assert.equal(bed.hub.stubs!.agile.requests.length, count);
    await c.admin.updateResource(by, id, { credentials: { username: 'DEMO_PORTAL_USER', password: 'DEMO_PORTAL_PASSWORD' } });
    const after = await c.executeRead(id, 'tree', { id: ROOTS.first }, { principal: bed.reviewer.principal, purpose: 'DEMO_MIGRATED' });
    assert.equal(after.ok, true, after.ok ? '' : after.reason);
    assert.equal(await k.vault.has(username), false);
    assert.equal(await k.vault.has(password), false);
});
test('ordinary users cannot read variable records or use administrator commands, and no secret value reaches stored output', async () => {
    const k = bed.hub.records, by = bed.hub.admin.principal;
    const value = 'ordinary-evidence-marker';
    const v = await k.variables.setVariable(by, 'DEMO_NOTE', value, 'DEMO_NOTE');
    await assert.rejects(variableCommand(adminSession('', bed.reviewer.principal), ['list']), /管理员/);
    await assert.rejects(namedSecretCommand(adminSession('', bed.reviewer.principal), ['list']), /管理员/);
    const view = await client.call('get_nodes', { reference: 'rec:' + v.value.decision.digest });
    assert.ok(!JSON.stringify(view.out).includes(value));
    const secrets = [AGILE_ACCOUNT.password, PASSWORD, WRONG, AUTH];
    const forms = (value: string) => [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1), Buffer.from(value).toString('base64'), createHash('sha256').update(value).digest('hex'), createHash('sha512').update(value).digest('hex'), createHash('sha512').update(value).digest('base64')];
    const check = (bytes: Uint8Array) => { for (const value of secrets)
        for (const form of forms(value))
            assert.ok(!Buffer.from(bytes).includes(Buffer.from(form)), 'secret bytes must stay in the encrypted vault'); };
    check(Buffer.from([...bed.hub.logs, ...output].join('\n')));
    for (const kind of RECORD_KINDS) {
        let cursor: string | null = null;
        do {
            const page: import('../../hub/records/api.ts').Page<import('../../hub/records/api.ts').StoredRecord> = await k.store.list({ kind, limit: 500, cursor });
            for (const row of page.items)
                check(Buffer.from(JSON.stringify(row)));
            cursor = page.next;
        } while (cursor);
    }
    const walk = async (dir: string): Promise<void> => { for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.name === 'vault')
            continue;
        if (entry.isDirectory())
            await walk(path);
        else
            check(await readFile(path));
    } };
    await walk(k.dataDir);
    if (!k.config.logDir.startsWith(k.dataDir + '/'))
        await walk(k.config.logDir);
});

});


test('product variable acceptance covers publication, sync, composition and administrator commands',async t=>{
 const postgres=await startPostgres();
 const scratch=await mkdtemp(join(tmpdir(),'circle-hub-product-vars-'));
 const server=createServer((_request,response)=>{response.setHeader('content-type','application/json');response.end(JSON.stringify({text:'Synthetic source'}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();assert.ok(address&&typeof address!=='string');
 const hub=await createTestHub({postgres,repositoryPacks:false,stubs:false,requireOsIsolation:false});
 t.after(async()=>{await hub.close();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await postgres.stop();await rm(scratch,{recursive:true,force:true});});
 const lines:string[]=[];
 const session:VariableCommandSession={ctx:{io:{cwd:scratch}},options:{},admin:async()=>hub.admin.principal,records:async()=>hub.records,hub:async()=>hub.hub,out:line=>lines.push(line),err:line=>lines.push(line)};
 const system=await writePack(scratch,{id:'demo-vars-source',version:'1.0.0',kind:'system',title:'合成来源',description:'回环合成只读来源',files:{
  'system.json':{json:{schema:'system@1',title:'Synthetic source',roles:[{name:'api'}],auth:{kind:'none'},routes:[{id:'item',role:'api',method:'GET',path:'/items/{id}',response:'json',max_bytes:1048576,read:true}],reads:[{name:'item',external:'demo-vars:item',request:{route:'item',params:{id:'{id}'}},project:{module:'functions/project.ts'}}]}},
  'functions/project.ts':'export default function(){return {artifacts:[],warnings:[]};}',
 }});
 await hub.publishPack(system);
 await hub.addResource({system_pack:'demo-vars-source@1.0.0',name:'合成变量来源',environment:'test',origins:{api:`http://127.0.0.1:${address.port}`},allow_plaintext:[`http://127.0.0.1:${address.port}`]});
 const declaration={schema:'product@1',id:'demo-vars-product',title:'合成变量产品',names:['SyntheticVariableProduct'],catalogs:[],
  variables:[{name:'DEMO_PRODUCT_LABEL',description:'Synthetic label',schema:{type:'string'},default:'Synthetic default'},{name:'DEMO_PRODUCT_ITEMS',description:'Synthetic words',schema:{type:'array',items:{type:'string'}},default:['fallback']}],
  sync:{start:['demo-vars:item:1'],plan:{module:'functions/plan.ts'},options:{label:'${var:DEMO_PRODUCT_LABEL}'}},
  producers:[{id:'words',title:'合成词',function:{module:'functions/produce.ts'},inputs:{page:{source:'page'}},params:{words:'${var:DEMO_PRODUCT_ITEMS}'}}],
 };
 const files={'product.json':{json:declaration},'functions/plan.ts':`export default function(input:any){return {fetch:[],done:true,note:input.options.label,builds:[{name:'Demo_10_6',family:'SyntheticVariableProduct',line:'10.6',base:'Demo_10_6',platform:null,built_at:null,released_at:'2026-01-01T00:00:00.000Z',sources:{page:'demo-vars:item:1'}}]};}`,
 'functions/produce.ts':`export default function(input:any){return {entries:[{kind:'definition',path:'/words',statement:input.params.words.join(' '),data:{words:input.params.words},fragments:[{slot:'page',parser:'json@1',selector:'p/text'}],applicability:null}],warnings:[]};}`};
 const source=await writePack(scratch,{id:'demo-vars-product',version:'1.0.0',kind:'product',title:'合成变量产品',description:'合成声明',files});
 await hub.publishPack(source);
 const refused=await hub.knowledgeSync('demo-vars-product');assert.match(refused.error??'',/DEMO_PRODUCT_LABEL.*var set/);assert.equal(refused.plan.reads,0);
 lines.length=0;await variableCommand(session,['list']);assert.match(lines.join('\n'),/DEMO_PRODUCT_ITEMS.*没设置/);
 const dry=await hub.knowledgeSync('demo-vars-product',{dryRun:true});assert.equal(dry.error,null);assert.ok(dry.variables?.every(v=>v.default));assert.equal(dry.plan.note,'Synthetic default');
 const setVar=async(name:string,value:unknown)=>{await writeFile(join(scratch,'value.json'),JSON.stringify(value));await variableCommand(session,['set',name,'--file','value.json','--reason','合成变量验收']);};
 await setVar('DEMO_PRODUCT_LABEL','Synthetic configured');await setVar('DEMO_PRODUCT_ITEMS',['synthetic','configured']);
 const sync=await hub.knowledgeSync('demo-vars-product');assert.equal(sync.error,null);assert.equal(sync.plan.note,'Synthetic configured');assert.equal(sync.counts.produced,1,JSON.stringify(sync.builds));
 const built=sync.builds.find(b=>b.composition)!;
 const composition=await hub.hub.knowledge.store.composition(built.composition!);assert.equal(composition?.variables?.length,2);
 assert.deepEqual((await hub.hub.knowledge.store.entry(composition!.composition[0].entry))?.data.words,['synthetic','configured']);
 lines.length=0;await variableCommand(session,['list','--root',built.root!]);assert.match(lines.join('\n'),/DEMO_PRODUCT_LABEL.*第 1 版/);assert.match(lines.join('\n'),/DEMO_PRODUCT_ITEMS.*第 1 版/);
 await setVar('DEMO_PRODUCT_LABEL','Synthetic changed');
 const changed=await hub.knowledgeSync('demo-vars-product');assert.equal(changed.counts.produced,1);assert.equal(changed.builds[0].root,built.root);assert.equal(changed.builds[0].calls?.made,0);
 lines.length=0;await variableCommand(session,['list','--root',built.root!]);assert.ok(lines.some(line=>line.includes('DEMO_PRODUCT_LABEL')&&line.includes('第 1 版')));assert.ok(lines.some(line=>line.includes('DEMO_PRODUCT_LABEL')&&line.includes('第 2 版')));assert.ok(lines.every(line=>line.includes('组成 ')));
 const second=await writePack(scratch,{id:'demo-vars-other',version:'1.0.0',kind:'product',title:'另一个合成产品',description:'撞名合成反例',files:{...files,'product.json':{json:{...declaration,id:'demo-vars-other',names:['OtherSyntheticVariableProduct']}}}});
 const collision=await hub.hub.registry.publish(hub.admin.principal,second);assert.equal(collision.ok,false);if(!collision.ok)assert.equal(collision.problems[0].message,'名字不可用');
 await hub.records.variables.setVariable(hub.admin.principal,'DEMO_UNUSED_VALUE',1,'合成无使用者');
 await hub.records.variables.setVariable(hub.admin.principal,'DEMO_PRODUCT_ITEMS',1,'合成旧值不合模式');
 lines.length=0;await variableCommand(session,['list']);assert.match(lines.join('\n'),/DEMO_UNUSED_VALUE.*设置了，没有使用者/);assert.match(lines.join('\n'),/DEMO_PRODUCT_ITEMS.*不合.*demo-vars-product/);
});
