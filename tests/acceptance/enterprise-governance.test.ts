import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {createSign,generateKeyPairSync} from 'node:crypto';
import {canonicalHash,sha256} from '../../packages/contracts/src/index.ts';
import {root,setup,type Harness} from './harness.ts';

const skillText=Buffer.from('---\nname: governance-fixture\ndescription: Synthetic governance skill.\n---\nUse the declared hub tools.\n');
function skill(id:string,tools:string[]){return {manifest:{id,version:'1.0.0',title:'Synthetic governance skill',owner:'synthetic-team',tools,triggers:['manual'],inputs:{},outputs:['out.txt'],model:'scripted'},files:[{path:'SKILL.md',base64:skillText.toString('base64'),sha256:sha256(skillText)}],trial:{toolCalls:tools.map(name=>({name,argsSha256:sha256('{}'),ok:true})),outputs:[]}};}
async function postSkill(h:Harness,body:ReturnType<typeof skill>){return h.raw('/v1/skillpacks',{token:await h.login(),headers:{'x-scope-id':'scp_lab'},body});}
async function approveChange(h:Harness,change:any,username='bob'){const approval=(await h.request(`/v1/tasks/${change.approvalTaskId}/approvals`,undefined,username))[0];return h.request(`/v1/tasks/${change.approvalTaskId}/approvals/${approval.approvalId}`,{inputRevisionId:approval.inputRevisionId,targetIdentity:approval.targetIdentity,actionDigest:approval.actionDigest,approve:true},username);}
async function assignRole(h:Harness,principalId:string,role:string){const change=await h.request('/v1/scopes/scp_lab/approval-roles',{principalId,role,idempotencyKey:`role-${principalId}-${role}`});await approveChange(h,change);return change;}
async function command(env:NodeJS.ProcessEnv,args:string[]){const child=spawn(process.execPath,['bin/circle-hub',...args],{cwd:root,env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout!.on('data',data=>{stdout+=data.toString();});child.stderr!.on('data',data=>{stderr+=data.toString();});const [code]=await once(child,'exit');return {code,stdout,stderr};}

test('Enterprise governance: approved knowledge is searchable and a role quorum can accept or reject with a reason',async t=>{
  const h=await setup(t);
  const bytes=Buffer.from('Feature alpha is available'),src=await h.request('/v1/knowledge/sources',{scopeId:'scp_lab',sourceId:'fixture/manual',revision:'1',path:'/synthetic/manual.txt',knowledgeCategory:'product',sourceType:'document',parserVersion:'fixture/1',contentBase64:bytes.toString('base64'),sha256:sha256(bytes),acl:{sourceReaders:['prn_alice','prn_bob'],platformReaders:['prn_alice','prn_bob']}});
  const evidence=await h.request('/v1/knowledge/evidence',{sourceRecordId:src.recordId,start:0,end:bytes.length});
  const candidate=await h.request('/v1/knowledge/claims',{scopeId:'scp_lab',subject:'feature-alpha',predicate:'availability',value:'available',evidenceIds:[evidence.recordId],origin:'model'});
  await h.request(`/v1/knowledge/claims/${candidate.recordId}/request-review`,{reviewerId:'prn_bob'});
  const review=await h.request(`/v1/knowledge/claims/${candidate.recordId}/review`,{decision:'approve',promote:true,reason:'Synthetic independent review',ruleVersion:'human-review/1'},'bob');
  const found=await h.request('/v1/knowledge/search?mode=exact&q=feature-alpha');
  assert.equal(found.items.length,1);assert.equal(found.items[0].snapshotId,review.snapshot.recordId);
  const note=Buffer.from('Owner can read this synthetic note'),hidden=await h.request('/v1/knowledge/sources',{scopeId:'scp_lab',sourceId:'fixture/owner',revision:'1',path:'/synthetic/owner-note.txt',knowledgeCategory:'product',sourceType:'document',parserVersion:'fixture/1',contentBase64:note.toString('base64'),sha256:sha256(note),acl:{sourceReaders:['prn_bob'],platformReaders:['prn_bob']}});
  const owned=await fetch(`${h.url}/v1/knowledge/records/${hidden.recordId}/content`,{headers:{authorization:`Bearer ${await h.login()}`}});
  assert.equal(owned.status,200);assert.equal(owned.headers.get('content-type'),'text/plain');assert.match(owned.headers.get('content-disposition')??'',/owner-note\.txt/);assert.equal((owned.headers.get('content-disposition')??'').includes('.bin'),false);
  const sourceDownload=await fetch(`${h.url}/v1/sources/${hidden.payload.raw.sourceRevisionId}/content`,{headers:{authorization:`Bearer ${await h.login()}`}});
  assert.equal(sourceDownload.status,200);
  await h.reject(`/v1/knowledge/records/${hidden.recordId}/content`,undefined,'SOURCE_FORBIDDEN','limited');
  assert.ok((await h.db.query("SELECT 1 FROM audit WHERE action='knowledge.access-denied' AND detail->>'code'='SOURCE_FORBIDDEN'")).rowCount);

  await assignRole(h,'prn_bob','manager');await assignRole(h,'prn_bob','security');await assignRole(h,'prn_admin','security');
  const submitted=await h.request('/v1/approval-requests',{scopeId:'scp_lab',title:'Finance retention',summary:'Keep the synthetic policy for seven years',content:{fileName:'policy.md',mediaType:'text/markdown',text:'Synthetic finance policy'},policy:{roles:[{role:'manager',count:1},{role:'security',count:1}]},idempotencyKey:'governance-quorum-1'});
  assert.equal(submitted.status,'open');assert.equal(submitted.taskId.startsWith('task_'),true);
  const task=await h.request(`/v1/tasks/${submitted.taskId}/status`);assert.equal(task.capabilityPackId,'hub-task');assert.equal(['waiting-review','admitted','running'].includes(task.phase),true);
  const pending=await h.request('/v1/approvals/pending',undefined,'bob');
  assert.ok(pending.items.some((item:any)=>item.kind==='governance'&&item.requestId===submitted.requestId&&item.content.fileName==='policy.md'));
  assert.equal((await h.request('/v1/approvals/pending')).items.some((item:any)=>item.requestId===submitted.requestId),false);
  const preview=await fetch(`${h.url}/v1/approval-requests/${submitted.requestId}/content`,{headers:{authorization:`Bearer ${await h.login('bob')}`}});
  assert.equal(preview.headers.get('content-type'),'text/markdown');assert.match(preview.headers.get('content-disposition')??'',/policy\.md/);assert.equal(await preview.text(),'Synthetic finance policy');
  await h.reject(`/v1/approval-requests/${submitted.requestId}/decisions`,{approve:true},'SELF_APPROVAL');
  assert.ok((await h.db.query("SELECT 1 FROM audit WHERE action='approval.blocked' AND detail->>'code'='SELF_APPROVAL' AND detail->>'requestId'=$1",[submitted.requestId])).rowCount);
  const partial=await h.request(`/v1/approval-requests/${submitted.requestId}/decisions`,{approve:true},'bob');
  assert.equal(partial.status,'open');
  await h.reject(`/v1/approval-requests/${submitted.requestId}/decisions`,{approve:true},'DECISION_CONFLICT','bob');
  const approved=await h.request(`/v1/approval-requests/${submitted.requestId}/decisions`,{approve:true},'admin');
  assert.equal(approved.status,'approved');assert.ok(approved.recordId);assert.ok(approved.snapshotId);
  const shared=await h.request('/v1/knowledge/search?q=retention');
  assert.ok(shared.items.some((item:any)=>item.recordId===approved.recordId&&item.snapshotId===approved.snapshotId));
  const declined=await h.request('/v1/approval-requests',{scopeId:'scp_lab',title:'Rejected note',summary:'This synthetic decision is declined',content:{fileName:'note.txt',text:'do not publish'},policy:{roles:[{role:'manager',count:1}]},idempotencyKey:'governance-decline-1'});
  const rejection=await h.request(`/v1/approval-requests/${declined.requestId}/decisions`,{approve:false,reason:'范围不符'},'bob');
  assert.equal(rejection.status,'declined');assert.equal(rejection.declineReason,'范围不符');
  await h.reject(`/v1/approval-requests/${declined.requestId}/decisions`,{approve:false,reason:'again'},'DECISION_CONFLICT','admin');

  const asset=await h.request('/v1/assets',{scopeId:'scp_lab',kind:'knowledge-source',name:'Synthetic self approval',version:'1.0.0',declaration:{reads:[],writes:[],credentials:[]},configuration:{}});
  const self=(await h.request(`/v1/tasks/${asset.approvalTaskId}/approvals`))[0];
  await h.reject(`/v1/tasks/${asset.approvalTaskId}/approvals/${self.approvalId}`,{inputRevisionId:self.inputRevisionId,targetIdentity:self.targetIdentity,actionDigest:self.actionDigest,approve:true,reason:'自己批'},'SELF_APPROVAL');
  assert.ok((await h.db.query("SELECT 1 FROM audit WHERE action='approval.blocked' AND detail->>'code'='SELF_APPROVAL' AND detail->>'approvalId'=$1",[self.approvalId])).rowCount);
  const other=await h.request('/v1/assets',{scopeId:'scp_lab',kind:'knowledge-source',name:'Synthetic declined asset',version:'1.0.0',declaration:{reads:[],writes:[],credentials:[]},configuration:{}});
  const answer=(await h.request(`/v1/tasks/${other.approvalTaskId}/approvals`))[0];
  const classic=await h.request(`/v1/tasks/${other.approvalTaskId}/approvals/${answer.approvalId}`,{inputRevisionId:answer.inputRevisionId,targetIdentity:answer.targetIdentity,actionDigest:answer.actionDigest,approve:false,reason:'需要补充材料'},'bob');
  assert.equal(classic.status,'declined');
});

test('Enterprise governance: hub task and packs are built-in tools, unknown names fail at push, and audit export is timezone aware',async t=>{
  const h=await setup(t);
  const created=await h.request('/v1/tasks/submit',{scopeId:'scp_lab',title:'Synthetic hub task',capabilityPackId:'hub-task',input:{note:'synthetic'},idempotencyKey:'hub-task-http-1'});
  assert.equal(created.capabilityPackId,'hub-task');assert.equal(created.flowVersion,'hub-task/1');
  const tools=await h.request('/v1/tools');assert.equal(tools.some((tool:any)=>tool.name==='hub_task'||tool.name==='hub_packs'),false);
  const headers={authorization:`Bearer ${await h.login()}`,'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-11-25'};
  const call=async(name:string,args:any,meta:any)=>{const response=await fetch(`${h.url}/mcp`,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args,_meta:meta}})});assert.equal(response.status,200);return (await response.json() as any).result;};
  const packs=await call('hub_packs',{},{'hub/idempotencyKey':'packs-read'});
  assert.equal(packs.isError,false);assert.ok(packs.structuredContent.packs.some((pack:any)=>pack.capabilityPackId==='hub-task'&&pack.titleZh==='创建受治理的任务'));
  const taskArgs={scopeId:'scp_lab',title:'Synthetic MCP hub task',input:{note:'mcp'},idempotencyKey:'hub-task-mcp-1'};
  const admitted=await call('hub_task',taskArgs,{'hub/idempotencyKey':'hub-task-mcp-1','hub/confirmation':{argsDigest:canonicalHash(taskArgs)}});
  assert.equal(admitted.structuredContent.capabilityPackId,'hub-task');
  const builtin=await postSkill(h,skill('builtin-tools',['hub_task','hub_packs']));
  assert.equal(builtin.status,201,JSON.stringify(builtin.body));assert.deepEqual(builtin.body.data.check,{undeclaredTools:[],missingTools:[]});
  assert.equal((await h.request(`/v1/change-sets/${builtin.body.data.changeSetId}`)).status,'waiting-review');
  await approveChange(h,builtin.body.data);assert.equal((await h.request(`/v1/skillpacks/${builtin.body.data.skillPackId}`)).status,'registered');
  const known=await postSkill(h,skill('known-offline',['docs.search']));
  assert.equal(known.status,201);assert.deepEqual(known.body.data.check.missingTools,['docs.search']);assert.equal((await h.request(`/v1/change-sets/${known.body.data.changeSetId}`)).status,'blocked');
  const unknown=await postSkill(h,skill('unknown-tool',['hidden.read']));
  assert.equal(unknown.status,422);assert.equal(unknown.body.error.code,'SKILLPACK_CHECK_FAILED');assert.deepEqual(unknown.body.error.details.check,{undeclaredTools:[],missingTools:['hidden.read']});

  await h.db.query("INSERT INTO audit(tenant_id,scope_id,principal_id,action,detail) VALUES('tnt_lab','scp_lab','prn_alice','=danger','{\"note\":\"synthetic\"}')");
  const csvResponse=await fetch(`${h.url}/v1/admin/audit/export?format=csv&timezone=Asia%2FShanghai&action=%3Ddanger`,{headers:{authorization:`Bearer ${await h.login()}`}});
  assert.equal(csvResponse.status,200);assert.match(csvResponse.headers.get('content-type')??'',/text\/csv/);
  const csv=await csvResponse.text();assert.match(csv,/id,principalId,scopeId,action,createdAt,detail/);assert.match(csv,/'=danger/);assert.match(csv,/\+08/);
  const exported=await h.request('/v1/admin/audit/export?format=json&timezone=UTC&action=tasks.submit');
  assert.equal(exported.format,'json');assert.equal(exported.timezone,'UTC');assert.ok(exported.items.every((item:any)=>item.action==='tasks.submit'&&/\+00/.test(item.createdAt)));
  assert.ok(Array.isArray(await h.request('/v1/admin/audit')));
  await h.reject('/v1/admin/audit/export?timezone=Not%2FAZone',undefined,'INVALID_PAYLOAD');
  const english=await h.raw('/v1/not-a-route',{token:await h.login()});
  assert.equal(english.body.error.message,'API route not found');assert.equal(english.body.error.messageZh,'接口路由不存在');assert.equal(english.body.error.messageEn,undefined);
  const chinese=await h.raw('/v1/not-a-route',{token:await h.login(),headers:{'accept-language':'zh-CN,zh;q=0.9'}});
  assert.equal(chinese.body.error.message,'接口路由不存在');assert.equal(chinese.body.error.messageEn,'API route not found');assert.equal(chinese.body.error.messageZh,'接口路由不存在');

  const clean={...process.env};for(const key of Object.keys(clean))if(key.startsWith('CIRCLE_SERVER_'))delete clean[key];delete clean.CIRCLE_HUB_TOKEN;
  const help=await command(clean,[]);assert.equal(help.code,0,help.stderr);assert.match(help.stdout,/admin audit/);
  const adminHelp=await command(clean,['admin','help']);assert.equal(adminHelp.code,0,adminHelp.stderr);assert.match(adminHelp.stdout,/--timezone/);
  const env={...clean,CIRCLE_HUB_URL:h.url,CIRCLE_HUB_TOKEN:await h.login()};
  const cli=await command(env,['admin','audit','--format','csv','--timezone','Asia/Shanghai','--action','tasks.submit']);
  assert.equal(cli.code,0,cli.stderr);assert.match(cli.stdout,/tasks\.submit/);assert.match(cli.stdout,/\+08/);
});

test('Enterprise governance: configured loopback OIDC issues a session for a provisioned subject',async t=>{
  const h=await setup(t);
  await h.reject('/v1/auth/oidc/start',undefined,'TARGET_NOT_FOUND');
  const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const pem=publicKey.export({type:'spki',format:'pem'}).toString();
  let claims={sub:'unknown-subject',email:'nobody@example.test',nonce:''};
  const server=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));if(req.url==='/token'){const header=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url'),body=Buffer.from(JSON.stringify({iss:`http://127.0.0.1:${(server.address() as any).port}`,aud:'synthetic-client',exp:Math.floor(Date.now()/1000)+300,...claims})).toString('base64url'),signature=createSign('RSA-SHA256').update(`${header}.${body}`).sign(privateKey).toString('base64url');res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id_token:`${header}.${body}.${signature}`}));return;}res.writeHead(404);res.end();});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(()=>resolve(undefined))));
  const port=(server.address() as any).port,origin=`http://127.0.0.1:${port}`;
  h.env.CIRCLE_HUB_OIDC_CONFIG=JSON.stringify({issuer:origin,clientId:'synthetic-client',clientSecret:'synthetic-only-secret',authorizationUrl:`${origin}/authorize`,tokenUrl:`${origin}/token`,redirectUri:`${origin}/callback`,publicKeyPem:pem});
  await h.stop();await h.startServer();
  const first=await h.raw('/v1/auth/oidc/start');assert.equal(first.status,200);
  claims={...claims,nonce:new URL(first.body.data.authorizationUrl).searchParams.get('nonce')??''};
  await h.reject('/v1/auth/oidc/callback',{code:'synthetic-code',state:first.body.data.state},'UNAUTHENTICATED');
  await h.db.query("UPDATE policies SET oidc_sub='synthetic-subject' WHERE principal_id='prn_alice'");
  const second=await h.raw('/v1/auth/oidc/start');claims={sub:'synthetic-subject',email:'alice',nonce:new URL(second.body.data.authorizationUrl).searchParams.get('nonce')??''};
  const session=await h.raw('/v1/auth/oidc/callback',{body:{code:'synthetic-code',state:second.body.data.state}});
  assert.equal(session.status,200,JSON.stringify(session.body));assert.equal(session.body.data.principalId,'prn_alice');assert.equal(session.body.data.tenantId,'tnt_lab');assert.equal(session.body.data.tokenType,'Bearer');
  const status=await h.raw('/v1/status',{token:session.body.data.token});assert.equal(status.status,200);
});
