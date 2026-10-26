// Read a real Hub submission, never an uploaded imitation of a validation record.
import CRITERION from '../tables/criterion.schema.json' with {type:'json'};
import {schema} from './schema.ts';
const object=(value:unknown):value is Record<string,any>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
export default function(input:any):unknown{
 const bound=input.inputs?.find((value:any)=>value.slot==='declaration'),record=bound?.model,submission=record?.body;
 const fail=(message:string)=>({error:{code:'case-compile-criterion-review.declaration',message,fix:'绑定原 case-compile 提交的 rec:，以原声明运行为 predecessor；不上传副本'},warnings:[]});
 if(bound?.external!==null||bound?.meta?.pointer!==undefined||bound?.meta?.kind!=='submission'||typeof bound?.meta?.record!=='string'||record?.kind!=='submission'||typeof submission?.run!=='string'||!Array.isArray(submission.items))return fail('缺真实 Hub 提交记录');
 const items=[];
 for(const [itemIndex,item]of submission.items.entries()){
  const plans=item?.handling==='handled'?item.slots?.plan:null;if(!Array.isArray(plans)||plans.length!==1)continue;
  const declarations=plans[0]?.data?.criteria;if(!Array.isArray(declarations))continue;
  for(const [index,criterion]of declarations.entries()){
   if(!schema(CRITERION).safeParse(criterion).success)return fail('原提交的类型化判据缺结构字段');
   items.push({id:submission.run+':'+criterion.id,label:criterion.id,location:{slot:'declaration',parser:'json@1',selector:`p/body/items/${itemIndex}/slots/plan/0/data/criteria/${index}`},fields:{criterion,author_run:submission.run,declaration:'rec:'+bound.meta.record}});
  }
 }
 return items.length?{items,warnings:[]} :fail('原提交没有类型化判据声明');
}
