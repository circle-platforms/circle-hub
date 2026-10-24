// Real knowledge composition and reference reads over a private synthetic database.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { labelOf } from '../../contracts/generated/vocabulary.ts';
import { catalogXml, BASE_CATALOG, extraProducer, makeWorld, startPostgres } from './test-support.ts';

test('tree entry and whole-node reads disclose missing target observations for the four new fields',async t=>{
  const pg=await startPostgres();t.after(()=>pg.stop());
  const entry={kind:'behaviour',path:'/evidence',statement:'Synthetic conditional source statement',data:{},fragments:[{parser:'xml@1',selector:'x/catalog'}],applicability:{components:{with:['Card-A']},memory:{minimum:{bytes:8*1024**3,inclusive:true},raw:'内存至少8GB'},licenses:['Permit-A'],deployment_forms:['Form-A']}};
  const w=await makeWorld(pg,{pack:{declaration:{catalogs:[],producers:[extraProducer('declared',{entries:[entry]})]}}});t.after(()=>w.close());
  w.external.set('site:tree:synthetic-10.6',{bytes:catalogXml(BASE_CATALOG),mediaType:'application/xml'});
  const made=await w.knowledge.produceTree({product:w.product,build:{name:'Synthetic_10_6_1',family:'ACME',line:'10.6',base:'Synthetic_10_6_1',platform:null,built_at:null,released_at:null,sources:{tree:'site:tree:synthetic-10.6'},root:null}});
  assert.equal(made.ok,true,JSON.stringify(made));
  const node=(await w.knowledge.getNodes({root:made.root!,paths:['/evidence'],depth:0},w.user))!.nodes[0]!;
  for(const id of [node.entries[0]!.entry,null]){
    const read=await w.knowledge.treeReader().read(made.root!,'/evidence',id,{user:w.user.id,role:w.user.role});assert.ok(read);
    const premises=(read.validity as {premises:string[]}).premises;
    for(const field of ['components','memory','licenses','deployment_forms'] as const)assert.ok(premises.includes('目标前提，未核对：缺目标上的'+labelOf('applicability_field',field)+'观察；下一步：在目标上观察'));
  }
});
