// The pre-move walk is frozen as test data: the product pack's original module bytes (with their SHA-256 list) and the
// outputs it gave for every directory fixture the repository's tests fed it. Nothing here is a pack file.
//
// walks.jsonl holds one call per line: `kind` (directoryOf, mainsOf or booksOf), the inputs, and either `result` or
// `error` ({code, message, next_action}). A booksOf line also holds `reads` (each external id the walk asked for and the
// value it got; `{__throws: error}` when the caller's read refused) and `listed` (listedSources of each group). Values
// are JSON with `undefined` written as "__undefined__" and a Map as {__map: [[key, value], ...]}. The calls were recorded
// at commit 63e15782 by running packs/product/famx/**/*.test.ts, hub/knowledge/seed.test.ts and
// scripts/diagnostics/seed-lists-repro.test.ts against the original module, then deduplicated.
// trees.json holds, per production fixture of testing/production.ts, the tree root digest, the composition's entry
// digests and the bound sources the same harness produced at that commit.
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';

export const MIGRATION_TEST='adoc-format migration equivalence across the repository directory fixtures';
/** The product pack module the walk moved out of, relative to the rebuilt tree. */
const ORIGINAL='packs/product/famx/functions/adoc/tree.ts';

export interface RecordedError {code:string;message:string;next_action:string}
export type RecordedCall=
 |{kind:'directoryOf';root:unknown;line:string;result?:unknown;error?:RecordedError}
 |{kind:'mainsOf';cli:unknown;app:unknown;result?:unknown;error?:RecordedError}
 |{kind:'booksOf';root:string;mains:unknown;reads:Record<string,unknown>;result?:unknown;listed?:string[][];error?:RecordedError};

/** The JSON form of a value as the recorder wrote it. */
export const recorded=(value:unknown):unknown=>JSON.parse(JSON.stringify(value,(_key,v)=>v===undefined?'__undefined__':v instanceof Map?{__map:[...v.entries()]}:v));
/** A recorded value back as the walk saw it. */
export const revive=(value:unknown):unknown=>value==='__undefined__'?undefined:JSON.parse(JSON.stringify(value),(_key,v)=>v==='__undefined__'?undefined:v);

export async function frozenWalks():Promise<RecordedCall[]>{
 const text=await readFile(new URL('./baseline/walks.jsonl',import.meta.url),'utf8');
 return text.split('\n').filter(Boolean).map(line=>JSON.parse(line) as RecordedCall);
}

export async function frozenTrees():Promise<Record<string,{root:string;entries:string[];sources:{external:string;sha256:string;parser:string|null}[]}>>{
 return JSON.parse(await readFile(new URL('./baseline/trees.json',import.meta.url),'utf8'));
}

export interface OriginalWalk {
 ManualSourceError:new (...args:never[])=>Error&{code:string;next_action:string};
 directoryOf(root:unknown,line:string):string|null;
 mainsOf(cli:unknown,app:unknown):{cli:string;app:string}|null;
 booksOf(root:string,mains:{cli:string;app:string}|null,read:(id:string)=>unknown):{groups:{directory:string;tree:unknown}[]}&Record<string,unknown>;
 listedSources(root:string,tree:never):string[];
}

/** Rebuild the original module from its verified bytes in a temporary directory and load it. */
export async function originalWalk():Promise<{walk:OriginalWalk;close:()=>Promise<void>}>{
 const root=await mkdtemp(join(tmpdir(),'adoc-format-baseline-'));
 try{
  const manifest=JSON.parse(await readFile(new URL('./baseline/manifest.json',import.meta.url),'utf8')) as {files:{path:string;sha256:string;size:number}[]};
  for(const row of manifest.files){
   const bytes=await readFile(new URL('./baseline/'+row.path+'.txt',import.meta.url));
   if(createHash('sha256').update(bytes).digest('hex')!==row.sha256||bytes.length!==row.size)throw new Error('pre-move baseline bytes changed: '+row.path);
   const path=join(root,row.path);
   await mkdir(dirname(path),{recursive:true});
   await writeFile(path,bytes);
  }
  await writeFile(join(root,'package.json'),'{"type":"module"}');
  const walk=await import(pathToFileURL(join(root,ORIGINAL)).href) as OriginalWalk;
  return {walk,close:()=>rm(root,{recursive:true,force:true})};
 }catch(error){await rm(root,{recursive:true,force:true});throw error;}
}
