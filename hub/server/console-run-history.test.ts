// The task page asks for a window of the newest submissions and says so (issue 200). Scripted fake runs service, synthetic only.
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {after,before,test} from 'node:test';
import {wordingProblems} from './console/testing-wording.ts';
import {RUN_HISTORY_LIMIT} from './console/pages.ts';
import {testConsoleCredentials,createTestServer,type TestServer,type TestUser} from './testing.ts';
import {defaultPacks,fakeWorkflowPack} from './fakes.ts';

let server:TestServer;
before(async()=>{server=await createTestServer({packs:[...defaultPacks(),fakeWorkflowPack('facts','合成事实',['text/plain'],{factsOnly:true})]});});
after(async()=>{await server?.close();});
const send=(path:string,cookie='',method='GET',body='')=>new Promise<{status:number;body:string;headers:import('node:http').IncomingHttpHeaders}>((resolve,reject)=>{
 const req=request(`${server.url}${path}`,{method,headers:{cookie,origin:server.url,'content-type':'application/x-www-form-urlencoded'}},res=>{const chunks:Buffer[]=[];res.on('data',(b:Buffer)=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode!,body:Buffer.concat(chunks).toString(),headers:res.headers}));});req.on('error',reject);req.end(body);
});
const csrf=(body:string)=>/name="csrf" value="([^"]+)"/.exec(body)![1];
async function login(user:TestUser){
 const form=await send('/console/login');
 const logged=await send('/console/login',form.headers['set-cookie']![0].split(';')[0],'POST',new URLSearchParams({...testConsoleCredentials(user.token),csrf:csrf(form.body)}).toString());
 assert.equal(logged.status,303);return logged.headers['set-cookie']![0].split(';')[0];
}
async function start(user:TestUser){
 await server.assign(user.principal,'facts');
 server.fakes.runs.items=subject=>[{id:'entry-0',label:'合成条目',summary:'合成摘要',fields:{},location:subject}];
 const out=await server.fakes.runs.startRun(user.principal,{pack:'facts',inputs:{subject:{external:'tracker:document:synthetic'}}},{traceId:'1'.repeat(32),sessionId:null});
 assert.equal(out.call_result,'ok');return out.run!.run;
}

test('the task page asks for the newest window, says how many submissions it lists, and links to older ones and back',async()=>{
 const user=await server.createUser('合成详情读者');const id=await start(user);const cookie=await login(user);
 server.fakes.runs.runOptions.length=0;
 // The submissions are in the 过程 tab of the task page (decision 151); its paging links stay in that tab.
 const plain=await send(`/console/runs/${id}?tab=process`,cookie);assert.equal(plain.status,200);
 assert.deepEqual(server.fakes.runs.runOptions.at(-1),{history:{limit:RUN_HISTORY_LIMIT,before:null}},'the page reads a window, never the whole history');
 assert.equal(RUN_HISTORY_LIMIT,10,'a row reads a whole result: ten at a time');
 // Every other tab shows the current and the production result only, and asks for a window of one submission.
 for(const tab of ['','?tab=items','?tab=requests','?tab=sources','?tab=record','?view=record']){
  server.fakes.runs.runOptions.length=0;assert.equal((await send(`/console/runs/${id}${tab}`,cookie)).status,200,tab);
  assert.deepEqual(server.fakes.runs.runOptions.at(-1),{history:{limit:1,before:null},requests:'waiting'},tab+': a tab that lists no settled request asks for the waiting ones (issue 200)');
 }
 server.fakes.runs.runOptions.length=0;assert.equal((await send(`/console/runs/${id}?older=synthetic-older-cursor`,cookie)).status,200);
 assert.deepEqual(server.fakes.runs.runOptions.at(-1),{history:{limit:1,before:null},requests:'waiting'},'a cursor of the 过程 tab moves no other tab');
 assert.doesNotMatch(plain.body,/查看更早的提交|回到最近的提交/,'no paging note while the fake answers without a window');
 // A windowed answer: older submissions remain, and the first row is the one behind the current result.
 const detail=(await server.fakes.runs.getRun(user.principal,id))!;
 server.fakes.runs.script.answerNext('getRun',{...detail,history:{limit:RUN_HISTORY_LIMIT,next:'synthetic-older-cursor',pinned:detail.submissions[0]?.record??'x'.repeat(64)}});
 const windowed=await send(`/console/runs/${id}?tab=process`,cookie);assert.equal(windowed.status,200);
 assert.match(windowed.body,/本页列出 \d+ 次提交，每页最多 10 次，较早的在上；第一行是当前结果对应的提交；撤回提示按本页列出的结果、当前结果和生产结果判断。/);
 assert.ok(windowed.body.includes(`href="/console/runs/${id}?tab=process&amp;older=synthetic-older-cursor"`),'the link to older submissions carries the cursor');
 assert.doesNotMatch(windowed.body,/回到最近的提交/,'the newest window has no way back');
 assert.deepEqual(wordingProblems(windowed.body),[]);
 // An older page: the cursor reaches the service, and the way back is offered.
 server.fakes.runs.runOptions.length=0;
 server.fakes.runs.script.answerNext('getRun',{...detail,history:{limit:RUN_HISTORY_LIMIT,next:null}});
 const older=await send(`/console/runs/${id}?tab=process&older=synthetic-older-cursor`,cookie);assert.equal(older.status,200);
 assert.deepEqual(server.fakes.runs.runOptions.at(-1),{history:{limit:RUN_HISTORY_LIMIT,before:'synthetic-older-cursor'}});
 assert.match(older.body,new RegExp(`href="/console/runs/${id}\\?tab=process">回到最近的提交`));assert.doesNotMatch(older.body,/查看更早的提交/,'the oldest window has no older link');
 // A cursor longer than any the store hands out is not passed on.
 server.fakes.runs.runOptions.length=0;
 const hostile=await send(`/console/runs/${id}?tab=process&older=${'x'.repeat(600)}`,cookie);assert.equal(hostile.status,200);
 assert.deepEqual(server.fakes.runs.runOptions.at(-1),{history:{limit:RUN_HISTORY_LIMIT,before:null}});
});
