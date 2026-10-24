// Form and source-family check only. Acceptance of the criterion is the account owner's judgment.
const object=(value:any)=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const root=(reference:string)=>/^(?:src|rec|tree):[a-f0-9]{64}/.exec(reference)?.[0]??null;
export default function(input:any):unknown{
 const subject=input.subject??{},item=subject,fields=item.fields??{},claims=subject.slots?.review;
 const bad=(message:string)=>[{verdict:'refute',code:'criterion-review.form',statement:message,grounds:[],tier:'blocking'}];
 if(!Array.isArray(claims)||claims.length!==1)return bad('每条声明必须有且只有一条接受或不接受的确认');
 const claim=claims[0];
 if(!object(claim)||!['accept','reject'].includes(claim.code)||typeof claim.data?.reason!=='string'||!claim.data.reason.trim()||claim.location!==item.location)return bad('确认必须指向本条声明，带接受与否和非空理由');
 if(!Array.isArray(claim.quotes)||!claim.quotes.length)return bad('确认必须附本声明期望来源的引文');
 const allowed=new Set([fields.criterion,...(fields.grounds??[]).map((value:any)=>value.reference)].filter((value:any)=>typeof value==='string').map(root));allowed.delete(null);
 for(const quote of claim.quotes){
  if(typeof quote?.reference!=='string'||typeof quote.text!=='string'||!quote.text.trim()||!allowed.has(root(quote.reference)))return bad('复核引文只能取声明所引的期望来源，不得换成被判对象或无关来源');
  if(typeof input.sources?.[quote.reference]!=='string')return [{verdict:'unknown',reason:'missing_input',missing:'缺少复核引文的可读原件 '+quote.reference+'；下一步：src 以原件根引用补绑 evidence，rec 可带片段，引文保留原片段；缺读权时由管理员授权或有权的非作者复核',statement:'缺少复核引文的可读原件；绑定或授权后重开复核运行',grounds:[],tier:'blocking'}];
 }
 return [{verdict:'support',statement:claim.code==='accept'?'账号确认接受判据变更':'账号确认不接受判据变更',grounds:[item.location,...claim.quotes.map((quote:any)=>quote.reference)],tier:'blocking',data:{criterion_review:{accepted:claim.code==='accept',reason:claim.data.reason}}}];
}
