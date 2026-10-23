import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {Hub} from '../tools/jev/lib/hub.ts';
import {HUB_KEY} from './servers.ts';
test('c3 1 submission refusal remains a receipt while read refusals remain typed errors',async t=>{
 const receipt={call_result:'error',acceptance:'not_accepted',errors:[{code:'RUN_SUPERSEDED',item:'p_synthetic',fix:'对新运行提交'}]};const server=createServer(async(req,res)=>{const parts=[];for await(const c of req)parts.push(c);const input=JSON.parse(Buffer.concat(parts).toString());res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:input.id,result:input.method==='initialize'?{}:{content:[{type:'text',text:'合成拒绝回执'}],structuredContent:receipt}}));});await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));t.after(()=>server.close());const hub=new Hub(`http://127.0.0.1:${(server.address() as any).port}`,HUB_KEY,()=>{});assert.deepEqual(await hub.call('submit_result',{}),receipt);await assert.rejects(()=>hub.call('get_nodes',{}),/RUN_SUPERSEDED/);
});

import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {main} from '../tools/jev/jev.ts';
import * as workflow from '../tools/jev/lib/workflow.ts';
import {LocalStore,secretGuard} from '../tools/jev/lib/local.ts';
import {fakeHub,fakeJev,entry,node,digest,MODEL,JEV_KEY,ROOT} from './servers.ts';
test('c3 2 unbacked calibration cannot authorize descent or submission',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jev-c3-calibration-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=entry('definition','synthetic passage',7,'/alpha');const hub=await fakeHub([node('/',[],[{name:'alpha',path:'/alpha',digest:digest(8)}]),node('/alpha',[source])]);const jev=await fakeJev();t.after(()=>hub.close());t.after(()=>jev.close());const store=await LocalStore.open('out',dir,secretGuard([JEV_KEY,HUB_KEY]));await store.append('calibration.jsonl',{model:MODEL,chain:'placement.choice',samples:Array.from({length:80},(_,i)=>({input:digest(i),expected:'alpha',chosen:'alpha',probability:0.5}))});await writeFile(join(dir,'pieces.json'),JSON.stringify({pieces:[{id:'p',reference:source.reference}]}));const err:string[]=[];assert.equal(await main(['place','--hub',hub.url,'--model',MODEL,'--base-url',jev.url,'--root',ROOT,'--under','/','--pieces','pieces.json','--out','out'],{cwd:dir,stdin:Readable.from([JEV_KEY+'\n'+HUB_KEY+'\n']),stdout:()=>{},stderr:v=>err.push(v)}),0,err.join('\n'));const proposals=JSON.parse(await readFile(join(dir,'out/proposals.json'),'utf8'));assert.equal(proposals.items.length,0);await assert.rejects(()=>workflow.verifyProposals({model:MODEL,root:ROOT,items:[]},new Hub(hub.url,HUB_KEY,store.guard),store),/校准/);
});

import {seedCalibration} from './calibration.ts';
import {inputDigest} from '../tools/jev/lib/api.ts';
test('c3 2 calibration checks every witness model input expected label and probability against the tree',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jev-c3-backed-'));t.after(()=>rm(dir,{recursive:true,force:true}));const hub=await fakeHub([node('/',[],[{name:'alpha',path:'/alpha',digest:digest(900)}]),node('/alpha',Array.from({length:80},(_,i)=>entry('definition','synthetic calibration text '+i,100+i,'/alpha')))]);t.after(()=>hub.close());const store=await LocalStore.open('out',dir,secretGuard([JEV_KEY,HUB_KEY]));const client=new Hub(hub.url,HUB_KEY,store.guard);const set=await seedCalibration(store,client,'/alpha');const records=await store.records('judgments.jsonl');assert.equal((await workflow.calibrationState(store,MODEL,client)).total,80);
 const edits:Array<(set:any,r:any)=>void>=[s=>s.judgments[0]=digest(999),(_s,r)=>r.requested_model='jev-10.6.1',(_s,r)=>r.returned_model='jev-10.6.1',(_s,r)=>r.exact_model='jev-10.6.1',(_s,r)=>r.question_type='score',s=>s.samples[0].input=digest(999),s=>s.samples[0].expected='none',s=>s.samples[0].chosen='none',s=>s.samples[0].probability=0.5,(_s,r)=>r.instructions+=' changed'];
 for(const edit of edits){const changed=structuredClone(set),rows=structuredClone(records);edit(changed,rows[0]);if(changed.judgments[0]===set.judgments[0])changed.judgments[0]=inputDigest(rows[0]);await writeFile(join(dir,'out/calibration.jsonl'),JSON.stringify(changed)+'\n');await writeFile(join(dir,'out/judgments.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');const state=await workflow.calibrationState(store,MODEL,client);assert.equal(state.total,79);assert.equal(state.discarded,1);}
});
