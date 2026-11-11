// Current audience and withdrawal checks are views; historical submissions and validation records are never rewritten.
import { RunRecord } from '../../../contracts/src/run.ts';
import { ValidationResult } from '../../../contracts/src/validation.ts';
import type {RequestBody} from '../../requests/api.ts';
import { PROTOCOL_CODES } from '../../../contracts/generated/protocol.ts';
import type { ProtocolError } from '../../../contracts/src/common.ts';
import type { Principal } from '../../records/api.ts';
import { createDocumentCache, parseReference, resolveReference, type RecordReader } from '../../refs/api.ts';
import { ENGINE_COMPONENT, type EngineContext } from './deps.ts';
import { canSeeRun, canViewRun, identityOf, principalOf, recordReader, sourceReader } from './readers.ts';
import {isMemoryRecord} from '../../../contracts/src/memory.ts';
import { resultFor,runById,submissionByDigest } from './store.ts';
import {HubReadFailure,retryRead} from './retry-read.ts';
import {attemptEvidence} from './retry-evidence.ts';
import {receivedDigest} from './util.ts';
import {unavailableError} from './errors.ts';
import {queryRead} from './query-scope.ts';
import {groundsOf,groundsWithSources,resultGrounds} from './ground-extraction.ts';
import {resultSummaryOf,type ResultSummary} from './result-summary.ts';
import {INDEX} from './store.ts';
export {forgetExtractedGrounds,groundsOf} from './ground-extraction.ts';

async function withdrawalReferences(ctx:EngineContext,value:unknown,trustedResult=false):Promise<string[]>{
  const diagnostics=trustedResult?new Set((Array.isArray(value)?value:[value]).flatMap(result=>(result as ValidationResult).unavailable_references??[])):new Set<string>();
  const references=new Set(groundsOf(value).filter(reference=>!diagnostics.has(reference))),work=[...references],seen=new Set<string>();
  while(work.length){const reference=work.pop()!;if(seen.has(reference))continue;seen.add(reference);
    const ref=parseReference(reference);if(ref.scheme!=='rec')continue;
    const record=await ctx.deps.records.store.get(ref.record);if(record?.kind!=='validation_result')continue;
    for(const ground of groundsOf(record.body).filter(ground=>!(record.body as ValidationResult).unavailable_references?.includes(ground)))if(!references.has(ground)){references.add(ground);work.push(ground);}
  }
  return [...references];
}
export async function hasWithdrawnGrounds(ctx:EngineContext,value:unknown,trustedResult=false):Promise<boolean>{return ctx.deps.knowledge?.spaces?.hasWithdrawnGrounds(await withdrawalReferences(ctx,value,trustedResult))??false;}
export async function withdrawalState(ctx:EngineContext,value:unknown,by:Principal,trustedResult=false):Promise<{grounds_withdrawn:string[];grounds_withdrawn_hidden_count:number}>{return ctx.deps.knowledge?.spaces?.withdrawalState(await withdrawalReferences(ctx,value,trustedResult),by)??{grounds_withdrawn:[],grounds_withdrawn_hidden_count:0};}

export async function groundsAudience(ctx:EngineContext,run:RunRecord,value:ValidationResult,options:{pending?:boolean;recorded?:boolean;submitter?:Principal}={}):Promise<ProtocolError|null>{
  const grounds=resultGrounds(value,run);if(!grounds.length)return null;
  if(!ctx.deps.records.principals?.list)return {code:'RESULT_GROUNDS_UNREADABLE',message:PROTOCOL_CODES.RESULT_GROUNDS_UNREADABLE.when,fix:PROTOCOL_CODES.RESULT_GROUNDS_UNREADABLE.fix};
  const provisional=options.recorded?null:await submissionByDigest(ctx.deps.records.store,run.run,value.submission);
  const permissionOptions={pending:options.pending,...(provisional?{provisionalSubmission:provisional.digest}:{})};
  const submitter=options.submitter??await ctx.deps.records.principals.get(run.runner??run.configurer??'');
  const diagnostic=new Set(options.recorded?value.unavailable_references??[]:[]);
  const claims=[...value.cross_item,...Object.values(value.partitions).flatMap(items=>items.flatMap(item=>item.requirements.flatMap(requirement=>requirement.claims)))];
  if(options.recorded&&submitter)for(const reference of grounds.filter(reference=>!diagnostic.has(reference)))if(!await groundsReadableBy(ctx,run,[reference],submitter,permissionOptions))return unavailableError();
  if(!options.recorded&&submitter){
    for(const reference of grounds)if(!await groundsReadableBy(ctx,run,[reference],submitter,permissionOptions)){
      // Evidence already read successfully cannot become an absent diagnostic after a concurrent grant revocation.
      if(run.sources.some(source=>source.reference===reference)||claims.some(claim=>claim.warrant.producer==='function'&&claim.warrant.id==='quote@1'&&claim.statement.verdict==='support'&&claim.grounds.includes(reference)))return unavailableError();
      // Submitter-scoped exact validators already saw the same opaque absence. Do not disclose whether it exists.
      diagnostic.add(reference);
    }
    if(diagnostic.size)value.unavailable_references=[...diagnostic];
  }
  const evidence=grounds.filter(reference=>!diagnostic.has(reference));
  if(await hasWithdrawnGrounds(ctx,evidence))return {code:'GROUNDS_WITHDRAWN',message:PROTOCOL_CODES.GROUNDS_WITHDRAWN.when,fix:PROTOCOL_CODES.GROUNDS_WITHDRAWN.fix};
  const people=await ctx.deps.records.principals.list();
  const readers:Principal[]=[];for(const person of people)if(!person.disabled&&await canViewRun(person,run,ctx.deps.records.store))readers.push(person);
  for(const by of readers)if(!await groundsReadableBy(ctx,run,evidence,by,permissionOptions))return {code:'RESULT_GROUNDS_UNREADABLE',message:PROTOCOL_CODES.RESULT_GROUNDS_UNREADABLE.when,fix:PROTOCOL_CODES.RESULT_GROUNDS_UNREADABLE.fix};
  return null;
}

/**
 * Whether `by` may read every ground `value` names within `run`. `references` gives those grounds when the caller already
 * holds them (a result's summary lists them, in the order the result gives them); `value` is then not looked at.
 */
export async function groundsReadableBy(ctx:EngineContext,run:RunRecord,value:unknown,by:Principal,options:{pending?:boolean;trustedResult?:boolean;provisionalSubmission?:string;unavailableReferences?:readonly string[];references?:readonly string[]}={}):Promise<boolean>{
  const documents=createDocumentCache(8);
  const check=async(reference:string,seen:Set<string>,depth:number,atRun=run,pending=options.pending===true,inheritedInput=false):Promise<boolean>=>{
    if(depth>64||seen.has(reference))return false;seen.add(reference);
    const spaces=ctx.deps.knowledge?.spaces,legacy=sourceReader(ctx.deps.records.artifacts,'function',atRun.sources);
    const identity=identityOf(by,pending?undefined:atRun.run);
    const ref=parseReference(reference);
    const frozenInput=ref.scheme==='rec'&&atRun.sources.some(binding=>{const input=parseReference(binding.reference);return input.scheme==='rec'&&input.record===ref.record&&(input.pointer===undefined||ref.pointer===input.pointer||ref.pointer?.startsWith(input.pointer+'/'));});
    if(ref.scheme==='rec'){
      const record=await ctx.deps.records.store.get(ref.record);
      if(record&&isMemoryRecord(record))return false;
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
      // A result cites a few roots hundreds of times: each is looked up once per read.
      const products=await queryRead(ctx,['root-products',ref.root] as const,async([,root])=>(await knowledge?.rootInfo(root)??[]).map(info=>info.product));
      if(products.length){const readable=await ctx.deps.packs.readableProducts(by);return products.some(product=>readable.has(product));}
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
  try{for(const reference of (options.references??resultGrounds(value,run)).filter(reference=>!diagnostic.has(reference)))if(!await check(reference,new Set(),0))return false;return true;}finally{documents.dispose?.();}
}

/** A workflow grant never lends the initiator's private input data to another reader. */
export async function runReadableBy(ctx:EngineContext,by:Principal,run:RunRecord):Promise<boolean>{
  if(ctx.deps.records.principals){const account=await ctx.deps.records.principals.get(by.id);if(!account||account.disabled)return false;by=account;}
  if(run.pack_space&&run.pack_space!=='team'&&run.runner!==by.id&&run.configurer!==by.id){const owner=await ctx.deps.records.principals?.get(run.pack_space);if(!owner||owner.disabled)return false;}
  if(!await canViewRun(by,run,ctx.deps.records.store))return false;
  return run.runner===by.id||run.configurer===by.id||await groundsReadableBy(ctx,run,run.sources,by);
}

/** Instance diagnostics of a rejected submission do not grant access to its private grounds. */
export async function resultReadableBy(ctx:EngineContext,run:RunRecord,result:ValidationResult,by:Principal):Promise<boolean>{
 return queryRead(ctx,['result-readable',by,run,result] as const,async([,by,run,result])=>{
  if(run.runner===by.id)return true;
  if(!canSeeRun(by,run)&&result.acceptance!=='accepted'||!await groundsReadableBy(ctx,run,result,by,{trustedResult:true}))return false;
  const raw=await submissionByDigest(ctx.deps.records.store,run.run,result.submission);
  if(raw&&!await groundsReadableBy(ctx,run,raw.body,by,{unavailableReferences:result.unavailable_references}))return false;
  return true;
 });
}

/**
 * resultReadableBy for a result known by its summary (W08 R[6]): the same rule over the same grounds, which the summary
 * lists in the order the result gives them, so the result itself is not read.
 */
export async function summaryReadableBy(ctx:EngineContext,run:RunRecord,summary:ResultSummary,by:Principal):Promise<boolean>{
 return queryRead(ctx,['summary-readable',by,run.run,summary.result] as const,async()=>{
  if(run.runner===by.id)return true;
  const references=groundsWithSources(summary.grounds,summary.bound,run);
  if(!canSeeRun(by,run)&&summary.acceptance!=='accepted'||!await groundsReadableBy(ctx,run,null,by,{references,unavailableReferences:summary.unavailable_references}))return false;
  const raw=await submissionByDigest(ctx.deps.records.store,run.run,summary.submission);
  if(raw&&!await groundsReadableBy(ctx,run,raw.body,by,{unavailableReferences:summary.unavailable_references}))return false;
  return true;
 });
}

/** Request instances retain run-owner/administrator scope and never lend a private submission's diagnostics. */
export async function requestReadable(ctx:EngineContext,by:Principal,request:RequestBody):Promise<boolean>{
  if(!request.run)return by.role==='admin'||request.audience===by.id;
  const stored=await runById(ctx.deps.records.store,request.run);if(!stored||!canSeeRun(by,stored.body)||!await runReadableBy(ctx,by,stored.body))return false;
  if(stored.body.runner===by.id||stored.body.configurer===by.id)return true;
  const store=ctx.deps.records.store;
  // The result that issued the request, by its summary: a page of waiting requests no longer reads a result for each.
  const issued=store.findDigests?(await store.findDigests({key:INDEX.resultSubmission,value:`${request.run}:${request.source}`,kind:'validation_result',limit:1,newestFirst:true})).items[0]:undefined;
  const summary=issued===undefined?null:await resultSummaryOf(store,request.run,issued);
  if(summary)return summaryReadableBy(ctx,stored.body,summary,by);
  if(!store.findDigests||issued!==undefined){
    const result=await resultFor(store,request.run,request.source);
    if(result)return resultReadableBy(ctx,stored.body,result.body,by);
  }
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
