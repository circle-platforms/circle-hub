import assert from 'node:assert/strict';
import {test} from 'node:test';
import {access} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Database,createPool} from '../../records/db.ts';
import {openPackTestbed} from './testing/setup.ts';
import {startPostgres} from '../../testing/postgres.ts';
import {workflowPack,editJson,withFiles} from './testing/builder.ts';
import {Extractor} from './extract.ts';

test('publication samples run without a member lock and deletion wins before promotion',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const bed=await openPackTestbed({postgres:pg});t.after(()=>bed.close());const db=new Database(createPool(bed.kit.database));t.after(()=>db.end());
 const base=workflowPack(),pack=withFiles(editJson<Record<string,any>>(base,'checks.json',c=>void c.checks.push({id:'pause',function:{module:'functions/pause.ts'},applies:'run',judges:'subject',tier:'advisory'})),{
  'functions/pause.ts':"export default async function(input){await new Promise(resolve=>setTimeout(resolve,1000));return [{verdict:input.subject.bad?'refute':'support',...(input.subject.bad?{code:'demo-review.paused'}:{}),statement:'synthetic check',grounds:[],tier:'advisory'}];}",
  'samples/positive/pause.json':{id:'pause_good',source:'author',check:'pause',subject:{bad:false},expect:[{verdict:'support'}]},
  'samples/negative/pause.json':{id:'pause_bad',source:'author',check:'pause',subject:{bad:true},expect:[{verdict:'refute',code:'demo-review.paused'}]},
 });
 const original=Extractor.prototype.stage;let deleting:Promise<unknown>|undefined,directory='',promoted=false;
 t.mock.method(Extractor.prototype,'stage',async function(this:Extractor,...args:Parameters<Extractor['stage']>){
  const staged=await original.apply(this,args);directory=staged.directory;
  return {get directory(){
   deleting??=(async()=>{
    await db.transaction(async tx=>{await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE NOWAIT',[bed.carol.id],tx);});
    const api=bed.kit.memberDeletions!,preview=await api.preview(bed.admin,bed.carol.id),intent=await api.prepare(bed.admin,{...preview,operation_id:randomUUID()});await api.finish(bed.admin,bed.carol.id,intent.operation_id);
   })();void deleting.catch(()=>{});
   return directory;
  },promote:async()=>{promoted=true;return staged.promote();},discard:()=>staged.discard()};
 });
 const publishing=bed.registry.personal!.publish(bed.carol,(await bed.write(pack)).dir);
 // Observe a refusal immediately as well as after awaiting deletion; no unhandled race rejection.
 const outcome=publishing.then(value=>({value}),error=>({error}));
 const result=await outcome;assert.ok(deleting,'the sample actually used a staged function tree: '+JSON.stringify(result));await deleting;
 assert.ok('error' in result,JSON.stringify(result));assert.equal(promoted,false);await assert.rejects(access(directory));assert.ok((await bed.kit.principals.get(bed.carol.id))?.deleted_at);
 assert.equal((await bed.kit.store.list({kind:'personal_pack_version'})).items.length,0);
});
