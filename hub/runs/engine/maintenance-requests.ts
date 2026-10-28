import {MissingFact,RecoveryGap,UnknownExit,type LayerResult,type ValidationResult} from '../../../contracts/src/validation.ts';
import {PARTITION,isReason} from '../../../contracts/generated/vocabulary.ts';
import type {RunRecord} from '../../../contracts/src/run.ts';
import type {Page,StoredRecord} from '../../records/api.ts';
import type {EngineContext} from './deps.ts';
import {recordResultRequests,RequestBodySchema,type RequestBody} from './requests.ts';

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
