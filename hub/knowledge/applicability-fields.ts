// View-only states. Author declarations and admitted model claims remain separate and never alter entry content.
import {APPLICABILITY_FIELD,isDeclarationStatus} from '../../contracts/generated/vocabulary.ts';
import type {Applicability} from '../../contracts/src/product.ts';
import type {ApplicabilityFields,KnowledgeContributionPageView} from '../../contracts/src/contributions.ts';
import {canonicalize,sha256Hex} from '../records/api.ts';
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export function applicabilityFields(data:Record<string,unknown>,value:Applicability|null):ApplicabilityFields {
 const marker=object(data.applicability_state)&&data.applicability_state.schema==='applicability-state@1'?data.applicability_state:null;
 const known=marker&&isDeclarationStatus(marker.declaration_status)&&Array.isArray(marker.declared_fields)&&marker.declared_fields.every(f=>(APPLICABILITY_FIELD as readonly unknown[]).includes(f));
 return Object.fromEntries(APPLICABILITY_FIELD.map(field=>[field,{declaration_status:known?(marker!.declared_fields as string[]).includes(field)?'declared':'undeclared':null,judgment_status:'unjudged',declaration_value:known?value?.[field]??null:null,judgments:[],conflicted:Array.isArray(marker?.conflicted_fields)&&marker!.conflicted_fields.includes(field),...(known?{}:{...(value?.[field]===undefined?{}:{legacy_value:value[field]}),missing:'结构化声明出处尚未核验'}),next_action:'按需由作者补结构声明，或在 knowledge-contribution 运行提交本条目的条件主张及逐字引文'}])) as unknown as ApplicabilityFields;
}
const criteriaCache=new WeakMap<object,{inventory:readonly {name:string}[];value:string}>();
export function applicabilityCriterion(context:{grammar:string;closed_sets:Partial<Record<string,string[]>>}|undefined,inventory:readonly {name:string}[]|undefined):string|null {
 if(!context||!inventory)return null;
 const saved=criteriaCache.get(context);if(saved?.inventory===inventory)return saved.value;
 const lists=Object.fromEntries(APPLICABILITY_FIELD.filter(field=>field!=='memory'&&field!=='builds').map(field=>[field,[...new Set(context.closed_sets[field]??[])].sort()]));
 const value=sha256Hex(canonicalize({grammar:context.grammar,closed_sets:lists,known_builds:[...new Set(inventory.map(r=>r.name))].sort()}));criteriaCache.set(context,{inventory,value});return value;
}
export function applyApplicabilityJudgments(entry:{entry:string;applicability_fields?:ApplicabilityFields;applicability_context?:{composition:string|null;criteria_digest:string|null}},views:KnowledgeContributionPageView[],complete:boolean):void {
 const fields=entry.applicability_fields;if(!fields)return;
 const unread=views.some(v=>v.contribution===undefined||v.status==='credential_unreadable'&&v.contribution.kind==='applicability_claim');
 for(const field of APPLICABILITY_FIELD){const refs:string[]=[];const values=new Set<string>();
  for(const view of views){if(view.status!=='valid'||!view.contribution||!('statement'in view.contribution))continue;const c=view.contribution,p=c.applicability_claim;
   if(c.kind!=='applicability_claim'||!p||p.entry!==entry.entry||p.field!==field||p.admission.composition!==entry.applicability_context?.composition||p.admission.criteria_digest!==entry.applicability_context?.criteria_digest)continue;
   refs.push(view.record);values.add(canonicalize(p.value));
  }
  fields[field].judgments=[...new Set(refs)].sort();fields[field].judgment_status=refs.length?'judged':complete&&!unread?'unjudged':null;
  fields[field].conflicted ||= values.size>1;
  if(!complete||unread)fields[field].missing='本节点回注尚未完全核读；下一步按 next 续读或由管理员恢复保留来源，再逐字段核对';
 }
}
