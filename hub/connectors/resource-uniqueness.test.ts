import type {Environment} from '../../contracts/generated/vocabulary.ts';
import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {startPostgres,type TemporaryPostgres} from '../testing/postgres.ts';
import {openConnectorKit} from './testing/kit.ts';
import {writePack} from './testing/packs.ts';
let postgres:TemporaryPostgres;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
async function world(t:{after:(fn:()=>Promise<void>)=>void}){
 const kit=await openConnectorKit(postgres);t.after(()=>kit.close());
 for(const id of ['unique-one','unique-two']){kit.packs.set(await writePack(kit.packRoot,{id,system:{schema:'system@1',title:'合成资源',roles:[{name:'source'}],auth:{kind:'none'},routes:[{id:'one',role:'source',method:'GET',path:'/one',response:'json',read:true,max_bytes:1024}],reads:[{name:'one',external:'fixture:item',request:{route:'one'}}]}}));}
 return {kit,add:(pack='unique-one',environment:Environment='test')=>kit.connectors.admin.addResource(kit.admin,{system_pack:pack,name:pack,environment,origins:{source:'http://192.0.2.1'}})};
}
test('an enabled external type is unique within each environment even across different packs',async t=>{
 const w=await world(t);await w.add();await assert.rejects(w.add('unique-two'),/fixture:item.*test|test.*fixture:item/);
 await w.add('unique-two','production');
});
test('concurrent enabling from independent services leaves exactly one active resource',async t=>{
 const w=await world(t);const a=await w.add();await w.kit.connectors.admin.disable(w.kit.admin,a.id);const b=await w.add('unique-two');await w.kit.connectors.admin.disable(w.kit.admin,b.id);
 const other=w.kit.make();const results=await Promise.allSettled([w.kit.connectors.admin.enable(w.kit.admin,a.id),other.admin.enable(w.kit.admin,b.id)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await other.admin.listResources(w.kit.admin)).filter(r=>r.enabled).length,1);
});
test('an update cannot move a resource into a conflicting environment',async t=>{
 const w=await world(t);await w.add();const b=await w.add('unique-two','production');
 await assert.rejects(w.kit.connectors.admin.updateResource(w.kit.admin,b.id,{environment:'test'}),/fixture:item/);
 assert.equal((await w.kit.connectors.admin.describe(w.kit.admin,b.id))!.environment,'production');
});

test('broken bound profiles are visible in admin resource lists and private read diagnostics',async t=>{
 const w=await world(t);const resource=await w.add();w.kit.packs.remove('unique-one');w.kit.connectors.refresh();
 const notes:string[]=[];
 const result=await w.kit.connectors.reader.read('fixture:item:sample',{principal:w.kit.user,purpose:'synthetic diagnostics',adminNote:reason=>notes.push(reason)});
 assert.equal(result.ok,false);assert.ok(notes.some(note=>note.includes(resource.id)&&note.includes('恢复原包')));
 assert.ok(w.kit.log.some(event=>event.event==='resource_binding_failed'&&event.resource===resource.id));
 const admin=(await w.kit.connectors.admin.listResources(w.kit.admin)).find(row=>row.id===resource.id)!;assert.ok(admin.binding_error);assert.match(admin.binding_error.fix,/恢复原包/);
 assert.ok((await w.kit.connectors.catalog.list(w.kit.admin))[0].binding_error);
 assert.equal((await w.kit.connectors.admin.listResources(w.kit.user))[0].binding_error,undefined);assert.deepEqual(await w.kit.connectors.catalog.list(w.kit.user),[]);
});
