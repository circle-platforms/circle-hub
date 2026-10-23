import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,readFile,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {main} from '../tools/jev/jev.ts';
import * as workflow from '../tools/jev/lib/workflow.ts';
import {Hub} from '../tools/jev/lib/hub.ts';
import {LocalStore,secretGuard} from '../tools/jev/lib/local.ts';
import {fakeHub,fakeJev,entry,node,digest,MODEL,JEV_KEY,HUB_KEY,ROOT} from './servers.ts';
async function fixture(t:any){const dir=await mkdtemp(join(tmpdir(),'jev-review-'));t.after(()=>rm(dir,{recursive:true,force:true}));const piece=entry('definition','synthetic source passage',1,'/source');const hub=await fakeHub([node('/',[],[{name:'alpha',path:'/alpha',digest:digest(2)},{name:'source',path:'/source',digest:digest(3)}]),node('/alpha',[entry('definition','synthetic child meaning',2,'/alpha')]),node('/source',[piece])]);const jev=await fakeJev();t.after(()=>hub.close());t.after(()=>jev.close());const guard=secretGuard([JEV_KEY,HUB_KEY]);const store=await LocalStore.open('out',dir,guard);await store.append('calibration.jsonl',{model:MODEL,chain:'placement.choice',samples:Array.from({length:80},(_,i)=>({input:digest(i),expected:'alpha',chosen:'alpha',probability:1}))});await writeFile(join(dir,'pieces.json'),JSON.stringify({pieces:[{id:'p',reference:piece.reference}]}));const err:string[]=[];assert.equal(await main(['place','--hub',hub.url,'--model',MODEL,'--base-url',jev.url,'--root',ROOT,'--under','/','--pieces','pieces.json','--out','out'],{cwd:dir,stdin:Readable.from([JEV_KEY+'\n'+HUB_KEY+'\n']),stdout:()=>{},stderr:v=>err.push(v)}),0,err.join('\n'));return {dir,store,hub:new Hub(hub.url,HUB_KEY,guard),input:JSON.parse(await readFile(join(dir,'out/proposals.json'),'utf8'))};}
test('submission checks models records descent calibration text code and source identity before claiming provenance',async t=>{const s=await fixture(t);const verify=(workflow as any).verifyProposals;assert.equal(typeof verify,'function');await verify(s.input,s.hub,s.store);
 const edits:Array<(p:any)=>void>=[p=>p.model='jev-latest',p=>p.model='jev-10.6.1',p=>p.items[0].judgments=[],p=>p.items[0].judgments=[digest(999)],p=>p.items[0].data.path='/source',p=>p.items[0].text=p.items[0].text.replace('p=1.00','p=0.97'),p=>p.items[0].code='other',p=>p.items[0].id='p_forged',p=>p.items[0].supporting_judgment=digest(111),p=>p.items[0].data.source.quote='forged quote'];for(const edit of edits){const changed=structuredClone(s.input);edit(changed);await assert.rejects(()=>verify(changed,s.hub,s.store));}
 await assert.rejects(()=>verify(s.input,new Hub('https://example.invalid/mcp',HUB_KEY,()=>{}),s.store),/scripted/);
 await writeFile(join(s.dir,'out/calibration.jsonl'),'');await assert.rejects(()=>verify(s.input,s.hub,s.store),/校准/);
});

test('Hub preserves typed tool refusals HTTP status and JSON RPC errors',async t=>{
 const {createServer}=await import('node:http');let mode='tool';const server=createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const input=JSON.parse(Buffer.concat(chunks).toString());if(mode==='401'){res.writeHead(401);res.end();return;}const result=input.method==='initialize'?{}:{structuredContent:{call_result:'error',errors:[{code:'REFERENCE_UNRESOLVED',path:'/build',message:'合成构建不存在',fix:'改用列出的构建',options:['synthetic-build']} ]}};res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(mode==='rpc'?{jsonrpc:'2.0',id:input.id,error:{code:-32602,message:'合成参数缺失'}}:{jsonrpc:'2.0',id:input.id,result}));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());const url=`http://127.0.0.1:${(server.address() as any).port}`;
 await assert.rejects(()=>new Hub(url,HUB_KEY,()=>{}).call('start_run',{}),error=>error instanceof Error&&['start_run','REFERENCE_UNRESOLVED','/build','合成构建不存在','改用列出的构建','synthetic-build'].every(v=>error.message.includes(v)));
 mode='401';await assert.rejects(()=>new Hub(url,HUB_KEY,()=>{}).call('start_run',{}),/401.*\/secrets HUB_TOKEN/);mode='rpc';await assert.rejects(()=>new Hub(url,HUB_KEY,()=>{}).call('get_nodes',{}),/-32602.*合成参数缺失/);
});
