// Native release-notes@2 JSON only. Heading words and filenames never establish release status or identity.
import PRODUCT from '../product.json' with {type:'json'};
import {isReleaseStatus} from './generated/vocabulary.ts';
import type {ReleaseResult,Family} from './types.ts';
import {isRecord} from './util.ts';
export function produceReleaseEntries(model:unknown,expectedBuild:string|null=null):ReleaseResult {
 const out:ReleaseResult={product:null,version:null,build:null,released:null,entries:[],warnings:[],complete:false};
 const missing=(fact:string)=>out.warnings.push('缺失事实：'+fact+'；下一步：发布页或缺陷系统维护者在来源原件发布 release-notes@2 的显式结构字段，重新读取并重产新根');
 if(!isRecord(model)||model.schema!=='release-notes@2'||model.complete!==true||!Array.isArray(model.defects)){missing('完整的 release-notes@2 JSON 与 defects 数组；HTML/Markdown 标题不能补状态');return out;}
 if(typeof model.product!=='string'||!PRODUCT.names.includes(model.product)){missing('精确等于产品包 names 声明的 product 字段');return out;}
 out.product=model.product as Family;
 if(typeof model.build!=='string'||!model.build.length||expectedBuild!==null&&model.build!==expectedBuild){missing('与锁定构建完全相等的 build 字段');return out;}out.build=model.build;
 if(typeof model.version==='string'&&/^[0-9]+(?:\.[0-9]+){1,3}$/.test(model.version))out.version=model.version;
 if(typeof model.released==='string'&&/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(model.released)){const date=new Date(model.released+'T00:00:00Z');if(Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===model.released)out.released=model.released;}
 if(model.defects.length>10000){missing('不超过 10000 行的完整分片及其清单');return out;}
 let complete=true;
 for(const [i,row]of model.defects.entries()){
  if(!isRecord(row)||typeof row.bug!=='string'||!row.bug.length||row.bug.length>200||!isReleaseStatus(row.status)||typeof row.text!=='string'||!row.text.length){complete=false;missing(`defects/${i} 的 bug、发布 status 闭集字段及原文 text`);continue;}
  const data:Record<string,unknown>={bug:row.bug,status:row.status,text:row.text,build:out.build,module:typeof row.module==='string'?row.module:null,...(typeof row.system==='string'?{system:row.system}:{})};
  out.entries.push({kind:'defect',path:null,statement:row.text,data,applicability:{builds:[out.build]},fragments:[{parser:'json@1',selector:'p/defects/'+i},{parser:'json@1',selector:'p/product'},{parser:'json@1',selector:'p/build'}]});
 }
 out.complete=complete;return out;
}
export default function releaseNotes(input:unknown):ReleaseResult{return produceReleaseEntries(isRecord(input)&&isRecord(input.model)?input.model:input);}
