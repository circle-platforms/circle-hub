import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {sha256} from '../../packages/contracts/src/index.ts';
import {setup,type Harness} from './harness.ts';

const skillText=Buffer.from('---\nname: pinned-judgement\ndescription: Synthetic skill with no tools.\n---\nUse the pinned judgement.\n');
function skillBody(id:string){return {manifest:{id,version:'1.0.0',title:'Synthetic pinned skill',owner:'synthetic-team',tools:[],triggers:['manual'],inputs:{},outputs:['out.txt'],model:'scripted'},files:[{path:'SKILL.md',base64:skillText.toString('base64'),sha256:sha256(skillText)}],trial:{toolCalls:[],outputs:[]}};}
async function approveChange(h:Harness,change:any,username='bob'){const approval=(await h.request(`/v1/tasks/${change.approvalTaskId}/approvals`,undefined,username))[0];return h.request(`/v1/tasks/${change.approvalTaskId}/approvals/${approval.approvalId}`,{inputRevisionId:approval.inputRevisionId,targetIdentity:approval.targetIdentity,actionDigest:approval.actionDigest,approve:true},username);}

test('Teams grant knowledge access and an approval role to their members',async t=>{
  const h=await setup(t);
  const change=await h.request('/v1/scopes/scp_lab/teams',{name:'Legal',members:['prn_bob'],idempotencyKey:'team-legal-bob'});
  await approveChange(h,change);
  const teamId=change.submission.teamId as string;
  assert.match(teamId,/^team_[a-f0-9]{32}$/);
  const listed=await h.request('/v1/scopes/scp_lab/teams');
  assert.deepEqual(listed.items.find((item:any)=>item.teamId===teamId).members,['prn_bob']);
  const bytes=Buffer.from('Team note'),source=await h.request('/v1/knowledge/sources',{scopeId:'scp_lab',sourceId:'fixture/team',revision:'1',path:'/synthetic/team-note.txt',knowledgeCategory:'product',sourceType:'document',parserVersion:'fixture/1',contentBase64:bytes.toString('base64'),sha256:sha256(bytes),acl:{sourceReaders:[teamId],platformReaders:[teamId]}});
  const owner=await fetch(`${h.url}/v1/knowledge/records/${source.recordId}/content`,{headers:{authorization:`Bearer ${await h.login()}`}});
  assert.equal(owner.status,200);assert.equal(await owner.text(),'Team note');
  const member=await fetch(`${h.url}/v1/knowledge/records/${source.recordId}/content`,{headers:{authorization:`Bearer ${await h.login('bob')}`}});
  assert.equal(member.status,200);
  await h.reject(`/v1/knowledge/records/${source.recordId}/content`,undefined,'SOURCE_FORBIDDEN','admin');
  assert.ok((await h.db.query("SELECT 1 FROM audit WHERE action='knowledge.access-denied' AND detail->>'code'='SOURCE_FORBIDDEN' AND principal_id='prn_admin'")).rowCount);
  const role=await h.request('/v1/scopes/scp_lab/approval-roles',{teamId,role:'legal',idempotencyKey:'team-legal-role'});
  await approveChange(h,role);
  const request=await h.request('/v1/approval-requests',{scopeId:'scp_lab',title:'Counsel review',summary:'Synthetic legal text',content:{fileName:'counsel.txt',mediaType:'text/plain',text:'Approved by the legal team'},policy:{roles:[{role:'legal',count:1}]},idempotencyKey:'team-legal-request'});
  await h.reject(`/v1/approval-requests/${request.requestId}/decisions`,{approve:true},'FORBIDDEN_ACTION','admin');
  const decided=await h.request(`/v1/approval-requests/${request.requestId}/decisions`,{approve:true},'bob');
  assert.equal(decided.status,'approved');
});

test('The current snapshot id is readable and a later null publish is stale',async t=>{
  const h=await setup(t);
  const empty=await h.request('/v1/knowledge/snapshots/current?scopeId=scp_lab&knowledgeCategory=consolidated');
  assert.equal(empty.snapshotId,null);
  const first=await h.request('/v1/knowledge/snapshots',{scopeId:'scp_lab',knowledgeCategory:'consolidated',expectedSnapshotId:null});
  const current=await h.request('/v1/knowledge/snapshots/current?scopeId=scp_lab&knowledgeCategory=consolidated');
  assert.equal(current.snapshotId,first.recordId);
  await h.reject('/v1/knowledge/snapshots',{scopeId:'scp_lab',knowledgeCategory:'consolidated',expectedSnapshotId:null},'INPUT_REVISION_STALE');
  const second=await h.request('/v1/knowledge/snapshots',{scopeId:'scp_lab',knowledgeCategory:'consolidated',expectedSnapshotId:current.snapshotId});
  assert.equal(second.recordId,first.recordId);
  const bytes=Buffer.from('Feature beta is available'),src=await h.request('/v1/knowledge/sources',{scopeId:'scp_lab',sourceId:'fixture/beta',revision:'1',path:'/synthetic/beta.txt',knowledgeCategory:'product',sourceType:'document',parserVersion:'fixture/1',contentBase64:bytes.toString('base64'),sha256:sha256(bytes),acl:{sourceReaders:['prn_alice','prn_bob'],platformReaders:['prn_alice','prn_bob']}});
  const evidence=await h.request('/v1/knowledge/evidence',{sourceRecordId:src.recordId,start:0,end:bytes.length});
  const candidate=await h.request('/v1/knowledge/claims',{scopeId:'scp_lab',subject:'feature-beta',predicate:'availability',value:'available',evidenceIds:[evidence.recordId],origin:'model'});
  await h.request(`/v1/knowledge/claims/${candidate.recordId}/request-review`,{reviewerId:'prn_bob'});
  const review=await h.request(`/v1/knowledge/claims/${candidate.recordId}/review`,{decision:'approve',promote:true,reason:'Synthetic independent review',ruleVersion:'human-review/1'},'bob');
  const product=await h.request('/v1/knowledge/snapshots/current?scopeId=scp_lab&knowledgeCategory=product');
  assert.equal(product.snapshotId,review.snapshot.recordId);
});

test('An approved skill installs into the pack list and a run can pin a judgement',async t=>{
  const h=await setup(t);
  await writeFile(`${h.scratch}/runtime.json`,JSON.stringify({circleBin:'synthetic-runtime-not-executed',circleCommit:'0'.repeat(40),circleVersion:'1.7.0',model:{kind:'scripted',base_url:'http://127.0.0.1:9/v1',model:'synthetic',protocol:'openai',api_key:randomBytes(16).toString('hex')}}),{mode:0o600});
  h.env.CIRCLE_RUNTIME_CONFIG=`${h.scratch}/runtime.json`;await h.stop();await h.startServer();
  const pushed=await h.raw('/v1/skillpacks',{token:await h.login(),headers:{'x-scope-id':'scp_lab'},body:skillBody('pinned-judgement')});
  assert.equal(pushed.status,201,JSON.stringify(pushed.body));
  const pack=pushed.body.data;await approveChange(h,pack);
  assert.equal((await h.request('/v1/packs')).some((item:any)=>item.capabilityPackId==='pinned-judgement'),false);
  const blocked=await h.reject('/v1/tasks/submit',{scopeId:'scp_lab',title:'Run before install',capabilityPackId:'pinned-judgement',input:{},idempotencyKey:'skill-before-install'},'APPROVAL_REQUIRED');
  assert.match(blocked.message,/install/);assert.notEqual(blocked.code,'UNSUPPORTED_VERSION');
  const direct=await h.request(`/v1/skillpacks/${pack.skillPackId}/runs`,{inputs:{},idempotencyKey:'approved-run-without-install'});
  assert.equal(direct.taskId.startsWith('task_'),true);
  await h.reject(`/v1/skillpacks/${pack.skillPackId}/install`,{},'FORBIDDEN_ACTION','bob');
  const installed=await h.request(`/v1/skillpacks/${pack.skillPackId}/install`,{});
  assert.equal(installed.lifecycle,'running');assert.equal(installed.capabilityPackId,'pinned-judgement');
  const packs=await h.request('/v1/packs');
  assert.ok(packs.some((item:any)=>item.capabilityPackId==='pinned-judgement'&&item.installed===true&&item.skillPackId===pack.skillPackId));
  const admitted=await h.request('/v1/tasks/submit',{scopeId:'scp_lab',title:'Run installed skill',capabilityPackId:'pinned-judgement',input:{note:'synthetic'},idempotencyKey:'skill-after-install'});
  assert.equal(admitted.taskId.startsWith('task_'),true);
  const text='incident starts when the synthetic alarm repeats',digest=sha256(text);
  const judgement=await h.request('/v1/judgements',{scopeId:'scp_lab',name:'Incident start',judgementKind:'incident-start',fileName:'incident-start.txt',mediaType:'text/plain',text,idempotencyKey:'judgement-incident-start'});
  await approveChange(h,judgement);
  const pin={assetId:judgement.items[0].assetId,version:judgement.items[0].version,sha256:digest};
  const listed=await h.request('/v1/judgements?scopeId=scp_lab');
  assert.ok(listed.items.some((item:any)=>item.assetId===pin.assetId&&item.sha256===digest&&item.judgementKind==='incident-start'));
  const download=await fetch(`${h.url}/v1/judgements/${pin.assetId}/content`,{headers:{authorization:`Bearer ${await h.login()}`}});
  assert.equal(download.status,200);assert.equal(download.headers.get('content-type'),'text/plain');assert.equal(await download.text(),text);
  const pinned=await h.request(`/v1/skillpacks/${pack.skillPackId}/runs`,{inputs:{note:'use the pin'},idempotencyKey:'run-with-judgement',judgementPins:[pin]});
  const stored=(await h.db.query('SELECT input FROM tasks WHERE task_id=$1',[pinned.taskId])).rows[0].input;
  assert.equal(stored.judgementPins[0].sha256,digest);
  await h.reject(`/v1/skillpacks/${pack.skillPackId}/runs`,{inputs:{},idempotencyKey:'run-bad-pin',judgementPins:[{...pin,sha256:'a'.repeat(64)}]},'SOURCE_HASH_MISMATCH');
});
