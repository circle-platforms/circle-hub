import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Page, StoredRecord } from '../records/api.ts';
import { setup } from './testing/context.ts';

async function report(c: Awaited<ReturnType<typeof setup>>, reference: string) {
  const source = await c.kit.artifacts.source(c.owner, reference.slice(4));
  assert.ok(source?.bytes); return JSON.parse(new TextDecoder().decode(source.bytes));
}
test('reports retain target outcomes but never assert dynamic verdicts without certified attribution', async t => {
  const c = await setup(); t.after(() => c.close());
  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  const value = await report(c, state.result!);
  assert.equal(value.rows[0].reported_terminal, 'pass'); assert.equal(value.rows[0].dynamic_terminal, 'no_verdict');
  assert.ok(value.rows[0].limits.includes('目标对本次派发的报告'));
  assert.ok(value.rows[0].limits.includes('未排除本地操作'));
  const other = await c.kit.principals.createUser(c.admin, '其他合成用户');
  assert.equal(await c.kit.artifacts.source(other, state.result!.slice(4)), null);
  assert.ok((await c.kit.artifacts.source(c.admin, state.result!.slice(4)))?.bytes);
});

test('incomplete channels and empty or unmapped rows have no verdict; mismatched result digest freezes', async t => {
  for (const mode of ['partial', 'empty', 'unmapped-row', 'result-sha']) {
    const c = await setup({ mode, alter: (name, v) => name !== 'read_blob' ? v : mode === 'empty' ? { ...v, rows: [{}] } : mode === 'unmapped-row' ? { ...v, rows: [{ id: 'synthetic-case', outcome: 'unmapped' }] } : v }); t.after(() => c.close());
    const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
    if (mode === 'result-sha') { assert.equal(state.frozen, true); assert.equal(state.result, undefined); }
    else { const r = await report(c, state.result!); assert.equal(r.rows[0].dynamic_terminal, 'no_verdict'); assert.equal(r.rows[0].reported_terminal, null); }
  }
});

test('heartbeat deadlines and interruptions are recorded while status reads continue; fencing changes are disclosed', async t => {
  for (const mode of ['heartbeat-failure', 'fencing']) {
    const c = await setup({ mode, ...(mode==='heartbeat-failure'?{ttl:60,delay:{inspect_slot:160}}:{}) }); t.after(() => c.close());
    const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
    if(mode==='heartbeat-failure'){assert.equal(state.outcome,'not_dispatched');assert.equal(c.calls.filter(n=>n==='send_blob').length,0);continue;}
    assert.equal(c.calls.filter(n => n === 'send_blob').length, 1);
    const events = await c.service.journal.events(state.job);
    if (mode === 'heartbeat-failure') {
      assert.ok(c.calls.includes('touch_slot'));
      assert.ok(events.some(e => e.body.detail.lease_interrupted === true));
      const r = await report(c, state.result!); assert.equal(r.lease_interrupted, true);
    } else assert.equal((await report(c, state.result!)).lease_drift, true);
    assert.ok(c.calls.includes('read_blob'));
  }
});

test('secrets are absent from every record, object, file, and reply projection even when echoed by the target', async t => {
  const c = await setup({ alter: (_name, value) => ({ ...value, debug: 'Bearer synthetic-secret' }) }); t.after(() => c.close());
  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(state.outcome, 'effective');
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await walk(file); else assert.ok(!(await readFile(file)).includes(Buffer.from('synthetic-secret')), 'secret found in synthetic file output');
    }
  };
  await walk(c.kit.dataDir);
  const { RECORD_KINDS } = await import('../../contracts/generated/protocol.ts');
  for (const kind of RECORD_KINDS) {
    let cursor: string | null = null;
    do { const page: Page<StoredRecord> = await c.kit.store.list({ kind, limit: 500, ...(cursor ? { cursor } : {}) }); assert.ok(!JSON.stringify(page.items).includes('synthetic-secret')); cursor = page.next; } while (cursor);
  }
});

test('a fence change during result retrieval is recorded before publishing the result', async t => {
  const c = await setup({ mode: 'fencing-result' }); t.after(() => c.close());
  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal((await report(c, state.result!)).lease_drift, true);
});

test('deployment-specific limitations are copied as executor declarations rather than inferred by the core', async t => {
  const c = await setup(); t.after(() => c.close());
  await c.registry.update(c.admin, c.executor.id, { ...c.executor.definition, limitations: ['合成运行环境使用实时文件，内容一致性未认证'] });
    await c.freezeExecutor();
  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  const result = await report(c, state.result!);
  assert.equal(result.executor_declarations.provenance, 'declared');
  assert.deepEqual(result.executor_declarations.limitations, ['合成运行环境使用实时文件，内容一致性未认证']);
  assert.ok(result.executor_declarations.definition_sha256);
});

test('runner declarations are observations of saved literal markers even in an incomplete result',async t=>{
  const c=await setup({alter:(name,value)=>name==='read_blob'?{...value,complete:false,rows:[{id:'synthetic-case',outcome:'good',log:'SYNTHETIC_PRESENT',sessions:{'synthetic.txt':'another session'}}]}:value});t.after(()=>c.close());
  await c.registry.update(c.admin,c.executor.id,{...c.executor.definition,result:{...c.executor.definition.result,log:'/log',sessions:'/sessions'},side_effects:[{message:'合成动作一',marker:'SYNTHETIC_PRESENT'},{message:'合成动作二',marker:'SYNTHETIC_ABSENT'},{message:'合成声明'}]});
    await c.freezeExecutor();
  const state=await c.service.dispatch(c.admin,c.run,c.executor.id);const value=await report(c,state.result!);
  assert.equal(value.side_effects[0].marker_present,true);assert.equal(value.side_effects[1].marker_present,false);
  assert.match(value.side_effects[0].text,/本次日志里有这一项的标记/);assert.match(value.side_effects[1].text,/本次日志里没有这一项的标记/);
  assert.match(value.side_effects[2].text,/运行器会这样做（执行器定义声明，Hub 看不见）/);
  assert.match(value.side_effects[0].reference,/^src:[a-f0-9]{64}$/);
  assert.equal(value.rows[0].dynamic_terminal,'no_verdict');
});

test('certified owned reports become qualified judgments only after per-seat proof and exact closing logs',async t=>{
  for(const outcome of ['good','bad']) {
    const {probes}=await import('./testing/probes.ts');
    const {canonicalBytes}=await import('../records/api.ts');
    const c=await setup({extraTools:['inspect_seat'],alter:(name,value)=>{
      const last=c.endpoint.calls.filter(e=>e.params.name===name).at(-1)?.params.arguments as Record<string,unknown>;
      if(name==='inspect_seat')return {output:last.command==='inspect version'?'version: synthetic-build':`address: 192.0.2.${Number(last.seat)+1}/24`};
      if(name==='read_blob')return {...value,ownership:'staging_directory',rows:[{id:'synthetic-case',outcome,log:'SYNTHETIC_END',stale:false}]};
      return value;
    }});t.after(()=>c.close());
    const manifest=await c.kit.artifacts.ingest({bytes:canonicalBytes({id:'synthetic-bed',devices:[1,2].map(n=>({interfaces:[{address:`192.0.2.${n}/24`}]}))}),mediaType:'application/json',origin:{upload:{session:'synthetic'}},author:{user:c.owner.id},provenanceType:'declared',visibility:{readers:[c.owner.id],admins:true,packs:[],shareable:false}});
    c.detail.run.sources=c.detail.run.sources.map(s=>s.slot==='synthetic-manifest'?{...s,reference:`src:${manifest.body.sha256}`}:s);
    (c.detail.latest!.result.partitions.delivered[0].requirements[0].claims[0].statement.data as any).bed.manifest_sha256=manifest.body.sha256;
    c.effectDocument.effects[0].parameters.values.manifest_sha256=[manifest.body.sha256];
    const proof=await c.kit.artifacts.ingest({bytes:new TextEncoder().encode('synthetic ownership certification'),mediaType:'text/plain',origin:{upload:{session:'synthetic'}},author:{user:c.admin.id},provenanceType:'declared',visibility:{readers:[c.admin.id],admins:true,packs:[],shareable:false}});
    await c.registry.update(c.admin,c.executor.id,{...c.executor.definition,manifest_sha256:manifest.body.sha256,allowed_tools:[...c.executor.definition.allowed_tools,'inspect_seat'],probes,premises:{result_ownership:{version:'1',evidence:[`src:${proof.body.sha256}`]}},result:{...c.executor.definition.result,ownership:{pointer:'/ownership',value:'staging_directory',reason:'/ownership_reason'},request_id:'/request',log:'/log',log_stale:'/stale',closing_marker:'SYNTHETIC_END'}});
    await c.freezeExecutor();
    const state=await c.service.dispatch(c.admin,c.run,c.executor.id);const value=await report(c,state.result!);
    assert.equal(value.rows[0].dynamic_terminal,outcome==='good'?'pass':'fail');assert.equal(value.rows[0].qualifier.nature,'judgment');assert.equal(value.rows[0].accepted_as_fact,false);
  }
});
