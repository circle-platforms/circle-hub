// Decision 84 phase 3 uses the real assembly, official MCP client and synthetic password accounts only.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zipSync } from 'fflate';
import { writePack, workflowPack, type PackDescription } from '../../hub/runs/packs/testing/builder.ts';
import { createTestHub, type TestHub } from '../../hub/server/testing-real.ts';
import { connect, type McpClient } from './support/mcp.ts';
import { openConsole } from './support/console.ts';
import { testConsoleCredentials } from '../../hub/server/testing.ts';
import { labelOf } from '../../contracts/generated/vocabulary.ts';

let hub:TestHub,dir:string,owner:Awaited<ReturnType<TestHub['createUser']>>,other:typeof owner;
let client:McpClient,reader:McpClient,admin:McpClient;
const csrf=(body:string)=>/name="csrf" value="([^"]+)"/.exec(body)?.[1]??'';
const packId='synthetic-private-review';
before(async()=>{
  dir=await mkdtemp(join(tmpdir(),'knowledge-sharing-'));
  hub=await createTestHub({repositoryPacks:false,packs:[],stubs:false,mindmapSkill:false,workbookSkill:false,xmlSkill:false,htmlSkill:false});
  owner=await hub.createUser('合成共享成员');other=await hub.createUser('合成获授权成员');
  client=await connect(hub,owner.token);reader=await connect(hub,other.token);admin=await connect(hub,hub.admin.token);
});
after(async()=>{await client?.close();await reader?.close();await admin?.close();await hub?.close();if(dir)await rm(dir,{recursive:true,force:true});});

test('MCP sharing merges a verified entry, saves refusal receipts and lets its submitter withdraw the team copy',async()=>{
  const spaces=hub.hub.knowledge.spaces!;
  const source=await hub.records.artifacts.ingest({bytes:Buffer.from('合成团队来源：每次两项。'),mediaType:'text/plain',origin:{read:{object:'synthetic:document:shared'}},author:{user:null},provenanceType:'observed',visibility:{readers:[owner.user.id],admins:true,packs:[],shareable:false}});
  const saved=await client.call('upload_file',{personal_entry:{kind:'observation',statement:'合成可共享观察',path:'/submitted',grounds:[{reference:'src:'+source.body.sha256,quotation:'每次两项'}]}});
  assert.equal(saved.isError,false,saved.text);const entry=saved.out.personal_entry!;
  const submit={root:entry.root,path:'/submitted',entry:entry.entry};
  const shared=await client.call('upload_file',{share_entry:submit});assert.equal(shared.isError,false,shared.text);assert.equal(shared.out.share?.status,'merged');
  assert.ok(shared.out.share?.reference);assert.match(shared.text,/个人原条目保留/);
  assert.equal((await reader.call('get_nodes',{reference:shared.out.share!.reference!})).isError,false);
  assert.equal((await client.call('get_nodes',{reference:entry.reference})).isError,false);
  const duplicate=await client.call('upload_file',{share_entry:submit});assert.equal(duplicate.out.share?.code,'SHARE_DUPLICATE');assert.equal(duplicate.isError,true);
  const ownConsole=await openConsole(hub,owner.token);assert.ok(testConsoleCredentials(owner.token).password);
  const history=await ownConsole.get('/console/knowledge/submissions');assert.equal(history.status,200,history.body);assert.match(history.body,/已合并/);assert.match(history.body,/已拒收/);assert.match(history.body,/SHARE_DUPLICATE/);
  const team=await ownConsole.get('/console/knowledge/space?'+new URLSearchParams({space:'team',root:shared.out.share!.team_root!,path:'/submitted',entry:entry.entry}));assert.equal(team.status,200,team.body);assert.match(team.body,/提交人/);assert.match(team.body,/合成共享成员/);assert.match(team.body,/撤回条目/);
  const withdrawn=await client.call('upload_file',{withdraw_entry:{root:shared.out.share!.team_root!,path:'/submitted',entry:entry.entry}});assert.equal(withdrawn.isError,false,withdrawn.text);
  assert.match((await reader.call('get_nodes',{reference:shared.out.share!.reference!})).text,/已撤回/);
  assert.ok((await spaces.history(owner.principal,'team')).items.length>=3);
  const uploaded=await spaces.importFile(owner.principal,Buffer.from('合成未署名上传依据'),'text/plain','synthetic.txt');
  const uploadEntry=await spaces.write(owner.principal,{kind:'observation',statement:'合成上传知识',grounds:[{reference:'src:'+uploaded.body.sha256,quotation:'未署名上传'}]});
  const refused=await client.call('upload_file',{share_entry:{root:uploadEntry.root,path:'/',entry:uploadEntry.entry}});assert.equal(refused.out.share?.code,'SHARE_UPLOAD_UNSIGNED');
  for(const denied of [reader,admin])assert.equal((await denied.call('get_nodes',{reference:'rec:'+shared.out.share!.record})).isError,true);
});

let privateRun:string,resultReference:string,personalEntry:string;
test('personal workflow runs freeze the namespace and require grounds readable by every current workflow grantee',async()=>{
  const spec=workflowPack({id:packId,product:{catalogs:[]}});spec.files['knowledge.json']={schema:'knowledge@1',requires:[]};const written=await writePack(join(dir,'workflow'),spec);
  const published=await hub.hub.registry.personal!.publish(owner.principal,written.dir);assert.ok(published.ok,JSON.stringify(published));
  const list=await client.call('list_task_packs',{});assert.ok(list.out.packs.some(row=>row.id===packId&&row.space===owner.user.id));
  assert.ok(!(await admin.call('list_task_packs',{})).out.packs.some(row=>row.id===packId));
  const instructions=await client.call('get_nodes',{pack:packId,pack_space:owner.user.id});assert.equal(instructions.isError,false,instructions.text);
  assert.equal((await admin.call('get_nodes',{pack:packId,pack_space:owner.user.id})).isError,true);
  const spaces=hub.hub.knowledge.spaces!,source=await spaces.importFile(owner.principal,Buffer.from('合成只给指定读者的依据'),'text/plain','basis.txt','/basis');
  const entry=await spaces.write(owner.principal,{path:'/basis',kind:'observation',statement:'合成个人依据',grounds:[{reference:'src:'+source.body.sha256,quotation:'指定读者'}]});
  const input='src:'+(await spaces.importFile(owner.principal,Buffer.from('{}'),'application/json','synthetic.json','/inputs')).body.sha256;
  const started=await client.call('start_run',{pack:packId,pack_space:owner.user.id,inputs:{target:{reference:input}}});assert.equal(started.isError,false,started.text);privateRun=started.out.run!.run;assert.equal(started.out.run?.pack_space,owner.user.id);
  assert.equal(await hub.hub.runs.getRun(hub.admin.principal,privateRun),null);
  await hub.hub.registry.personal!.grant(owner.principal,packId,{audience:'member',member:other.user.id});
  await spaces.grant(owner.principal,{path:'/inputs',audience:'member',member:other.user.id});
  personalEntry=`tree:${started.out.run!.knowledge_spaces!.personal}/basis@${entry.entry}`;
  const submission={run:privateRun,model:'synthetic-scripted@1',items:[],cross_item:[{nature:'judgment',code:'level',rank:'a',statement:'合成带个人依据的判断',grounds:[personalEntry]}]};
  const refused=await client.call('submit_result',submission);assert.equal(refused.out.errors[0]?.code,'RESULT_GROUNDS_UNREADABLE',refused.text);assert.match(refused.text,/共享|授权/);
  await spaces.grant(owner.principal,{path:'/basis',audience:'member',member:other.user.id});
  const accepted=await client.call('submit_result',submission);assert.equal(accepted.out.acceptance,'accepted',accepted.text);
  const detail=await hub.hub.runs.getRun(owner.principal,privateRun);assert.ok(detail?.latest);resultReference='rec:'+detail.latest.record;
  assert.equal((await reader.call('get_nodes',{reference:resultReference})).isError,false);
  assert.equal((await admin.call('get_nodes',{reference:resultReference})).isError,true);
  await spaces.grant(owner.principal,{path:'/basis',audience:'member',member:other.user.id,revoke:true});
  const revoked=await hub.hub.runs.getRun(other.principal,privateRun);assert.ok(revoked);assert.equal(revoked.latest,null);assert.ok(revoked.submissions.every(row=>row.result===null));
  const cachedRefusal=await client.call('submit_result',submission);assert.equal(cachedRefusal.out.errors[0]?.code,'RESULT_GROUNDS_UNREADABLE');assert.equal(cachedRefusal.out.result,undefined);
  assert.equal((await reader.call('get_nodes',{reference:resultReference})).isError,true,'revoking the input grant also blocks the immutable record endpoint');
  const rebound=await reader.call('start_run',{pack:packId,pack_space:owner.user.id,inputs:{target:{reference:resultReference}}});
  assert.equal(rebound.out.errors[0]?.code,'SOURCE_UNAVAILABLE',rebound.text);assert.equal(rebound.out.run,undefined,'a record input cannot copy a result whose basis is no longer readable');
  await spaces.grant(owner.principal,{path:'/basis',audience:'member',member:other.user.id});
  const repaired=await client.call('submit_result',submission);assert.equal(repaired.out.acceptance,'accepted',repaired.text);assert.equal(repaired.out.result?.trace,accepted.out.result?.trace,'the unchanged accepted receipt survives a temporary grant revocation');assert.ok(repaired.text.includes(resultReference));
  assert.equal((await reader.call('get_nodes',{reference:resultReference})).isError,false);
  await hub.hub.registry.personal!.grant(owner.principal,packId,{audience:'member',member:other.user.id,revoke:true});
  assert.equal(await hub.hub.runs.getRun(other.principal,privateRun),null);assert.equal((await reader.call('get_nodes',{reference:resultReference})).isError,true);
  assert.equal((await client.call('get_nodes',{reference:resultReference})).isError,false);
  for(const denied of [client,admin])assert.equal((await denied.call('get_nodes',{reference:'rec:'+published.version.record})).isError,true);
});

test('withdrawal qualifies an immutable accepted result and rejects a new submission using that ground',async()=>{
  const spaces=hub.hub.knowledge.spaces!,ref=(await import('../../hub/refs/api.ts')).parseReference(personalEntry);assert.equal(ref.scheme,'tree');if(ref.scheme!=='tree')return;
  const detail=await hub.hub.runs.getRun(owner.principal,privateRun);assert.ok(detail?.latest);const digest=detail.latest.record;
  await spaces.withdraw(owner.principal,ref.entry!);
  const current=await hub.hub.runs.getRun(owner.principal,privateRun);assert.ok(current?.grounds_withdrawn?.includes(personalEntry));assert.equal(current?.latest?.record,digest);
  const read=await client.call('get_nodes',{reference:resultReference});assert.equal(read.isError,false,read.text);assert.ok(read.text.includes(labelOf('validity_status','grounds_withdrawn')));
  const submit=await client.call('submit_result',{run:privateRun,model:'synthetic-scripted@1',items:[],cross_item:[{nature:'judgment',code:'level',rank:'a',statement:'合成撤回后重交',grounds:[personalEntry]}]});assert.equal(submit.out.errors[0]?.code,'GROUNDS_WITHDRAWN',submit.text);
});

test('console owner stages and publishes a generic skill, controls grants and cannot promote without the team publish right',async()=>{
  const spec:PackDescription={id:'synthetic-personal-steps',version:'1.0.0',kind:'skill',title:'合成通用做法',description:'合成个人步骤',files:{'SKILL.md':'# 合成通用做法\n按合成步骤执行。','skill.json':{schema:'skill@1',parsers:[]}}};
  const written=await writePack(join(dir,'skill'),spec);const files:Record<string,Uint8Array>={};for(const path of ['pack.json',...written.manifest.files.map(row=>row.path)])files[path]=await readFile(join(written.dir,path));
  const ownConsole=await openConsole(hub,owner.token),otherConsole=await openConsole(hub,other.token);const home=await ownConsole.get('/console/packs/-/publish');assert.equal(home.status,200,home.body);const nonce=csrf(home.body);
  const boundary='synthetic-personal-pack';const body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="csrf"\r\n\r\n${nonce}\r\n--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="synthetic.zip"\r\nContent-Type: application/zip\r\n\r\n`),Buffer.from(zipSync(files)),Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const staged=await new Promise<Awaited<ReturnType<typeof ownConsole.get>>>((resolve,reject)=>{import('node:http').then(({request})=>{const req=request({host:'127.0.0.1',port:hub.port,path:'/console/packs/do/stage',method:'POST',headers:{cookie:'circle_hub_session='+ownConsole.sessionCookie,origin:'http://127.0.0.1:'+hub.port,'content-type':'multipart/form-data; boundary='+boundary}},res=>{const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode!,headers:res.headers,body:Buffer.concat(chunks).toString()}));});req.on('error',reject);req.end(body);}).catch(reject);});
  assert.equal(staged.status,303,staged.body);const waiting=await ownConsole.get('/console/packs/-/publish'),stage=/name="stage" value="([^"]+)"/.exec(waiting.body)?.[1];assert.ok(stage,waiting.body);
  const outsider=await otherConsole.get('/console/packs/-/publish');assert.equal((await otherConsole.post('/console/packs/do/publish',{csrf:csrf(outsider.body),stage})).status,400);
  assert.equal((await ownConsole.post('/console/packs/do/publish',{csrf:nonce,stage})).status,303);
  const detailUrl='/console/packs/'+spec.id+'?space='+owner.user.id;const detail=await ownConsole.get(detailUrl);assert.equal(detail.status,200,detail.body);assert.match(detail.body,/使用授权/);assert.match(detail.body,/发布到团队/);
  assert.equal((await otherConsole.get(detailUrl)).status,404);
  assert.equal((await ownConsole.post('/console/packs/do/grant',{csrf:'invalid',pack:spec.id,audience:'member',member:other.user.name})).status,403);
  assert.equal((await ownConsole.send('/console/packs/do/grant',{method:'POST',headers:{origin:'http://192.0.2.1','content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:nonce,pack:spec.id,audience:'member',member:other.user.name}).toString()})).status,403);
  assert.equal((await ownConsole.post('/console/packs/do/grant',{csrf:nonce,pack:spec.id,audience:'member',member:other.user.name})).status,303);assert.equal((await otherConsole.get(detailUrl)).status,200);
  const readable=await reader.call('get_nodes',{pack:spec.id,pack_space:owner.user.id});assert.equal(readable.isError,false,readable.text);assert.match(readable.text,/合成通用做法/);
  assert.equal((await ownConsole.post('/console/packs/do/promote',{csrf:nonce,pack:spec.id,version:spec.version})).status,400);
  await hub.records.authorizations.grantPublishRight(hub.admin.principal,owner.user.id);
  assert.equal((await ownConsole.post('/console/packs/do/promote',{csrf:nonce,pack:spec.id,version:spec.version})).status,303);
  assert.ok(await hub.hub.registry.resolve(spec.id));assert.ok(await hub.hub.registry.personal!.resolve(owner.principal,owner.user.id,spec.id));
  const workflowPromoted=await hub.hub.registry.personal!.promote(owner.principal,packId);assert.ok(workflowPromoted.ok,JSON.stringify(workflowPromoted));
  await hub.assignPack(owner.principal,packId);await hub.assignPack(other.principal,packId);
  assert.equal(await hub.hub.runs.getRun(other.principal,privateRun),null,'the old private result is not widened by promotion');
  const input='src:'+(await hub.hub.knowledge.spaces!.importFile(owner.principal,Buffer.from('{"team":true}'),'application/json','team.json','/inputs')).body.sha256;const team=await client.call('start_run',{pack:packId,inputs:{target:{reference:input}}});assert.equal(team.isError,false,team.text);assert.equal(team.out.run?.team_shared,true);
  assert.ok(await hub.hub.runs.getRun(other.principal,team.out.run!.run));
  await hub.assignPack(hub.admin.principal,packId);
  const hidden=await hub.hub.knowledge.spaces!.importFile(owner.principal,Buffer.from('{"private":"synthetic metadata"}'),'application/json','hidden.json','/hidden');
  const rebound=await admin.call('start_run',{pack:packId,inputs:{target:{reference:'rec:'+hidden.digest}}});
  assert.equal(rebound.out.errors[0]?.code,'SOURCE_UNAVAILABLE',rebound.text);assert.equal(rebound.out.run,undefined,'administrators cannot bind a private source artifact through its metadata record');
});

test('a frozen personal skill keeps its namespace but loses use when the owner revokes the initiator grant',async()=>{
  const spec=workflowPack({id:'synthetic-dependency-review',product:{catalogs:[]}});spec.files['knowledge.json']={schema:'knowledge@1',requires:[]};
  spec.dependencies=[{pack:'synthetic-personal-steps',space:owner.user.id}];
  assert.ok((await hub.hub.registry.personal!.publish(other.principal,(await writePack(join(dir,'dependent'),spec)).dir)).ok);
  const spaces=hub.hub.knowledge.spaces!,input=await spaces.importFile(other.principal,Buffer.from('{}'),'application/json','dependent.json');
  const started=await reader.call('start_run',{pack:spec.id,pack_space:other.user.id,inputs:{target:{reference:'src:'+input.body.sha256}}});assert.equal(started.isError,false,started.text);
  const run=started.out.run!;assert.equal(run.skills?.[0]?.space,owner.user.id);
  assert.ok(await hub.hub.parsers.forRun!(run.run,{user:other.user.id,role:'user'}));
  await assert.rejects(hub.hub.parsers.forRun!(run.run,{user:hub.admin.user.id,role:'admin'}),/授权/);
  await hub.hub.registry.personal!.grant(owner.principal,'synthetic-personal-steps',{audience:'member',member:other.user.id,revoke:true});
  await assert.rejects(hub.hub.parsers.forRun!(run.run,{user:other.user.id,role:'user'}),/授权/);
  assert.equal((await reader.call('get_nodes',{pack:'synthetic-personal-steps',pack_space:owner.user.id})).isError,true);
  const refused=await reader.call('submit_result',{run:run.run,model:'synthetic-scripted@1',items:[],cross_item:[{nature:'judgment',code:'level',rank:'a',statement:'合成撤权后提交',grounds:[]}]});assert.equal(refused.out.errors[0]?.code,'SOURCE_UNAVAILABLE',refused.text);
  assert.ok((await hub.records.store.find({kind:'submission',key:'runs.submission.run',value:run.run,limit:10})).items.length,'a missing skill never discards the received submission');
});

test('a fact-only personal workflow accepts private inputs without giving administrators automatic result access',async()=>{
  const spec=workflowPack({id:'synthetic-private-facts',product:{catalogs:[]}});
  const requirements=spec.files['requirements.json'] as {requirements:Array<{key:string}>};requirements.requirements=requirements.requirements.filter(row=>row.key==='titles');
  const checks=spec.files['checks.json'] as {checks:Array<{id:string}>};checks.checks=checks.checks.filter(row=>row.id==='titles');
  spec.files['slots.schema.json']={schema:'slots@1',item:{},run:{}};spec.files['knowledge.json']={schema:'knowledge@1',requires:[]};
  spec.files['functions/project.ts']="export default input => ({items:[{id:'title',label:input.inputs[0].model.title,location:{parser:'json@1',selector:'p/title'},fields:{title:input.inputs[0].model.title}}],warnings:[]});";
  delete spec.files['samples/positive/codes-good.json'];delete spec.files['samples/negative/codes-bad.json'];delete spec.files['tables/codes.json'];
  const published=await hub.hub.registry.personal!.publish(other.principal,(await writePack(join(dir,'private-facts'),spec)).dir);assert.ok(published.ok,JSON.stringify(published));
  const file=await hub.hub.knowledge.spaces!.importFile(other.principal,Buffer.from(JSON.stringify({title:'合成私有标题'})),'application/json','private-facts.json');
  const started=await reader.call('start_run',{pack:spec.id,pack_space:other.user.id,inputs:{target:{reference:'src:'+file.body.sha256}}});assert.equal(started.isError,false,started.text);assert.ok(started.out.result);
  const detail=await hub.hub.runs.getRun(other.principal,started.out.run!.run);assert.ok(detail?.production);assert.equal(detail.run.items[0]?.label,'合成私有标题');
  assert.equal((await admin.call('get_nodes',{reference:'rec:'+detail.production.record})).isError,true);
});

test('a private workflow with identical team bytes keeps its owner and hides request instances from ungranted administrators',async()=>{
  const spec=workflowPack({id:'synthetic-private-unknown',product:{catalogs:[]}});
  spec.files['knowledge.json']={schema:'knowledge@1',requires:[]};
  spec.files['slots.schema.json']={schema:'slots@1',item:{},run:{}};
  spec.files['requirements.json']={schema:'requirements@1',requirements:[{key:'probe',name:'合成检查',description:'合成缺失事实',target:'run',required:true,done_rule:'bookkeeping',layers:['static'],accepted_producer:'fact',checks:['probe'],error_handling:[]}]};
  spec.files['checks.json']={schema:'checks@1',checks:[{id:'probe',function:{module:'functions/probe.ts'},applies:'run',judges:'subject',tier:'advisory'}]};
  spec.files['functions/probe.ts']="export default input => input.subject?.probe==='good'?[{verdict:'support',statement:'合成正例',grounds:[],tier:'advisory'}]:input.subject?.probe==='bad'?[{verdict:'refute',code:'synthetic-private-unknown.sample_refute',statement:'合成反例',grounds:[],tier:'advisory'}]:[{verdict:'unknown',reason:'check_error',missing:'合成私有请求实例',statement:'合成私有检查尚未完成',grounds:[],tier:'advisory'}];";
  for(const path of Object.keys(spec.files))if(path.startsWith('samples/')||path.startsWith('tables/'))delete spec.files[path];
  spec.files['samples/positive/probe.json']={id:'probe_good',source:'author',check:'probe',subject:{probe:'good'},expect:[{verdict:'support'}]};
  spec.files['samples/negative/probe.json']={id:'probe_bad',source:'author',check:'probe',subject:{probe:'bad'},expect:[{verdict:'refute',code:'synthetic-private-unknown.sample_refute'}]};
  const written=await writePack(join(dir,'private-unknown'),spec),team=await hub.hub.registry.publish(hub.admin.principal,written.dir);
  assert.ok(team.ok,JSON.stringify(team));
  const own=await hub.hub.registry.personal!.publish(other.principal,written.dir);assert.ok(own.ok,JSON.stringify(own));assert.equal(own.version.digest,team.version.digest);
  const file=await hub.hub.knowledge.spaces!.importFile(other.principal,Buffer.from('{}'),'application/json','unknown.json','/unknown');
  const started=await reader.call('start_run',{pack:spec.id,pack_space:other.user.id,inputs:{target:{reference:'src:'+file.body.sha256}}});assert.equal(started.isError,false,started.text);
  const run=started.out.run!;assert.ok(started.out.result,started.text);
  const requests=await hub.hub.runs.listRequests!(other.principal,run.run);assert.ok(requests.length);assert.ok(requests.every(row=>row.audience===other.user.id),'repair requests use the personal publisher, not the owner of identical team bytes');
  assert.ok(!(await hub.hub.runs.listRequests!(hub.admin.principal)).some(row=>row.run===run.run));
  for(const row of requests)assert.equal((await admin.call('get_nodes',{reference:'rec:'+row.record})).isError,true);
  await hub.hub.registry.personal!.grant(other.principal,spec.id,{audience:'administrators'});
  await hub.hub.knowledge.spaces!.grant(other.principal,{path:'/unknown',audience:'administrators'});
  const detail=await hub.hub.runs.getRun(hub.admin.principal,run.run);assert.ok(detail?.production,'authorized readers can read an accepted unknown result without receiving request authority');
  assert.equal((await admin.call('get_nodes',{reference:'rec:'+detail.production.record})).isError,false);
  assert.ok(!(await hub.hub.runs.listRequests!(hub.admin.principal)).some(row=>row.run===run.run));
  for(const row of requests)assert.equal((await admin.call('get_nodes',{reference:'rec:'+row.record})).isError,true);
  const privateAdmin=await hub.hub.registry.personal!.publish(hub.admin.principal,written.dir);assert.ok(privateAdmin.ok);
  const adminFile=await hub.hub.knowledge.spaces!.importFile(hub.admin.principal,Buffer.from('{}'),'application/json','admin-unknown.json');
  const adminStart=await admin.call('start_run',{pack:spec.id,pack_space:hub.admin.user.id,inputs:{target:{reference:'src:'+adminFile.body.sha256}}});assert.equal(adminStart.isError,false,adminStart.text);
  const ownRequests=await hub.hub.runs.listRequests!(hub.admin.principal,adminStart.out.run!.run);assert.ok(ownRequests.length);
  const fixed={...spec,version:'1.0.1'},updated=await writePack(join(dir,'private-unknown-fixed'),fixed);
  const refused=await hub.hub.registry.publish(hub.admin.principal,updated.dir,{answerRequests:[ownRequests[0].record]});assert.equal(refused.ok,false);assert.ok(!refused.ok&&refused.problems.some(row=>row.rule==='publish.answer_request'),'team publication cannot answer a private repair request with the same digest');
});


test('shared revisions use the selected team directory through MCP and password-console forms',async()=>{
  const spaces=hub.hub.knowledge.spaces!,source=await hub.records.artifacts.ingest({bytes:Buffer.from('合成修订依据：每次三项。'),mediaType:'text/plain',origin:{read:{object:'synthetic:document:revision'}},author:{user:null},provenanceType:'observed',visibility:{readers:[owner.user.id],admins:true,packs:[],shareable:false}});
  const body={kind:'observation',statement:'合成共享修订第一版',path:'/revision-personal',grounds:[{reference:'src:'+source.body.sha256,quotation:'每次三项'}]};
  const first=(await client.call('upload_file',{personal_entry:body})).out.personal_entry!;
  const shared=await client.call('upload_file',{share_entry:{root:first.root,path:body.path,entry:first.entry,team_path:'/revision-team/first'}});
  assert.equal(shared.isError,false,shared.text);assert.equal(shared.out.share?.target_path,'/revision-team/first');assert.ok(shared.text.includes('/revision-team/first'));
  const changed=(await client.call('upload_file',{personal_entry:{...body,statement:'合成共享修订第二版',replaces:first.entry}})).out.personal_entry!;
  const browser=await openConsole(hub,owner.token);
  const page=await browser.get('/console/knowledge/space?'+new URLSearchParams({space:owner.user.id,root:changed.root,path:body.path,entry:changed.entry}));
  assert.equal(page.status,200,page.body);assert.match(page.body,/name="team_path"/);
  const csrf=/name="csrf" value="([^"]+)"/.exec(page.body)?.[1];assert.ok(csrf);
  const merged=await browser.post('/console/knowledge/do/share',{csrf,root:changed.root,path:body.path,entry:changed.entry,team_path:'/revision-team/second'});
  assert.equal(merged.status,303,merged.body);
  const team=(await spaces.current('team'))!,current=await spaces.entry(other.principal,team.root,'/revision-team/second',changed.entry);
  assert.equal(current?.body.replaces,first.entry);assert.equal(current?.body.shared_from?.path,body.path);
  assert.match((await reader.call('get_nodes',{reference:shared.out.share!.reference!})).text,/被取代/);
  const history=await browser.get('/console/knowledge/submissions');assert.equal(history.status,200,history.body);assert.match(history.body,/团队目录/);assert.ok(history.body.includes('/revision-team/second'));
});

test('rejected raw submissions never disclose copied private quotations through direct records or record inputs',async()=>{
  const spaces=hub.hub.knowledge.spaces!,privateQuote='合成仅本人可读的拒收原始引文甲';
  const privateSource=await spaces.importFile(owner.principal,Buffer.from(privateQuote),'text/plain','synthetic-rejected-quote.txt','/rejected-private');
  const personal=await spaces.write(owner.principal,{kind:'observation',statement:'合成被拒提交依据',path:'/rejected-private',grounds:[{reference:'src:'+privateSource.body.sha256,quotation:privateQuote}]});
  const input=await hub.records.artifacts.ingest({bytes:Buffer.from('{"synthetic":"public-input-for-rejected-submission"}'),mediaType:'application/json',origin:{read:{object:'synthetic:document:submission-input'}},author:{user:null},provenanceType:'observed',visibility:{readers:[owner.user.id,other.user.id],admins:true,packs:[],shareable:false}});
  const started=await client.call('start_run',{pack:packId,inputs:{target:{reference:'src:'+input.body.sha256}}});assert.equal(started.isError,false,started.text);const run=started.out.run!;
  for(const by of [other.principal,hub.admin.principal])assert.ok(await hub.hub.runs.getRun(by,run.run),'the counterexample readers otherwise have access to this team run');
  const reference=`tree:${run.knowledge_spaces!.personal}/rejected-private@${personal.entry}`;
  const refused=await client.call('submit_result',{run:run.run,model:'synthetic-scripted@1',items:[],cross_item:[{nature:'judgment',code:'level',rank:'a',statement:privateQuote,grounds:[reference]}]});
  assert.equal(refused.out.errors[0]?.code,'RESULT_GROUNDS_UNREADABLE',refused.text);
  const detail=await hub.hub.runs.getRun(owner.principal,run.run);assert.ok(detail?.submissions.length);const raw='rec:'+detail.submissions[0].record;
  const own=await client.call('get_nodes',{reference:raw});assert.equal(own.isError,false,own.text);assert.ok(own.text.includes(privateQuote),'the received raw submission is preserved for its submitter');
  for(const actor of [reader,admin]){
    const denied=await actor.call('get_nodes',{reference:raw}),missing=await actor.call('get_nodes',{reference:'rec:'+'e'.repeat(64)});
    assert.equal(denied.isError,true,denied.text);assert.deepEqual(denied.out.errors,missing.out.errors);assert.ok(!denied.text.includes(privateQuote));
    const rebound=await actor.call('start_run',{pack:packId,inputs:{target:{reference:raw}}});assert.equal(rebound.out.errors[0]?.code,'SOURCE_UNAVAILABLE',rebound.text);assert.equal(rebound.out.run,undefined);assert.ok(!rebound.text.includes(privateQuote));
  }
});


test('records disclose member grants only to participants and give administrators all-admin grants and all share receipts',async()=>{
  const spaces=hub.hub.knowledge.spaces!,personal=hub.hub.registry.personal!;
  const namedPath='/synthetic-named-grant-audit',adminPath='/synthetic-admin-grant-audit';
  await spaces.directory(owner.principal,namedPath);await spaces.directory(owner.principal,adminPath);
  await spaces.grant(owner.principal,{path:namedPath,audience:'member',member:other.user.id});
  await spaces.grant(owner.principal,{path:adminPath,audience:'administrators'});
  for(const [id,audience] of [['synthetic-named-audit-workflow','member'],['synthetic-admin-audit-workflow','administrators']] as const){
    const spec=workflowPack({id,product:{catalogs:[]}}),written=await writePack(join(dir,id),spec);
    const published=await personal.publish(owner.principal,written.dir);assert.ok(published.ok,JSON.stringify(published));
    await personal.grant(owner.principal,id,{audience,...(audience==='member'?{member:other.user.id}:{})});
  }
  const first=await spaces.write(owner.principal,{kind:'observation',statement:'合成审计甲未核验条目',path:'/audit-owner-source'});
  const second=await spaces.write(other.principal,{kind:'observation',statement:'合成审计乙未核验条目',path:'/audit-other-source'});
  await spaces.share(owner.principal,{root:first.root,path:'/audit-owner-source',entry:first.entry,team_path:'/audit-owner-target'});
  await spaces.share(other.principal,{root:second.root,path:'/audit-other-source',entry:second.entry,team_path:'/audit-other-target'});
  // A stale or wrong projection must not turn a member grant into an administrator-visible event.
  for(const [kind,schema,object] of [['knowledge_space_grant','knowledge-space-grant@1',{path:'/synthetic-misindexed-private-grant'}],['personal_pack_grant','personal-pack-grant@1',{pack:'synthetic-misindexed-private-pack'}]] as const){
    const key=kind==='knowledge_space_grant'?'knowledge.space.grantee':'personal.pack.grantee';
    await hub.records.store.put({kind,schema,provenance:'declared',body:{space:owner.user.id,...object,audience:'member',member:other.user.id,action:'grant',by:owner.user.id,at:new Date().toISOString()},index:[{key,value:'administrators'}]});
  }
  const stranger=await hub.createUser('合成无关记录成员');
  const ownerPage=await (await openConsole(hub,owner.token)).get('/console/records');
  const otherPage=await (await openConsole(hub,other.token)).get('/console/records');
  const adminBrowser=await openConsole(hub,hub.admin.token),adminPage=await adminBrowser.get('/console/records');
  const absentPage=await (await openConsole(hub,stranger.token)).get('/console/records');
  for(const page of [ownerPage,otherPage,adminPage,absentPage])assert.equal(page.status,200,page.body);
  for(const page of [ownerPage,otherPage]){assert.ok(page.body.includes('synthetic-named-grant-audit'));assert.ok(page.body.includes('synthetic-named-audit-workflow'));}
  assert.ok(adminPage.body.includes('synthetic-admin-grant-audit'));assert.ok(adminPage.body.includes('synthetic-admin-audit-workflow'));
  for(const page of [adminPage,absentPage]){assert.ok(!page.body.includes('synthetic-named-grant-audit'));assert.ok(!page.body.includes('synthetic-named-audit-workflow'));}
  assert.ok(!adminPage.body.includes('synthetic-misindexed-private-grant'));assert.ok(!adminPage.body.includes('synthetic-misindexed-private-pack'));
  assert.ok(adminPage.body.includes('audit-owner-target'));assert.ok(adminPage.body.includes('audit-other-target'));
  assert.ok(ownerPage.body.includes('audit-owner-target'));assert.ok(!ownerPage.body.includes('audit-other-target'));
  assert.ok(otherPage.body.includes('audit-other-target'));assert.ok(!otherPage.body.includes('audit-owner-target'));
  const filtered=await adminBrowser.get('/console/records?'+new URLSearchParams({user:owner.user.id}));assert.equal(filtered.status,200,filtered.body);assert.ok(filtered.body.includes('audit-owner-target'));assert.ok(!filtered.body.includes('audit-other-target'));assert.ok(!filtered.body.includes('synthetic-named-grant-audit'));assert.ok(!filtered.body.includes('synthetic-named-audit-workflow'));
  const dated=await adminBrowser.get('/console/records?'+new URLSearchParams({from:'2000-01-01',to:'2000-01-02'}));assert.equal(dated.status,200);assert.ok(!dated.body.includes('audit-owner-target'));assert.ok(!dated.body.includes('synthetic-admin-grant-audit'));
  const forgedFilter=await (await openConsole(hub,stranger.token)).get('/console/records?'+new URLSearchParams({user:owner.user.id}));assert.equal(forgedFilter.status,200);assert.ok(!forgedFilter.body.includes('synthetic-named-grant-audit'));assert.ok(!forgedFilter.body.includes('audit-owner-target'));
});
