import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startPostgres } from '../testing/postgres.ts';
import { createTestServer } from './testing.ts';
import { ROOT_1 } from './fakes.ts';

test('a disconnected start remains queryable and its completed run can be recovered without another start',async t=>{
  const postgres=await startPostgres();t.after(()=>postgres.stop());const hub=await createTestServer({postgres});t.after(()=>hub.close());
  const alice=await hub.createUser('synthetic-alice'),bob=await hub.createUser('synthetic-bob');await hub.assign(alice.principal,'review');
  const client=await hub.client(alice.token,{sessionId:'synthetic-session'});t.after(()=>client.close());
  const other=await hub.client(bob.token,{sessionId:'synthetic-other'});t.after(()=>other.close());
  const upload=await client.call('upload_file',{file_path:Buffer.from('synthetic source').toString('base64'),media_type:'text/plain'});
  const args={pack:'review',client_key:'synthetic-key',inputs:{subject:{reference:upload.structuredContent.reference}}};
  let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});t.after(()=>release());
  const detail=hub.deps.runsDetail!,original=detail.startRunDetailed.bind(detail);let starts=0;
  detail.startRunDetailed=async(...input)=>{starts++;enter();await gate;return original(...input);};
  const abort=new AbortController();
  const disconnected=fetch(hub.mcpUrl,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:`Bearer ${alice.token}`,'circle-session-id':'synthetic-session'},body:JSON.stringify({jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'start_run',arguments:args}}),signal:abort.signal});
  await entered;
  const status=await client.call('get_nodes',{call_query:{start_run:args}});
  assert.equal(status.isError,false);const active=status.structuredContent.call_status as {active_total:number;completed:unknown[];missing?:string;next_action:string};
  assert.equal(active.active_total,1);assert.equal(active.completed.length,0);assert.match(active.missing!,/完成结果/);assert.match(active.next_action,/不重复/);
  const trace=((status.structuredContent.call_status as {active:{trace:string}[]}).active)[0].trace;
  const hidden=await other.call('get_nodes',{call_query:{start_run:args}});const otherStatus=hidden.structuredContent.call_status as {active_total:number;completed:unknown[]};
  assert.equal(otherStatus.active_total,0);assert.equal(otherStatus.completed.length,0);
  abort.abort();await assert.rejects(disconnected);release();
  let recovered:any;
  for(let i=0;i<120;i++){
    recovered=(await client.call('get_nodes',{call_query:{start_run:args,trace}})).structuredContent.call_status;
    if(recovered.active_total===0&&recovered.completed.length>0)break;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.equal(starts,1,'status queries never reissue the original start');
  assert.equal(recovered.active_total,0);assert.equal(recovered.completed.length,1);assert.equal(recovered.completed[0].call_result,'ok');
  assert.equal(recovered.missing,undefined);
  assert.ok(recovered.completed[0].run_record?.startsWith('rec:'));
  const record=await client.call('get_nodes',{reference:recovered.completed[0].run_record});
  assert.equal(record.isError,false,JSON.stringify(record.structuredContent));
  assert.ok(String((record.structuredContent.content as {text?:string}).text).includes(recovered.completed[0].run));
});

test('two identical reads are tracked separately and a finished read does not invent its lost body',async t=>{
  const postgres=await startPostgres();t.after(()=>postgres.stop());const hub=await createTestServer({postgres});t.after(()=>hub.close());
  const client=await hub.client(hub.admin.token,{sessionId:'synthetic-session'});t.after(()=>client.close());
  const knowledge=hub.deps.knowledge,original=knowledge.getNodes.bind(knowledge);
  const mixedArgs=await client.call('get_nodes',{root:ROOT_1,call_query:{get_nodes:{root:ROOT_1}}});assert.equal(mixedArgs.isError,true);
  assert.equal((mixedArgs.structuredContent.errors as {path?:string}[])[0]?.path,'/root');
  const unusual=JSON.parse(`{"root":"${ROOT_1}","__proto__":{"synthetic":true}}`);
  const invalid=await client.call('get_nodes',unusual);assert.equal(invalid.isError,true);
  const recoveredInvalid=await client.call('get_nodes',{call_query:{get_nodes:unusual,trace:invalid.structuredContent.trace}});
  assert.equal((recoveredInvalid.structuredContent.call_status as {completed:unknown[]}).completed.length,1,'the original arguments, including __proto__, identify their own call');
  let count=0,ready!:()=>void;const entered=new Promise<void>(resolve=>{ready=resolve;});
  let firstRelease!:()=>void,secondRelease!:()=>void;
  const gates=[new Promise<void>(resolve=>{firstRelease=resolve;}),new Promise<void>(resolve=>{secondRelease=resolve;})];
  t.after(()=>{firstRelease();secondRelease();});
  knowledge.getNodes=async(...input)=>{const index=count++;if(count===2)ready();await gates[index];return original(...input);};
  const args={root:ROOT_1,paths:['/'],depth:0};
  const first=client.call('get_nodes',args),second=client.call('get_nodes',args);await entered;
  const both=(await client.call('get_nodes',{call_query:{get_nodes:args}})).structuredContent.call_status as any;
  assert.equal(both.active_total,2);assert.equal(new Set(both.active.map((row:any)=>row.trace)).size,2);assert.equal(both.completed.length,0);
  firstRelease();assert.equal((await Promise.race([first,second])).isError,false);
  const mixed=(await client.call('get_nodes',{call_query:{get_nodes:args}})).structuredContent.call_status as any;
  assert.equal(mixed.active_total,1);assert.equal(mixed.completed.length,1);assert.match(mixed.missing,/完成结果/);
  secondRelease();assert.ok((await Promise.all([first,second])).every(answer=>!answer.isError));
  const done=(await client.call('get_nodes',{call_query:{get_nodes:args}})).structuredContent.call_status as any;
  assert.equal(done.active_total,0);assert.equal(done.completed.length,2);assert.match(done.missing,/原回答正文未存档/);assert.match(done.next_action,/当前权限重读/);
});
