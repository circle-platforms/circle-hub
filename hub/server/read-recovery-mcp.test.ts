import assert from 'node:assert/strict';
import { test } from 'node:test';
import { artifactShareKey } from '../records/api.ts';
import { startPostgres } from '../testing/postgres.ts';
import { createTestServer } from './testing.ts';

test('a disconnected source read can recover its exact reply only while current access remains',async t=>{
  const pg=await startPostgres();t.after(()=>pg.stop());const hub=await createTestServer({postgres:pg});t.after(()=>hub.close());
  const alice=await hub.createUser('synthetic-owner'),bob=await hub.createUser('synthetic-reader');
  const source=await hub.records.artifacts.ingest({bytes:Buffer.from('合成正文\n合成下一行'),mediaType:'text/plain',origin:{upload:{session:'synthetic'}},author:{user:alice.user.id},provenanceType:'declared',visibility:{readers:[alice.user.id],admins:true,packs:[],shareable:true}});
  const share=artifactShareKey(source);await hub.records.authorizations.share(hub.admin.principal,share,[bob.user.id]);
  const client=await hub.client(bob.token,{sessionId:'synthetic-reader-session'});t.after(()=>client.close());
  const other=await hub.client(alice.token,{sessionId:'synthetic-owner-session'});t.after(()=>other.close());
  const args={reference:`src:${source.body.sha256}/text@1/l/1`};
  let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});t.after(()=>release());
  const original=hub.records.artifacts.source.bind(hub.records.artifacts);let reads=0,paused=false;
  hub.records.artifacts.source=async(...input)=>{if(input[0].id===bob.user.id&&input[1]===source.body.sha256){reads++;if(!paused){paused=true;enter();await gate;}}return original(...input);};
  const abort=new AbortController();
  const disconnected=fetch(hub.mcpUrl,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:`Bearer ${bob.token}`,'circle-session-id':'synthetic-reader-session'},body:JSON.stringify({jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'get_nodes',arguments:args}}),signal:abort.signal});
  await entered;
  const active=await client.call('get_nodes',{call_query:{get_nodes:args}});const trace=(active.structuredContent.call_status as {active:{trace:string}[]}).active[0].trace;
  abort.abort();await assert.rejects(disconnected);release();
  let recovered:any;
  for(let i=0;i<120;i++){
    recovered=await client.call('get_nodes',{call_query:{get_nodes:args,trace}});
    if(recovered.structuredContent.content)break;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  const content=recovered.structuredContent.content as {text:string;note:string};
  assert.equal(content.text,'合成正文');assert.match(content.note,/历史快照/);assert.ok(reads>=2,'recovery rechecks the source');
  await hub.records.authorizations.unshare(hub.admin.principal,share,bob.user.id);
  const denied=await client.call('get_nodes',{call_query:{get_nodes:args,trace}});
  assert.equal(denied.structuredContent.content,undefined);assert.match(JSON.stringify(denied.structuredContent.call_status),/未能按当前权限/);
  assert.ok(!JSON.stringify(denied).includes('合成正文'));
  const hidden=await other.call('get_nodes',{call_query:{get_nodes:args,trace}});assert.equal(hidden.structuredContent.content,undefined);
});
