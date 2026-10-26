import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProductDeclaration} from '../../contracts/src/product.ts';
import {TreeRootBody} from '../../contracts/src/knowledge.ts';
import {ReadManifest} from '../../contracts/src/resources.ts';
import {manifestDigest} from '../runs/api.ts';
import {createConnectors} from '../connectors/api.ts';
import {addSyntheticResource,setSyntheticCredential} from '../connectors/testing/credentials.ts';
import {fakePacks} from '../connectors/testing/packs.ts';
import {startStub,text} from '../connectors/testing/api.ts';
import {createDefaultRegistry} from '../refs/api.ts';
import {stagePack,readManifest} from '../../packs/workflow/case-review/packaging.ts';
import {PACK_DIR} from '../../packs/system/svn/api.ts';
import {makeWorld,startPostgres,sandboxIsolation} from './test-support.ts';
const EXTERNAL='svn:file:17/chapter.adoc';
const MEDIA='application/octet-stream';
const BODY='= Synthetic 10.8 manual\n\n== Chapter\n\n'+('Synthetic source paragraph. '.repeat(12))+'\0End.\n';
const PRODUCER=`export default input=>({entries:(input.lists?.files?.map(source=>({slot:'files',source}))??Object.entries(input.slots).filter(([,source])=>source!==null).map(([slot,source])=>({slot,source}))).map(({slot,source})=>({kind:'behaviour',path:'/manual/chapter',statement:source.model.lines.join(String.fromCharCode(10)),data:{nulRemoved:source.model.nulRemoved,media_type:source.media_type},fragments:[{slot,source:source.sha256,parser:source.parser,selector:source.model.lines.length===1?'l/1':'l/1-'+source.model.lines.length}],applicability:null})),warnings:[]});`;

test('the shipped FAMX and FAMY adoc groups explicitly declare text parsing',async()=>{
 const product=ProductDeclaration.parse(JSON.parse(await readFile(new URL('../../packs/product/famx/product.json',import.meta.url),'utf8')));
 for(const role of ['adoc_famx_files','adoc_famy_files']){
  const sources=product.producers.flatMap(producer=>Object.values(producer.inputs)).filter(source=>'source' in source&&source.source===role);
  assert.equal(sources.length,1);assert.equal(sources[0].parser,'text@1');
 }
});

test('synthetic SVN octet-stream originals remain intact while only declared groups parse text and count NUL',async t=>{
 const postgres=await startPostgres();t.after(()=>postgres.stop());
 for(const mode of ['declared-list','undeclared-list','mixed-single','declared-single'] as const)await t.test(mode,async t=>{
  const role='adoc_famx_files';
  const declared=mode==='declared-list'||mode==='declared-single';
  const single=mode==='mixed-single'||mode==='declared-single';
  const inputs=mode==='mixed-single'?{first:{source:role,parser:'text@1'},ordinary:{source:role}}:single?{file:{source:role,parser:'text@1'}}:{files:{source:role,many:true,...(declared?{parser:'text@1'}:{})}};
  const w=await makeWorld(postgres,{pack:{functions:{'document.ts':PRODUCER},declaration:{catalogs:[],producers:[{id:'manual',title:'合成手册',function:{module:'functions/document.ts'},inputs}]}}});
  t.after(()=>w.close());
  const directoryRoot=await mkdtemp(join(tmpdir(),'circle-hub-declared-text-'));t.after(()=>rm(directoryRoot,{recursive:true,force:true}));
  const directory=await stagePack(PACK_DIR,join(directoryRoot,'svn'));const pack=await readManifest(directory);
  const packs=fakePacks([{id:pack.id,version:pack.version,kind:pack.kind,digest:manifestDigest(pack),directory}]);
  const connectors=createConnectors({records:w.kit,packs,parsers:createDefaultRegistry(),sandbox:{requireOsIsolation:await sandboxIsolation()},resourceCacheMs:0});
  const authorization='Basic synthetic-declared-text';
  const server=await startStub(request=>request.headers.authorization===authorization&&request.method==='GET'&&request.path==='/repository/!svn/rvr/17/chapter.adoc'?text(BODY,MEDIA):text('Absent','text/plain',404));
  t.after(()=>server.close());
  const resource=(await addSyntheticResource(w.kit,packs,connectors,w.admin,{system_pack:'svn',name:'合成 SVN',environment:'test',origins:{svn:server.origin+'/repository'},allow_plaintext:[server.origin],settings:{repository_path:'/repository'}})).id;
  await setSyntheticCredential(w.kit,connectors,w.admin,resource,'authorization',authorization);
  let manifest:string|null=null;
  w.external.read=async(id,context)=>{const response=await connectors.reader.read(id,context);if(response.ok)manifest=response.manifest;return response;};
  const sources={[role]:single?EXTERNAL:[EXTERNAL]};
  const result=await w.knowledge.produceTree({product:w.product,by:w.admin,sources,build:{name:'Synthetic_zx-u_10_8_1',family:'ACME',line:'10.8',base:'Synthetic_zx-u_10_8_1',platform:'zx-u',built_at:null,released_at:null,root:null,sources}});
  assert.ok(manifest,'SVN read manifest exists even when no parser is declared');
  const receipt=ReadManifest.parse((await w.kit.store.get(manifest))!.body);
  assert.equal(receipt.requests[0].media_type,MEDIA);
  const original=receipt.artifacts.find(artifact=>artifact.name==='original')!;assert.equal(original.media_type,MEDIA);
  assert.deepEqual(Buffer.from((await w.kit.objects.get(original.sha256))!),Buffer.from(BODY),'original NUL bytes stay unchanged');
  if(!declared){assert.equal(result.ok,false);assert.match(result.reason??'',/没有支持此媒体类型的核心解析器/);return;}
  assert.ok(result.ok,result.reason??'');
  assert.ok(result.warnings.some(warning=>warning.includes('服务器媒体类型 application/octet-stream，按来源声明以 text@1 解析')));
  const root=TreeRootBody.parse((await w.kit.store.get(result.composition!))!.body);
  const source=root.sources.find(row=>row.external===EXTERNAL)!;assert.equal(source.media_type,MEDIA);assert.equal(source.parser,'text@1');
  const node=(await w.knowledge.getNodes({root:result.root!,paths:['/manual/chapter'],depth:0},w.admin))!.nodes[0];
  const read=await w.knowledge.treeReader().read(result.root!,node.path,node.entries[0].entry,{user:w.admin.id,role:w.admin.role});
  assert.ok(read);assert.equal((read.data as {data:{nulRemoved:number}}).data.nulRemoved,1);
 });
});
