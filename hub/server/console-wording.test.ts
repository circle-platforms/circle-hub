// Whole rendered pages, not a static-copy registry. Every service and file is synthetic and loopback-only.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {wordingProblems} from './console/testing-wording.ts';
import {html} from './console/html.ts';
import {identityPage,confirmPage,endedPage} from './console/authorize.ts';
import type {AuthorizationRequest} from './oauth.ts';
import {evidence} from './console/presentation.ts';
import {createTestHub} from './testing-real.ts';
import {createTestServer} from './testing.ts';
import {openConsole} from '../../tests/acceptance/support/console.ts';
import {writePack} from '../runs/packs/testing/builder.ts';

test('the rendered wording guard rejects old UI copy and missing spaces while retaining original evidence verbatim',()=>{
 assert.ok(wordingProblems('<p>未核验 · 近30天 · Circle正在执行</p>').length>=2);
 assert.ok(wordingProblems('<button title="等待你处理">分享</button>').length);
 assert.deepEqual(wordingProblems('<p>待验证 · 近 30 天 · Cursor 正在执行</p>'),[]);
 const original='原文未核验Circle42目录历史依据';const rendered=html`<p>原文：${evidence(original)}</p>`;assert.ok(rendered.text.includes(original));assert.deepEqual(wordingProblems(rendered.text),[]);
});

test('the wording guard rejects Circle as the generic client name but keeps names a client reported',()=>{
 for(const markup of ['<p>已连接的 Circle</p>','<h1>允许 Circle 连接 Hub</h1>','<button>签发 Circle 访问令牌…</button>','<a title="在管理员的 Circle 中执行">查看命令…</a>','<td>Circle</td>'])assert.ok(wordingProblems(markup).some(problem=>problem.includes('Circle as the client name')),markup);
 for(const markup of ['<p>已连接的客户端</p>','<p>circle-hub 控制台</p>','<td><span data-evidence>Circle 3.9</span></td>','<pre>Circle</pre>','<code>Circle</code>'])assert.deepEqual(wordingProblems(markup),[],markup);
});

test('connection confirmation keeps original client and account names separate from static UI wording',()=>{
 const original='原文未核验Circle42授权',request:AuthorizationRequest={id:'synthetic-request',client:{id:'synthetic-client',name:original},redirectUri:'https://192.0.2.1/callback',redirectSent:true,device:null,state:null,challenge:'s'.repeat(43),peer:'127.0.0.1',resource:'http://192.0.2.1/mcp',issuer:'http://192.0.2.1',secure:false,created:0,csrf:'synthetic-csrf',browser:'synthetic-browser',invitation:null,failures:0,ended:null,decision:null};
 for(const markup of [identityPage(request,null),confirmPage(request,{id:'synthetic-account',name:original,role:'成员'},'session','synthetic-csrf',null),endedPage({...request,ended:'approved'})]){assert.ok(markup.text.includes(original));assert.deepEqual(wordingProblems(markup.text),[]);}
});

test('synthetic signed-in, anonymous, knowledge, memory, workflow, management and error pages use the design wording',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'circle-hub-wording-'));let real:Awaited<ReturnType<typeof createTestHub>>|undefined,fake:Awaited<ReturnType<typeof createTestServer>>|undefined;
 try{
  real=await createTestHub({repositoryPacks:false,stubs:false,mindmapSkill:false,workbookSkill:false,xmlSkill:false,htmlSkill:false});
  const owner=await real.createUser('合成文案作者'),reader=await real.createUser('合成文案读者'),client=await openConsole(real,owner.token),admin=await openConsole(real,real.admin.token);
  const original='原文未核验Circle42目录历史依据',spaces=real.hub.knowledge.spaces!;
  const source=await real.records.artifacts.ingest({bytes:Buffer.from(original),name:'合成原始材料.txt',mediaType:'text/plain',origin:{read:{object:'synthetic:document:wording'}},author:{user:null},provenanceType:'observed',visibility:{readers:[owner.user.id],admins:true,packs:[],shareable:false}});
  const saved=await spaces.write(owner.principal,{path:'/方法/认证',kind:'observation',statement:'合成认证观察',grounds:[{reference:'src:'+source.body.sha256,quotation:original}]});
  await spaces.write(owner.principal,{path:'/方法/认证',kind:'pitfall',statement:'合成待验证笔记'});
  const memory=await real.hub.knowledge.memory!.write(owner.principal,{title:'合成会话偏好',path:'/偏好',markdown:original,expected_version:null,client_key:'wording-memory'});
  const spec={id:'synthetic-wording-skill',version:'1.0.0',kind:'skill' as const,title:'合成通用做法',description:'合成步骤',files:{'SKILL.md':'# 合成做法\n检查合成输入。','skill.json':{schema:'skill@1',parsers:[]}}};const pack=await writePack(join(directory,'pack'),spec);assert.ok((await real.hub.registry.personal!.publish(owner.principal,pack.dir)).ok);
  await spaces.grant(owner.principal,{path:'/方法',audience:'member',member:reader.user.id});
  const folder='/console/knowledge/space?'+new URLSearchParams({space:owner.user.id,path:'/方法/认证',scope:'personal'}),entry=folder+'&entry='+saved.entry,workflow='/console/packs/'+spec.id+'?space='+owner.user.id;
  const cases=['/console/knowledge','/console/knowledge?scope=personal','/console/knowledge?scope=shared','/console/knowledge?scope=team',folder,entry,entry+'&edit=1',entry+'&share=1',folder+'&directory=1',folder+'#grant-knowledge','/console/knowledge/submissions','/console/knowledge/source?sha256='+source.body.sha256,'/console/knowledge?view=memory&scope=personal','/console/knowledge?view=memory&scope=personal&edit=1','/console/knowledge?view=memory&scope=personal&document='+memory.document,'/console/knowledge?view=memory&scope=personal&document='+memory.document+'&share=1','/console/packs?scope=personal',workflow,workflow+'#grant-pack','/console/packs/-/publish','/console/search?q='+encodeURIComponent('合成')];
  const failures:string[]=[];
  for(const path of cases){const answer=await client.get(path);assert.equal(answer.status,200,path);for(const error of wordingProblems(answer.body))failures.push(path+' '+error);}
  for(const path of ['/console/team/'+owner.user.id,'/console/operations/member','/console/operations/system','/console/operations/pack','/console/operations/knowledge','/console/settings']){const answer=await admin.get(path);assert.equal(answer.status,200,path);for(const error of wordingProblems(answer.body))failures.push(path+' '+error);}
  const bad=await client.post('/console/knowledge/do/quota',{csrf:/name="csrf" value="([^"]+)"/.exec((await client.get(folder)).body)![1],space:owner.user.id,bytes:'-1'});assert.equal(bad.status,404);for(const error of wordingProblems(bad.body))failures.push('forbidden quota '+error);
  const badRange=await admin.get('/console/records?from=bad-time');assert.equal(badRange.status,400);for(const error of wordingProblems(badRange.body))failures.push('bad range '+error);
  assert.ok((await client.get(entry)).body.includes(original),'quotes are not reformatted to pass the UI check');
  fake=await createTestServer();const member=await fake.createUser('合成任务读者');await fake.assign(member.principal,'review');const mcp=await fake.client(member.token),uploaded=await mcp.call('upload_file',{file_path:Buffer.from('合成文案任务').toString('base64')}),started=await mcp.call('start_run',{pack:'review',inputs:{subject:{reference:String(uploaded.structuredContent.reference)}}});const startedRun=started.structuredContent.run as {run:string;items:{id:string}[]};await mcp.call('submit_result',{run:startedRun.run,model:'scripted-model@test',items:[{item:startedRun.items[0].id,handling:'handled',slots:{findings:[{text:'合成文案检查'}]}},{item:startedRun.items[1].id,handling:'handled',slots:{unknown:true}}]});await mcp.close();const run=startedRun.run,operator=await openConsole(fake,fake.admin.token),user=await openConsole(fake,member.token);
  for(const path of ['/console/overview','/console/runs','/console/runs/'+run,'/console/runs/'+run+'?view=record','/console/results','/console/records','/console/team','/console/team/'+member.user.id,'/console/team?circle='+(await fake.records.principals.tokens(member.user.id))[0].id,'/console/connections','/console/settings','/console/packs','/console/packs/review','/console/search','/console/login','/console/password','/console/absent']){const answer=await operator.get(path);assert.ok([200,404].includes(answer.status),path);for(const error of wordingProblems(answer.body))failures.push(path+' '+error);}
  for(const path of ['/console/knowledge','/console/overview','/console/team','/console/settings']){const answer=await user.get(path);for(const error of wordingProblems(answer.body))failures.push('member '+path+' '+error);}
  assert.deepEqual(failures,[],failures.join('\n'));
 }finally{await fake?.close();await real?.close();await rm(directory,{recursive:true,force:true});}
});
