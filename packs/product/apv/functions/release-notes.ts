// Status is an explicit source declaration. Missing status affects the defect, never unrelated build sources.
import PRODUCT from '../product.json' with {type:'json'};
import {isReleaseStatus} from './generated/vocabulary.ts';
import type {ReleaseResult,Family,ProducedEntry} from './types.ts';
import {isRecord} from './util.ts';
export const STATUS_MISSING='发布说明缺陷条目的原始 release-notes@2 status（或缺陷系统的显式结构状态）';
export const STATUS_NEXT='发布页或缺陷系统维护者补原始结构状态和所属构建，重新读取该来源并重产；依赖已修复状态的要求项在补齐前保持未知，命令树和手册可继续使用';
export function undeclaredReleaseEntry(build:string|null,parser:string,selector:string,text:string,bug:string|null=null,system?:string,missing=STATUS_MISSING):ProducedEntry{
 return {kind:'defect',path:null,statement:text||'发布说明缺陷身份或状态未声明',data:{bug,status:null,declaration_status:'undeclared',...(bug===null?{identity_declaration_status:'undeclared'}:{}),text,build,...(system?{system}:{}),missing,next_action:STATUS_NEXT},applicability:build===null?null:{builds:[build]},fragments:[{parser,selector}]};
}
export function produceReleaseEntries(model:unknown,expectedBuild:string|null=null):ReleaseResult {
 const out:ReleaseResult={product:null,version:null,build:expectedBuild,released:null,entries:[],warnings:[],complete:false};
 const gap=(fact:string)=>{out.entries.push(undeclaredReleaseEntry(expectedBuild,'json@1','p','发布说明缺陷身份或状态未声明',null,undefined,fact));out.warnings.push(fact+'；下一步：'+STATUS_NEXT);return out;};
 if(!isRecord(model)||model.schema!=='release-notes@2'||!Array.isArray(model.defects))return gap('缺完整 release-notes@2 的结构化缺陷清单，不能从正文推断身份或状态');
 if(typeof model.product!=='string'||!PRODUCT.names.includes(model.product))return gap('缺精确等于产品包 names 声明的 product 字段');out.product=model.product as Family;
 if(typeof model.build!=='string'||!model.build.length||expectedBuild!==null&&model.build!==expectedBuild)return gap('缺与锁定构建完全相等的 build 字段');out.build=model.build;
 if(typeof model.version==='string'&&/^[0-9]+(?:\.[0-9]+){1,3}$/.test(model.version))out.version=model.version;
 if(typeof model.released==='string'&&/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(model.released)){const date=new Date(model.released+'T00:00:00Z');if(Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===model.released)out.released=model.released;}
 if(model.defects.length>10000)return gap('缺不超过 10000 行的完整分片及清单');
 for(const [i,row]of model.defects.entries()){
  const bug=isRecord(row)&&typeof row.bug==='string'&&row.bug.length>0&&row.bug.length<=200?row.bug:null;
  const text=isRecord(row)&&typeof row.text==='string'?row.text:'';
  if(!isRecord(row)||bug===null||!isReleaseStatus(row.status)){const missing=bug===null?'defects/'+i+' 缺原始结构 bug 身份及 status':STATUS_MISSING+'：defects/'+i;const entry=undeclaredReleaseEntry(out.build,'json@1','p/defects/'+i,text,bug,isRecord(row)&&typeof row.system==='string'?row.system:undefined,missing);if(isRecord(row)&&Object.hasOwn(row,'status'))entry.data.raw_status=row.status;out.entries.push(entry);out.warnings.push(missing+'；下一步：'+STATUS_NEXT);continue;}
  out.entries.push({kind:'defect',path:null,statement:text||'缺陷 '+bug+'：原始结构状态 '+row.status,data:{bug,status:row.status,declaration_status:'declared',text,build:out.build,module:typeof row.module==='string'?row.module:null,...(typeof row.system==='string'?{system:row.system}:{})},applicability:{builds:[out.build]},fragments:[{parser:'json@1',selector:'p/defects/'+i},{parser:'json@1',selector:'p/product'},{parser:'json@1',selector:'p/build'}]});
 }
 out.complete=model.complete===true;
 if(!out.complete){out.entries.push(undeclaredReleaseEntry(out.build,'json@1','p','发布说明缺陷范围未声明完整',null,undefined,'缺原始 complete:true，当前清单不能证明缺陷范围完整'));out.warnings.push('发布说明缺完整范围；下一步：'+STATUS_NEXT);}
 return out;
}
export default function releaseNotes(input:unknown):ReleaseResult{return produceReleaseEntries(isRecord(input)&&isRecord(input.model)?input.model:input);}
