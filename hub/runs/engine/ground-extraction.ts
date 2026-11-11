// Which grounds a value names: a pure reading of its content, apart from the decision of who may read them (grounds.ts).
// A leaf module, so the summary of a result can be projected where the result is stored.
import { Ground } from '../../../contracts/src/reference.ts';
import type { RunRecord } from '../../../contracts/src/run.ts';
import { ValidationResult } from '../../../contracts/src/validation.ts';
import { verifiedBodyDigest } from '../../records/api.ts';
import { parseReference } from '../../refs/api.ts';

/**
 * What a stored record names as grounds depends on its content alone, and its digest stands for that content: the store
 * verified the body against it when it read the record. A page that lists a hundred tasks asked for the same extraction of
 * every result on each load, a full parse and two walks of a result each time (issue 200). The extraction of a verified body
 * is kept by its digest; whether a reader may read each ground is still decided on every call.
 */
const EXTRACTED_LIMIT=2048;
const extracted=new Map<string,readonly string[]>();
function remembered(key:string|undefined,compute:()=>string[]):string[]{
  if(key===undefined)return compute();
  const hit=extracted.get(key);
  if(hit!==undefined){extracted.delete(key);extracted.set(key,hit);return [...hit];}
  const value=Object.freeze(compute());
  extracted.set(key,value);
  if(extracted.size>EXTRACTED_LIMIT)extracted.delete(extracted.keys().next().value!);
  return [...value];
}
/** Drops what is kept, for a test that counts the work. */
export function forgetExtractedGrounds():void{extracted.clear();}

export function groundsOf(value:unknown):string[]{
  // Only one verified body is kept: a list of values is walked as one, in the order it always was.
  const digest=Array.isArray(value)?undefined:verifiedBodyDigest(value);
  return remembered(digest===undefined?undefined:'grounds\n'+digest,()=>extractGrounds(value));
}
function extractGrounds(value:unknown):string[]{
  const metadata=new WeakMap<object,string>();
  for(const candidate of Array.isArray(value)?value:[value])if(ValidationResult.safeParse(candidate).success){
    const result=candidate as ValidationResult;
    const items=Object.values(result.partitions).flat();
    // These links explain Hub routing/provenance; the original records retain their separate read guards.
    for(const item of items)for(const criterion of item.replaced_criteria??[])metadata.set(criterion,'review');
    for(const claim of [...result.cross_item,...items.flatMap(item=>item.requirements.flatMap(requirement=>requirement.claims))]){
      const source=claim.statement.data?.judgment_source;
      if(claim.warrant.producer==='model'&&source&&typeof source==='object'&&(source as {submission?:unknown}).submission===result.submission&&(source as {pointer?:unknown}).pointer===claim.pointer)metadata.set(source,'record');
    }
  }
  const found=new Set<string>(),seen=new Set<object>(),work=[value];
  while(work.length){const row=work.pop();if(typeof row==='string'){if(row.includes(':')&&Ground.safeParse(row).success)found.add(row);}else if(row&&typeof row==='object'&&!seen.has(row)){seen.add(row);for(const [key,item] of Object.entries(row))if(metadata.get(row)!==key)work.push(item);}}
  return [...found];
}

/** The digests the validity conditions of a value bind, in the order a walk of the value meets them. */
export function boundOf(value:unknown):string[]{
  const bound=new Set<string>(),work=[value],seen=new Set<object>();
  while(work.length){const row=work.pop();if(!row||typeof row!=='object'||seen.has(row))continue;seen.add(row);
    const validity=(row as Record<string,unknown>).validity;
    if(validity&&typeof validity==='object'&&Array.isArray((validity as Record<string,unknown>).bound))for(const digest of (validity as {bound:unknown[]}).bound)if(typeof digest==='string')bound.add(digest);
    work.push(...Object.values(row));
  }
  return [...bound];
}

/**
 * The grounds of a result within its run: the grounds it names, then each source of the run that its validity conditions
 * bind. Structural rule claims bind source digests even when their rendered statement contains no explicit URI.
 */
export function groundsWithSources(grounds:readonly string[],bound:readonly string[],run:RunRecord):string[]{
  const found=new Set(grounds),digests=new Set(bound);
  for(const source of run.sources){const ref=parseReference(source.reference);if(ref.scheme==='src'&&digests.has(ref.sha256)||source.artifact&&digests.has(source.artifact))found.add(source.reference);}
  return [...found];
}

export function resultGrounds(value:unknown,run:RunRecord):string[]{
  // The sources a result binds are those of its run, and a run record does not change: the pair names the answer.
  const digest=Array.isArray(value)?undefined:verifiedBodyDigest(value);
  return remembered(digest===undefined?undefined:'result\n'+digest+'\n'+run.run,()=>groundsWithSources(groundsOf(value),boundOf(value),run));
}
