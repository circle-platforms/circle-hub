import type { z } from 'zod';
import { GetNodesInput, GetNodesOutput } from '../../contracts/src/tools.ts';
import { canonicalize, sha256Hex, type Principal } from '../records/api.ts';
import { parseReference, type ReaderIdentity } from '../refs/api.ts';
import { recoverySourcesReadable, type ContributionLayer } from '../knowledge/api.ts';
import type { ServerDeps } from './api.ts';
import { recordReaderFor, sourceReaderFor } from './readers.ts';

type Answer=z.infer<typeof GetNodesOutput>;
const MAX_DYNAMIC=100, BATCH=8;
async function everyBounded<T>(values:readonly T[],check:(value:T)=>Promise<boolean>):Promise<boolean>{
  for(let at=0;at<values.length;at+=BATCH)if((await Promise.all(values.slice(at,at+BATCH).map(check))).some(ok=>!ok))return false;
  return true;
}

/** Return the old read only when current permissions and every included dynamic source can still be checked. */
export async function recoverRead(deps:ServerDeps,user:Principal,args:Record<string,unknown>,raw:Record<string,unknown>,trace:string,at:string):Promise<Answer|null>{
  const input=GetNodesInput.safeParse(args),saved=GetNodesOutput.safeParse(raw);
  if(!input.success||input.data.call_query!==undefined||!saved.success||saved.data.call_result!=='ok'||saved.data.call_status!==undefined)return null;
  const answer=saved.data,request=input.data,reader:ReaderIdentity={user:user.id,role:user.role,...(request.run?{run:request.run}:{})};
  try{
    const run=request.run?await deps.runs.getRun(user,request.run):null;
    if(request.run&&!run)return null;
    const layer=(deps.knowledge as typeof deps.knowledge&{layers?:{contributions:ContributionLayer}}).layers?.contributions;
    if(request.reference!==undefined){
      if(!answer.content)return null;
      const ref=parseReference(request.reference);
      if(ref.scheme==='src'){
        const source=await sourceReaderFor(deps.records,user,'function').read(ref.sha256,reader);
        if(!source||source.readTier!==answer.content.read_tier)return null;
        if(source.bytes!==null&&source.bytes!==undefined){
          if(source.bytes.length!==source.size||sha256Hex(source.bytes)!==ref.sha256)return null;
          const captures=await deps.records.artifacts.records(ref.sha256);
          if(!captures.length||captures.some(row=>!row.body.scan.inspected||row.body.scan.truncated||row.body.scan.findings.length>0))return null;
        }else if(answer.content.text!==undefined||answer.content.structure!==undefined)return null;
      }else if(ref.scheme==='rec'){
        const current=await recordReaderFor(deps.records,deps.runs,user,()=>{},layer).read(ref.record,reader);if(!current)return null;
      }else return null; // Tree/reference validity needs its own bounded provenance path.
    }else{
      if(!answer.nodes||!answer.root||request.root!==undefined&&request.root!==answer.root||request.root===undefined&&run?.run.root!==answer.root)return null;
      if(!await recoverySourcesReadable(deps.knowledge,user,answer.root))return null;
      const contributions=answer.nodes.flatMap(node=>node.contributions??[]);
      const feeding=answer.nodes.flatMap(node=>node.feeding_objects??[]);
      if(contributions.length>MAX_DYNAMIC||feeding.length>MAX_DYNAMIC)return null;
      const seen=new Set(contributions.filter(row=>row.contribution!==undefined).map(row=>row.record));
      for(const node of answer.nodes)for(const entry of node.entries)for(const state of Object.values(entry.applicability_fields??{}))if(state.judgments.some(digest=>!seen.has(digest)))return null;
      if(contributions.length&&(!layer||!await everyBounded(contributions,async view=>{
        const current=await layer.readView(view.record,user);if(!current||current.status!==view.status)return false;
        return view.contribution===undefined||canonicalize(current.contribution)===canonicalize(view.contribution);
      })))return null;
      if(feeding.length&&(!deps.knowledge.feeding||!await everyBounded(feeding,async row=>{
        const ref=parseReference(row.reference);if(ref.scheme!=='rec')return false;
        return (await deps.knowledge.feeding!.recordState(ref.record,user))?.validity==='valid';
      })))return null;
    }
    const note=`原调用 ${trace} 在 ${at} 的回答（历史快照）；当前权限已重核，内容可能不是最新状态`;
    if(answer.content)answer.content={...answer.content,note:[answer.content.note,note].filter(Boolean).join('；')};
    else if(answer.coverage)answer.coverage={...answer.coverage,note:[answer.coverage.note,note].filter(Boolean).join('；')};
    else return null;
    return answer;
  }catch{return null;}
}
