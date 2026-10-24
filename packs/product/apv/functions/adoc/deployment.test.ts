import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {ProducerInput} from '../../../../../contracts/src/product.ts';
import {jsonParser,textParser,markdownParser} from '../../../../../hub/refs/api.ts';
import {sha256} from './input.ts';
import {addAdocSources,adocRole,familyManual,ManualSourceError} from './deployment.ts';
const root='synthetic/10.6.1';const revision='17';
const rootId='svn:directory:'+encodeURIComponent(root);
const childId='svn:directory-at:17/'+encodeURIComponent(root+'/chapters');
const fileId=(name:string)=>'svn:file:17/'+encodeURIComponent(root+'/'+name);
const texts={'book.adoc':'\ufeff= Synthetic\r\n\r\ninclude::chapters/body.adoc[]\r\n','chapters/body.adoc':'== Synthetic section\n\n{brand} family content.\n'};
const member=(name:string,text:string)=>({name,directory:false,external:fileId(name),revision:'16',size:Buffer.byteLength(text)});
const metadata={directory:root,revision,members:[member('book.adoc',texts['book.adoc']),{name:'chapters',directory:true,external:null,revision:'15',size:null}]};
const child={directory:root+'/chapters',revision,members:[{...member('chapters/body.adoc',texts['chapters/body.adoc']),name:'body.adoc'}]};
const slot=(external:string,value:unknown,media='application/json')=>{
 const bytes=Buffer.from(typeof value==='string'?value:JSON.stringify(value));
 const parser=media==='text/plain'?textParser:jsonParser;
 return {external,sha256:sha256(bytes.toString()),media_type:media,parser:media==='text/plain'?'text@1':'json@1',model:parser.parse(bytes).model};
};
const build={name:'Rel_APV_10_6_1_9',base:'Rel_APV_10_6_1_9',family:'APV',line:'10.6.1',platform:null,built_at:null,released_at:'2026-01-01T00:00:00.000Z',sources:{tree:'site:tree:demo'},root:null};
const input=(family='APV',brand='Alpha'):ProducerInput=>({build,slots:{meta:slot(rootId,metadata),tree:null,cli:null,app:null},lists:{files:[slot(childId,child),...Object.entries(texts).map(([name,text])=>slot(fileId(name),text,'text/plain'))]},batch:{index:0,of:1},params:{family,root:'synthetic/{line}',main:'book.adoc',attributes:{[family]:{brand}}}});

test('families expand from exact UTF-8 originals and keep distinct content and original text citations',async()=>{
 const apv=await familyManual(input());const nsae=await familyManual(input('NSAE','Beta'));
 assert.ok(apv.entries.some(e=>e.statement.includes('Alpha')));assert.ok(nsae.entries.some(e=>e.statement.includes('Beta')));
 assert.ok(apv.entries.every(e=>e.path?.startsWith('/manual/cli-apv/')));assert.ok(nsae.entries.every(e=>e.path?.startsWith('/manual/cli-nsae/')));
 assert.ok(apv.entries.every(e=>e.fragments.every(f=>f.parser==='text@1'&&f.slot==='files'&&f.source&&f.selector.startsWith('l/'))));
});
test('explicit null uses Markdown; configured adoc failures never fall back to Markdown',async()=>{
 const value=input();value.params.root=null;value.slots.cli={...slot('manual:cli:10.6.1','# Synthetic\n\nMarkdown fallback.','text/plain'),parser:'markdown@1',model:markdownParser.parse(Buffer.from('# Synthetic\n\nMarkdown fallback.')).model};
 assert.ok((await familyManual(value)).entries.some(e=>e.statement.includes('Markdown fallback')));
 value.params.root='synthetic/{line}';value.slots.meta=null;
 await assert.rejects(familyManual(value),e=>e instanceof ManualSourceError&&e.code==='apv.adoc.directory_unreadable'&&e.next_action.includes('SVN'));
});
test('missing chapters, altered bytes, non-UTF-8 and different revision metadata refuse the complete group',async()=>{
 for(const edit of [
  (v:ProducerInput)=>{v.lists!.files.pop();},
  (v:ProducerInput)=>{(v.lists!.files[1].model as any).raw_utf8+='changed';},
  (v:ProducerInput)=>{delete (v.lists!.files[1].model as any).raw_utf8;},
  (v:ProducerInput)=>{(v.lists!.files[0].model as any).revision='18';},
 ]){const v=input();edit(v);await assert.rejects(familyManual(v),ManualSourceError);}
});
test('the plan pins every descendant directory to the root revision and binds complete metadata and chapter lists',()=>{
 const options={adoc:{APV:{root:'synthetic/{line}',main:'book.adoc'},NSAE:{root:null,main:'book.adoc'}}};
 const first=structuredClone(build);const wanted:string[]=[];const notes:string[]=[];
 const read:any={[rootId]:{ok:true,parser:'json@1',model:metadata}};
 addAdocSources(first,options,read,id=>wanted.push(id),notes);assert.deepEqual(wanted,[childId]);
 read[childId]={ok:true,parser:'json@1',model:child};wanted.length=0;
 addAdocSources(first,options,read,id=>wanted.push(id),notes);
 assert.deepEqual(wanted,[]);assert.deepEqual(notes,[]);
 assert.deepEqual((first.sources as any)[adocRole('APV','files')],[childId,fileId('book.adoc'),fileId('chapters/body.adoc')]);
 assert.equal((first.sources as any)[adocRole('APV','meta')],rootId);
});

test('adoc-enabled families refuse the transitional catalog with the concrete replacement action',async()=>{
 const value=input();value.slots.cli={...slot('manual:cli:10.6.1',{schema:'ist.manual-command-catalog'}),parser:'json@1'};
 await assert.rejects(familyManual(value),e=>e instanceof ManualSourceError&&e.code==='apv.adoc.catalog_reading_off'&&e.next_action.includes('adoc 文件表'));
});
test('recursive traversal refuses excessive depth and total entries rather than returning a partial group',()=>{
 const options={adoc:{APV:{root:'synthetic/{line}'},NSAE:{root:null}}};const notes:string[]=[];
 const read:any={};
 for(let depth=0;depth<=6;depth++){
  const path=root+('/nested'.repeat(depth));
  read[depth===0?rootId:'svn:directory-at:17/'+encodeURIComponent(path)]={ok:true,parser:'json@1',model:{directory:path,revision,members:[{name:'nested',directory:true,revision:'16',external:null,size:null}]}};
 }
 addAdocSources(structuredClone(build),options,read,()=>assert.fail('all directory metadata present'),notes);
 assert.ok(notes.some(n=>n.includes('深度')&&n.includes('旧根不动')));
 const many={...metadata,members:Array.from({length:513},(_,i)=>({name:'file-'+i+'.adoc',directory:false,revision:'16',external:fileId('file-'+i+'.adoc'),size:1}))};
 notes.length=0;addAdocSources(structuredClone(build),options,{[rootId]:{ok:true,parser:'json@1',model:many}},()=>{},notes);
 assert.ok(notes.some(n=>n.includes('上限')&&n.includes('不截断')));
});

test('an invalid configured root stays a production refusal instead of becoming an empty successful plan',async()=>{
 const configured={adoc:{APV:{root:'../synthetic/{line}',main:'book.adoc'},NSAE:{root:null,main:'book.adoc'}}};
 const original=structuredClone(build),notes:string[]=[];
 assert.doesNotThrow(()=>addAdocSources(original,configured,{},()=>assert.fail('invalid roots send no read request'),notes));
 assert.ok(notes.some(note=>note.includes('APV_ADOC_ROOT')&&note.includes('下一步')));
 const value=input();value.params.root=configured.adoc.APV.root;
 await assert.rejects(familyManual(value),e=>e instanceof ManualSourceError&&e.code==='apv.adoc.invalid_root');
});

test('configured adoc production refuses a missing build with a concrete recovery action',async()=>{
 for(const root of ['synthetic/{line}',null]){const value=input();value.params.root=root;delete value.build;
 await assert.rejects(familyManual(value),error=>error instanceof TypeError&&error.message.includes('缺少 build')&&error.message.includes('下一步'));}
});
