import assert from 'node:assert/strict';
import {test} from 'node:test';
import {captureResponse} from './capture.ts';
import {Journal,type JobBinding} from './journal.ts';
import {newId,sha256Hex,type RecordsKit,type Transaction} from '../records/api.ts';

function fixture(options:{failAction?:boolean;beforeCommit?:()=>Promise<void>}={}){
  const committed:Array<{kind:string;body:any}>=[],blobs=new Map<string,Uint8Array>();
  let transaction=0;
  type Tx=Transaction&{rows:typeof committed};
  const store={
    async withTransaction<T>(run:(tx:Tx)=>Promise<T>):Promise<T>{
      const tx:Tx={transactionId:++transaction,rows:[]};
      const value=await run(tx);await options.beforeCommit?.();committed.push(...tx.rows);return value;
    },
    async put(value:{kind:string;body:any},tx:Tx){
      assert.ok(tx.transactionId>0);if(options.failAction)throw Error('synthetic response append failed');
      tx.rows.push(value);return {digest:'a'.repeat(64),body:value.body,created:true};
    },
  };
  const artifacts={
    async ingestObservedRead(input:any,tx:Tx){
      assert.equal(input.author.user,null);assert.equal(input.provenanceType,'observed');
      assert.equal(input.readTier,'function_bytes_only');assert.equal(input.visibility.admins,true);
      assert.equal(input.visibility.shareable,false);assert.ok(input.origin.read.object.startsWith('executor:'));
      const hash=sha256Hex(input.bytes);blobs.set(hash,Uint8Array.from(input.bytes));
      tx.rows.push({kind:'source_artifact',body:{sha256:hash}});
      return {digest:'b'.repeat(64),body:{sha256:hash}};
    },
  };
  const records={store,artifacts} as unknown as RecordsKit;
  const user=newId('usr'),run=newId('run');
  const binding:JobBinding={job:'c'.repeat(64),initiated_by:newId('usr'),executor:newId('exe'),executor_digest:'d'.repeat(64),
    target_key:'e'.repeat(64),user,resources:['bed/synthetic'],run,input:null};
  const journal=new Journal(records,()=>new Date('2026-11-15T00:00:00Z'));
  const input={records,journal,binding,bytes:Buffer.from('{"synthetic":"result"}'),status:200,operation:'result',complete:true};
  return {committed,blobs,binding,input};
}
test('first received bytes and their response action become visible only after their shared commit',async()=>{
  let release!:()=>void,arrived!:()=>void;
  const gate=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{arrived=r;});
  const f=fixture({beforeCommit:async()=>{arrived();await gate;}});
  let returned=false;
  const pending=captureResponse(f.input).then(value=>{returned=true;return value;});
  await ready;assert.equal(returned,false);assert.equal(f.committed.length,0);assert.equal(f.blobs.size,1);
  release();const source=await pending;
  assert.equal(source,'src:'+sha256Hex(f.input.bytes));assert.equal(f.committed.length,2);
  const event=f.committed[1].body;
  assert.equal(event.detail.phase,'result.response');assert.equal(event.detail.source_record,'rec:'+'b'.repeat(64));
  assert.deepEqual(event.inputs,[source,'rec:'+'b'.repeat(64)]);
});
test('failure before commit leaves neither a source record nor an action, even when CAS bytes already exist',async()=>{
  const f=fixture({beforeCommit:async()=>{throw Error('synthetic exit before commit');}});
  await assert.rejects(captureResponse(f.input),/before commit/);
  assert.equal(f.committed.length,0);assert.equal(f.blobs.size,1);
});
test('failure after source capture while appending the response cannot publish an orphan source record',async()=>{
  const f=fixture({failAction:true});
  await assert.rejects(captureResponse(f.input),/response append failed/);
  assert.equal(f.committed.length,0);assert.equal(f.blobs.size,1);
});
test('partial read metadata stays partial and retains the locally expected RPC identity',async()=>{
  const f=fixture();
  await captureResponse({...f.input,status:0,complete:false,metadata:{rpc_id:7,rpc_method:'tools/call',received_sha256:'f'.repeat(64),redacted:false,started_at:'2026-11-15T00:00:00Z',ended_at:'2026-11-15T00:00:01Z'}});
  const detail=f.committed[1].body.detail;
  assert.equal(f.committed[1].body.result,'error');assert.equal(detail.complete,false);assert.equal(detail.http_status,0);
  assert.equal(detail.rpc_id,7);assert.equal(detail.rpc_method,'tools/call');
});

test('redacted received-byte fingerprints and public response links share one commit without disclosing the private fingerprint',async()=>{
  const f=fixture();delete f.binding.run;
  const run=newId('run');
  f.binding.input={run,user:f.binding.user,lineage:run,ancestors:[run],item:'synthetic-artifact',items:['synthetic-case'],
    plan_run:newId('run'),sha256:'a'.repeat(64),target:'synthetic-bed',manifest_sha256:'e'.repeat(64),build:'synthetic-build',generator:'synthetic-generator',result:'d'.repeat(64)};
  await captureResponse({...f.input,metadata:{rpc_id:9,rpc_method:'tools/call',received_sha256:'f'.repeat(64),redacted:true,started_at:'2026-11-15T00:00:00Z',ended_at:'2026-11-15T00:00:01Z'}});
  assert.equal(f.committed.length,3);
  const privateEvent=f.committed[1].body,publicEvent=f.committed[2].body;
  assert.equal(privateEvent.run,null);assert.equal(privateEvent.detail.phase,'result.private_response');
  assert.equal(privateEvent.detail.received_sha256,'f'.repeat(64));
  assert.equal(Object.hasOwn(publicEvent.detail,'received_sha256'),false);
  assert.equal(publicEvent.detail.redacted,true);assert.equal(publicEvent.detail.rpc_id,9);
});
