// Legacy exported utility, not a check in this workflow. Author labels are read only from bound original nodes.
// Model judgments are accepted through template-gap's submit_result checks; this utility cannot establish acceptance.
import POLICY from '../tables/template-v3-coverage.json' with { type: 'json' };
import { failure, guarded, isRecord } from './common.ts';
import type { ClassificationStatus } from '../../../../contracts/generated/vocabulary.ts';
import type { CategoryFact, CoverageSkip } from './types.ts';
export type Template = { schema:'case-review.template@2';id:string;origin:string;description?:string;categories:Array<{id:string;label:string;group:string;description:string}> };
export type CoverageOutput = {template:string;required:string[];covered:string[];missing:string[];skipped:CoverageSkip[];categories:CategoryFact[];classification_status:ClassificationStatus;unclassified:string[];warnings:[]};
function readTemplate(value:unknown):Template|string{
 if(!isRecord(value)||value.schema!=='case-review.template@2'||typeof value.id!=='string'||!value.id.length||typeof value.origin!=='string'||!value.origin.trim()||!Array.isArray(value.categories)||!value.categories.length)return '缺少 schema、id、origin 或 categories';
 if(Object.keys(value).some(k=>!['schema','id','origin','description','categories'].includes(k)))return '模板含未声明字段';
 const seen=new Set<string>();
 for(const c of value.categories){if(!isRecord(c)||Object.keys(c).some(k=>!['id','label','group','description'].includes(k))||!['id','label','group','description'].every(k=>typeof c[k]==='string'&&(c[k] as string).length>0)||seen.has(c.id as string))return '类别只允许唯一 id、label、group、description';seen.add(c.id as string);}
 return value as Template;
}
export function templateCoverage(input:unknown):CoverageOutput|ReturnType<typeof failure>{
 if(!isRecord(input)||!Array.isArray(input.items))return failure('invalid_input','输入里没有 items 数组','传入条目、描述性模板和 Hub 已绑定的 inputs 原件解析树');
 const template=readTemplate(input.template);if(typeof template==='string')return failure('template_invalid',`模板表不可用：${template}`,'使用 tables/template-v3.json 的描述性闭集声明');
 if(input.judgments!==undefined)return failure('invalid_input','这个工具不能把调用方提供的模型主张当作已受理判断','在 template-gap 运行中提交 CategoryJudgment，由 Hub 核验原件身份、逐字引文和用例归属');
 const known=new Set(template.categories.map(c=>c.id)),members=new Map<string,Set<string>>(),unclassified:string[]=[];
 const sources=Array.isArray(input.inputs)?input.inputs.filter(isRecord):[];
 for(const item of input.items){
  if(!isRecord(item)||typeof item.id!=='string'||!isRecord(item.fields))return failure('invalid_input','条目缺少 id 或 fields','传入完整投影条目；不能把未读条目从覆盖范围里删掉');
  const fields=item.fields;
  const matches=sources.filter(s=>{if(s.parser!=='kityminder@1'||!isRecord(s.model)||!Array.isArray(s.model.nodes))return false;const id=typeof s.external==='string'?s.external.split(':').slice(2).join(':').split('@')[0]:typeof s.sha256==='string'?`upload-${s.sha256.slice(0,12)}`:null;return id===fields.document;});
  let raw:unknown=undefined;
  if(matches.length===1){const model=matches[0].model as {nodes:unknown[]};const nodes=model.nodes.filter(n=>isRecord(n)&&n.selector===(isRecord(item.location)?item.location.selector:fields.node));if(nodes.length===1&&isRecord(nodes[0])&&isRecord(nodes[0].data))raw=nodes[0].data.category_ids;}
  if(raw===undefined){unclassified.push(item.id);members.set(item.id,new Set());continue;}
  if(!Array.isArray(raw)||raw.length<1||raw.length>256||!raw.every(id=>typeof id==='string'&&known.has(id)))return failure('invalid_input',`用例 ${item.id} 的 category_ids 不符合闭集声明`,'category_ids 每项必须精确等于模板 id；不改大小写、不去空白、不映射测试类型标签');
  members.set(item.id,new Set(raw as string[]));
 }
 const skipped:CoverageSkip[]=[];
 if(input.skipped!==undefined&&!Array.isArray(input.skipped))return failure('invalid_input','skipped 不是数组','按类别编号和用户给出的非空理由声明跳过');
 for(const skip of (input.skipped??[]) as unknown[]){if(!isRecord(skip)||typeof skip.category!=='string'||!known.has(skip.category)||typeof skip.reason!=='string'||!skip.reason.trim()||skipped.some(s=>s.category===skip.category))return failure('invalid_input','跳过声明的类别、理由或唯一性不成立','每个已知类别只声明一次，并照用户原话写明理由');skipped.push({category:skip.category,reason:skip.reason});}
 const categories=template.categories.map(c=>{const evidence=[...members].filter(([,ids])=>ids.has(c.id)).map(([id])=>id).sort();return{id:c.id,label:c.label,group:c.group,required:POLICY.required.values.includes(c.id),present:evidence.length>0,count:evidence.length,evidence:evidence.slice(0,50)};});
 return {template:template.id,required:categories.filter(c=>c.required).map(c=>c.id),covered:categories.filter(c=>c.present).map(c=>c.id),missing:unclassified.length?[]:categories.filter(c=>c.required&&!c.present&&!skipped.some(s=>s.category===c.id)).map(c=>c.id),skipped,categories,classification_status:unclassified.length?'unclassified':'classified',unclassified:unclassified.sort(),warnings:[]};
}
export default function (input: unknown): unknown { return guarded(() => templateCoverage(input)); }
