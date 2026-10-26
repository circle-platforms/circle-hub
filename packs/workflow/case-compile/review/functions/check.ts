// Content acceptance is the independent reviewer's judgment; the function checks form and the original literal quote.
const object=(value:unknown):value is Record<string,any>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
export default function(input:any):unknown{
 const item=input.subject??{},criterion=item.fields?.criterion,claims=item.slots?.review;
 const bad=(statement:string)=>[{verdict:'refute',code:'case-compile-criterion-review.form',statement,grounds:[],tier:'blocking'}];
 if(!object(criterion)||!Array.isArray(claims)||claims.length!==1)return bad('每条类型化判据要有唯一复核判断');
 const claim=claims[0];if(!object(claim)||(claim.code!=='accept'&&claim.code!=='reject')||typeof claim.data?.reason!=='string'||!claim.data.reason.trim()||claim.location!==item.location)return bad('复核必须指向原声明、明确接受/拒绝并有理由');
 if(!Array.isArray(claim.quotes)||!claim.quotes.some((quote:any)=>quote.reference===criterion.quote?.reference&&quote.text===criterion.quote?.text))return bad('复核必须逐字引用原判据所引的作者期望');
 const original=input.sources?.[criterion.quote.reference];
 if(typeof original!=='string')return [{verdict:'unknown',reason:'missing_input',missing:'缺作者期望的可读原件；下一步：绑定 evidence，或由有读权的非作者账号复核',statement:'作者期望引文尚未可读',grounds:[],tier:'blocking'}];
 if(!original.includes(criterion.quote.text))return bad('复核的引文不在实际读取的作者原件中');
 return [{verdict:'support',statement:'类型化判据复核的身份、引文与判断形状已核对；语义接受属于复核判断',grounds:[item.location,criterion.quote.reference],tier:'blocking',data:{accepted:claim.code==='accept',criterion:criterion.id}}];
}
