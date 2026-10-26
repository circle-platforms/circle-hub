import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {after,before,test} from 'node:test';
import {BASE_CATALOG,DEFAULT_PRODUCERS,catalogXml,extraProducer,makeWorld,startPostgres} from './test-support.ts';
import {resolveReference,createDefaultRegistry} from '../refs/api.ts';
let postgres:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{postgres=await startPostgres();});after(async()=>{await postgres?.stop();});
for(const allowed of [false,true])test(`placement proposals require the source producer permission (${allowed})`,async t=>{
 const extra=extraProducer('cases',{entries:[{kind:'case',path:null,statement:'synthetic unplaced case',data:{},fragments:[{parser:'xml@1',selector:'x/catalog/group[1]/command[1]'}],applicability:null}]},undefined,allowed?'judgment_allowed':'code_only');
 const w=await makeWorld(postgres,{pack:{declaration:{producers:[DEFAULT_PRODUCERS[0],extra]}}});t.after(()=>w.close());
 const name='Rel_ACME_10_6_1_71';w.external.set(`site:tree:${name}`,{bytes:catalogXml(BASE_CATALOG),mediaType:'application/xml'});
 const result=await w.knowledge.produceTree({product:w.product,build:{name,family:'ACME',line:'10.6.1',base:name,platform:null,built_at:null,released_at:null,root:null,sources:{tree:`site:tree:${name}`}}});assert.equal(result.ok,true,result.reason??'');
 const production=await w.knowledge.store.latestProduction(w.product.product.id,name),composition=production!.detail.composition!;
 const body=await w.knowledge.store.composition(composition),row=body!.unplaced[0];
 const reference=`tree:${result.root}/@${row.entry}`;
 const resolve=async(ref:string)=>{const got=await resolveReference(ref,{reader:{user:w.user.id,role:'user'},parsers:createDefaultRegistry(),trees:w.knowledge.treeReader({composition})});return got.resolved?{ok:true as const,value:{reference:got.reference,text:got.text}}:{ok:false as const,message:got.message};};
 const scope={root:result.root,product:w.product.product.id,composition,resolve};
 const input={kind:'placement_proposal',root:result.root,path:'/commands/system/reboot',statement:'synthetic bot placement',source:{reference,quote:'synthetic unplaced case'}};
 if(!allowed){
  await writeFile(join(w.product.directory,'product.json'),JSON.stringify({...w.product.product,producers:w.product.product.producers.map(p=>({...p,placement:'judgment_allowed'}))}));
 }
 if(!allowed)await assert.rejects(()=>w.knowledge.layers.contributions.prepare(w.user,input,scope),/生产器.*未允许/);
 else{
  const prepared=await w.knowledge.layers.contributions.prepare(w.user,input,scope);assert.equal(prepared.kind,'placement_proposal');
  const originalPack=w.packs.pack.bind(w.packs);
  w.packs.pack=async()=>({...w.product,kind:'workflow'});
  await assert.rejects(()=>w.knowledge.layers.contributions.prepare(w.user,input,scope),(error:any)=>error.code==='REFERENCE_UNRESOLVED'&&error.message.includes('不是产品包')&&typeof error.fix==='string');
  w.packs.pack=originalPack;
  await assert.rejects(()=>w.knowledge.layers.contributions.prepare(w.user,{...input,path:'/missing'},scope),/路径/);
  await assert.rejects(()=>w.knowledge.layers.contributions.prepare(w.user,{...input,source:{reference,quote:'fabricated quote'}},scope),/引文/);
 }
});
