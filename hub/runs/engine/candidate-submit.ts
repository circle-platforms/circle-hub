// Independent document-output channel: no candidate text is passed to ordinary validation, logs or run events.
import type { z } from 'zod';
import { CandidateProposal } from '../../../contracts/src/candidates.ts';
import type { SubmitResultOutput } from '../../../contracts/src/tools.ts';
import type { ProtocolError } from '../../../contracts/src/common.ts';
import type { RunRecord } from '../../../contracts/src/run.ts';
import type { LoadedWorkflow } from '../../ports.ts';
import type { Principal } from '../../records/api.ts';
import type { CandidateSourceScope } from '../../knowledge/api.ts';
import { parseReference } from '../../refs/api.ts';
import type { EngineContext } from './deps.ts';
import type { CandidateEnvelope } from './candidate-envelope.ts';
import { buildScope, createResolver } from './exact.ts';
import { actionsOf, putAction } from './store.ts';
import { receivedDigest } from './util.ts';

type Receipt = NonNullable<z.infer<typeof SubmitResultOutput>['candidate_receipt']>;
const COMPONENT='knowledge.candidates@1';
function sourceScope(ctx:EngineContext,run:RunRecord,workflow:LoadedWorkflow):CandidateSourceScope{
  return {begin:async owner=>{
    const scope=await buildScope(ctx,run,workflow,owner,'model'),resolver=createResolver(ctx,scope,'model');
    return {resolve:async reference=>{
      const ref=parseReference(reference),result=await resolver.resolve(reference);
      if(!result.ok||result.value.text===null)return null;
      if(ref.scheme==='src'){
        const source=await ctx.deps.records.artifacts.source(owner,ref.sha256,{consumer:'model'});
        return source?.bytes?{reference:result.value.reference,text:result.value.text,provenance:source.artifact.body.provenance_type,record:source.artifact.digest}:null;
      }
      if(ref.scheme==='rec'){
        const record=await ctx.deps.records.store.get(ref.record);
        return record?{reference:result.value.reference,text:result.value.text,provenance:record.provenance,record:record.digest}:null;
      }
      if(ref.scheme==='tree'){
        const metadata=await ctx.deps.knowledge.layers?.candidates.sourceMetadata(owner,result.value.reference);
        return metadata?{reference:result.value.reference,text:result.value.text,...metadata}:null;
      }
      return null; // The boundary forbids a bare entry as a ground; it must be cited by its tree address.
    }};
  }};
}
function candidateProblem(error:unknown,index:number):ProtocolError{
  const code=(error as {code?:unknown}|null)?.code;
  if(code==='QUOTE_MISMATCH')return {code,message:'候选引文与所引来源不逐字一致',fix:'照抄所引片段中的原文后重交这条候选',path:`/candidates/${index}`};
  if(code==='REFERENCE_UNRESOLVED')return {code,message:'候选引用或归位路径不能解析',fix:'使用本次范围内可解析的引用和依据根里的路径',path:`/candidates/${index}`};
  if(code==='SUBMISSION_SCHEMA_VIOLATION')return {code,message:'候选不符合工作流声明',fix:'按声明的文档产出提交 source、statement 和所需路径/关系；不自报来源类型、依据等级或适用条件',path:`/candidates/${index}`};
  return {code:'SOURCE_UNAVAILABLE',message:'候选的来源不在本次范围、目前不可读或候选通道不可用',fix:'确认引用属于本次运行且本人此刻可读；会话说法须使用本人私有摘录',path:`/candidates/${index}`};
}
function matchesInput(run:RunRecord,slot:string,reference:string):boolean{
  const ref=parseReference(reference);
  return run.sources.filter(s=>s.slot===slot).some(binding=>{
    try{const source=parseReference(binding.reference);return ref.scheme==='src'&&source.scheme==='src'?ref.sha256===source.sha256:ref.scheme==='rec'&&source.scheme==='rec'&&ref.record===source.record;}catch{return false;}
  });
}
export async function submitCandidates(ctx:EngineContext,owner:Principal,run:RunRecord,envelope:CandidateEnvelope):Promise<Receipt|undefined>{
  if(envelope.summary===null&&!envelope.forgedSummary)return undefined;
  const summary=envelope.summary??{count:0,sha256:receivedDigest([]).digest};
  const receipt:Receipt={...summary,accepted:0,deduplicated:0,rejected:0,records:[],errors:[]};
  const startedAt=ctx.now().toISOString();
  const workflow=await ctx.deps.workflows.byDigest(run.pack_digest),layer=ctx.deps.knowledge.layers?.candidates;
  if(envelope.forgedSummary)receipt.errors.push({code:'SUBMISSION_SCHEMA_VIOLATION',message:'候选摘要由 Hub 生成，不能由提交者提供',fix:'删除 candidate_summary；候选放在 candidates',path:'/candidate_summary'});
  if(envelope.snapshotFailed||!Array.isArray(envelope.payload)||envelope.payload.length>100){
    receipt.rejected=summary.count;
    receipt.errors.push({code:'SUBMISSION_SCHEMA_VIOLATION',message:'候选部分须为不超过 100 条的数组',fix:'把按文档的产出放入 candidates 数组',path:'/candidates'});
  }else{
    const declarations=new Map(workflow?.workflow.outputs?.documents.map(output=>[output.id,output])??[]);
    const counts=new Map<string,number>();
    for(const [i,raw]of envelope.payload.entries()){
      try{
        const parsed=CandidateProposal.safeParse(raw);
        if(!parsed.success||envelope.forgedSummary)throw {code:'SUBMISSION_SCHEMA_VIOLATION'};
        const proposal=parsed.data,declaration=declarations.get(proposal.output);
        if(declaration===undefined||counts.get(proposal.output)===declaration.max_items)throw {code:'SUBMISSION_SCHEMA_VIOLATION'};
        counts.set(proposal.output,(counts.get(proposal.output)??0)+1);
        if(proposal.binding!==undefined&&(run.root===undefined||proposal.binding.root!==run.root))throw {code:'REFERENCE_UNRESOLVED'};
        if(declaration.input!==undefined&&!matchesInput(run,declaration.input,proposal.source.reference))throw {code:'SOURCE_UNAVAILABLE'};
        if(layer===undefined||workflow===null)throw {code:'SOURCE_UNAVAILABLE'};
        const model=typeof envelope.ordinary.model==='string'?envelope.ordinary.model:'(undeclared)';
        const prepared=await layer.prepareDocuments(owner,[{declaration,proposal}],model,false,sourceScope(ctx,run,workflow));
        const written=await layer.appendPrepared(owner,prepared);
        receipt.accepted+=written.accepted;receipt.deduplicated+=written.deduplicated;receipt.records.push(...written.records);
      }catch(error){receipt.rejected++;receipt.errors.push(candidateProblem(error,i));}
    }
  }
  receipt.records=[...new Set(receipt.records)];
  // Existing validate events can record boundary verification. No primary submission/result or repair key is attached.
  const previous=(await actionsOf(ctx.deps.records.store,run.run)).some(event=>event.body.component===COMPONENT&&event.body.detail.sha256===summary.sha256&&event.body.acceptance===(receipt.errors.length?'not_accepted':'accepted'));
  if(!previous||receipt.accepted>0)await putAction(ctx.deps.records.store,{action:'validate',component:COMPONENT,run:run.run,inputs:[],startedAt,endedAt:ctx.now().toISOString(),acceptance:receipt.errors.length?'not_accepted':'accepted',codes:[...new Set(receipt.errors.map(e=>e.code))],detail:{count:summary.count,sha256:summary.sha256,accepted:receipt.accepted,deduplicated:receipt.deduplicated,rejected:receipt.rejected}});
  return receipt;
}
