import {MissingFact,RecoveryGap,UnknownExit,type LayerResult,type ValidationResult} from '../../../contracts/src/validation.ts';
import {PARTITION,isReason} from '../../../contracts/generated/vocabulary.ts';
import type {RunRecord} from '../../../contracts/src/run.ts';
import {digestOf,type Page,type StoredRecord} from '../../records/api.ts';
import type {EngineContext} from './deps.ts';
import {putRequest,recordResultRequests,RequestBodySchema,type RequestBody} from './requests.ts';
import {isUnsettled} from './terminals.ts';

/** Batch the same request identity that putRequest uses; due time is not part of that identity. */
export async function restoreLegacyRequests(ctx:EngineContext,stored:StoredRecord<RunRecord>,latest:StoredRecord<ValidationResult>):Promise<void>{
  const runner=stored.body.runner??stored.body.configurer;if(!runner)return;
  const planned:Array<{input:RequestBody;key:string}>=[];
  for(const [partition,items] of Object.entries(latest.body.partitions))for(const [i,item] of items.entries())for(const [j,requirement] of item.requirements.entries())for(const [k,layer] of requirement.layers.entries()){
    if(!isUnsettled(layer)||!layer.reason||layer.exit&&layer.missing)continue;
    const path='/partitions/'+partition+'/'+i+'/requirements/'+j+'/layers/'+k;
    const input:RequestBody={run:stored.body.run,kind:'repair',audience:runner,due:new Date(ctx.now().getTime()+86400000).toISOString(),source:latest.digest,code:layer.reason,item:item.item,requirement:requirement.requirement,missing:'旧结果 rec:'+latest.digest+' '+path+'：'+(!layer.exit?'出口未写；':'')+(!layer.missing?'缺失事实未写':''),next_action:'原提交者带 Circle-Session-Id 用 submit_result 原样重交，Hub 追加重评结果；旧运行或作者缺会话时，以原工作为 predecessor 开带会话的新修订后重新复核。旧记录不回填'};
    const {due:_,...identity}=input;planned.push({input,key:digestOf(identity)});
  }
  const keys=[...new Set(planned.map(row=>row.key))],existing=new Set<string>();
  for(let at=0;at<keys.length;at+=128){
    const found=await ctx.deps.records.store.findFirstMany({key:'runs.request.key',values:keys.slice(at,at+128),kind:'request'});
    for(const key of found.keys())existing.add(key);
  }
  for(const row of planned)if(!existing.has(row.key)){await putRequest(ctx,row.input);existing.add(row.key);}
}

/** Only the complete, contract-valid exits already present in a result can be restored. */
function recordedRequestGaps(layer:LayerResult){
  const gaps:Array<{exit:import('../../../contracts/src/validation.ts').UnknownExit;missing:string;reason:import('../../../contracts/generated/vocabulary.ts').Reason;code:string}>=[];
  const exit=UnknownExit.safeParse(layer.exit),missing=MissingFact.safeParse(layer.missing);
  const reason=layer.reason===undefined?'check_error':layer.reason;
  if(exit.success&&missing.success&&isReason(reason))gaps.push({exit:exit.data,missing:missing.data,reason,code:layer.code??reason});
  if(Array.isArray(layer.gaps))for(const raw of layer.gaps){const gap=RecoveryGap.safeParse(raw);if(gap.success)gaps.push({...gap.data,code:gap.data.reason});}
  return gaps;
}

/** Older accepted results may name a complete exit without its corresponding queue record. */
export async function restoreRecordedRequests(ctx:EngineContext,stored:StoredRecord<RunRecord>,latest:StoredRecord<ValidationResult>):Promise<void>{
  const result=latest.body;
  const candidates=Object.values(result.partitions).flat().some(item=>item.requirements.some(requirement=>requirement.layers.some(layer=>
    recordedRequestGaps(layer).some(gap=>gap.exit.action==='request'&&'user'in gap.exit.audience))));
  if(!candidates)return;
  // Read the run's indexed request bodies in pages; resolving each answer separately is unnecessary here.
  const existing=new Set<string>();let cursor:string|null=null;
  do{
    const page:Page<StoredRecord<RequestBody>>=await ctx.deps.records.store.find<RequestBody>({kind:'request',key:'runs.request.run',value:stored.body.run,limit:500,cursor});
    for(const row of page.items){const parsed=RequestBodySchema.safeParse(row.body);if(row.schema==='request@1'&&parsed.success){const q=parsed.data;existing.add(JSON.stringify([q.source,q.item??null,q.requirement??null,q.kind,q.audience,q.missing,q.code]));}}
    cursor=page.next;
  }while(cursor!==null);
  const missing=new Set<string>();
  for(const partition of PARTITION){
    const items=result.partitions[partition];
    for(let i=0;i<items.length;i++){
      const item=items[i]!;
      for(let j=0;j<item.requirements.length;j++){
        const requirement=item.requirements[j]!;
        for(let k=0;k<requirement.layers.length;k++){
          const layer=requirement.layers[k]!;
          const needsRequest=recordedRequestGaps(layer).some(gap=>{
            if(gap.exit.action!=='request'||!('user'in gap.exit.audience)||gap.exit.request_kind===undefined)return false;
            const audience=gap.exit.audience.user;
            const key=JSON.stringify([result.submission,item.item,requirement.requirement,gap.exit.request_kind,audience,gap.missing,gap.code]);
            return !existing.has(key);
          });
          if(needsRequest)missing.add(JSON.stringify([partition,i,j,k]));
        }
      }
    }
  }
  if(!missing.size)return;
  // The normal router derives the same named next action; only the detached copy can be annotated.
  const draft=structuredClone(result);
  for(const partition of PARTITION){
    const items=draft.partitions[partition];
    for(let i=items.length-1;i>=0;i--){
      const item=items[i]!;
      for(let j=item.requirements.length-1;j>=0;j--){
        const requirement=item.requirements[j]!;
        requirement.layers=requirement.layers.filter((_,k)=>missing.has(JSON.stringify([partition,i,j,k])));
        for(const layer of requirement.layers){
          if(!UnknownExit.safeParse(layer.exit).success||!MissingFact.safeParse(layer.missing).success||layer.reason!==undefined&&!isReason(layer.reason)){delete layer.exit;delete layer.missing;}
          if(Array.isArray(layer.gaps)){const valid=layer.gaps.filter(gap=>RecoveryGap.safeParse(gap).success);if(valid.length)layer.gaps=valid;else delete layer.gaps;}
          else delete layer.gaps;
        }
        if(!requirement.layers.length)item.requirements.splice(j,1);
      }
      if(!item.requirements.length)items.splice(i,1);
    }
  }
  draft.cross_item=[];draft.errors=[];
  await recordResultRequests(ctx,stored.body,draft);
}
