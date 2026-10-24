// The core supplies eligible request positions after checking the bound record kind and predecessor.
export default function(input:any):unknown{
 const bound=input.inputs?.find((value:any)=>value.slot==='declaration'),context=input.context?.criterion_review;
 const submission=bound?.model?.body;
 if(!context||!Array.isArray(submission?.criterion_changes))return {error:{code:'criterion-review.declaration_missing',message:'缺少原提交中的判据变更声明',fix:'显式绑定判断请求所指的提交 rec:，predecessor 写声明运行'},warnings:[]};
 const items=[];
 for(const eligible of context.declarations){
  const index=Number(eligible.pointer.slice('/criterion_changes/'.length)),change=submission.criterion_changes[index];
  if(!change)return {error:{code:'criterion-review.declaration_missing',message:'请求指向的声明不在原提交里',fix:'按请求的 source 和 declaration 重新绑定，不能换成结果或上传副本'},warnings:[]};
  items.push({id:'criterion-'+index,label:change.assertion,summary:'判据变更声明，等待账号主人确认',location:{slot:'declaration',parser:'json@1',selector:'p/body/criterion_changes/'+index},fields:{...change,declaration:eligible.pointer,request:eligible.request}});
 }
 return {items,warnings:[]};
}
