// Production harness of the migration equivalence: the repository's synthetic product pack (famx) produces its two
// family manuals from synthetic SVN directory fixtures through real Hub knowledge transactions and its sandboxed
// producer. The same harness ran before the move (frozen in baseline/trees.json) and runs after it. All bytes are synthetic.
import {cp,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createTestParserRegistry} from '../../../../hub/testing/parsers.ts';
import {ProductDeclaration,type BuildInfo} from '../../../../contracts/src/product.ts';
import {createKnowledge} from '../../../../hub/knowledge/api.ts';
import {FakeExternal,FakePacks} from '../../../../hub/knowledge/test-support.ts';
import {sha256Hex} from '../../../../hub/records/api.ts';
import type {TemporaryPostgres} from '../../../../hub/testing/postgres.ts';
import {openTestRecords} from '../../../../hub/testing/records.ts';

/** The synthetic product pack that consumes the walk (test data only; the skill names no product at run time). */
const PRODUCT_DIR=fileURLToPath(new URL('../../../product/famx/',import.meta.url));

interface FixtureFile {path:string;text:string}
export interface ProductionFixture {
 name:string;
 /** The root template both families use. */
 template:string;
 line:string;
 build:string;
 /** The directory the template names for this line. */
 directory:string;
 main:string;
 app_main:string;
 files:FixtureFile[];
 /** Directories with no adoc inside, listed but never opened. */
 siblings:string[];
}

export const PRODUCTION_FIXTURES:readonly ProductionFixture[]=[
 {
  name:'flat book directory under {line}',template:'synthetic/{line}',line:'10.8.1',build:'Rel_FAMX-ZX-U_10_8_1_901',directory:'synthetic/10.8.1',
  main:'book.adoc',app_main:'app.adoc',siblings:[],
  files:[
   {path:'book.adoc',text:'= Synthetic\n\ninclude::chapters/body.adoc[]\n'},
   {path:'app.adoc',text:'= Synthetic APP\n\n== Application\n\n{brand} APP content.\n'},
   {path:'chapters/body.adoc',text:'== Section\n\n{brand} family content.\n\n== Second section\n\nMore {brand} text.\n'},
  ],
 },
 {
  name:'two book directories under the three-component {line_dir}',template:'manual/{line_dir}',line:'10.7',build:'Rel_FAMX-ZX-U_10_7_902',directory:'manual/10_7_0',
  main:'cli/book.adoc',app_main:'app/app.adoc',siblings:['old'],
  files:[
   {path:'cli/book.adoc',text:'= Synthetic CLI\n\ninclude::chapters/one.adoc[]\n\ninclude::chapters/two.adoc[]\n'},
   {path:'cli/chapters/one.adoc',text:'== Interfaces\n\n{brand} interface chapter.\n'},
   {path:'cli/chapters/two.adoc',text:'== Routing\n\n{brand} routing chapter.\n'},
   {path:'app/app.adoc',text:'= Synthetic APP\n\n== Overview\n\n{brand} application overview.\n'},
  ],
 },
];

export interface ProducedTree {root:string;entries:string[];sources:{external:string;sha256:string;parser:string|null}[]}

/** Directory listing documents for every directory of the fixture, keyed by external id, as the SVN pack projects them. */
function listings(fixture:ProductionFixture,revision:string):Map<string,unknown>{
 const out=new Map<string,unknown>();
 const dirs=new Set<string>(['']);
 for(const file of fixture.files){const parts=file.path.split('/');for(let i=1;i<parts.length;i++)dirs.add(parts.slice(0,i).join('/'));}
 for(const sibling of fixture.siblings)dirs.add(sibling);
 const full=(rel:string)=>rel?`${fixture.directory}/${rel}`:fixture.directory;
 const parent=(rel:string)=>rel.includes('/')?rel.slice(0,rel.lastIndexOf('/')):'';
 const name=(rel:string)=>rel.slice(rel.lastIndexOf('/')+1);
 for(const dir of [...dirs].sort()){
  const members:unknown[]=[];
  for(const child of [...dirs].sort())if(child!==''&&parent(child)===dir)members.push({name:name(child),directory:true,external:null,revision:'16',size:null});
  for(const file of fixture.files)if(parent(file.path)===dir)members.push({name:name(file.path),directory:false,external:'svn:file:'+revision+'/'+encodeURIComponent(full(file.path)),revision:'16',size:Buffer.byteLength(file.text)});
  const id=dir===''?'svn:directory:'+encodeURIComponent(fixture.directory):'svn:directory-at:'+revision+'/'+encodeURIComponent(full(dir));
  out.set(id,{directory:full(dir),revision,members});
 }
 return out;
}

/**
 * Produce both family manuals of one fixture and return the tree root digest, the composition's entry digests in order
 * and the bound sources. `addAdocSources` is the product pack's sync step, passed in so the caller names it.
 */
export async function produceFixture(postgres:TemporaryPostgres,fixture:ProductionFixture,addAdocSources:(build:BuildInfo,options:Record<string,unknown>,read:Record<string,unknown>,want:(id:string)=>void,notes:string[])=>void):Promise<ProducedTree>{
 const records=await openTestRecords({postgres});const dir=await mkdtemp(join(tmpdir(),'adoc-format-production-'));
 try{
  const admin=(await records.principals.bootstrapAdmin('合成管理员')).user;
  await cp(join(PRODUCT_DIR,'functions'),join(dir,'functions'),{recursive:true,filter:source=>!source.endsWith('.test.ts')});
  await writeFile(join(dir,'functions','synthetic-plan.ts'),'export default function(input:any){return {fetch:[],builds:[input.options.build],done:true};}');
  const raw=JSON.parse(await readFile(join(PRODUCT_DIR,'product.json'),'utf8'));
  const declaredAdoc=raw.sync.options.adoc as Record<string,Record<string,unknown>>;
  raw.sync={start:['site:page:index'],plan:{module:'functions/synthetic-plan.ts'},options:raw.sync.options};
  await writeFile(join(dir,'product.json'),JSON.stringify(raw));
  const product={id:'famx',version:'1.0.0',digest:sha256Hex(JSON.stringify(raw)),directory:dir,kind:'product' as const,product:ProductDeclaration.parse(raw)};
  const packs=new FakePacks();packs.add(product);const external=new FakeExternal(records);
  external.set('site:page:index',{bytes:'<html></html>',mediaType:'text/html'});
  external.set('site:tree:demo',{bytes:'<commands><scope type="global"><item name="demo" help_string="Synthetic"/></scope></commands>',mediaType:'application/xml'});
  const revision='17';
  const docs=listings(fixture,revision);
  for(const [id,doc] of docs)external.set(id,{bytes:JSON.stringify(doc),mediaType:'application/json'});
  for(const file of fixture.files)external.set('svn:file:'+revision+'/'+encodeURIComponent(fixture.directory+'/'+file.path),{bytes:file.text,mediaType:'text/plain'});
  for(const declaration of product.product.variables??[])await records.variables.setVariable(admin,declaration.name,declaration.default,'合成默认值的显式部署设置');
  for(const family of ['FAMX','FAMY']){
   await records.variables.setVariable(admin,family+'_ADOC_ROOT',fixture.template,'合成源目录');
   await records.variables.setVariable(admin,family+'_ADOC_MAIN',fixture.main,'合成主文件');
   await records.variables.setVariable(admin,family+'_ADOC_APP_MAIN',fixture.app_main,'合成主文件');
   await records.variables.setVariable(admin,'FAMX_ADOC_ATTRIBUTES_'+family,{brand:family==='FAMX'?'Alpha':'Beta'},'合成族属性');
  }
  const build:BuildInfo={name:fixture.build,base:fixture.build,family:'FAMX',line:fixture.line,platform:'zx-u',built_at:null,released_at:'2026-01-01T00:00:00.000Z',sources:{tree:'site:tree:demo'}};
  const read:Record<string,unknown>=Object.fromEntries([...docs].map(([id,model])=>[id,{ok:true,parser:'json@1',model}]));
  // The sync options as the pack declares them, with the variables this fixture sets.
  const options={adoc:Object.fromEntries(['FAMX','FAMY'].map(family=>[family,{...declaredAdoc[family],root:fixture.template,main:fixture.main,app_main:fixture.app_main}]))};
  const wanted:string[]=[];const notes:string[]=[];
  addAdocSources(build,options,read,id=>wanted.push(id),notes);
  if(wanted.length||notes.length)throw new Error(`the sync step did not bind the whole fixture: ${JSON.stringify({wanted,notes})}`);
  const knowledge=createKnowledge({records,parsers:createTestParserRegistry(),packs,external,admin,sandbox:{requireOsIsolation:false}});
  const sync=await knowledge.syncProduct(product,{options:{build},maxAgeSeconds:0,recheck:true});
  if(sync.counts.produced!==1)throw new Error(`production failed: ${JSON.stringify(sync.builds)}`);
  const body=await knowledge.store.composition(sync.builds[0].composition!);
  const current=await knowledge.currentRoot('famx',fixture.line);
  if(!body||!current)throw new Error('no current root');
  return {
   root:current.root,
   entries:body.composition.map(row=>row.entry),
   sources:body.sources.map(source=>({external:source.external,sha256:source.sha256,parser:source.parser??null})),
  };
 }finally{await records.close();await rm(dir,{recursive:true,force:true});}
}
