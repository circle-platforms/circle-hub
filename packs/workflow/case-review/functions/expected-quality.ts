// Model judgment admission only: exact expected-leaf ownership, source identity and verbatim evidence.
import type {CheckOutcome} from '../../../../contracts/src/tables.ts';
import {isRecord} from './common.ts';
export function expectedQuality(input:unknown):CheckOutcome[]{
 const raw=isRecord(input)?input:{},s=isRecord(raw.subject)?raw.subject:{},fields=isRecord(s.fields)?s.fields:{},slots=isRecord(s.slots)?s.slots:{};
 const own=typeof s.item==='string'?{item:s.item}:{};const sources=isRecord(raw.sources)?raw.sources:{};
 const bad=(message:string):CheckOutcome[]=>[{verdict:'refute',code:'case-review.quote_missing',statement:message,grounds:[],tier:'blocking',...own}];
 const location=typeof s.location==='string'?s.location:'';const at=location.indexOf('/kityminder@1/');
 const expected=Array.isArray(fields.expected)?fields.expected:[],selectors=Array.isArray(fields.expectedSelectors)?fields.expectedSelectors:[];
 if(at<0||!expected.length||fields.expectedCount!==expected.length||selectors.length!==expected.length||expected.some(v=>typeof v!=='string'||v===''))return [{verdict:'unknown',reason:'missing_input',missing:'完整的期望叶子文字和位置；下一步由客户端补读当前脑图的全部期望叶子，再提交判断',statement:'期望质量未判断：缺完整期望叶子及位置；下一步补读当前脑图后重交',grounds:[],tier:'blocking',...own}];
 const base=location.slice(0,at)+'/kityminder@1/';const expectedRefs=selectors.map(v=>base+v);
 const claims=Array.isArray(slots.expected_quality)?slots.expected_quality:[];
 if(claims.length===0)return [{verdict:'unknown',reason:'missing_input',missing:'本用例全部期望的模型质量判断；下一步由运行者补交 expected_quality 主张和全部期望叶子的逐字引文',statement:'期望质量未判断；下一步补交模型判断及逐字引文',grounds:[],tier:'blocking',...own}];
 if(claims.length!==1||!isRecord(claims[0]))return bad('每个用例提交恰好一条期望质量判断，并逐字引用全部期望叶子');
 const c=claims[0],data=isRecord(c.data)?c.data:{},quotes=Array.isArray(c.quotes)?c.quotes:[];
 if(c.code!=='expected_quality'||data.schema!=='expected-quality@1'||typeof data.vague!=='boolean'||data.source_sha256!==location.slice(4,at)||data.expected_count!==expected.length||!Array.isArray(data.expected_references)||JSON.stringify(data.expected_references)!==JSON.stringify(expectedRefs)||quotes.length!==expected.length)return bad('期望质量槽位的原件、条目期望数或引用身份不一致；按本用例全部期望叶子修正');
 for(let i=0;i<expected.length;i++){if(typeof sources[expectedRefs[i]]!=='string')return [{verdict:'unknown',reason:'missing_input',missing:'期望原文 '+expectedRefs[i]+' 的可读字节；下一步运行者补读该叶子后重交',statement:'期望质量未判断：对应原件不可读；下一步补读原件后重交',grounds:[],tier:'blocking',...own}];const q=quotes[i];if(!isRecord(q)||q.reference!==expectedRefs[i]||q.text!==expected[i]||sources[expectedRefs[i]]!==q.text)return bad('期望质量的引文必须逐字等于本用例对应期望叶子原文，不能引用祖先、兄弟或正规化后的文字');}
 return [{verdict:'support',statement:'期望质量主张的原件、全部叶子位置和逐字引文已核；语义仍为模型判断',grounds:expectedRefs,tier:'blocking',...own}];
}
export default expectedQuality;
