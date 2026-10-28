import {createTestParserRegistry as createDefaultRegistry} from '../../testing/parsers.ts';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {makeWorld,startPostgres,STATIC_PLAN_SOURCE,DEFAULT_SYNC,COMMANDS_SOURCE,catalogXml} from '../test-support.ts';
import {SeedlingBody} from '../../../contracts/src/knowledge.ts';
import {seedlingName} from '../seedling.ts';
import {manifestDigest} from '../../runs/api.ts';

const famx=new URL('../../../packs/product/famx/',import.meta.url);
// This isolated feeding world explicitly declares its installed capability; production installation is tested in refs/skills.
export function installedMindmapFixture(){
 const registry=createDefaultRegistry();
 const manifest=JSON.parse(readFileSync(new URL('../../../packs/skill/mindmap-format/pack.json',import.meta.url),'utf8'));
 registry.freeze=async dependencies=>{assert.ok(dependencies.every(dep=>dep.pack===manifest.id&&(dep.version===undefined||dep.version===manifest.version)));return {parsers:registry,skills:[{pack:manifest.id,version:manifest.version,digest:manifestDigest(manifest)}]};};
 return registry;
}

export const mapBytes=Buffer.from(JSON.stringify({agile:{id:'SYN-DOC'},root:{data:{id:'root',text:'Synthetic zx-u 10.8'},children:Array.from({length:40},(_,i)=>({data:{id:'case-'+i,autoid:'SYN-'+i,text:'Synthetic case '+i,priority:2,resource:['functional']},children:[{data:{id:'step-'+i,text:'system show'},children:[{data:{id:'expect-'+i,text:'Synthetic expected '+i}}]}]}))}}));
export async function world(pg:Awaited<ReturnType<typeof startPostgres>>,slow:boolean|number=false,failure?:string,nativeTree?:string){
 const manifest=JSON.parse(readFileSync(new URL('pack.json',famx),'utf8'));
 const functions:Record<string,string>=Object.fromEntries(manifest.files.filter((file:{path:string})=>file.path.startsWith('functions/')).map((file:{path:string})=>[file.path.slice(10),readFileSync(new URL(file.path,famx),'utf8')]));
 functions['synthetic-tree.ts']=nativeTree?"export {commandTree as default} from './producers.ts';":COMMANDS_SOURCE;functions['synthetic-plan.ts']=STATIC_PLAN_SOURCE;
 if(slow)functions['slow.ts']=`import project from './feeding.ts';export default input=>{const until=Date.now()+${typeof slow==='number'?slow:800};while(Date.now()<until){}return project(input);};`;
 if(failure)functions['failure.ts']=failure;
 const name='Rel_FAMX-zx-u_10_8_1_1';
 const w=await makeWorld(pg,{pack:{id:'famx',names:['FAMX','FAMY'],functions,declaration:{sync:{...DEFAULT_SYNC,plan:{module:'functions/synthetic-plan.ts'},options:{builds:[{name,base:name,family:'FAMX',line:'10.8.0',platform:'zx-u',built_at:'2026-10-01T00:00:00.000Z',released_at:'2026-10-02T00:00:00.000Z',sources:{tree:'site:tree:synthetic'}}]}},catalogs:[],producers:[{id:'tree',title:'Synthetic tree',function:{module:'functions/synthetic-tree.ts'},inputs:{tree:{source:'tree'}}}],feeding:{project:{module:failure?'functions/failure.ts':slow?'functions/slow.ts':'functions/feeding.ts'},normalize_line:{module:'functions/feeding.ts',export:'normalizeLine'}}}}});
 w.external.set('site:tree:synthetic',{bytes:nativeTree??catalogXml({system:[{name:'show',params:[]}]}),mediaType:'application/xml'});await w.knowledge.syncProduct(w.product,{by:w.admin});
 const root=await w.knowledge.rootOfBuild('famx',name);assert.ok(root);const comp=await w.knowledge.store.composition(root.composition);assert.ok(comp);const original=comp.sources[0];
 for(let i=8;i<28;i++){const line='10.'+i+'.0',body=SeedlingBody.parse({product:'famx',line,root:root.root,composition:root.composition,build:name,origin:[{role:'command-tree',producer:original.producer,slot:original.slot,external:original.external,sha256:original.sha256,revision:null}],parent:null,basis:'Synthetic seed'});const rec=await w.knowledge.store.putClaim('seedling@1','projected',body,[{key:'knowledge.seedling',value:'famx/'+line},{key:'knowledge.seedling.root',value:'famx/'+root.root}]);await w.kit.pointers.move({name:seedlingName('famx',line),expected:null,next:rec.digest,by:w.admin,run:null,component:'synthetic.feeding@1'});}
 const ingest=async(bytes:Uint8Array)=>w.kit.artifacts.ingest({bytes,mediaType:'application/json',origin:{read:{object:'agile:mindmap:SYN-DOC'}},author:{user:null},provenanceType:'observed',visibility:{readers:[w.user.id],admins:true,packs:[],shareable:false},readTier:'model_readable'});
 const document=await ingest(mapBytes),meta=await ingest(Buffer.from(JSON.stringify({id:'SYN-DOC',title:'Synthetic doc',ancestors:['rel_famx_10_8'],root:{id:'synthetic-root',title:'FAMX'}})));
 let calls=0;Object.assign(w.knowledge.__context.sandbox,{onAttempt:()=>{calls++;}});
 return {...w,name,root,document,meta,calls:()=>calls,scope:{product:'famx',root:root.root,composition:root.composition,sourceRecord:document.digest,metaSource:meta.body.sha256}};
}
export async function readCapture(w:Awaited<ReturnType<typeof world>>,external:string,bytes:Uint8Array){
 const {newId}=await import('../../records/api.ts');const {ReadManifest}=await import('../../../contracts/src/resources.ts');
 const ingest=(data:Uint8Array,origin:import('../../records/api.ts').ArtifactOrigin,name:string,provenanceType:import('../../records/api.ts').IngestInput['provenanceType'])=>w.kit.artifacts.ingest({bytes:data,mediaType:'application/json',origin,name,author:{user:null},provenanceType,visibility:{readers:[w.user.id],admins:true,packs:[],shareable:false},readTier:'model_readable'});
 const original=await ingest(bytes,{read:{object:external}},'original','observed');const nested=await ingest(Buffer.from('{"synthetic_tree":true}'),{read:{object:'agile:tree:roots'}},'tree','observed');
 const origin={generated:{generator:'synthetic-agile.mindmap@1',inputs:['src:'+original.body.sha256,'src:'+nested.body.sha256]}};
 const content=await ingest(bytes,origin,'content','projected');const meta=await ingest(Buffer.from(JSON.stringify({id:'SYN-DOC',ancestors:['rel_famx_10_8'],root:{id:'synthetic-root',title:'FAMX'}})),origin,'meta','projected');const artifacts=[{name:'original',artifact:original},{name:'content',artifact:content},{name:'meta',artifact:meta}];
 const at=new Date().toISOString();const body=ReadManifest.parse({action:'read',run:null,item:null,inputs:['rec:'+original.digest,'rec:'+nested.digest],component:'connectors.read@1',lease:null,started_at:at,ended_at:at,result:'completed',error_code:null,external,revision:null,resource:newId('res'),environment:'test',system_pack:{id:'synthetic-agile',version:'1.0.0',digest:w.product.digest},read:'mindmap',principal:w.user.id,purpose:'Synthetic capture identity',requests:[],reads:[],original:null,artifacts:artifacts.map(({name,artifact})=>({name,record:artifact.digest,sha256:artifact.body.sha256,media_type:artifact.body.media_type,size:artifact.body.size})),coverage:{complete:true,examined:1,total:1},reason:null,warnings:[]});
 const manifest=await w.kit.store.put({kind:'action',schema:'read-manifest@1',provenance:'observed',body,index:artifacts.map(({artifact})=>({key:'connectors.artifact',value:artifact.digest}))});
 return {ok:true as const,id:external,revision:null,artifacts,manifest:manifest.digest,content,meta,scope:{...w.scope,sourceRecord:content.digest,metaSource:meta.body.sha256,metaRecord:meta.digest,readManifest:manifest.digest,requested:external}};
}
export async function workingPackage(w:Awaited<ReturnType<typeof world>>){const {writeProductPack}=await import('../test-support.ts');const manifest=JSON.parse(readFileSync(new URL('pack.json',famx),'utf8'));const functions:Record<string,string>=Object.fromEntries(manifest.files.filter((file:{path:string})=>file.path.startsWith('functions/')).map((file:{path:string})=>[file.path.slice(10),readFileSync(new URL(file.path,famx),'utf8')]));const current=writeProductPack(w.dir,{id:'famx',version:'1.7.4',names:['FAMX','FAMY'],functions,declaration:{...w.product.product,feeding:{...w.product.product.feeding!,project:{module:'functions/feeding.ts'}}}});w.packs.add(current);return current;}
