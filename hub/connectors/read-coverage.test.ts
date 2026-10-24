import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {startPostgres,type TemporaryPostgres} from '../testing/postgres.ts';
import {openConnectorKit} from './testing/kit.ts';
import {writePack} from './testing/packs.ts';
import {ReadManifest} from '../../contracts/src/resources.ts';
let postgres:TemporaryPostgres;before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());

test('a partial nested result limits its parent and is reread rather than cached as complete',async t=>{
  let calls=0;
  const kit=await openConnectorKit(postgres,{fetch:async()=>{calls++;return new Response('{"value":1}',{headers:{'content-type':'application/json'}});},callFunction:async(_target,input,kind)=>{
    if(kind==='project')return {artifacts:[],complete:false,note:'合成后页待补齐，重读来源后确认'};
    return {requests:[{key:'original',route:'one'}],reads:[{external:'fixture:leaf:sample'}],done:true,original:'original'};
  }});t.after(()=>kit.close());
  const handle=await writePack(kit.packRoot,{id:'synthetic-coverage',functions:['docstore.ts'],system:{schema:'system@1',title:'合成覆盖',roles:[{name:'source'}],auth:{kind:'none'},routes:[{id:'one',role:'source',method:'GET',path:'/one',response:'json',max_bytes:1024,read:true}],reads:[{name:'leaf',external:'fixture:leaf',request:{route:'one'},project:{module:'functions/docstore.ts',export:'searchProject'}},{name:'parent',external:'fixture:parent',plan:{module:'functions/docstore.ts',export:'searchPlan'}}]}});kit.packs.set(handle);
  await kit.connectors.admin.addResource(kit.admin,{system_pack:handle.id,name:'合成覆盖来源',environment:'test',origins:{source:'http://192.0.2.2'}});
  const read=()=>kit.connectors.reader.read('fixture:parent:sample',{principal:kit.user,purpose:'synthetic coverage'});
  const first=await read();assert.equal(first.ok,true);if(!first.ok)return;
  assert.equal(first.coverage?.complete,false);assert.match(first.coverage?.note??'',/fixture:leaf:sample/);
  const record=await kit.records.store.get(first.manifest);assert.equal(ReadManifest.parse(record!.body).coverage.complete,false);
  await read();assert.equal(calls,4,'the two partial leaf reads cannot collapse into one cached success');
});
