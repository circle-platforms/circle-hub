import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createTestServer} from './testing.ts';
import {StartRunOutput} from '../../contracts/src/tools.ts';
import {openConsole} from '../../tests/acceptance/support/console.ts';

test('overview shows its figures, then the tasks that need attention beside their statistics, without folded sections or a duplicate inspector',async t=>{
 const hub=await createTestServer();t.after(()=>hub.close());await hub.assign(hub.admin.principal,'review');const client=await hub.client(hub.admin.token);t.after(()=>client.close());const uploaded=await client.call('upload_file',{file_path:Buffer.from('合成任务').toString('base64')});const ids:string[]=[];
 for(let n=0;n<10;n++){const answer=await client.call('start_run',{pack:'review',inputs:{subject:{reference:uploaded.structuredContent!.reference}}});const result=StartRunOutput.parse(answer.structuredContent);assert.ok(result.run);ids.push(result.run.run);}
 const latest=ids.at(-1)!;const run=await hub.deps.runs.getRun(hub.admin.principal,latest);assert.ok(run);await client.call('submit_result',{run:latest,model:'synthetic-model',items:run.run.items.map(item=>({item:item.id,handling:'handled',slots:{findings:[{text:'合成已交付发现'}]}}))});
 const getRun=hub.deps.runs.getRun.bind(hub.deps.runs);hub.deps.runs.getRun=async(by,id)=>id===ids[8]?null:getRun(by,id);
 const console=await openConsole(hub,hub.admin.token),response=await console.get('/console/overview');assert.equal(response.status,200,response.body);const body=response.body;
 // Decision 151: four figures, then the attention list (the main column) with the statistics in the column beside it.
 assert.ok(body.includes('data-overview-tasks'));assert.ok(body.indexOf('id="live-overview-kpis"')<body.indexOf('data-overview-tasks'));assert.ok(body.indexOf('data-overview-tasks')<body.indexOf('data-overview-side'));assert.doesNotMatch(body,/<aside class="ch-inspector"/);
 assert.equal((body.slice(body.indexOf('data-overview-kpis'),body.indexOf('data-overview-tasks')).match(/class="ch-card ch-tile"/g)??[]).length,4);
 assert.match(body,/<a class="ch-tile-link" href="\/console\/runs" aria-label="查看任务列表"><\/a>/,'the task figure leads to the task list');
 const list=body.slice(body.indexOf('data-overview-tasks'),body.indexOf('data-overview-side'));assert.equal((list.match(/class="ch-row"/g)??[]).length,8);assert.ok(!list.includes('/console/runs/'+latest));for(const id of ids.slice(1,9))assert.ok(list.includes('/console/runs/'+id),id);assert.match(list,/结果暂不可用/);assert.match(list,/查看全部任务/);assert.match(list,/最多 8 个/);
 assert.match(list,/<h2 class="ch-card-title">[\s\S]*?需要处理/);
 // No folded sections, nothing that is only planned, and no chart of the period's call spans.
 assert.doesNotMatch(body,/ch-overview-details|统计与趋势|系统与知识概况|规划中的功能|多终端协同|消息通知|定时任务与机器人|期间任务/);
 const side=body.slice(body.indexOf('data-overview-side'));
 for(const phrase of ['检查项结果','每日任务数量','按结果以表格查看','业务系统读取','Hub 状态','未启用 HTTPS'])assert.ok(side.includes(phrase),phrase);
 assert.ok(body.includes('截至'));
});

test('a new team sees the empty task next step first while genuine zeros and unknown denominators remain distinct',async t=>{
 const hub=await createTestServer();t.after(()=>hub.close());const console=await openConsole(hub,hub.admin.token),response=await console.get('/console/overview');assert.equal(response.status,200);assert.match(response.body,/所选时段没有任务/);const tasks=response.body.slice(response.body.indexOf('data-overview-tasks'),response.body.indexOf('data-overview-side'));assert.match(tasks,/所选时段没有任务[\s\S]*查看工作流/);assert.doesNotMatch(tasks,/查看全部任务/);assert.match(response.body,/已有结果的 0 个任务中 0 个/);assert.ok(response.body.includes('—'));assert.doesNotMatch(response.body,/<aside class="ch-inspector"/);
});
