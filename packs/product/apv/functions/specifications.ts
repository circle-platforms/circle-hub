import type {ProducerOutput} from '../../../../contracts/src/product.ts';
import {produceManualEntries} from './manual.ts';
import {documentLines, documentNameOf} from './documents.ts';
import {PRODUCT_LINE} from './naming.ts';
import {isRecord} from './util.ts';
import type {MarkdownModel} from './types.ts';

export const SPEC_LIST = 'manual:spec-list:configured';
/** Same NFKC and case-insensitive name families as documentLines, with ASCII letter boundaries. */
export function productDocument(text: string): boolean {
 const normalized=text.normalize('NFKC').toLowerCase();
 return PRODUCT_LINE.names.some(name=>{const key=name.toLowerCase();let at=normalized.indexOf(key);while(at>=0){if(!/[a-z]/.test(normalized[at-1]??'')&&!/[a-z]/.test(normalized[at+key.length]??''))return true;at=normalized.indexOf(key,at+1);}return false;});
}
export function specificationScope(read:Record<string,unknown>):{fetch:string[];sources?:Record<string,string|string[]>;note:string} {
 if(!Object.hasOwn(read,SPEC_LIST))return {fetch:[SPEC_LIST],note:'规格目录尚未读取；下一步自动读取配置目录清单'};
 const result=read[SPEC_LIST];
 if(!isRecord(result)||result.ok!==true||result.parser!=='json@1'||!isRecord(result.model)||result.model.complete!==true||!Array.isArray(result.model.files))return {fetch:[],note:'规格目录清单未完整读取，不移动不分版本的根；下一步资源管理员核对目录与权限后重跑同步'};
 const files=result.model.files;
 if(files.some(file=>!isRecord(file)||typeof file.path!=='string'||typeof file.name!=='string'||file.path.split('/').some(p=>!p||p==='.'||p==='..'||/[;\\\u0000-\u001f]/.test(p))))return {fetch:[],note:'规格目录清单含无效成员，不移动不分版本的根；下一步修正目录成员后重读'};
 const selected=files.filter(file=>productDocument(file.name+' '+(typeof file.title==='string'?file.title:'')));
 const ids=[...new Set(selected.map(file=>'manual:file:'+file.path.split('/').map(encodeURIComponent).join('/')))].sort();
 return {fetch:[],sources:{spec_documents:ids,spec_catalog:SPEC_LIST},note:`规格文档：不分版本 ${ids.length} 份；不属于这条产品线 ${files.length-selected.length} 份（仍可按原引用读取，未挂本树）`};
}
/** Specifications use K1 section production and K02 applicability, with no command catalog or build selection. */
export function specifications(input:unknown):ProducerOutput {
 if(!isRecord(input))throw new TypeError('规格生产缺少输入；下一步绑定规格文档清单后重产');
 const documents=isRecord(input.lists)&&Array.isArray(input.lists.documents)?input.lists.documents:[];
 const entries:ProducerOutput['entries']=[];const warnings:string[]=[];
 const catalog=isRecord(input.slots)&&isRecord(input.slots.catalog)&&isRecord(input.slots.catalog.model)?input.slots.catalog.model:null;
 for(const document of documents){
  if(!isRecord(document)||typeof document.external!=='string'||!document.external.startsWith('manual:file:')||document.parser!=='markdown@1'||typeof document.sha256!=='string')throw new TypeError('规格文档缺少可引用的 Markdown 章节模型；下一步将源转为受支持的章节格式后重产');
  const path=decodeURIComponent(document.external.slice('manual:file:'.length).split('@')[0]);
  const listed=catalog&&Array.isArray(catalog.files)?catalog.files.find(f=>isRecord(f)&&f.path===path):null;
  const title=isRecord(listed)&&typeof listed.title==='string'?listed.title:'';
  const params=isRecord(input.params)?input.params:{};
  const out=produceManualEntries(document.model as MarkdownModel,null,{...params,name:path,noTree:true});
  warnings.push(...out.warnings);
  if(out.warnings.some(w=>w.startsWith('内部错误')))throw new TypeError('规格章节生产未完成；下一步修复源章节后重产');
  for(const entry of out.entries)entries.push({...entry,path:entry.path?.replace(/^\/manual\//,'/spec/')??null,data:{...entry.data,document_lines:documentLines(documentNameOf(path))},fragments:entry.fragments.map(fragment=>({...fragment,slot:'documents',source:document.sha256 as string}))});
 }
 return {entries,warnings,...(documents.length===0&&catalog?{inventory:[{label:'规格',listed:{slot:'catalog',parser:'json@1',selector:'p/files'},complete:{slot:'catalog',parser:'json@1',selector:'p/complete'},selected:0}]}:{})};
}

/** Explicit specification records; source type, not document title, declares the role. */
export function structuredSpecification(model:unknown):{id:string|null;title:string;linked_builds:string[]}{
 if(!isRecord(model))throw Error('规格原件缺结构对象；恢复原件后重读');const fields=isRecord(model.fields)?model.fields:model;
 if(fields.id!==undefined&&fields.id!==null&&typeof fields.id!=='string')throw Error('规格 id 必须是原始字符串；修正原件后重读');
 if(fields.title!==undefined&&typeof fields.title!=='string')throw Error('规格 title 必须是原始字符串；修正原件后重读');
 const linked=fields.linked_builds??[];if(!Array.isArray(linked)||linked.some(v=>typeof v!=='string'))throw Error('linked_builds 必须是原始字符串数组；修正原件后重读');
 return {id:typeof fields.id==='string'?fields.id:null,title:typeof fields.title==='string'?fields.title:'',linked_builds:linked};
}
