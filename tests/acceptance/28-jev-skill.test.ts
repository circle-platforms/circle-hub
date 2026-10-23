// Client skill against the real Hub, temporary PostgreSQL and a scripted loopback judgment service.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { startPostgres } from '../../hub/testing/postgres.ts';
import { openBed } from './support/hub.ts';
import { productSite } from './support/env.ts';
import { fakeJev, MODEL, JEV_KEY } from '../../packs/workflow/knowledge-contribution/testing/servers.ts';
import { inputDigest } from '../../hub/jev/api.ts';
import { sha256Hex } from '../../hub/records/api.ts';
import { osIsolationAvailable } from '../../hub/rules/api.ts';

test('scenario 28: Circle skill calibrates places and submits proposals while Hub sees no judgment key',async t=>{
 if(!await osIsolationAvailable()){t.skip('sandbox-exec 不可用；未验证真实 Hub 沙箱验收');return;}
 const postgres=await startPostgres();t.after(()=>postgres.stop());const dir=await mkdtemp(join(tmpdir(),'jev-acceptance-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const site=await productSite();const parts=/_(\d+)_(\d+)_(\d+)_/.exec(site.RELEASED);assert.ok(parts);const line=parts.slice(1).join('.');assert.ok(Number(parts[1])>=10&&Number(parts[2])>=6);
 const path='/commands/fixture/sample';const paragraphs=Array.from({length:90},(_,i)=>`Synthetic calibration passage number ${i} describes an invariant observable property.`);
 const manual='**fixture sample**\n\n'+paragraphs.join('\n\n')+'\n';
 const bed=await openBed({postgres,syncOneName:false,webdav:{[`/cli/rel_synthetic_${line.replaceAll('.','_')}/cli_cn/cli_cn.md`]:manual}});t.after(()=>bed.close());
 await bed.hub.assignPack(bed.reviewer.principal,'knowledge-contribution');
 await cp(new URL('../../packs/workflow/knowledge-contribution/tools/jev/',import.meta.url),join(dir,'skill'),{recursive:true});
 const expected=new Map<string,string>();
 const service=await fakeJev(request=>({body:{model:MODEL,answers:Object.fromEntries(Object.entries(request.questions).map(([id,q])=>{assert.equal(q.type,'choice');if(q.type!=='choice')throw new Error('expected choice');const name=expected.get(id);assert.ok(name,'scripted oracle has a precomputed answer for '+id);assert.ok(Object.hasOwn(q.criteria,name));return [id,{type:'choice',choice:name,confidence:1,probabilities:Object.fromEntries(Object.keys(q.criteria).map(key=>[key,key===name?1:0]))}];})),usage:{input_tokens:1,output_tokens:1}}}));t.after(()=>service.close());
 const run=async(action:string,args:string[]=[])=>new Promise<{code:number|null;out:string;err:string}>((done,reject)=>{const judging=action==='calibrate'||action==='place';const child=spawn(process.execPath,[join(dir,'skill/jev.ts'),action,'--hub',bed.hub.mcpUrl,...(judging?['--model',MODEL,'--base-url',service.url]:[]),'--out','result',...args],{cwd:dir,env:{PATH:process.env.PATH}});let out='',err='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);child.on('error',reject);child.on('exit',code=>done({code,out,err}));child.stdin.end((judging?JEV_KEY+'\n':'')+bed.reviewer.token+'\n');});
 const product=bed.product.names[0]!;const lock=await run('lock',['--product',product,'--build',site.RELEASED]);assert.equal(lock.code,0,lock.err);const locked=JSON.parse(await readFile(join(dir,'result/lock.json'),'utf8'));
 const client=await bed.connect(bed.reviewer);const response=await client.call('get_nodes',{root:locked.root,paths:[path],depth:0});const nodes=response.out.nodes as any[];assert.ok(nodes?.[0]);const entries=nodes[0].entries as any[];assert.ok(entries.length>=90,'synthetic paragraphs produced enough distinct code-placed entries');
 const pathParts=path.slice(1).split('/');for(const row of entries)for(let depth=0;depth<pathParts.length;depth++){const at=depth===0?'/':'/'+pathParts.slice(0,depth).join('/');expected.set('q'+inputDigest({entry:row.entry,path:at}).slice(0,40),pathParts[depth]!);}
 const chosen=entries.find(row=>row.statement===paragraphs[0]);assert.ok(chosen);for(let depth=0;depth<pathParts.length;depth++){const at=depth===0?'/':'/'+pathParts.slice(0,depth).join('/');expected.set('q'+inputDigest({piece:sha256Hex(chosen.statement),path:at}).slice(0,40),pathParts[depth]!);}
 const dry=await run('calibrate',['--root',locked.root,'--under',path,'--dry-run']);assert.equal(dry.code,0,dry.err);assert.equal(service.requests.length,0);
 const calibration=await run('calibrate',['--root',locked.root,'--under',path]);assert.equal(calibration.code,0,calibration.err);
 await writeFile(join(dir,'pieces.json'),JSON.stringify({pieces:[{id:'p1',reference:chosen.reference}]}));const place=await run('place',['--root',locked.root,'--under','/','--pieces','pieces.json']);assert.equal(place.code,0,place.err);const proposals=JSON.parse(await readFile(join(dir,'result/proposals.json'),'utf8'));assert.equal(proposals.items.length,1);assert.equal(proposals.items[0].data.path,path);
 const submit=await run('submit',['--proposals','result/proposals.json','--product',product,'--build',site.RELEASED]);assert.equal(submit.code,0,submit.err);const receipt=JSON.parse(await readFile(join(dir,'result/receipt.json'),'utf8'));assert.equal(receipt.acceptance,'accepted');assert.equal(receipt.result.contributions.stored.length,1);
 const identities=(await readFile(join(dir,'result/run-identities.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));const identity=identities.at(-1);assert.match(identity.pack_digest,/^[a-f0-9]{64}$/);const submissions=await bed.hub.records.store.find<any>({key:'runs.submission.run',value:receipt.result.run,kind:'submission',limit:5});assert.equal(submissions.items.length,1);assert.equal(submissions.items[0].body.model,`${MODEL}（Circle 技能 jev，knowledge-contribution@${identity.pack_digest}）`);const detail=await bed.hub.hub.runs.getRun(bed.reviewer.principal,receipt.result.run);assert.equal(identity.pack_digest,detail!.run.pack_digest);
 const views=await bed.hub.hub.knowledge.layers.contributions.list(locked.root,[path],bed.reviewer.principal);assert.equal(views.length,1);assert.equal(views[0].contribution.kind,'placement_proposal');assert.ok('statement' in views[0].contribution);assert.match(views[0].contribution.statement,/Jev@jev-scripted-10\.6\.0，p=1\.00/);
 proposals.items[0].data.path='/does-not-exist';await writeFile(join(dir,'bad.json'),JSON.stringify(proposals));const bad=await run('submit',['--proposals','bad.json','--product',product,'--build',site.RELEASED]);assert.equal(bad.code,3);assert.ok(bad.out.includes(proposals.items[0].id));assert.ok(bad.err.includes('--skip'));assert.equal(JSON.parse(await readFile(join(dir,'result/receipt.json'),'utf8')).acceptance,'accepted','earlier receipt remains immutable');
 let cursor:string|null=null;do{const logs=await bed.hub.records.callLog.query(bed.hub.admin.principal,{limit:500,cursor});assert.ok(!JSON.stringify(logs).includes(JEV_KEY));cursor=logs.next;}while(cursor);assert.ok(!JSON.stringify(service.requests).includes(bed.reviewer.token));assert.ok(!JSON.stringify(service.requests).includes('用例'));for(const result of [lock,dry,calibration,place,submit,bad])assert.ok(!JSON.stringify(result).includes(JEV_KEY));
});
