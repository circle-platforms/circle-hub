// Source-only acceptance draft: do not run without the integrator's sole PostgreSQL slot and a fresh full-test.lock check.
// Real assembly/MCP/records; scripted synthetic packs and loopback only. No permission implementation is replaced.
import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {join} from 'node:path';
import {before,after,test} from 'node:test';
import {createTestHub,type TestHub,type TestUser,type TestMcpClient} from '../../hub/server/testing-real.ts';
import {startPostgres,type TemporaryPostgres} from '../../hub/testing/postgres.ts';
import {temporaryDirectory,workflowPack,systemPack,writePack,type PackDescription} from '../../hub/runs/packs/testing/builder.ts';
import type {ResourceRecord} from '../../contracts/src/resources.ts';
import {connect,type McpClient} from './support/mcp.ts';
import {openConsole} from './support/console.ts';
import {toolText} from '../../hub/server/text.ts';
import {packListHead} from '../../hub/server/pack-words.ts';

const flow='synthetic-default-flow',effectFlow='synthetic-default-effect-flow',retiredFlow='synthetic-retired-flow',skill='synthetic-default-skill';
const privateFlow='synthetic-other-private-flow',ownPrivateFlow='synthetic-admin-private-flow';
let postgres:TemporaryPostgres,hub:TestHub,scratch:Awaited<ReturnType<typeof temporaryDirectory>>,resourceServer:Server,resource:ResourceRecord;
let defaultAdmin:TestUser,member:TestUser,assigned:TestUser,disabled:TestUser,privateOwner:TestUser;
let adminClient:McpClient,memberClient:McpClient,assignedClient:McpClient,adminWire:TestMcpClient,memberWire:TestMcpClient;
let businessReads=0;
const clients:Array<{close():Promise<void>}>=[];
let initialAnnotations:Record<string,unknown>,initialMemberAnnotations:Record<string,unknown>;
function syntheticWorkflow(id:string,title:string):PackDescription{
  const pack=workflowPack({id,title,product:{catalogs:[]}});
  pack.files['knowledge.json']={schema:'knowledge@1',requires:[]};return pack;
}
function annotations(tools:Awaited<ReturnType<TestMcpClient['listTools']>>){
  const selected:Record<string,unknown>={};
  for(const name of ['start_run','submit_result']){const tool=tools.tools.find(tool=>tool.name===name);assert.ok(tool);selected[name]=tool.annotations;}
  return selected;
}
async function input(client:McpClient){return client.upload(Buffer.from(JSON.stringify({items:[{id:'case-one',fields:{title:'合成待核对内容'}}]})),'synthetic-subject.json','application/json');}
async function begin(client:McpClient,pack:string,pack_space?:string){
  const reference=await input(client);
  return client.call('start_run',{pack,...(pack_space?{pack_space}:{}),inputs:{target:{reference}}});
}
const defaultLabel='管理员默认可用（未分配给当前账户）';
function lineAfterTitle(answer:{text:string;out:{packs:readonly {title:string;description:string}[]}},title:string){
  const pack=answer.out.packs.find(pack=>pack.title===title);assert.ok(pack,'the actual detail list includes the declared pack');
  const lines=answer.text.split('\n'),at=lines.indexOf(`${pack.title}，${pack.description}`);
  assert.ok(at>=0,'locate the exact actual pack detail heading, not the earlier title-only index');return lines[at+1];
}
async function hasWorkflow(client:McpClient,id:string){const answer=await client.call('list_task_packs',{});assert.equal(answer.isError,false,answer.text);return answer.out.packs.some(pack=>pack.id===id&&pack.kind==='workflow');}

before(async()=>{
  scratch=await temporaryDirectory('admin-default-workflows-');postgres=await startPostgres();
  hub=await createTestHub({postgres,repositoryPacks:false,stubs:false,mindmapSkill:false,workbookSkill:false,xmlSkill:false,htmlSkill:false,requireOsIsolation:false});
  defaultAdmin=await hub.createUser('合成非发布者默认管理员','admin');
  member=await hub.createUser('合成未分配成员');assigned=await hub.createUser('合成注解对照成员');disabled=await hub.createUser('合成将停用管理员','admin');privateOwner=await hub.createUser('合成私人包作者');
  adminWire=await hub.client(defaultAdmin.token);clients.push(adminWire);initialAnnotations=annotations(await adminWire.listTools());
  memberWire=await hub.client(member.token);clients.push(memberWire);initialMemberAnnotations=annotations(await memberWire.listTools());
  const regular=syntheticWorkflow(flow,'合成管理员默认工作流');
  const external=syntheticWorkflow(effectFlow,'合成外读与作业工作流');
  const workflow=external.files['workflow.json'] as {inputs:unknown[]};
  workflow.inputs.push({slot:'outside',role:'expected',description:'合成外部来源',accepts:['tracker:item'],required:false,many:false});
  const checks=external.files['checks.json'] as {checks:Array<{id:string;table?:string}>};
  checks.checks.find(check=>check.id==='titles')!.table='policies/titles.json';
  external.files['policies/titles.json']=external.files['tables/titles.json'];delete external.files['tables/titles.json'];
  const requirements=external.files['requirements.json'] as {effects?:unknown[]};
  requirements.effects=[{id:'synthetic_submit',resource_kind:'executor',action:'submit',effect_class:'job',parameters:{values:{mode:['synthetic']}},release:{requirements:['titles'],artifact:'titles'},trigger:'hub_template',budget:{count:1,duration_ms:10000},deadline_ms:60000,optional:false,policy_checks:['titles']}];
  for(const spec of [regular,external,syntheticWorkflow(retiredFlow,'合成已退役工作流'),systemPack({id:'synthetic-default-system'})])await hub.publishPack((await writePack(join(scratch.path,spec.id),spec)).dir);
  await hub.hub.registry.retire(hub.admin.principal,retiredFlow,'1.0.0','合成退役反例');
  const skillSpec:PackDescription={id:skill,version:'1.0.0',kind:'skill',title:'合成未安装技能',description:'合成技能不享管理员默认例外',files:{'SKILL.md':'# 合成技能\n仅用于验收。\n','skill.json':{schema:'skill@1',parsers:[]}}};
  await hub.publishPack((await writePack(join(scratch.path,skill),skillSpec)).dir);
  const personal=hub.hub.registry.personal;assert.ok(personal);
  const other=await personal.publish(privateOwner.principal,(await writePack(join(scratch.path,privateFlow),syntheticWorkflow(privateFlow,'合成他人未分享私有工作流'))).dir);assert.ok(other.ok);
  const own=await personal.publish(defaultAdmin.principal,(await writePack(join(scratch.path,ownPrivateFlow),syntheticWorkflow(ownPrivateFlow,'合成管理员本人私有工作流'))).dir);assert.ok(own.ok);
  await hub.assignPack(assigned.principal,effectFlow); // Positive annotation control only; never assign to the default administrator.
  resourceServer=createServer((_req,res)=>{businessReads++;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'synthetic-business-item',title:'合成业务原件'}));});
  await new Promise<void>(resolve=>resourceServer.listen(0,'127.0.0.1',resolve));
  resource=await hub.hub.connectors.admin.addResource(hub.admin.principal,{system_pack:'synthetic-default-system',name:'合成无分配业务资源',environment:'test',origins:{api:`http://127.0.0.1:${(resourceServer.address() as AddressInfo).port}`},allow_plaintext:[`http://127.0.0.1:${(resourceServer.address() as AddressInfo).port}`]});
  adminClient=await connect(hub,defaultAdmin.token);memberClient=await connect(hub,member.token);assignedClient=await connect(hub,assigned.token);clients.push(adminClient,memberClient,assignedClient);
});
after(async()=>{
  for(const client of clients)await client.close().catch(()=>{});
  await hub?.close();
  if(resourceServer)await new Promise<void>(resolve=>{resourceServer.closeAllConnections();resourceServer.close(()=>resolve());});
  await postgres?.stop();await scratch?.remove();
});

// Should exist: B04 R[2], R02 R[1], Boss16:18. Default use is a current enabled-account capability, not assignment.
test('enabled unassigned administrator can enumerate start and see the same public workflows in the actual console projection',async()=>{
  assert.deepEqual(await hub.records.authorizations.packsFor(defaultAdmin.user.id),[]);
  assert.equal(await hasWorkflow(adminClient,flow),true);assert.equal(await hasWorkflow(adminClient,effectFlow),true);
  const listed=await adminClient.call('list_task_packs',{});
  assert.equal(lineAfterTitle(listed,'合成管理员默认工作流'),defaultLabel);assert.equal(lineAfterTitle(listed,'合成外读与作业工作流'),defaultLabel);
  assert.notEqual(lineAfterTitle(listed,'合成管理员本人私有工作流'),defaultLabel);assert.notEqual(lineAfterTitle(listed,'合成管理员本人私有工作流'),'已分配');
  assert.equal((await hub.deps.memberCapabilities(defaultAdmin.principal)).unassigned_workflows_count,0);
  assert.equal(listed.text.split('\n')[0],packListHead((listed.out.index??listed.out.packs).length),'header does not count listed defaults as unassigned');
  const available=await hub.hub.workflows.summaries(defaultAdmin.principal,{includeAdminDefault:true});
  const assignedOnly=await hub.hub.workflows.summaries(defaultAdmin.principal,{includeAdminDefault:false});
  assert.ok(available.some(pack=>pack.id===flow));assert.ok(available.some(pack=>pack.id===effectFlow));
  assert.equal(assignedOnly.some(pack=>pack.id===flow||pack.id===effectFlow),false);
  const started=await begin(adminClient,flow);assert.equal(started.isError,false,started.text);assert.ok(started.out.run);
  const view=await hub.deps.memberCapabilities(defaultAdmin.principal);assert.ok(view.workflows.some(pack=>pack.ref===flow+'@1.0.0'));
  const consoleClient=await openConsole(hub,defaultAdmin.token),page=await consoleClient.get('/console/me');assert.equal(page.status,200);assert.ok(page.body.includes('合成管理员默认工作流'));
});

// Should exist: B04/R02 default is explicitly excluded from assignment records/projections; D06 annotations depend on assignments.
test('default use creates no assign decision and appears in neither user nor team assignment projections',async()=>{
  await adminClient.call('list_task_packs',{});await begin(adminClient,flow);await hub.deps.memberCapabilities(defaultAdmin.principal);
  assert.deepEqual(await hub.records.authorizations.packsFor(defaultAdmin.user.id),[]);
  assert.deepEqual(await hub.records.authorizations.usersOf(flow),[]);
  assert.deepEqual(await hub.hub.registry.packsFor(defaultAdmin.user.id),[]);
  assert.deepEqual(await hub.hub.registry.usersOf(flow),[]);
  assert.equal((await hub.records.authorizations.usersOf(effectFlow)).includes(defaultAdmin.user.id),false);
  assert.deepEqual(await hub.records.authorizations.teamsOf(hub.admin.principal,'pack',flow),{teams:[],all:false});
  const decisions=await hub.records.authorizations.history({permission:'assign',subject:defaultAdmin.user.id,limit:100});assert.equal(decisions.items.length,0);
});

// Should exist: D06 F[2]/R[4], Boss16:18. External/effect declarations must be real, with a positive assigned-user control.
test('default external and hub-template workflows do not widen administrator MCP annotations',async()=>{
  assert.equal(await hasWorkflow(adminClient,effectFlow),true,'the dangerous declaration is actually available by default');
  const actual=annotations(await adminWire.listTools());assert.deepEqual(actual,initialAnnotations);
  assert.deepEqual(annotations(await memberWire.listTools()),initialMemberAnnotations,'ordinary-user hints remain unchanged after publication/default availability');
  for(const who of [member,assigned])assert.deepEqual(await hub.hub.workflows.summaries(who.principal,{includeAdminDefault:true}),await hub.hub.workflows.summaries(who.principal,{includeAdminDefault:false}),'admin-default inclusion never changes an ordinary member summary');
  const control=await hub.client(assigned.token);clients.push(control);const tools=await control.listTools();
  const start=tools.tools.find(tool=>tool.name==='start_run')!,submit=tools.tools.find(tool=>tool.name==='submit_result')!;
  assert.equal(start.annotations?.openWorldHint,true);assert.equal(submit.annotations?.openWorldHint,true);assert.equal(submit.annotations?.destructiveHint,true);
  for(const [who,client] of [[member,memberClient],[assigned,assignedClient]] as const){const list=await client.call('list_task_packs',{});assert.equal(list.text,toolText('list_task_packs',list.out,{packList:{offset:0},caller:{role:'user',name:who.user.name}}),'ordinary member bytes retain the original rendering path');assert.equal(list.text.split('\n').includes(defaultLabel),false);assert.equal(list.text.split('\n').includes('已分配'),false);}
  await hub.assignPack(defaultAdmin.principal,flow);
  const classified=await adminClient.call('list_task_packs',{});assert.equal(lineAfterTitle(classified,'合成管理员默认工作流'),'已分配');assert.equal(lineAfterTitle(classified,'合成外读与作业工作流'),defaultLabel);
  assert.deepEqual(annotations(await adminWire.listTools()),initialAnnotations,'explicit local-only workflow assignment does not make default external/effect workflows count toward hints');
});

// Should exist: R02 R[0], Boss16:18 preserves ordinary member assignment rules.
test('ordinary unassigned users gain no public workflow and explicit assignment still works',async()=>{
  assert.equal(await hasWorkflow(memberClient,flow),false);assert.equal((await begin(memberClient,flow)).isError,true);
  assert.equal((await hub.deps.memberCapabilities(member.principal)).workflows.some(pack=>pack.ref===flow+'@1.0.0'),false);
  await hub.assignPack(member.principal,flow);assert.equal(await hasWorkflow(memberClient,flow),true);assert.equal((await begin(memberClient,flow)).isError,false);
});

// Should exist: R02 changes83/owner15:00 and Boss16:18 resource counterexample: default workflow use never grants resource reads.
test('an administrator without resource assignment cannot read business data while an explicitly assigned reader can',async()=>{
  assert.equal(await hub.records.authorizations.canUseResource(defaultAdmin.user.id,resource.id),false);
  const before=businessReads,denied=await hub.hub.connectors.reader.read('tracker:item:synthetic-business-item',{principal:defaultAdmin.principal,purpose:'synthetic admin resource negative'});
  assert.equal(denied.ok,false);assert.equal(businessReads,before,'denied admin read never reaches the synthetic business endpoint');
  const wire=await adminClient.call('resolve_reference',{reference:'tracker:item:synthetic-business-item'});assert.equal(wire.isError,true);assert.equal(businessReads,before);
  const team=await hub.records.teams.create(hub.admin.principal,'合成业务资源读取团队');await hub.records.teams.add(hub.admin.principal,team.id,member.user.id);
  await hub.records.authorizations.assignResource(hub.admin.principal,resource.id,team.id);
  const allowed=await hub.hub.connectors.reader.read('tracker:item:synthetic-business-item',{principal:member.principal,purpose:'synthetic explicitly assigned control'});assert.equal(allowed.ok,true);assert.ok(businessReads>before);
  assert.equal(await hub.records.authorizations.canUseResource(defaultAdmin.user.id,resource.id),false);
});

// Should exist: R01 active-account authority, Boss16:18 explicitly excludes disabled admins.
test('a disabled administrator cannot use default workflows through stale credentials or the capability projection',async()=>{
  await hub.records.principals.setDisabled(hub.admin.principal,disabled.user.id,true);
  assert.equal(await hub.records.principals.authenticate('Bearer '+disabled.token),null);
  await assert.rejects(()=>hub.client(disabled.token));
  await assert.rejects(()=>hub.deps.memberCapabilities(disabled.principal));
});

// Should exist: T02 R[4]/R[6] publication retirement and Boss16:18: an old version is not default-startable.
test('retired public workflow is absent from default list and capabilities and cannot start by its exact old version',async()=>{
  assert.equal(await hasWorkflow(adminClient,retiredFlow),false);
  assert.equal((await hub.deps.memberCapabilities(defaultAdmin.principal)).workflows.some(pack=>pack.ref===retiredFlow+'@1.0.0'),false);
  const answer=await begin(adminClient,retiredFlow+'@1.0.0');assert.equal(answer.isError,true);assert.equal(answer.out.run,undefined);
});

// Should exist: T01 R[5]/R02 R[6], Boss16:18. Other unshared private space stays private; own space keeps existing ownership use.
test('other owners unshared private workflow is not an admin default while the admin own private workflow still starts',async()=>{
  assert.equal(await hasWorkflow(adminClient,privateFlow),false);
  const denied=await begin(adminClient,privateFlow,privateOwner.user.id);assert.equal(denied.isError,true);assert.equal(denied.out.run,undefined);
  assert.equal((await hub.deps.memberCapabilities(defaultAdmin.principal)).workflows.some(pack=>pack.ref===privateFlow+'@1.0.0'),false);
  const own=await begin(adminClient,ownPrivateFlow,defaultAdmin.user.id);assert.equal(own.isError,false,own.text);assert.ok(own.out.run);
});

// Should exist: T01/R02 skill boundary plus Boss clarification: publication alone is not installation; installation benefits every enabled user.
test('uninstalled skill gets no admin exception and installing it preserves the ordinary all-enabled-user rule',async()=>{
  for(const who of [defaultAdmin,member]){assert.equal(await hub.hub.registry.canUse(who.user.id,skill),false);assert.equal((await hub.deps.memberCapabilities(who.principal)).skills.some(pack=>pack.ref===skill+'@1.0.0'),false);}
  const uninstalled=await adminClient.call('list_task_packs',{});assert.equal(uninstalled.out.packs.some(pack=>pack.id===skill),false);
  await hub.hub.registry.install(hub.admin.principal,skill+'@1.0.0');
  const skillList=await adminClient.call('list_task_packs',{});assert.notEqual(lineAfterTitle(skillList,'合成未安装技能'),defaultLabel);assert.notEqual(lineAfterTitle(skillList,'合成未安装技能'),'已分配');
  for(const [who,client] of [[defaultAdmin,adminClient],[member,memberClient]] as const){assert.equal(await hub.hub.registry.canUse(who.user.id,skill),true);const list=await client.call('list_task_packs',{});assert.equal(list.out.packs.some(pack=>pack.id===skill&&pack.kind==='skill'),true);assert.ok((await hub.deps.memberCapabilities(who.principal)).skills.some(pack=>pack.ref===skill+'@1.0.0'));}
});
