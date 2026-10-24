// Exact author resource values only. This check supplies no semantic category judgment.
import type {CheckOutcome} from '../../../../contracts/src/tables.ts';
import {declareResourceTags,RESOURCE_TAG_TABLE} from './generated/vocabulary.ts';
import {isRecord} from './common.ts';
export default function(input:unknown):CheckOutcome[]{
 const subject=isRecord(input)&&isRecord(input.subject)?input.subject:{};
 const fields=isRecord(subject.fields)?subject.fields:{};
 const own=typeof subject.item==='string'?{item:subject.item}:{};
 const grounds=typeof subject.location==='string'?[subject.location]:[];
 if(!Array.isArray(fields.case_resources))return [{verdict:'unknown',reason:'missing_input',tier:'advisory',...own,grounds,missing:'缺少新投影保存的逐用例 resource 原始声明',statement:'缺少逐用例标签声明；下一步用新包从原件重新开运行'}];
 const invalid:Array<{case:string;index:number|null;raw:unknown;allowed:readonly string[]}>=[];let missing=0;
 for(const row of fields.case_resources){
  if(!isRecord(row)||typeof row.case!=='string')continue;
  const declaration=declareResourceTags(row.present===false?undefined:row.resource);
  invalid.push(...declaration.issues.map(issue=>({case:row.case as string,...issue})));
  if(declaration.status==='undeclared')missing++;
 }
 const out:CheckOutcome[]=[];
 if(invalid.length)out.push({verdict:'refute',code:'template-gap.undeclared_tag',tier:'advisory',...own,grounds,pointer:'/fields/case_resources',statement:`未声明的标签 ${invalid.length} 处；允许的精确原文：${invalid[0].allowed.join('、')}。作者选择闭集原文修正 resource 后重新核验`,data:{table:RESOURCE_TAG_TABLE,total:invalid.length,issues:invalid.slice(0,20),shown:Math.min(20,invalid.length)}});
 if(missing)out.push({verdict:'unknown',reason:'missing_input',tier:'advisory',...own,grounds,missing:`${missing} 个用例缺少有效测试类型声明`,statement:`${missing} 个用例缺少有效测试类型声明；下一步作者按发布闭集补 resource 后重新核验，未声明不算没有某类用例`});
 if(!out.length)out.push({verdict:'support',tier:'advisory',...own,grounds,statement:'每个用例的 resource 都是发布闭集的精确原文，测试类型已声明',data:{table:RESOURCE_TAG_TABLE,checked:fields.case_resources.length}});
 return out;
}
