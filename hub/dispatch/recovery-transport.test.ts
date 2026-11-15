import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {test} from 'node:test';
import {ExecutorDefinition} from './definition.ts';
import {RpcClient,IncompleteReplyError,InvocationDefinitionError,ResponseStorageError} from './transport.ts';
import {definition} from './testing/definition.ts';
import {startEndpoint} from './testing/server.ts';

const source='src:'+'a'.repeat(64);
const save=async()=>source;
function recoveryDefinition(endpoint:string) {
  return ExecutorDefinition.parse({...definition(endpoint),calls:{...definition(endpoint).calls,query:{tool:'query_blob',arguments:{request:{$value:'request_id'}}}},allowed_tools:[...definition(endpoint).allowed_tools,'query_blob']});
}
const reads=['query_blob','inspect_blob','read_blob'];

test('recovery needs only query/status/result and reports optional lease tools truthfully',async t=>{
  const endpoint=await startEndpoint(reads,()=>({ok:true}));t.after(()=>endpoint.close());
  const client=new RpcClient(recoveryDefinition(endpoint.endpoint),'synthetic-secret','synthetic-job',save,undefined,undefined,{recovery:true});
  await client.connect();
  for(const role of ['query','status','result'] as const) assert.equal(client.hasTool(role),true);
  assert.equal(client.hasTool('heartbeat'),false);assert.equal(client.hasTool('release'),false);
  await client.call('query',{request_id:'synthetic-request'});await client.call('status',{remote_id:'synthetic-remote'});await client.call('result',{remote_id:'synthetic-remote'});
  assert.deepEqual(endpoint.calls.filter(c=>c.method==='tools/call').map(c=>c.params.name),reads);
  const normal=new RpcClient(recoveryDefinition(endpoint.endpoint),'synthetic-secret','synthetic-job',save);
  await assert.rejects(normal.connect(),/缺少允许清单/);
});

test('recovery rejects every new-work entrypoint locally even when the tools are advertised',async t=>{
  const cfg=recoveryDefinition('http://127.0.0.1:1');
  const endpoint=await startEndpoint([...cfg.allowed_tools],()=>({ok:true}));t.after(()=>endpoint.close());
  const client=new RpcClient(recoveryDefinition(endpoint.endpoint),'synthetic-secret','synthetic-job',save,undefined,undefined,{recovery:true});await client.connect();
  assert.throws(()=>client.prepareSubmit({}),/恢复连接/);
  for(const role of ['submit','acquire','precheck'] as const) await assert.rejects(client.call(role,{}),/恢复连接/);
  await assert.rejects(client.precheckRead(0,{}),/恢复连接/);
  await assert.rejects(client.declaredRead(cfg.calls.precheck,{},'synthetic-read'),/恢复连接/);
  assert.equal(endpoint.calls.filter(c=>c.method==='tools/call').length,0);
  assert.equal(client.hasTool('heartbeat'),true);
  await client.call('heartbeat',{lease_id:'synthetic-lease',lease_token:'synthetic-token'});
  await client.call('release',{lease_id:'synthetic-lease',lease_token:'synthetic-token'});
  assert.deepEqual(endpoint.calls.filter(c=>c.method==='tools/call').map(c=>c.params.name),['touch_slot','close_slot']);
});

test('each recovery read tool remains required and refused tools still prevent connection',async t=>{
  for(const missing of reads){const endpoint=await startEndpoint(reads.filter(x=>x!==missing),()=>({}));t.after(()=>endpoint.close());const client=new RpcClient(recoveryDefinition(endpoint.endpoint),'synthetic-secret','synthetic-job',save,undefined,undefined,{recovery:true});await assert.rejects(client.connect(),/缺少允许清单/);}
  const endpoint=await startEndpoint([...reads,'synthetic_forbidden'],()=>({}));t.after(()=>endpoint.close());
  const cfg=ExecutorDefinition.parse({...recoveryDefinition(endpoint.endpoint),refused_tools:['synthetic_forbidden']});
  await assert.rejects(new RpcClient(cfg,'synthetic-secret','synthetic-job',save,undefined,undefined,{recovery:true}).connect(),/密钥权限超出/);
  assert.equal(endpoint.calls.filter(c=>c.method==='tools/call').length,0);
});

test('recovery retains validation of the tool parameter declaration actually used',async t=>{
  const endpoint=await startEndpoint(reads,()=>({}),undefined,{query_blob:{type:'object',properties:{expected:{}},required:['expected'],additionalProperties:false}});t.after(()=>endpoint.close());
  const client=new RpcClient(recoveryDefinition(endpoint.endpoint),'synthetic-secret','synthetic-job',save,undefined,undefined,{recovery:true});await client.connect();
  await assert.rejects(client.call('query',{request_id:'synthetic-request'}),InvocationDefinitionError);
  assert.equal(endpoint.calls.filter(c=>c.method==='tools/call').length,0);
});

test('aborting a read saves received bytes and waits for committed storage before reporting incomplete',{timeout:10000},async t=>{
  const controller=new AbortController(),stored=Promise.withResolvers<void>(),commit=Promise.withResolvers<void>();
  const endpoint=await startEndpoint(reads,(_name,_args,res)=>{res.writeHead(200,{'content-type':'application/json'});res.write('synthetic partial answer');setTimeout(()=>controller.abort(),20);});t.after(()=>endpoint.close());
  let bytes='',complete: boolean|undefined,settled=false;
  const client=new RpcClient(recoveryDefinition(endpoint.endpoint),'synthetic-secret','synthetic-job',async(value,_status,op,whole)=>{if(op==='query'){bytes=Buffer.from(value).toString();complete=whole;stored.resolve();await commit.promise;}return source;},undefined,undefined,{recovery:true,signal:controller.signal});
  await client.connect();
  const result=client.call('query',{request_id:'synthetic-request'}).then(value=>{settled=true;return value;},error=>{settled=true;return error;});
  await stored.promise;assert.equal(settled,false);assert.equal(bytes,'synthetic partial answer');assert.equal(complete,false);
  let drained=false;const draining=client.drainReads().then(()=>{drained=true;});
  await Promise.resolve();assert.equal(drained,false);
  commit.resolve();assert.ok(await result instanceof IncompleteReplyError);await draining;assert.equal(drained,true);
});

test('an already aborted initialization performs no network call and stores the empty incomplete observation',async t=>{
  const controller=new AbortController();controller.abort();
  const endpoint=await startEndpoint(reads,()=>({}));t.after(()=>endpoint.close());let stored=false;
  const client=new RpcClient(recoveryDefinition(endpoint.endpoint),'synthetic-secret','synthetic-job',async(bytes,_status,op,complete)=>{assert.equal(op,'initialize');assert.equal(bytes.length,0);assert.equal(complete,false);stored=true;return source;},undefined,undefined,{recovery:true,signal:controller.signal});
  await assert.rejects(client.connect(),IncompleteReplyError);assert.equal(stored,true);assert.equal(endpoint.calls.length,0);
});

test('the signal can interrupt initialization already receiving a partial response',{timeout:10000},async t=>{
  const controller=new AbortController();let stored='';
  const server=createServer(async(req,res)=>{for await(const _chunk of req){}res.writeHead(200,{'content-type':'application/json'});res.write('partial initialization');setTimeout(()=>controller.abort(),20);});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
  const endpoint=`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const client=new RpcClient(recoveryDefinition(endpoint),'synthetic-secret','synthetic-job',async(bytes)=>{stored=Buffer.from(bytes).toString();return source;},undefined,undefined,{recovery:true,signal:controller.signal});
  await assert.rejects(client.connect(),IncompleteReplyError);assert.equal(stored,'partial initialization');
});

test('an aborted read signal never cancels a normal submit',async t=>{
  const controller=new AbortController();const endpoint=await startEndpoint(definition('x').allowed_tools,()=>({ok:true}));t.after(()=>endpoint.close());
  const client=new RpcClient(ExecutorDefinition.parse(definition(endpoint.endpoint)),'synthetic-secret','synthetic-job',save,undefined,undefined,{signal:controller.signal});await client.connect();controller.abort();
  const answer=await client.call('submit',{request_id:'synthetic-request',dispatch_sequence:1,sequence_scope:'synthetic-scope',payload_base64:'eA==',sha256:'a'.repeat(64),items:[],lease_id:'synthetic-lease'});
  assert.equal((answer.value as {ok:boolean}).ok,true);assert.equal(endpoint.calls.filter(c=>c.method==='tools/call').length,1);
});


test('drain waits for every concurrent non-submit call storage commit, not merely aborted IO',{timeout:10000},async t=>{
  const controller=new AbortController(),querySaved=Promise.withResolvers<void>(),statusSaved=Promise.withResolvers<void>(),queryCommit=Promise.withResolvers<void>(),statusCommit=Promise.withResolvers<void>();
  const endpoint=await startEndpoint(reads,()=>({ok:true}));t.after(()=>endpoint.close());
  const client=new RpcClient(recoveryDefinition(endpoint.endpoint),'synthetic-secret','synthetic-job',async(_bytes,_status,op)=>{if(op==='query'){querySaved.resolve();await queryCommit.promise;}if(op==='status'){statusSaved.resolve();await statusCommit.promise;}return source;},undefined,undefined,{recovery:true,signal:controller.signal});
  await client.connect();
  const query=client.call('query',{request_id:'synthetic-request'}),status=client.call('status',{remote_id:'synthetic-remote'});
  await Promise.all([querySaved.promise,statusSaved.promise]);controller.abort();
  let drained=false;const draining=client.drainReads().then(()=>{drained=true;});await Promise.resolve();assert.equal(drained,false);
  queryCommit.resolve();await query;assert.equal(drained,false,'the second save commit is still pending');
  statusCommit.resolve();await status;await draining;assert.equal(drained,true);
});

test('drain covers the whole connection sequence after abort during initialization storage',{timeout:10000},async t=>{
  const controller=new AbortController(),saved=Promise.withResolvers<void>(),commit=Promise.withResolvers<void>();
  const endpoint=await startEndpoint(reads,()=>({ok:true}));t.after(()=>endpoint.close());
  const client=new RpcClient(recoveryDefinition(endpoint.endpoint),'synthetic-secret','synthetic-job',async(_bytes,_status,op)=>{if(op==='initialize'){saved.resolve();await commit.promise;}return source;},undefined,undefined,{recovery:true,signal:controller.signal});
  const connection=client.connect().then(()=>null,error=>error);await saved.promise;controller.abort();
  let drained=false;const draining=client.drainReads().then(()=>{drained=true;});await Promise.resolve();assert.equal(drained,false);
  commit.resolve();assert.ok(await connection instanceof IncompleteReplyError);await draining;assert.equal(drained,true);
  assert.deepEqual(endpoint.calls.map(call=>call.method),['initialize']);
});

test('drain includes declaredRead save failures and excludes a normal submit still awaiting its commit',{timeout:10000},async t=>{
  const readSaved=Promise.withResolvers<void>(),readCommit=Promise.withResolvers<void>(),submitSaved=Promise.withResolvers<void>(),submitCommit=Promise.withResolvers<void>();
  const endpoint=await startEndpoint(definition('x').allowed_tools,()=>({ok:true}));t.after(()=>endpoint.close());
  const cfg=ExecutorDefinition.parse(definition(endpoint.endpoint));
  const client=new RpcClient(cfg,'synthetic-secret','synthetic-job',async(_bytes,_status,op)=>{if(op==='synthetic-read'){readSaved.resolve();await readCommit.promise;throw new Error('synthetic commit refusal');}if(op==='submit'){submitSaved.resolve();await submitCommit.promise;}return source;});await client.connect();
  const read=client.declaredRead(cfg.calls.precheck,{},'synthetic-read').then(()=>null,error=>error);await readSaved.promise;
  let drained=false;const draining=client.drainReads().then(()=>{drained=true;});await Promise.resolve();assert.equal(drained,false);
  readCommit.resolve();assert.ok(await read instanceof ResponseStorageError);await draining;assert.equal(drained,true);
  const submit=client.call('submit',{request_id:'synthetic-request',dispatch_sequence:1,sequence_scope:'synthetic-scope',payload_base64:'eA==',sha256:'a'.repeat(64),items:[],lease_id:'synthetic-lease'});await submitSaved.promise;
  await client.drainReads();submitCommit.resolve();await submit;
});
