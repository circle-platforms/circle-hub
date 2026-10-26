import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {ProducerInput} from '../../../../../contracts/src/product.ts';
import {jsonParser,textParser,markdownParser,xmlParser} from '../../../../../hub/refs/api.ts';
import {sha256} from './input.ts';
import {addAdocSources,adocRole,familyManual,ManualSourceError,directoryOf} from './deployment.ts';
const root='synthetic/10.8.1';const revision='17';
const rootId='svn:directory:'+encodeURIComponent(root);
const childId='svn:directory-at:17/'+encodeURIComponent(root+'/chapters');
const fileId=(name:string)=>'svn:file:17/'+encodeURIComponent(root+'/'+name);
const texts={'app.adoc':'= Synthetic APP\n\n== Application\n\n{brand} APP content.\n','book.adoc':'\ufeff= Synthetic\r\n\r\ninclude::chapters/body.adoc[]\r\n','chapters/body.adoc':'== Synthetic section\n\n{brand} family content.\n'};
const member=(name:string,text:string)=>({name,directory:false,external:fileId(name),revision:'16',size:Buffer.byteLength(text)});
const metadata={directory:root,revision,members:[member('book.adoc',texts['book.adoc']),member('app.adoc',texts['app.adoc']),{name:'chapters',directory:true,external:null,revision:'15',size:null}]};
const child={directory:root+'/chapters',revision,members:[{...member('chapters/body.adoc',texts['chapters/body.adoc']),name:'body.adoc'}]};
const slot=(external:string,value:unknown,media='application/json')=>{
 const bytes=Buffer.from(typeof value==='string'?value:JSON.stringify(value));
 const parser=media==='text/plain'?textParser:jsonParser;
 return {external,sha256:sha256(bytes.toString()),media_type:media,parser:media==='text/plain'?'text@1':'json@1',model:parser.parse(bytes).model};
};
const build={name:'Rel_FAMX-ZX-U_10_8_1_901',base:'Rel_FAMX-ZX-U_10_8_1_901',family:'FAMX',line:'10.8.1',platform:'zx-u',built_at:null,released_at:'2026-01-01T00:00:00.000Z',sources:{tree:'site:tree:demo'},root:null};
const input=(family='FAMX',brand='Alpha'):ProducerInput=>({build,slots:{meta:slot(rootId,metadata),tree:null,cli:null,app:null},lists:{files:[slot(childId,child),...Object.entries(texts).map(([name,text])=>slot(fileId(name),text,'text/plain'))]},batch:{index:0,of:1},params:{family,root:'synthetic/{line}',main:'book.adoc',app_main:'app.adoc',attributes:{[family]:{brand}}}});

test('families expand from exact UTF-8 originals and keep distinct content and original text citations',async()=>{
 const famx=await familyManual(input());const famy=await familyManual(input('FAMY','Beta'));
 assert.ok(famx.entries.some(e=>e.statement.includes('Alpha')));assert.ok(famy.entries.some(e=>e.statement.includes('Beta')));
 assert.deepEqual(new Set(famx.entries.map(entry=>entry.data.manual_name)),new Set(['cli-famx','app-famx']));
 assert.deepEqual(new Set(famy.entries.map(entry=>entry.data.manual_name)),new Set(['cli-famy','app-famy']));
 assert.ok(famx.entries.every(e=>e.path?.startsWith('/manual/cli-famx/')||e.path?.startsWith('/manual/app-famx/')));assert.ok(famy.entries.every(e=>e.path?.startsWith('/manual/cli-famy/')||e.path?.startsWith('/manual/app-famy/')));
 assert.ok(famx.entries.every(e=>e.fragments.every(f=>f.parser==='text@1'&&f.slot==='files'&&f.source&&f.selector.startsWith('l/'))));
});
test('explicit null uses Markdown; configured adoc failures never fall back to Markdown',async()=>{
 const value=input();value.params.root=null;value.slots.cli={...slot('manual:cli:10.8.1','# Synthetic\n\nMarkdown fallback.','text/plain'),parser:'markdown@1',model:markdownParser.parse(Buffer.from('# Synthetic\n\nMarkdown fallback.')).model};
 assert.ok((await familyManual(value)).entries.some(e=>e.statement.includes('Markdown fallback')));
 value.params.root='synthetic/{line}';value.slots.meta=null;
 await assert.rejects(familyManual(value),e=>e instanceof ManualSourceError&&e.code==='famx.adoc.directory_unreadable'&&e.next_action.includes('SVN'));
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
 const options={adoc:{FAMX:{root:'synthetic/{line}',main:'book.adoc'},FAMY:{root:null,main:'book.adoc'}}};
 const first=structuredClone(build);const wanted:string[]=[];const notes:string[]=[];
 const read:any={[rootId]:{ok:true,parser:'json@1',model:metadata}};
 addAdocSources(first,options,read,id=>wanted.push(id),notes);assert.deepEqual(wanted,[childId]);
 read[childId]={ok:true,parser:'json@1',model:child};wanted.length=0;
 addAdocSources(first,options,read,id=>wanted.push(id),notes);
 assert.deepEqual(wanted,[]);assert.deepEqual(notes,[]);
 assert.deepEqual((first.sources as any)[adocRole('FAMX','files')],[childId,fileId('book.adoc'),fileId('app.adoc'),fileId('chapters/body.adoc')]);
 assert.equal((first.sources as any)[adocRole('FAMX','meta')],rootId);
});

test('adoc-enabled families refuse the transitional catalog with the concrete replacement action',async()=>{
 const value=input();value.slots.cli={...slot('manual:cli:10.8.1',{schema:'ist.manual-command-catalog'}),parser:'json@1'};
 await assert.rejects(familyManual(value),e=>e instanceof ManualSourceError&&e.code==='famx.adoc.catalog_reading_off'&&e.next_action.includes('adoc 文件表'));
});
test('recursive traversal refuses excessive depth and total entries rather than returning a partial group',()=>{
 const options={adoc:{FAMX:{root:'synthetic/{line}'},FAMY:{root:null}}};const notes:string[]=[];
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
 const configured={adoc:{FAMX:{root:'../synthetic/{line}',main:'book.adoc'},FAMY:{root:null,main:'book.adoc'}}};
 const original=structuredClone(build),notes:string[]=[];
 assert.doesNotThrow(()=>addAdocSources(original,configured,{},()=>assert.fail('invalid roots send no read request'),notes));
 assert.ok(notes.some(note=>note.includes('FAMX_ADOC_ROOT')&&note.includes('下一步')));
 const value=input();value.params.root=configured.adoc.FAMX.root;
 await assert.rejects(familyManual(value),e=>e instanceof ManualSourceError&&e.code==='famx.adoc.invalid_root');
});

test('configured adoc production refuses a missing build with a concrete recovery action',async()=>{
 for(const root of ['synthetic/{line}',null]){const value=input();value.params.root=root;delete value.build;
 await assert.rejects(familyManual(value),error=>error instanceof TypeError&&error.message.includes('缺少 build')&&error.message.includes('下一步'));}
});

test('family deployment forwards closed vocabularies without inferring applicability scopes from prose',async()=>{
 for(const family of ['FAMX','FAMY']){
  const value=input(family);
  const body='== Outer 装有 Card-A 时\n\n需要 Permit-A 许可。适用于 Form-A 部署形态。\n\n=== Inner\n\n普通正文。\n';
  value.params.components=['Card-A'];value.params.licenses=['Permit-A'];value.params.deployment_forms=['Form-A'];
  value.lists!.files=value.lists!.files!.map(part=>part.external===fileId('chapters/body.adoc')?slot(part.external,body,'text/plain'):part.external===childId?slot(childId,{...child,members:[{...child.members[0],size:Buffer.byteLength(body)}]}):part);
  const out=await familyManual(value);
  const entry=out.entries.find(row=>row.statement==='普通正文。')!;assert.ok(entry);
  assert.equal(entry.applicability,null,'prose and a supplied vocabulary do not declare applicability');
  assert.equal((entry.data.applicability_state as any).declaration_status,'undeclared');
  assert.deepEqual(entry.fragments.map(fragment=>fragment.selector),['l/7']);
 }
});

test('line directory spelling follows declared decimal components while line preserves its original value',()=>{
 assert.equal(directoryOf('manual/{line}/cli','10.8'),'manual/10.8/cli');
 assert.equal(directoryOf('manual/{line_dir}/cli','10.8'),'manual/10_8_0/cli');
 assert.equal(directoryOf('manual/{line_dir}/app','10.8.2'),'manual/10_8_2/app');
 assert.equal(directoryOf('manual/{line_dir}','0010.008.000'),'manual/10_8_0');
 assert.equal(directoryOf('manual/{line_dir}','10'),'manual/10_0_0');
 assert.equal(directoryOf('manual/{line}','0010.008.000'),'manual/0010.008.000');
 assert.throws(()=>directoryOf('manual/{line_dir}','10.8-extra'),ManualSourceError);
});
test('CLI and APP use the same single family flag, webfonts policy and optional overseas flag with byte-identical repeated output',async()=>{
 const value=input();value.params.attributes={FAMX:{famA:true,overseas:true,webfonts:false}};
 const xml='<commands><scope type="global"><menu name="demo"><menu name="pool"><item name="add"><arguments><arg name="pool_name" type="STRING" optional="NO"/><arg name="weight" type="U16" optional="YES"/></arguments></item></menu></menu></scope></commands>';
 value.slots.tree={external:'site:tree:synthetic',sha256:sha256(xml),media_type:'application/xml',parser:'xml@1',model:xmlParser.parse(Buffer.from(xml)).model};
 const sources={...texts,'book.adoc':'= CLI\n\nifdef::famA[]\nCLI family A.\n\n*demo pool add* _<pool_name> [weight]_\nendif::[]\n\nifdef::webfonts[]\nNot retained.\nendif::[]\n','app.adoc':'= APP\n\nifdef::famA[]\nAPP family A.\nendif::[]\n\nifdef::overseas[]\nAPP overseas.\nendif::[]\n'};
 value.slots.meta=slot(rootId,{...metadata,members:metadata.members.map(member=>member.directory?member:{...member,size:Buffer.byteLength(sources[member.name as keyof typeof sources])})});
 value.lists!.files=value.lists!.files!.map(file=>{const name=Object.keys(sources).find(name=>file.external===fileId(name));return name?slot(file.external!,sources[name as keyof typeof sources],'text/plain'):file;});
 const first=await familyManual(value),second=await familyManual(value);assert.equal(JSON.stringify(first),JSON.stringify(second));
 assert.ok(first.entries.some(entry=>entry.path?.startsWith('/manual/cli-famx')&&entry.statement==='CLI family A.'));
 assert.ok(first.entries.some(entry=>entry.path?.startsWith('/manual/app-famx')&&entry.statement==='APP family A.'));
 assert.ok(first.entries.some(entry=>entry.statement==='APP overseas.'));assert.ok(!first.entries.some(entry=>entry.statement==='Not retained.'));
 const definition=first.entries.find(entry=>entry.kind==='definition')!;assert.ok(definition);assert.equal(definition.path,'/commands/demo/pool/add');assert.equal(definition.data.parameters_verified,true);assert.ok(JSON.stringify(definition.data.parameter_authorities).includes('src:'+sha256(xml)+'/xml@1/'));
 const extraBrand=structuredClone(value);extraBrand.params.attributes={FAMX:{famA:true},FAMY:{famB:true}};await assert.rejects(familyManual(extraBrand),error=>error instanceof ManualSourceError&&error.code==='famx.adoc.family_not_a_name');
 const incomplete=structuredClone(value);incomplete.params.app_main='missing.adoc';await assert.rejects(familyManual(incomplete),error=>error instanceof ManualSourceError&&error.code==='famx.adoc.missing_main');
});

test('each book is its main-file directory, and sibling directories are unread even when one would exceed the file limit',async()=>{
 const base='synthetic/10.8.1',revision='17',rootListing='svn:directory:'+encodeURIComponent(base);
 const atDir=(path:string)=>'svn:directory-at:17/'+encodeURIComponent(path);
 const atFile=(path:string)=>'svn:file:17/'+encodeURIComponent(path);
 const cli=base+'/cli',app=base+'/app',chapters=cli+'/chapters',wide=base+'/wide';
 const texts={'book.adoc':'= CLI\n\ninclude::chapters/body.adoc[]\n','chapters/body.adoc':'== Chapter\n\nCLI chapter.\n','app.adoc':'= APP\n\nAPP page.\n'};
 const fileMember=(directory:string,name:string,text:string)=>({name,directory:false,external:atFile(directory+'/'+name),revision:'16',size:Buffer.byteLength(text)});
 const dirMember=(name:string)=>({name,directory:true,external:null,revision:'16',size:null});
 const meta={directory:base,revision,members:[dirMember('cli'),dirMember('app'),dirMember('notes'),dirMember('pictures'),dirMember('wide')]};
 const cliDoc={directory:cli,revision,members:[fileMember(cli,'book.adoc',texts['book.adoc']),dirMember('chapters')]};
 const chaptersDoc={directory:chapters,revision,members:[fileMember(chapters,'body.adoc',texts['chapters/body.adoc'])]};
 const appDoc={directory:app,revision,members:[fileMember(app,'app.adoc',texts['app.adoc'])]};
 const wideDoc={directory:wide,revision,members:Array.from({length:129},(_,i)=>fileMember(wide,`w${i}.adoc`,'x'))};
 const models:Record<string,unknown>={[rootListing]:meta,[atDir(cli)]:cliDoc,[atDir(chapters)]:chaptersDoc,[atDir(app)]:appDoc,[atDir(wide)]:wideDoc};
 const ready=new Set([rootListing,atDir(wide)]);const asked:string[]=[];
 const read=new Proxy({},{get(_target,prop){if(typeof prop!=='string'||!prop.startsWith('svn:'))return undefined;asked.push(prop);if(!ready.has(prop))return undefined;const model=models[prop];return model===undefined?undefined:{ok:true,parser:'json@1',model};}}) as Record<string,{ok:boolean;parser:string;model:unknown}>;
 const options={adoc:{FAMX:{root:'synthetic/{line}',main:'cli/book.adoc',app_main:'app/app.adoc'},FAMY:{root:null,main:'book.adoc',app_main:'app.adoc'}}};
 const notes:string[]=[];const wanted:string[]=[];
 const planned=structuredClone(build);
 addAdocSources(planned,options,read,id=>wanted.push(id),notes);
 assert.deepEqual(notes,[]);assert.deepEqual(wanted,[atDir(cli),atDir(app)]);assert.equal(asked.includes(atDir(wide)),false);
 ready.add(atDir(cli));ready.add(atDir(app));wanted.length=0;
 addAdocSources(planned,options,read,id=>wanted.push(id),notes);
 assert.deepEqual(wanted,[atDir(chapters)]);
 ready.add(atDir(chapters));wanted.length=0;
 addAdocSources(planned,options,read,id=>wanted.push(id),notes);
 assert.deepEqual(wanted,[]);assert.equal(asked.includes(atDir(wide)),false);
 assert.deepEqual((planned.sources as Record<string,unknown>)[adocRole('FAMX','files')],[atDir(cli),atDir(chapters),atFile(cli+'/book.adoc'),atFile(chapters+'/body.adoc'),atDir(app),atFile(app+'/app.adoc')]);
 const value:ProducerInput={build,slots:{meta:slot(rootListing,meta),tree:null,cli:null,app:null},lists:{files:[slot(atDir(cli),cliDoc),slot(atDir(chapters),chaptersDoc),slot(atDir(app),appDoc),slot(atFile(cli+'/book.adoc'),texts['book.adoc'],'text/plain'),slot(atFile(chapters+'/body.adoc'),texts['chapters/body.adoc'],'text/plain'),slot(atFile(app+'/app.adoc'),texts['app.adoc'],'text/plain')]},batch:{index:0,of:1},params:{family:'FAMX',root:'synthetic/{line}',main:'cli/book.adoc',app_main:'app/app.adoc',attributes:{FAMX:{brand:'Alpha'}}}};
 const first=await familyManual(value),second=await familyManual(value);
 assert.equal(JSON.stringify(first),JSON.stringify(second));
 assert.ok(first.entries.some(entry=>entry.statement==='CLI chapter.'));
 assert.ok(first.entries.some(entry=>entry.statement==='APP page.'));
 assert.deepEqual(first.warnings.filter(warning=>warning.endsWith('未读：不在任何主文件目录内')),['notes 未读：不在任何主文件目录内','pictures 未读：不在任何主文件目录内','wide 未读：不在任何主文件目录内']);
 const composition=JSON.parse(first.warnings.find(warning=>warning.startsWith('名称族 FAMX / cli：组成 '))!.slice('名称族 FAMX / cli：组成 '.length));
 assert.equal(composition.directory,cli);assert.equal(composition.revision,'17');
 assert.deepEqual(composition.files,[{file:'book.adoc',sha256:sha256(texts['book.adoc'])},{file:'chapters/body.adoc',sha256:sha256(texts['chapters/body.adoc'])}]);
 const appComposition=JSON.parse(first.warnings.find(warning=>warning.startsWith('名称族 FAMX / app：组成 '))!.slice('名称族 FAMX / app：组成 '.length));
 assert.equal(appComposition.directory,app);assert.equal(appComposition.revision,'17');
 assert.deepEqual(appComposition.files,[{file:'app.adoc',sha256:sha256(texts['app.adoc'])}]);
 const missing=structuredClone(value);missing.lists!.files=missing.lists!.files.filter(file=>file.external!==atFile(chapters+'/body.adoc'));
 await assert.rejects(familyManual(missing),error=>error instanceof ManualSourceError&&error.code==='famx.adoc.incomplete_group');
});

test('a single book directory still stops at the existing adoc file limit',()=>{
 const base='synthetic/10.8.1',revision='17',rootListing='svn:directory:'+encodeURIComponent(base);
 const atDir=(path:string)=>'svn:directory-at:17/'+encodeURIComponent(path);
 const atFile=(path:string)=>'svn:file:17/'+encodeURIComponent(path);
 const cli=base+'/cli',app=base+'/app';
 const fileMember=(directory:string,name:string)=>({name,directory:false,external:atFile(directory+'/'+name),revision:'16',size:1});
 const dirMember=(name:string)=>({name,directory:true,external:null,revision:'16',size:null});
 const meta={directory:base,revision,members:[dirMember('cli'),dirMember('app')]};
 const cliDoc={directory:cli,revision,members:Array.from({length:129},(_,i)=>fileMember(cli,`w${i}.adoc`))};
 const appDoc={directory:app,revision,members:[fileMember(app,'app.adoc')]};
 const read:Record<string,{ok:boolean;parser:string;model:unknown}>={[rootListing]:{ok:true,parser:'json@1',model:meta},[atDir(cli)]:{ok:true,parser:'json@1',model:cliDoc},[atDir(app)]:{ok:true,parser:'json@1',model:appDoc}};
 const notes:string[]=[];
 addAdocSources(structuredClone(build),{adoc:{FAMX:{root:'synthetic/{line}',main:'cli/w0.adoc',app_main:'app/app.adoc'},FAMY:{root:null}}},read,()=>{},notes);
 assert.ok(notes.some(note=>note.includes('adoc 文件数超过上限')&&note.includes('不截断')&&note.includes('旧根不动')));
});
