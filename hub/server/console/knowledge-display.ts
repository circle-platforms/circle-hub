// Knowledge, memory and their dialogs share compact factual presentation.
import {uiLabelOf,type KnowledgeEntryStatus,type MemoryStatus,type ProvenanceType,type SourceAttributionStatus} from '../../../contracts/generated/vocabulary.ts';
import {html,type Html} from './html.ts';
import {count,fullTime,type Tone} from './ui.ts';
import {hoverTime,relativeTime} from './format.ts';
import {badge as chip,tooltip} from './presentation.ts';

const knowledgeTones={verified:'pass',unverified:'plain',withdrawn:'fail',superseded:'incomplete'} satisfies Record<KnowledgeEntryStatus,Tone|'plain'>;
const memoryTones={enabled:'pass',disabled:'plain',superseded:'incomplete'} satisfies Record<MemoryStatus,Tone|'plain'>;
/** What the verified status covers, beside the status itself: the quotation and path were checked verbatim; the statement is not thereby a fact (issue 227). */
export const VERIFIED_SCOPE='已逐字核对来源引文与路径，不代表陈述已获事实确认。';
export const knowledgeState=(state:KnowledgeEntryStatus)=>{
 const status=chip(uiLabelOf('knowledge_entry_status',state),knowledgeTones[state]);
 return state==='verified'?tooltip(status,VERIFIED_SCOPE):status;
};
export const memoryState=(state:MemoryStatus)=>chip(uiLabelOf('memory_status',state),memoryTones[state]);
export const number=(value:number):Html=>html`<span class="num nowrap">${count(value)}</span>`;
import {size} from './format.ts';
export {size};
/** A byte count in the console's one unit style (1024-based B, KB, MB, …) with the exact count in the tooltip (issue 244). */
export const exactSize=(bytes:number):Html=>html`<span class="nowrap" title="${count(bytes)} 字节">${size(bytes)}</span>`;
export {time as timestamp} from './format.ts';
export const minute=(iso:string|null|undefined)=>fullTime(iso).slice(0,16);
/** Which version a numbered version is (wording table, W38): a bare 版本 3 does not say whether it is the knowledge's, a memory's, a workflow's or a product's. */
export type VersionKind='知识版本'|'记忆版本';
export const versionName=(kind:VersionKind,at:string,reason?:string,ordinal?:number)=>kind+(ordinal===undefined?'':' '+count(ordinal))+' · '+relativeTime(at)+(reason?' · '+reason:'');
export const versionLabel=(kind:VersionKind,at:string,reason?:string,ordinal?:number):Html=>html`<span class="nowrap" title="${hoverTime(at)}">${versionName(kind,at,undefined,ordinal)}</span>${reason?html` · ${reason}`:''}`;
/** What the source type 声明 means: who provided the bytes and what was not collected independently (issue 228). */
export const DECLARED_SCOPE='内容由上传的人提供，Hub 没有独立采集的证明；不代表内容已被核实。';
/** What the team-source status says, apart from who uploaded the original: the confirmation is the uploader's, and it is neither a digital signature nor a copyright transfer. */
export const ATTRIBUTION_SCOPE={
 unsigned:'上传人尚未确认这份原文可作为团队来源；未确认的上传不会被团队知识接收。与上传人是谁无关。',
 attributed:'上传人已确认这份原文可作为团队来源，全体成员可读。这里的确认不是数字签名，也不转让版权；确认人和时间见下。',
} as const satisfies Record<SourceAttributionStatus,string>;
export const sourceTypeLabel=(type:ProvenanceType):Html|string=>{const label=uiLabelOf('provenance_type',type);return type==='declared'?tooltip(label,DECLARED_SCOPE):label;};
export const attributionBadge=(status:SourceAttributionStatus):Html=>tooltip(chip(uiLabelOf('source_attribution_status',status),status==='attributed'?'pass':'plain'),ATTRIBUTION_SCOPE[status]);
