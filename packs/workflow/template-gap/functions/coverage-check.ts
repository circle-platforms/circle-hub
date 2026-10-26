import TABLE from '../tables/template-v3.json' with {type:'json'};
import type { CheckOutcome } from '../../../../contracts/src/tables.ts';
import { classify, type Classification } from './classification.ts';
import { readTemplate, categoryFacts } from './template.ts';
import { casesOf } from './cases.ts';
import { isRecord, warningSink } from './common.ts';
export function checkedClassification(subject:Record<string,unknown>,sources:Readonly<Record<string,string>>):Classification{
 const template=readTemplate(TABLE);if(typeof template==='string')throw new Error(template);
 return classify(template,subject.source,typeof subject.document==='string'?subject.document:'',subject.case_rule==='tagged'?'tagged':'marked',subject.claims,sources);
}
export function coverageOutcomes(subject:unknown,sources:Readonly<Record<string,string>>={}):CheckOutcome[]{
 const s=isRecord(subject)?subject:{},item=typeof s.item==='string'?s.item:undefined;
 const base={tier:'advisory' as const,grounds:typeof s.location==='string'?[s.location]:[],...(item?{item}:{})};
 const invalidSkips=s.skipped!==undefined&&(!Array.isArray(s.skipped)||s.skipped.some(skip=>!isRecord(skip)||typeof skip.category!=='string'||!TABLE.categories.some(c=>c.id===skip.category)||typeof skip.reason!=='string'||!skip.reason.trim())||new Set((s.skipped as Array<{category:string}>).map(skip=>skip.category)).size!==(s.skipped as unknown[]).length);
 if(invalidSkips)return[{...base,verdict:'refute',code:'template-gap.category_invalid',statement:'跳过声明的类别、理由或唯一性不成立；按用户原话修正后重新提交',data:{covered:[],next_action:'按闭集编号和用户原话理由修正跳过声明'}}];
 const c=checkedClassification(s,sources);
 const covered=TABLE.categories.filter(category=>c.cases.some(row=>row.categories.includes(category.id))).map(category=>category.id);
 const data={covered,classification_status:c.unclassified.length?'unclassified':'classified',classified:c.cases.length-c.unclassified.length,total:c.cases.length,unclassified:c.unclassified,judgments:c.cases.flatMap(c=>c.judgments),skipped:s.skipped??[],qualifier_marks:c.cases.some(c=>c.judgments.length)?['conditional_on_judgment']:[]};
 if(c.errors.length)return[{...base,verdict:'refute',code:'template-gap.category_invalid',statement:`类别主张的结构、闭集或原件引文核验不成立：${c.errors.join('；')}；按原件修正主张后重新提交`,data:{...data,errors:c.errors,next_action:'修正类别主张后重新提交'}}];
 if(c.missing.length||c.unclassified.length||s.scope_complete!==true){
  const missing=[...c.missing,...c.unclassified.map(id=>`用例 ${id} 的类别判断`),...(s.scope_complete!==true?['本次用例范围的完整解析事实']:[])].join('；');
  return[{...base,verdict:'unknown',reason:'missing_input',missing,statement:`尚不能判断未见类别是否缺失：${missing}；下一步：客户端为未分类用例补 CategoryJudgment 并重新提交，或请作者补 category_ids 后重读；原件读取失败由运行者重读，仍失败交包维护人修复`,data:{...data,missing_categories:[],next_action:'客户端补逐用例类别判断后立即重新提交；作者字段需在原件修正后重新开始运行',recovery:{action:'补分类或原件读取后重新核验',object:{document:s.document},deadline:'本轮最终回报前；补证失败作为设计缺口交集成者 Claude',attempts:1}}}];
 }
 const source=s.source as {model:{nodes:unknown[]}},template=readTemplate(TABLE);if(typeof template==='string')throw new Error(template);
 const document=casesOf(String(s.document),source.model.nodes,warningSink(),{caseRule:s.case_rule==='tagged'?'tagged':'marked'});
 const categories=categoryFacts(template,document,{memberships:new Map(c.cases.map(c=>[c.id,c.categories]))});
 const skips=Array.isArray(s.skipped)?s.skipped.filter(isRecord):[];
 const missing=categories.filter(c=>c.required&&!c.present&&!skips.some(skip=>skip.category===c.id&&typeof skip.reason==='string'&&skip.reason.trim())).map(c=>c.id);
 const details={...data,categories,covered:categories.filter(c=>c.present).map(c=>c.id),missing};
 return [{...base,verdict:missing.length?'refute':'support',...(missing.length?{code:'template-gap.category_shortfall'}:{}),statement:missing.length?`按原件声明或本次引文核验成立的模型分类，在完整用例范围内未覆盖且未声明跳过：${missing.join('、')}`:'按原件声明或本次引文核验成立的模型分类，必选类别均有覆盖或用户明确跳过；引文存在不证明模型分类语义正确',data:details}];
}
export default function(input:unknown):CheckOutcome[]{const raw=isRecord(input)?input:{};return coverageOutcomes(raw.subject,isRecord(raw.sources)?raw.sources as Record<string,string>:{});}
