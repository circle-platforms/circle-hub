// Knowledge, memory and their dialogs share compact factual presentation.
import {uiLabelOf,type KnowledgeEntryStatus,type MemoryStatus} from '../../../contracts/generated/vocabulary.ts';
import {html,type Html} from './html.ts';
import {count,fullTime,type Tone} from './ui.ts';
import {relativeTime} from './format.ts';
import {badge as chip} from './presentation.ts';

const knowledgeTones={verified:'pass',unverified:'plain',withdrawn:'fail',superseded:'incomplete'} satisfies Record<KnowledgeEntryStatus,Tone|'plain'>;
const memoryTones={enabled:'pass',disabled:'plain',superseded:'incomplete'} satisfies Record<MemoryStatus,Tone|'plain'>;
export const knowledgeState=(state:KnowledgeEntryStatus)=>chip(uiLabelOf('knowledge_entry_status',state),knowledgeTones[state]);
export const memoryState=(state:MemoryStatus)=>chip(uiLabelOf('memory_status',state),memoryTones[state]);
export const number=(value:number):Html=>html`<span class="num nowrap">${count(value)}</span>`;
export {size} from './format.ts';
export {time as timestamp} from './format.ts';
export const minute=(iso:string|null|undefined)=>fullTime(iso).slice(0,16);
export const versionName=(at:string,reason?:string,ordinal?:number)=>'版本'+(ordinal===undefined?'':' '+count(ordinal))+' · '+relativeTime(at)+(reason?' · '+reason:'');
export const versionLabel=(at:string,reason?:string,ordinal?:number):Html=>html`<span class="nowrap" title="${fullTime(at)}">${versionName(at,undefined,ordinal)}</span>${reason?html` · ${reason}`:''}`;
