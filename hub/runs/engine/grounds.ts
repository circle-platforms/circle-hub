// Current audience and withdrawal checks are views; historical submissions and validation records are never rewritten.
import { Ground } from '../../../contracts/src/reference.ts';
import { RunRecord } from '../../../contracts/src/run.ts';
import { ValidationResult } from '../../../contracts/src/validation.ts';
import type {RequestBody} from '../../requests/api.ts';
import { PROTOCOL_CODES } from '../../../contracts/generated/protocol.ts';
import type { ProtocolError } from '../../../contracts/src/common.ts';
import type { Principal } from '../../records/api.ts';
import { createDocumentCache, parseReference, resolveReference, type RecordReader } from '../../refs/api.ts';
import { ENGINE_COMPONENT, type EngineContext } from './deps.ts';
import { canSeeRun, canViewRun, identityOf, principalOf, recordReader, sourceReader } from './readers.ts';
import { resultFor,runById,submissionByDigest } from './store.ts';
import {HubReadFailure,retryRead} from './retry-read.ts';
import {attemptEvidence} from './retry-evidence.ts';
import {receivedDigest} from './util.ts';

export function groundsOf(value:unknown):string[]{
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
  while(work.length){const row=work.pop();if(typeof row==='string'){if(Ground.safeParse(row).success)found.add(row);}else if(row&&typeof row==='object'&&!seen.has(row)){seen.add(row);for(const [key,item] of Object.entries(row))if(metadata.get(row)!==key)work.push(item);}}
  return [...found];
}

/** Structural rule claims bind source digests even when their rendered statement contains no explicit URI. */
function resultGrounds(value:unknown,run:RunRecord):string[]{
  const found=new Set(groundsOf(value)),bound=new Set<string>(),work=[value],seen=new Set<object>();
  while(work.length){const row=work.pop();if(!row||typeof row!=='object'||seen.has(row))continue;seen.add(row);
    const validity=(row as Record<string,unknown>).validity;
    if(validity&&typeof validity==='object'&&Array.isArray((validity as Record<string,unknown>).bound))for(const digest of (validity as {bound:unknown[]}).bound)if(typeof digest==='string')bound.add(digest);
    work.push(...Object.values(row));
  }
  for(const source of run.sources){const ref=parseReference(source.reference);if(ref.scheme==='src'&&bound.has(ref.sha256)||source.artifact&&bound.has(source.artifact))found.add(source.reference);}
  return [...found];
}

export async function withdrawnGrounds(ctx:EngineContext,value:unknown,trustedResult=false):Promise<string[]>{
  const diagnostics=trustedResult?new Set((Array.isArray(value)?value:[value]).flatMap(result=>(result as ValidationResult).unavailable_references??[])):new Set<string>();
  const references=new Set(groundsOf(value).filter(reference=>!diagnostics.has(reference))),work=[...references],seen=new Set<string>();
  while(work.length){const reference=work.pop()!;if(seen.has(reference))continue;seen.add(reference);
    const ref=parseReference(reference);if(ref.scheme!=='rec')continue;
    const record=await ctx.deps.records.store.get(ref.record);if(record?.kind!=='validation_result')continue;
    for(const ground of groundsOf(record.body))if(!references.has(ground)){references.add(ground);work.push(ground);}
  }
  return ctx.deps.knowledge?.spaces?.withdrawnGrounds([...references])??[];
}

export async function groundsAudience(ctx:EngineContext,run:RunRecord,value:ValidationResult,options:{pending?:boolean;recorded?:boolean;submitter?:Principal}={}):Promise<ProtocolError|null>{
  const grounds=resultGrounds(value,run);if(!grounds.length)return null;
  if(!ctx.deps.records.principals?.list)return {code:'RESULT_GROUNDS_UNREADABLE',message:PROTOCOL_CODES.RESULT_GROUNDS_UNREADABLE.when,fix:PROTOCOL_CODES.RESULT_GROUNDS_UNREADABLE.fix};
  const provisional=options.recorded?null:await submissionByDigest(ctx.deps.records.store,run.run,value.submission);
  const permissionOptions={pending:options.pending,...(provisional?{provisionalSubmission:provisional.digest}:{})};
  const submitter=options.submitter??await ctx.deps.records.principals.get(run.runner??run.configurer??'');
  const diagnostic=new Set(options.recorded?value.unavailable_references??[]:[]);
  if(!options.recorded&&submitter){
    for(const reference of grounds)if(!await groundsReadableBy(ctx,run,[reference],submitter,permissionOptions)){
      // Submitter-scoped exact validators already saw the same opaque absence. Do not disclose whether it exists.
      diagnostic.add(reference);
    }
    if(diagnostic.size)value.unavailable_references=[...diagnostic];
  }
  const evidence=grounds.filter(reference=>!diagnostic.has(reference));
  if((await withdrawnGrounds(ctx,evidence)).length)return {code:'GROUNDS_WITHDRAWN',message:PROTOCOL_CODES.GROUNDS_WITHDRAWN.when,fix:PROTOCOL_CODES.GROUNDS_WITHDRAWN.fix};
  const people=await ctx.deps.records.principals.list();
  const readers:Principal[]=[];for(const person of people)if(!person.disabled&&await canViewRun(person,run,ctx.deps.records.store))readers.push(person);
  for(const by of readers)if(!await groundsReadableBy(ctx,run,evidence,by,permissionOptions))return {code:'RESULT_GROUNDS_UNREADABLE',message:PROTOCOL_CODES.RESULT_GROUNDS_UNREADABLE.when,fix:PROTOCOL_CODES.RESULT_GROUNDS_UNREADABLE.fix};
  return null;
}

export async function groundsReadableBy(ctx:EngineContext,run:RunRecord,value:unknown,by:Principal,options:{pending?:boolean;trustedResult?:boolean;provisionalSubmission?:string;unavailableReferences?:readonly string[]}={}):Promise<boolean>{
  const documents=createDocumentCache(8);
  const check=async(reference:string,seen:Set<string>,depth:number,atRun=run,pending=options.pending===true,inheritedInput=false):Promise<boolean>=>{
    if(depth>64||seen.has(reference))return false;seen.add(reference);
    const spaces=ctx.deps.knowledge?.spaces,legacy=sourceReader(ctx.deps.records.artifacts,'function',atRun.sources);
    const identity=identityOf(by,pending?undefined:atRun.run);
    const ref=parseReference(reference);
    const frozenInput=ref.scheme==='rec'&&atRun.sources.some(binding=>{const input=parseReference(binding.reference);return input.scheme==='rec'&&input.record===ref.record&&(input.pointer===undefined||ref.pointer===input.pointer||ref.pointer?.startsWith(input.pointer+'/'));});
    if(ref.scheme==='rec'){
      const record=await ctx.deps.records.store.get(ref.record);
      if(record?.kind==='source_artifact'&&!await ctx.deps.records.artifacts.canRead(by,record as import('../../records/api.ts').SourceArtifact))return false;
    }
    // Admission checks authority over the source, not whether a selector passed the earlier static check.
    // A public product tree is one permission scope; personal trees retain their path and underlying-source guards.
    if(ref.scheme==='tree'){
      const version=await spaces?.version(ref.root);
      if(version){
        if(!await spaces!.mayRead(by,version.body.space,ref.path))return false;
        for(const row of version.body.entries.filter(row=>row.path===ref.path&&(!ref.entry||row.entry===ref.entry))){const entry=await spaces!.entry(by,ref.root,ref.path,row.entry);if(!entry)return false;for(const ground of entry.body.grounds)if(!await check(ground.reference,new Set(seen),depth+1,atRun,pending,inheritedInput))return false;}
        return true;
      }
      const knowledge=ctx.deps.knowledge;
      const roots=await knowledge?.rootInfo(ref.root)??[];
      if(roots.length){const readable=await ctx.deps.packs.readableProducts(by);return roots.some(root=>readable.has(root.product));}
      const tree=knowledge?.treeReader();if(await tree?.hasRoot?.(ref.root,identity))return true;
      if(tree)return (await tree.read(ref.root,ref.path,ref.entry??null,identity))!==null;
    }
    if(ref.scheme==='src'){
      const pins=[...new Set(atRun.sources.filter(binding=>{const source=parseReference(binding.reference);return source.scheme==='src'&&source.sha256===ref.sha256&&binding.artifact;}).map(binding=>binding.artifact!))];
      for(const capture of pins.length?pins:[undefined]){
        const candidates=capture?[await ctx.deps.records.store.get<import('../../records/api.ts').SourceArtifactBody>(capture)]:await ctx.deps.records.artifacts.records(ref.sha256);
        let readable=false;
        for(const candidate of candidates)if(candidate?.kind==='source_artifact'&&candidate.body.sha256===ref.sha256&&await ctx.deps.records.artifacts.canRead(by,candidate)){readable=true;break;}
        if(!readable&&inheritedInput&&await canViewRun(by,run,ctx.deps.records.store))readable=candidates.some(candidate=>candidate?.kind==='source_artifact'&&candidate.body.sha256===ref.sha256&&(pins.length>0&&'read' in candidate.body.origin&&candidate.body.visibility.admins&&candidate.body.provenance_type==='observed'||'generated' in candidate.body.origin&&candidate.body.origin.generated.inputs.some(input=>atRun.sources.some(binding=>binding.reference===input))));
        if(!readable)readable=await ctx.deps.records.artifacts.canReadForRun?.(by,ref.sha256,atRun.run,{...(capture?{record:capture}:{}),...(pending?{pending:atRun}:{})})??false;
        if(!readable)readable=await spaces?.mayReadSource(by,ref.sha256,pending?undefined:atRun.run,'function',capture)??false;
        if(!readable)readable=await ctx.deps.personalPacks?.mayReadSource(by,ref.sha256,pending?undefined:atRun.run,capture)??false;
        if(!readable&&!pins.length&&atRun.run!==run.run){const outer=new Set(seen);outer.delete(reference);readable=await check(reference,outer,depth+1,run,options.pending===true);}
        if(!readable)return false;
      }
      return true;
    }
    let parser=ctx.parsers;

    const attempts:Array<Record<string,unknown>>=[];
    const read=()=>resolveReference(reference,{reader:identity,parsers:parser,documents,trees:ctx.deps.knowledge?.treeReader(),records:recordReader(ctx.deps.records.store,ctx.deps.knowledge?.layers?.contributions),sources:{read:async(hash,reader)=>{
      const pins=[...new Set(atRun.sources.filter(binding=>{const ref=parseReference(binding.reference);return ref.scheme==='src'&&ref.sha256===hash&&binding.artifact;}).map(binding=>binding.artifact!))];
      if(pins.length){
        let selected:Awaited<ReturnType<typeof ctx.deps.records.artifacts.source>>=null;
        for(const capture of pins){
          const original=spaces?await spaces.source(by,hash,pending?undefined:atRun.run,'function',capture):await ctx.deps.records.artifacts.source(by,hash,{consumer:'function',record:capture})??(pending?null:await ctx.deps.records.artifacts.sourceForRun(by,hash,atRun.run,{consumer:'function',record:capture}));
          const declared=pending?await ctx.deps.records.artifacts.sourceForRun(by,hash,atRun.run,{consumer:'function',record:capture,pending:atRun}):null;
          const source=original??declared??await ctx.deps.personalPacks?.source(by,hash,pending?undefined:atRun.run,capture);
          if(!source)return null;
          selected??=source;
        }
        return selected;
      }
      const original=spaces?await spaces.source(by,hash,pending?undefined:atRun.run,'function'):await legacy.read(hash,reader);
      return original??await ctx.deps.personalPacks?.source(by,hash,pending?undefined:atRun.run)??null;
    }},consumer:'function'});
    if(ref.scheme==='rec'){
      // A missing JSON pointer is an exact-validator diagnostic, not a different permission to its parent record.
      if(!await recordReader(ctx.deps.records.store,ctx.deps.knowledge?.layers?.contributions).read(ref.record,identity)){
        const record=await ctx.deps.records.store.get<any>(ref.record);
        const currentSamples=record?.kind==='submission'&&record.digest===options.provisionalSubmission&&/^\/checks\/[0-9]+\/samples$/.test(ref.pointer??'');
        const candidateAction=pending&&record?.kind==='action'&&record.body.run===atRun.run;
        if(!(currentSamples||candidateAction||frozenInput)||!await canViewRun(by,inheritedInput?run:atRun,ctx.deps.records.store))return false;
      }
    }else{
      let resolved:Awaited<ReturnType<typeof read>>;
      try{resolved=await retryRead(read,result=>!result.resolved&&result.reason?{reason:result.reason,retry:true}:null,attempt=>{if(attempt.retry||attempt.attempt>1)attempts.push(attemptEvidence('read',ENGINE_COMPONENT,attempt,{reference}));});}
      catch{throw new HubReadFailure(reference,'check_error',attempts);}
      if(!resolved.resolved&&resolved.reason)throw new HubReadFailure(reference,resolved.reason,attempts);
      if(!resolved.resolved||!resolved.readable)return false;
      for(const ground of resolved.grounds)if(!await check(ground,new Set(seen),depth+1,atRun,pending,inheritedInput))return false;
    }
    if(ref.scheme==='tree'&&spaces){const version=await spaces.version(ref.root);if(version){
      const rows=version.body.entries.filter(row=>row.path===ref.path&&(!ref.entry||row.entry===ref.entry));
      for(const row of rows){const entry=await spaces.entry(by,ref.root,ref.path,row.entry);if(!entry)return false;for(const ground of entry.body.grounds)if(!await check(ground.reference,new Set(seen),depth+1,atRun,pending,inheritedInput))return false;}
    }}
    if(ref.scheme==='rec'){
      const record=await ctx.deps.records.store.get<any>(ref.record);
      if(record?.kind==='validation_result'){
        const linked=(await ctx.deps.records.store.find<RunRecord>({kind:'run',key:'runs.id',value:record.body.run,limit:1})).items[0];
        if(!linked||!await canViewRun(by,inheritedInput||frozenInput?run:linked.body,ctx.deps.records.store))return false;
        for(const ground of resultGrounds(record.body,linked.body).filter(ground=>!record.body.unavailable_references?.includes(ground)))if(!await check(ground,new Set(seen),depth+1,linked.body,false,inheritedInput||frozenInput))return false;
      }
      if(record?.kind==='run'||record?.kind==='submission'){
        let linked:RunRecord|undefined;
        if(record.kind==='run'){const parsed=RunRecord.safeParse(record.body);if(parsed.success)linked=parsed.data;}
        else linked=(await runById(ctx.deps.records.store,record.body.run))?.body;
        if(!linked)return false;
        const validation=record.kind==='submission'?await resultFor(ctx.deps.records.store,linked.run,receivedDigest(record.body).digest):null;
        const diagnostic=new Set(validation?.body.unavailable_references??[]);
        // A run's grounds are its admitted sources; projected fields may also retain unverified source-authored links.
        for(const ground of groundsOf(record.kind==='run'?record.body.sources:record.body).filter(ground=>!diagnostic.has(ground)))if(!await check(ground,new Set(seen),depth+1,linked,false,inheritedInput||frozenInput))return false;
      }
      if(record?.kind==='action'||record?.kind==='effect')for(const ground of groundsOf(record.body.inputs??[]))if(!await check(ground,new Set(seen),depth+1,atRun,pending,inheritedInput))return false;
    }
    return true;
  };
  const diagnostic=new Set(options.trustedResult?(value as ValidationResult).unavailable_references??[]:options.unavailableReferences??[]);
  try{for(const reference of resultGrounds(value,run).filter(reference=>!diagnostic.has(reference)))if(!await check(reference,new Set(),0))return false;return true;}finally{documents.dispose?.();}
}

/** A workflow grant never lends the initiator's private input data to another reader. */
export async function runReadableBy(ctx:EngineContext,by:Principal,run:RunRecord):Promise<boolean>{
  if(!await canViewRun(by,run,ctx.deps.records.store))return false;
  return run.runner===by.id||run.configurer===by.id||await groundsReadableBy(ctx,run,run.sources,by);
}

/** Instance diagnostics of a rejected submission do not grant access to its private grounds. */
export async function resultReadableBy(ctx:EngineContext,run:RunRecord,result:ValidationResult,by:Principal):Promise<boolean>{
  if(run.runner===by.id)return true;
  if(!canSeeRun(by,run)&&result.acceptance!=='accepted'||!await groundsReadableBy(ctx,run,result,by,{trustedResult:true}))return false;
  const raw=await submissionByDigest(ctx.deps.records.store,run.run,result.submission);
  if(raw&&!await groundsReadableBy(ctx,run,raw.body,by,{unavailableReferences:result.unavailable_references}))return false;
  return true;
}

/** Request instances retain run-owner/administrator scope and never lend a private submission's diagnostics. */
export async function requestReadable(ctx:EngineContext,by:Principal,request:RequestBody):Promise<boolean>{
  if(!request.run)return by.role==='admin'||request.audience===by.id;
  const stored=await runById(ctx.deps.records.store,request.run);if(!stored||!canSeeRun(by,stored.body)||!await runReadableBy(ctx,by,stored.body))return false;
  if(stored.body.runner===by.id||stored.body.configurer===by.id)return true;
  const result=await resultFor(ctx.deps.records.store,request.run,request.source);
  if(result)return resultReadableBy(ctx,stored.body,result.body,by);
  const raw=await submissionByDigest(ctx.deps.records.store,request.run,request.source);
  return !raw||await groundsReadableBy(ctx,stored.body,raw.body,by);
}

/** Every record-to-input and exact-value path uses the same current views as direct record reads. */
export function guardedRecords(ctx:EngineContext):RecordReader{
  const {store,artifacts}=ctx.deps.records;
  const base=recordReader(store,ctx.deps.knowledge?.layers?.contributions,(by,run)=>runReadableBy(ctx,by,run),(by,run,value)=>resultReadableBy(ctx,run,value as ValidationResult,by),(by,value)=>requestReadable(ctx,by,value as RequestBody),(by,run,digest)=>groundsReadableBy(ctx,run,'rec:'+digest,by));
  return {read:async(digest,reader)=>{
    const record=await store.get(digest);
    if(record?.kind==='source_artifact'&&!await artifacts.canRead(principalOf(reader),record as import('../../records/api.ts').SourceArtifact))return null;
    return base.read(digest,reader);
  }};
}
