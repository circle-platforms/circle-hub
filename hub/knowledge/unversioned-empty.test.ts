import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {before,after,test} from 'node:test';
import {ProductDeclaration} from '../../contracts/src/product.ts';
import {TreeRootBody} from '../../contracts/src/knowledge.ts';
import {startPostgres} from '../testing/postgres.ts';
import {openTestRecords} from '../testing/records.ts';
import {createDefaultRegistry} from '../refs/api.ts';
import {osIsolationAvailable} from '../rules/api.ts';
import {createKnowledge} from './api.ts';
import {FakeExternal,FakePacks} from './test-support.ts';
import type {ProductHandle} from '../ports.ts';
let pg:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{pg=await startPostgres();});after(()=>pg?.stop());
async function world(t:any,versioned=false){
 const kit=await openTestRecords({postgres:pg});t.after(()=>kit.close());const admin=(await kit.principals.bootstrapAdmin('合成管理员')).user;
 const directory=await mkdtemp(join(tmpdir(),'scope-empty-'));t.after(()=>rm(directory,{recursive:true,force:true}));await mkdir(join(directory,'functions'));
 await writeFile(join(directory,'functions/plan.ts'),`export default input=>({fetch:[],builds:[],scope:{inventory:'site:tree:inventory',...(input.read['site:tree:inventory']?.model?.skip?{docs:['site:tree:missing']}:{})},done:true});`);
 await writeFile(join(directory,'functions/produce.ts'),`export default input=>{const model=input.slots.inventory.model;if(model.mode==='throw')throw Error('Synthetic producer fault');return {entries:model.items.map((item,i)=>({kind:model.mode==='refused'?'not_a_kind':'case',path:model.mode==='unplaced'?null:'/docs',statement:'Synthetic source item',data:{document:'synthetic-document'},fragments:[{slot:'inventory',parser:'json@1',selector:'p/items/'+i}],applicability:null})),warnings:[],...(model.items.length?{}:{inventory:[{label:'文档',listed:{slot:'inventory',parser:'json@1',selector:model.mode==='bad-proof'?'p/complete':'p/items'},complete:{slot:'inventory',parser:'json@1',selector:'p/complete'},selected:model.mode==='wrong-selection'?1:0}]})};};`);
 const product=ProductDeclaration.parse({schema:'product@1',id:'synthetic',title:'Synthetic',names:['Synthetic'],catalogs:[],sync:{start:['site:tree:inventory'],plan:{module:'functions/plan.ts'}},producers:[{id:'documents',title:'Synthetic docs',unversioned:!versioned,function:{module:'functions/produce.ts'},inputs:{inventory:{source:'inventory',optional:true},items:{source:'docs',many:true,optional:true}}}]});
 const handle:ProductHandle={id:'synthetic',kind:'product',version:'1.0.0',digest:'a'.repeat(64),directory,product};const packs=new FakePacks();packs.add(handle);const external=new FakeExternal(kit);
 const set=(items:unknown[],extra={})=>external.set('site:tree:inventory',{bytes:JSON.stringify({complete:true,items,...extra}),mediaType:'application/json'});set([]);
 const knowledge=createKnowledge({records:kit,parsers:createDefaultRegistry(),packs,external,admin,jev:null,sandbox:{requireOsIsolation:await osIsolationAvailable()}});
 return {kit,admin,handle,external,knowledge,set,packs};
}
test('complete zero selections create a distinguishable empty scope and replace a populated pointer',async t=>{
 const w=await world(t);assert.equal(await w.knowledge.unversionedRoot!('synthetic'),null);
 const firstEmpty=await w.knowledge.syncProduct(w.handle);assert.equal(firstEmpty.scope?.outcome,'produced',JSON.stringify(firstEmpty));assert.equal(firstEmpty.counts.failed,0);assert.equal((await w.knowledge.unversionedRoot!('synthetic'))?.root,firstEmpty.scope?.root);
 w.set(['synthetic']);const populated=await w.knowledge.syncProduct(w.handle,{recheck:true});assert.equal(populated.scope?.outcome,'produced',JSON.stringify(populated));
 w.set([]);const empty=await w.knowledge.syncProduct(w.handle,{recheck:true});assert.equal(empty.scope?.outcome,'produced',JSON.stringify(empty));assert.equal(empty.counts.failed,0);
 const current=await w.knowledge.unversionedRoot!('synthetic');assert.equal(current?.root,empty.scope?.root);assert.notEqual(current?.root,populated.scope?.root);
 const record=await w.kit.store.get(empty.scope!.composition!);const body:any=record!.body;assert.equal(body.empty_scope.complete,true);assert.equal(body.empty_scope.sources[0].total,0);assert.equal(body.empty_scope.sources[0].selected,0);assert.match(body.empty_scope.sources[0].listed,/^src:/);
 assert.equal(TreeRootBody.safeParse({...body,counts:{...body.counts,entries:1}}).success,false);
 assert.equal(TreeRootBody.safeParse({...body,version:{line:'10.6',build:'Synthetic_10_6',family:'Synthetic',platform:null}}).success,false);
 const note='不分版本的根为空（清单完整，文档 0 份）';assert.ok(empty.scope!.reason.includes(note));
 const read=await w.knowledge.getNodes({root:current!.root,paths:['/'],depth:0},w.admin);assert.deepEqual(read?.nodes,[]);assert.equal(read?.coverage.note,note);assert.equal(read?.coverage.complete,true);
 const member=await w.kit.principals.createUser(w.admin,'合成读者');w.packs.readers.set(member.id,new Set(['synthetic']));const memberRead=await w.knowledge.getNodes({root:current!.root,paths:['/'],depth:0},member);assert.deepEqual(memberRead?.nodes,[]);assert.equal(memberRead?.coverage.note,note);
 const outsider=await w.kit.principals.createUser(w.admin,'合成无权者');assert.equal(await w.knowledge.getNodes({root:current!.root,paths:['/'],depth:0},outsider),null);
 const reference=await w.knowledge.treeReader({composition:empty.scope!.composition}).read(current!.root,'/',null,{user:w.admin.id,role:w.admin.role});assert.equal(reference?.text,note);
 const again=await w.knowledge.syncProduct(w.handle);assert.equal(again.scope?.outcome,'skipped');assert.ok(again.scope?.reason.includes(note));
 w.set(['synthetic'],{mode:'unplaced'});const unplaced=await w.knowledge.syncProduct(w.handle,{recheck:true});assert.equal(unplaced.scope?.unplaced,1);assert.equal(unplaced.scope?.root,current!.root);
 const currentRead=await w.knowledge.getNodes({root:current!.root,paths:['/'],depth:0},w.admin);assert.ok(currentRead);assert.equal(currentRead.nodes.length,1);assert.ok(!currentRead.coverage.note?.includes('清单完整'));
 const currentReference=await w.knowledge.treeReader().read(current!.root,'/',null,{user:w.admin.id,role:w.admin.role});assert.ok(currentReference);assert.notEqual(currentReference.text,note);
 const pinned=await w.knowledge.getNodes({root:current!.root,composition:empty.scope!.composition,paths:['/'],depth:0},w.admin);assert.deepEqual(pinned?.nodes,[]);assert.equal(pinned?.coverage.note,note);
});
for(const mode of ['incomplete','read-failed','throw','refused','skipped','bad-proof','wrong-selection'])test(`empty scope refusal preserves its pointer for ${mode}`,async t=>{
 const w=await world(t);w.set(['synthetic']);const initial=await w.knowledge.syncProduct(w.handle);assert.equal(initial.scope?.outcome,'produced',JSON.stringify(initial));
 if(mode==='read-failed')w.external.set('site:tree:inventory',{fail:'Synthetic read failure'});
 else w.set(mode==='refused'?['refused']:[],mode==='incomplete'?{complete:false}:mode==='skipped'?{skip:true}:{mode});
 const failed=await w.knowledge.syncProduct(w.handle,{recheck:true});assert.equal(failed.scope?.outcome,'failed',JSON.stringify(failed));assert.equal((await w.knowledge.unversionedRoot!('synthetic'))?.root,initial.scope?.root);
});
test('a versioned build still refuses a normal empty producer result',async t=>{
 const w=await world(t,true);const result=await w.knowledge.produceTree({product:w.handle,by:w.admin,build:{name:'Synthetic_10_6',base:'Synthetic_10_6',family:'Synthetic',line:'10.6',platform:null,built_at:null,released_at:null,root:null,sources:{inventory:'site:tree:inventory'}}});assert.equal(result.ok,false);
});
