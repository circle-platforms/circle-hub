// Join only Hub-bound accepted review records to exact current case/source/root identities.
import {isRecord} from './text.ts';
import type {FacetViewData,GroupBoard} from './types.ts';
import {groupId} from './board.ts';
const HEX=/^[a-f0-9]{64}$/;
export function applyExpectedJudgments(groups:GroupBoard[],view:Pick<FacetViewData,'product'|'root'>,inputs:unknown[]):void{
 const cases=new Map<string,{id:string;group:string;source:string}>(),ambiguous=new Set<string>();
 for(const b of inputs.filter(isRecord).filter(b=>b.slot==='cases')){
  const index=b.model;if(!isRecord(index)||index.schema!=='index-view@1'||index.kind!=='case'||index.key!=='case_location'||index.product!==view.product||!isRecord(index.build)||index.build.root!==view.root||!isRecord(index.entries))continue;
  for(const e of Object.values(index.entries)){if(!isRecord(e)||!isRecord(e.data))continue;const d=e.data;
   if(typeof d.document!=='string'||typeof d.node!=='string'||typeof d.source_sha256!=='string'||!HEX.test(d.source_sha256)||typeof d.case_location!=='string'||!d.case_location.startsWith(`src:${d.source_sha256}/kityminder@1/`))continue;
   const value={id:d.document+':'+d.node,group:groupId(typeof d.line==='string'?d.line:null,typeof d.module==='string'?d.module:null),source:d.source_sha256};
   const old=cases.get(d.case_location);if(old&&JSON.stringify(old)!==JSON.stringify(value))ambiguous.add(d.case_location);else cases.set(d.case_location,value);
  }
 }
 const answers=new Map<string,{values:Set<boolean>;sources:Set<string>}>(),seen=new Set<string>();
 for(const bound of inputs.filter(isRecord).filter(b=>b.slot==='reviews')){
  const meta=isRecord(bound.meta)?bound.meta:{};if(typeof meta.record!=='string'||!HEX.test(meta.record)||meta.kind!=='validation_result'||meta.schema!=='validation@1'||meta.pointer!==undefined||seen.has(meta.record))continue;
  const record=bound.model;if(!isRecord(record)||record.kind!=='validation_result'||record.schema!=='validation@1'||!isRecord(record.body))continue;
  const body=record.body;if(body.acceptance!=='accepted'||!isRecord(body.locks)||body.locks.root!==view.root||typeof body.locks.pack!=='string'||body.locks.pack.split('@')[0]!=='case-review'||!isRecord(body.partitions)||!Array.isArray(body.partitions.delivered))continue;
  seen.add(meta.record);
  for(const item of body.partitions.delivered.filter(isRecord)){
   if(typeof item.location!=='string'||ambiguous.has(item.location))continue;const original=cases.get(item.location);if(!original||item.item!==original.id||!Array.isArray(item.requirements))continue;
   for(const req of item.requirements.filter(isRecord)){
    if(req.requirement!=='expected_quality'||req.status!=='satisfied'||!Array.isArray(req.claims))continue;
    for(const claim of req.claims.filter(isRecord)){
     if(claim.item!==item.item||claim.requirement!=='expected_quality'||!isRecord(claim.statement)||claim.statement.code!=='expected_quality'||!isRecord(claim.statement.data)||!isRecord(claim.qualifier)||claim.qualifier.nature!=='judgment'||!isRecord(claim.warrant)||claim.warrant.producer!=='model'||!isRecord(claim.validity)||claim.validity.status!=='valid'||!Array.isArray(claim.validity.bound)||!claim.validity.bound.includes(view.root)||!claim.validity.bound.includes(original.source))continue;
     const d=claim.statement.data,refs=d.expected_references;
     if(d.schema!=='expected-quality@1'||typeof d.vague!=='boolean'||d.source_sha256!==original.source||!Number.isSafeInteger(d.expected_count)||Number(d.expected_count)<1||!Array.isArray(refs)||refs.length!==d.expected_count||new Set(refs).size!==refs.length||!Array.isArray(claim.grounds)||!Array.isArray(claim.resolutions))continue;
     const grounds=claim.grounds,resolutions=claim.resolutions;
     if(!refs.every(ref=>typeof ref==='string'&&ref.startsWith(`src:${original.source}/kityminder@1/`)&&grounds.includes(ref)&&resolutions.some(r=>isRecord(r)&&r.resolution==='resolved'&&typeof r.text==='string'&&r.text.length>0&&Array.isArray(r.references)&&r.references.includes(ref))))continue;
     const answer=answers.get(item.location)??{values:new Set<boolean>(),sources:new Set<string>()};answer.values.add(d.vague);answer.sources.add('rec:'+meta.record);answers.set(item.location,answer);
    }
   }
  }
 }
 for(const group of groups){let judged=0,vague=0,conflicted=0;const sources=new Set<string>();
  for(const [location,answer] of answers){if(cases.get(location)?.group!==group.id)continue;for(const ref of answer.sources)sources.add(ref);if(answer.values.size!==1){conflicted++;continue;}judged++;if(answer.values.has(true))vague++;}
  // Inconsistent joins cannot establish judgments for this group; retain the missing coverage instead of clamping.
  if(judged>group.counts.cases){judged=0;vague=0;conflicted=0;sources.clear();}
  group.quality={judged,unjudged:group.counts.cases-judged,conflicted,sources:[...sources].sort()};group.counts.vague=vague;group.ratios.vague={num:vague,den:judged};group.display.vague=judged===0?null:Math.round(vague/judged*10000)/10000;
 }
}
