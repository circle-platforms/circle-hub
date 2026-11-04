// The moved walk gives the pre-move product module's results: on every directory fixture the repository's tests fed
// it (frozen outputs), and on generated version lines, root templates and directory trees against the original bytes
// rebuilt from testing/baseline. Only the refusal code's namespace changes, from the product's to this pack's.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {DirectorySourceError,booksOf,directoryOf,listedSources,mainsOf} from './directory.ts';
import {MIGRATION_TEST,frozenWalks,originalWalk,recorded,revive,type RecordedError} from '../testing/baseline.ts';

/** The prefix the walk's own refusals carried in the product pack before the move. */
const OLD_PREFIX='famx.adoc.';
const NEW_PREFIX='adoc-format.';
/** The layout the synthetic product pack now declares for both families (read from its product.json). */
const declaration=JSON.parse(await readFile(new URL('../../../product/famx/product.json',import.meta.url),'utf8'));
const LAYOUT=declaration.sync.options.adoc.FAMX.layout as unknown;

type Outcome={result:unknown}|{error:RecordedError};
const run=(fn:()=>unknown):Outcome=>{
 try{return {result:recorded(fn())};}
 catch(error){
  if(error instanceof Error&&typeof (error as {code?:unknown}).code==='string')return {error:{code:(error as unknown as RecordedError).code,message:error.message,next_action:(error as unknown as RecordedError).next_action}};
  throw error;
 }
};
/** A refusal the walk raised itself moves to this pack's namespace; a refusal from the caller's read is passed through. */
const moved=(error:RecordedError,passedThrough:ReadonlySet<string>):RecordedError=>passedThrough.has(error.code)?error:{...error,code:error.code.startsWith(OLD_PREFIX)?NEW_PREFIX+error.code.slice(OLD_PREFIX.length):error.code};
const expectedOf=(call:{result?:unknown;error?:RecordedError},passedThrough:ReadonlySet<string>=new Set()):Outcome=>call.error?{error:moved(call.error,passedThrough)}:{result:call.result};

const walkOf=(walk:ReturnType<typeof booksOf>)=>({walk:recorded(walk),listed:walk.groups.map(group=>listedSources(group.directory,group.tree))});

test(MIGRATION_TEST+': frozen outputs of every recorded fixture',async()=>{
 const calls=await frozenWalks();
 const kinds={directoryOf:0,mainsOf:0,booksOf:0};
 for(const call of calls){
  kinds[call.kind]++;
  if(call.kind==='directoryOf'){
   const label=`directoryOf(${JSON.stringify(call.root)}, ${call.line})`;
   const root=revive(call.root);
   assert.deepEqual(run(()=>directoryOf(root,call.line,LAYOUT)),expectedOf(call),label);
   // A template without {line_dir} needs no layout, so a producer that declares none keeps its directory.
   if(typeof root!=='string'||!root.includes('{line_dir}'))assert.deepEqual(run(()=>directoryOf(root,call.line)),expectedOf(call),label+' without a layout');
  }else if(call.kind==='mainsOf'){
   assert.deepEqual(run(()=>mainsOf(revive(call.cli),revive(call.app))),expectedOf(call),`mainsOf(${JSON.stringify(call.cli)}, ${JSON.stringify(call.app)})`);
  }else{
   const asked:string[]=[];const thrown=new Set<string>();
   const read=(id:string):unknown=>{
    asked.push(id);
    assert.ok(Object.hasOwn(call.reads,id),`booksOf(${call.root}) asked for ${id}, which the original walk never read`);
    const value=call.reads[id] as {__throws?:RecordedError};
    if(value!==null&&typeof value==='object'&&value.__throws){thrown.add(value.__throws.code);throw new DirectorySourceError(value.__throws.code,value.__throws.message.slice(0,value.__throws.message.lastIndexOf('；下一步：')),value.__throws.next_action);}
    return revive(value);
   };
   const actual=run(()=>walkOf(booksOf(call.root,revive(call.mains) as never,read)));
   const expected=call.error?{error:moved(call.error,thrown)}:{result:{walk:call.result,listed:call.listed}};
   assert.deepEqual(actual,expected,`booksOf(${call.root}, ${JSON.stringify(call.mains)})`);
   assert.deepEqual(new Set(asked),new Set(Object.keys(call.reads)),`booksOf(${call.root}) reads the same external ids`);
  }
 }
 // The frozen corpus covers every kind of call, including refusals.
 assert.ok(kinds.directoryOf>0&&kinds.mainsOf>0&&kinds.booksOf>0,JSON.stringify(kinds));
 assert.ok(calls.some(call=>call.error),'the corpus holds refusals');
 assert.ok(calls.some(call=>call.kind==='directoryOf'&&typeof call.root==='string'&&call.root.includes('{line_dir}')&&call.result),'the corpus holds a {line_dir} expansion');
});

test(MIGRATION_TEST+': the rebuilt original module reproduces the frozen outputs',async t=>{
 const baseline=await originalWalk();t.after(()=>baseline.close());
 const old=baseline.walk;
 const oldRun=(fn:()=>unknown):Outcome=>{try{return {result:recorded(fn())};}catch(error){if(error instanceof old.ManualSourceError)return {error:{code:error.code,message:error.message,next_action:error.next_action}};throw error;}};
 for(const call of await frozenWalks()){
  if(call.kind==='directoryOf')assert.deepEqual(oldRun(()=>old.directoryOf(revive(call.root),call.line)),expectedOf(call,new Set([call.error?.code??''])));
  else if(call.kind==='mainsOf')assert.deepEqual(oldRun(()=>old.mainsOf(revive(call.cli),revive(call.app))),expectedOf(call,new Set([call.error?.code??''])));
  else{
   const read=(id:string):unknown=>{const value=call.reads[id] as {__throws?:RecordedError};if(value!==null&&typeof value==='object'&&value.__throws)throw new old.ManualSourceError(...[value.__throws.code,value.__throws.message.slice(0,value.__throws.message.lastIndexOf('；下一步：')),value.__throws.next_action] as never[]);return revive(value);};
   const actual=oldRun(()=>{const walk=old.booksOf(call.root,revive(call.mains) as never,read);return {walk:recorded(walk),listed:walk.groups.map(group=>old.listedSources(group.directory,group.tree as never))};});
   assert.deepEqual(actual,call.error?{error:call.error}:{result:{walk:call.result,listed:call.listed}});
  }
 }
});

test(MIGRATION_TEST+': group bounds at and one past each limit against the original bytes',async t=>{
 const baseline=await originalWalk();t.after(()=>baseline.close());
 const old=baseline.walk;
 const oldRun=(fn:()=>unknown):Outcome=>{try{return {result:recorded(fn())};}catch(error){if(error instanceof old.ManualSourceError)return {error:moved({code:error.code,message:error.message,next_action:error.next_action},new Set())};throw error;}};
 const root='synthetic/10.8';const revision='17';
 /** A tree from relative directory paths to their file names; every directory listed is read. */
 const tree=(dirs:Record<string,string[]>):Map<string,unknown>=>{
  const docs=new Map<string,unknown>();
  for(const [rel,files] of Object.entries(dirs)){
   const path=rel?`${root}/${rel}`:root;
   const children=Object.keys(dirs).filter(other=>other!==''&&(other.includes('/')?other.slice(0,other.lastIndexOf('/')):'')===rel).map(other=>({name:other.slice(other.lastIndexOf('/')+1),directory:true,external:null,revision,size:null}));
   const members=[...children,...files.map(name=>({name,directory:false,external:'svn:file:'+revision+'/'+encodeURIComponent(path+'/'+name),revision,size:1}))];
   docs.set(rel?'svn:directory-at:'+revision+'/'+encodeURIComponent(path):'svn:directory:'+encodeURIComponent(root),{directory:path,revision,members});
  }
  return docs;
 };
 const names=(count:number,suffix:string,prefix='f')=>Array.from({length:count},(_,i)=>`${prefix}${i}${suffix}`);
 const chain=(depth:number)=>Object.fromEntries(Array.from({length:depth+1},(_,i)=>[Array.from({length:i},(_,j)=>'d'+j).join('/'),i===depth?['book.adoc','app.adoc']:[]]));
 const fixtures:Record<string,Record<string,string[]>>={
  'entries at the bound':{'':['book.adoc','app.adoc'],a:names(254,'.png'),b:names(254,'.png')},
  'entries one past the bound':{'':['book.adoc','app.adoc'],a:names(255,'.png'),b:names(254,'.png')},
  'members at the bound':{'':['book.adoc','app.adoc',...names(510,'.png')]},
  'members one past the bound':{'':['book.adoc','app.adoc',...names(511,'.png')]},
  'files at the bound':{'':['book.adoc','app.adoc',...names(126,'.adoc')]},
  'files one past the bound':{'':['book.adoc','app.adoc',...names(127,'.adoc')]},
  'depth at the bound':chain(5),
  'depth one past the bound':chain(6),
  'directories at the bound':{'':['book.adoc','app.adoc'],...Object.fromEntries(names(31,'','d').map(name=>[name,[]]))},
  'directories one past the bound':{'':['book.adoc','app.adoc'],...Object.fromEntries(names(32,'','d').map(name=>[name,[]]))},
 };
 const outcomes=new Set<string>();
 for(const [label,dirs] of Object.entries(fixtures)){
  const docs=tree(dirs);const read=(id:string):unknown=>structuredClone(docs.get(id));
  for(const mains of [null,{cli:'book.adoc',app:'app.adoc'}]){
   const actual=run(()=>walkOf(booksOf(root,mains,read)));
   assert.deepEqual(actual,oldRun(()=>{const walk=old.booksOf(root,mains,read);return {walk:recorded(walk),listed:walk.groups.map(group=>old.listedSources(group.directory,group.tree as never))};}),label);
   outcomes.add(`${label}: ${'error' in actual?actual.error.code:'walked'}`);
  }
 }
 // Each pair walks at the bound and refuses one past it.
 for(const label of Object.keys(fixtures))assert.ok(outcomes.has(`${label}: ${label.includes('past')?NEW_PREFIX+'group_budget':'walked'}`),[...outcomes].join('\n'));
});

/** A small deterministic generator, so a failure names a reproducible case. */
function prng(seed:number):()=>number{let s=seed>>>0;return ()=>{s=(s+0x6d2b79f5)>>>0;let x=s;x=Math.imul(x^(x>>>15),x|1);x^=x+Math.imul(x^(x>>>7),x|61);return ((x^(x>>>14))>>>0)/4294967296;};}

test(MIGRATION_TEST+': generated lines and root templates against the original bytes',async t=>{
 const baseline=await originalWalk();t.after(()=>baseline.close());
 const old=baseline.walk;
 const oldRun=(fn:()=>unknown):Outcome=>{try{return {result:recorded(fn())};}catch(error){if(error instanceof old.ManualSourceError)return {error:moved({code:error.code,message:error.message,next_action:error.next_action},new Set())};throw error;}};
 const parts=['0','00','000','1','01','5','8','08','10','0010','123456789','1234567890','','a','-1',' 1'];
 const lines=new Set<string>(['10.8-extra','10..8','.10','10.','1.2.3.4','10.5.0.0','v10.5','10,5','１０.５']);
 for(const a of parts){lines.add(a);for(const b of parts){lines.add(`${a}.${b}`);for(const c of ['0','2','00','10','x'])lines.add(`${a}.${b}.${c}`);}}
 const roots:unknown[]=['m/{line}','m/{line_dir}','m/{line_dir}/{line}','m/{line}x{line_dir}/cli','{line_dir}','{line}','../m/{line}','/abs/{line_dir}','m','m/{x}/{line}','m/{line_dir}?','m//{line}','m/./{line}','m/{line}/..','m/{line}#a','m/{line};b','m/{line}\\c',null,42,undefined,['m/{line}']];
 let compared=0;
 for(const root of roots)for(const line of lines){
  assert.deepEqual(run(()=>directoryOf(root,line,LAYOUT)),oldRun(()=>old.directoryOf(root,line)),`directoryOf(${JSON.stringify(root)}, ${JSON.stringify(line)})`);
  compared++;
 }
 assert.ok(compared>8000,String(compared));
});

test(MIGRATION_TEST+': generated directory trees and main paths against the original bytes',async t=>{
 const baseline=await originalWalk();t.after(()=>baseline.close());
 const old=baseline.walk;
 const oldRun=(fn:()=>unknown):Outcome=>{try{return {result:recorded(fn())};}catch(error){if(error instanceof old.ManualSourceError)return {error:moved({code:error.code,message:error.message,next_action:error.next_action},new Set())};throw error;}};
 const mainChoices:unknown[][]=[[undefined,undefined],['book.adoc','app.adoc'],['cli/book.adoc','app/app.adoc'],['cli/book.adoc','cli/app.adoc'],['books/cli/book.adoc','books/app/app.adoc'],['book.adoc','app/app.adoc'],['missing/book.adoc','app/app.adoc'],['cli/book.txt','app/app.adoc'],['../book.adoc','app.adoc'],['cli/book.adoc',7],['d0/d1/book.adoc','d0/app.adoc']];
 const random=prng(20261104);
 const pick=<T>(items:readonly T[]):T=>items[Math.floor(random()*items.length)];
 let cases=0;
 for(let n=0;n<600;n++){
  const root='synthetic/10.'+(6+n%4);const revision=String(10+(n%5));
  const docs=new Map<string,unknown>();
  // A random directory tree: depth up to 7 (over the bound), some directories wide enough to break the group budget.
  const build=(path:string,depth:number,rel:string):void=>{
   const members:unknown[]=[];
   const width=random()<0.03?140:Math.floor(random()*5);
   const names=new Set<string>();
   for(let i=0;i<width;i++){
    const directory=depth<7&&random()<(width>20?0:0.35);
    const base=directory?pick(['cli','app','books','d0','d1','images','old','chapters']):pick(['book','app','body','intro','x'+i])+pick(['.adoc','.adoc','.adoc','.png','.txt']);
    const name=names.has(base)?base+'-'+i:base;names.add(name);
    const memberRevision=random()<0.02?String(Number(revision)+1):String(Math.max(1,Number(revision)-Math.floor(random()*3)));
    const external=directory?null:random()<0.02?'svn:file:1/elsewhere':'svn:file:'+revision+'/'+encodeURIComponent(path+'/'+name);
    members.push({name,directory,external,revision:memberRevision,size:directory?null:random()<0.02?-1:Math.floor(random()*900)});
    if(directory)build(path+'/'+name,depth+1,rel?rel+'/'+name:name);
   }
   const id=rel===''?'svn:directory:'+encodeURIComponent(root):'svn:directory-at:'+revision+'/'+encodeURIComponent(path);
   const doc:Record<string,unknown>={directory:random()<0.01?path+'x':path,revision:random()<0.01&&rel!==''?String(Number(revision)+1):revision,members};
   if(random()<0.08&&rel!=='')return; // never read: the walk names it as pending
   docs.set(id,doc);
  };
  build(root,0,'');
  // The fixed-revision root listing of a nested book is asked for by its pinned id as well.
  const pinned='svn:directory-at:'+revision+'/'+encodeURIComponent(root);
  if(docs.has('svn:directory:'+encodeURIComponent(root))&&random()<0.5)docs.set(pinned,docs.get('svn:directory:'+encodeURIComponent(root)));
  const read=(id:string):unknown=>structuredClone(docs.get(id));
  const [cli,app]=pick(mainChoices);
  const label=`case ${n}: ${root} mains ${JSON.stringify([cli,app])}`;
  const mains=run(()=>mainsOf(cli,app));
  assert.deepEqual(mains,oldRun(()=>old.mainsOf(cli,app)),label);
  if('error' in mains)continue;
  const named=mains.result as {cli:string;app:string}|null;
  assert.deepEqual(run(()=>walkOf(booksOf(root,named,read))),oldRun(()=>{const walk=old.booksOf(root,named,read);return {walk:recorded(walk),listed:walk.groups.map(group=>old.listedSources(group.directory,group.tree as never))};}),label);
  cases++;
 }
 assert.ok(cases>400,String(cases));
});
