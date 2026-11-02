// Knowledge, memory and their dialogs share compact factual presentation.
import {uiLabelOf,type KnowledgeEntryStatus,type MemoryStatus} from '../../../contracts/generated/vocabulary.ts';
import {html,type Html} from './html.ts';
import {count,when,type Tone} from './ui.ts';
import {badge as chip} from './presentation.ts';

const knowledgeTones={verified:'pass',unverified:'plain',withdrawn:'fail',superseded:'incomplete'} satisfies Record<KnowledgeEntryStatus,Tone|'plain'>;
const memoryTones={enabled:'pass',disabled:'plain',superseded:'incomplete'} satisfies Record<MemoryStatus,Tone|'plain'>;
export const knowledgeState=(state:KnowledgeEntryStatus)=>chip(uiLabelOf('knowledge_entry_status',state),knowledgeTones[state]);
export const memoryState=(state:MemoryStatus)=>chip(uiLabelOf('memory_status',state),memoryTones[state]);
export const number=(value:number):Html=>html`<span class="num nowrap">${count(value)}</span>`;
export function size(value:number):string{
 const units=['B','KB','MB','GB','TB'];let unit=0;
 while(value>=1024&&unit<units.length-1){value/=1024;unit++;}
 return value.toLocaleString('en-US',{maximumFractionDigits:unit&&value<10?1:0})+' '+units[unit];
}
export const minute=(iso:string|null|undefined)=>when(iso).slice(0,16);
export const timestamp=(iso:string|null|undefined):Html=>html`<time class="nowrap ch-time"${iso?html` datetime="${iso}" title="${when(iso)}"`:''}>${minute(iso)}</time>`;
export const versionName=(at:string,reason?:string,ordinal?:number)=>'版本'+(ordinal===undefined?'':' '+count(ordinal))+' · '+minute(at)+(reason?' · '+reason:'');
export const versionLabel=(at:string,reason?:string,ordinal?:number):Html=>html`<span class="nowrap">${versionName(at,undefined,ordinal)}</span>${reason?html` · ${reason}`:''}`;
