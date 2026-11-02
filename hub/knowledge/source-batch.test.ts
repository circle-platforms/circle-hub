import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {withReadScope} from '../records/api.ts';
import {Database} from '../records/db.ts';
import {makeWorld,startPostgres} from './test-support.ts';
let postgres:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
test('parallel folder sources batch registrations and preserve exact captures, reader isolation and later revocation',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!,sources:Awaited<ReturnType<typeof spaces.importFile>>[]=[];
 for(let i=0;i<12;i++)sources.push(await spaces.importFile(w.user,Buffer.from('合成批次原文 '+i),'text/plain','synthetic-'+i+'.txt','/batch'));
 const original=Database.prototype.query;let calls=0;
 Database.prototype.query=(async function(this:Database,...args:Parameters<typeof original>){calls++;return original.apply(this,args);}) as typeof original;
 t.after(()=>{Database.prototype.query=original;});
 const read=async(n:number)=>withReadScope(async()=>Promise.all(sources.slice(0,n).map(source=>spaces.source(w.user,source.body.sha256))));
 calls=0;assert.equal((await read(2)).length,2);const small=calls;
 calls=0;const large=await read(12);assert.equal(calls,small,'distinct source hashes coalesce, rather than adding SQL per source');
 for(let i=0;i<large.length;i++){assert.equal(large[i]?.artifact.digest,sources[i].digest);assert.equal(Buffer.from(large[i]!.bytes!).toString(),'合成批次原文 '+i);}
 await spaces.grant(w.user,{path:'/batch',audience:'member',member:w.outsider.id});
 await withReadScope(async()=>{
  assert.ok(await spaces.source(w.user,sources[0].body.sha256));
  await assert.rejects(w.kit.artifacts.source(w.user,sources[0].body.sha256,{record:(()=>undefined) as never}),TypeError);
  await assert.rejects(w.kit.artifacts.source(w.user,sources[0].body.sha256,{consumer:Number.NaN as never}),TypeError);
  assert.equal(await spaces.source(w.admin,sources[0].body.sha256),null);
  const changing={...w.admin},pending=w.kit.artifacts.source(changing,sources[0].body.sha256);changing.id=w.user.id;assert.equal(await pending,null,'the cached proof uses the reader at invocation');
  const granted=await spaces.source(w.outsider,sources[0].body.sha256,undefined,'model',sources[0].digest);assert.equal(granted?.artifact.digest,sources[0].digest);
  granted!.bytes![0]=0;
  assert.equal(Buffer.from((await spaces.source(w.outsider,sources[0].body.sha256))!.bytes!).toString(),'合成批次原文 0','callers never mutate the cached byte proof');
  assert.equal(await spaces.source(w.outsider,sources[0].body.sha256,undefined,'model',sources[1].digest),null,'another exact capture never borrows a digest proof');
 });
 await spaces.grant(w.user,{path:'/batch',audience:'member',member:w.outsider.id,revoke:true});
 assert.equal(await withReadScope(()=>spaces.source(w.outsider,sources[0].body.sha256)),null);
 t.diagnostic(`2 and 12 originals each use ${small} SQL statements`);
});
test('parallel sharing prechecks still inspect every original and retain the first failing phase',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!;
 for(let i=0;i<6;i++)await spaces.importFile(w.user,Buffer.from('合成待署名原文 '+i),'text/plain','synthetic-'+i+'.txt','/batch');
 const source=spaces.source.bind(spaces),seen:string[]=[];spaces.source=async(...args)=>{seen.push(args[1]);return source(...args);};
 const checks=await spaces.precheckGrant(w.user,'/batch');
 assert.equal(new Set(seen).size,6);assert.equal(checks[0].state,'pass');assert.deepEqual(checks.map(check=>check.state),['pass','pass','pass']);
 const first=(await spaces.sources(w.user)).find(row=>row.path==='/batch')!.sha256;
 spaces.source=async(...args)=>args[1]===first?null:source(...args);
 const missing=await spaces.precheckGrant(w.user,'/batch');assert.equal(missing[0].code,'SPACE_CONTENT_UNINSPECTABLE');assert.equal(missing[1].state,'unchecked');
});
