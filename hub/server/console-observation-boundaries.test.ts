import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createTestServer} from './testing.ts';
import {createTestHub} from './testing-real.ts';
import {openConsole} from '../../tests/acceptance/support/console.ts';
import {taskSteps,taskWaterfall} from './console/tasks.ts';
import {html} from './console/html.ts';
import type {PageContext} from './console/pages.ts';
import type {RunDetail} from '../ports.ts';
import type {CallLogLine} from '../records/api.ts';

const options={repositoryPacks:false,stubs:false,mindmapSkill:false,workbookSkill:false,xmlSkill:false,htmlSkill:false};

test('a client record shows registered credentials and observed use without implying a live connection',async t=>{
 const hub=await createTestHub(options);t.after(()=>hub.close());const owner=await hub.createUser('合成观测成员');
 const other=await hub.createUser('合成其他观测者');await hub.records.principals.issueToken(hub.admin.principal,other.user.id,'合成不可越权的其他编辑器');
 const unused=await hub.records.principals.issueToken(hub.admin.principal,owner.user.id,'合成尚未使用的编辑器');
 const active=await hub.client(owner.token);t.after(()=>active.close());
 const manager=await openConsole(hub,hub.admin.token),member=await openConsole(hub,owner.token),mark=await hub.records.store.watermark!();
 const page=await manager.get('/console/connections?tab=clients');assert.equal(page.status,200,page.body);
 for(const value of ['每行对应有效凭据','最近凭据使用不是在线状态','最近凭据使用','未记录不表示离线','hub-test-real','合成尚未使用的编辑器'])assert.ok(page.body.includes(value),value);
 assert.doesNotMatch(page.body,/已连接的客户端|最近连接/);
 const selected=await manager.get('/console/connections?circle='+unused.id);assert.equal(selected.status,200);assert.match(selected.body,/<dt>最近凭据使用<\/dt><dd>未记录<\/dd>/);assert.ok(selected.body.includes('不代表实时在线'));
 const mine=await member.get('/console/connections');assert.equal(mine.status,200);assert.ok(mine.body.includes('合成尚未使用的编辑器'));assert.ok(!mine.body.includes('合成不可越权的其他编辑器'));
 assert.equal(await hub.records.store.watermark!(),mark);
});

test('an inter-call gap retains the observed bounds and cannot be attributed to client processing or a location',async()=>{
 const server=await createTestServer();try{
 const detail={run:{run:'run_00000000000000000000000001',pack:'review@1.0.0',runner:server.admin.user.id,started_at:'2026-11-09T00:00:00.000Z',items:[],requirements:[]},latest:null,production:null,submissions:[],requests:[]} as unknown as RunDetail;
 const calls=[{at:'2026-11-09T00:00:01.000Z',tool:'start_run',duration_ms:100,call_result:'ok'},{at:'2026-11-09T00:01:01.000Z',tool:'submit_result',duration_ms:200,call_result:'ok',acceptance:'accepted'}] as CallLogLine[];
 const context={admin:false,principal:server.admin.principal,deps:server.deps,userName:async()=> '合成运行者'} as unknown as PageContext;
 const steps=await taskSteps(context,detail,calls,Date.parse('2026-11-09T00:02:00.000Z'));const gap=steps.find(step=>step.start===Date.parse(calls[0].at)&&step.end===Date.parse(calls[1].at)-200);assert.ok(gap);assert.equal(gap.name,'调用间未观测区间');assert.match(gap.sub,/不代表客户端计算耗时/);assert.equal(gap.end-gap.start,59800);
 const markup=html`${await taskWaterfall(context,detail,calls)}`.text;assert.match(markup,/调用间空档未由 Hub 观测/);assert.doesNotMatch(markup,/客户端本机处理|空档是客户端本机时间|执行位置：本机 Circle/);assert.ok(markup.includes('59800')||markup.includes('59,800'));
 }finally{await server.close();}
});
