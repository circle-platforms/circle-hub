import {commandIdentity} from './commands.ts';
import {isoTime} from './sync.ts';
// Feeding projection composes existing APV structural readers. It never classifies free text or guesses a version.
import {caseNodes} from './cases-nodes.ts';
import {elementDocument} from './cases.ts';
import {commandCatalog,textCommands} from './cases-commands.ts';
import {folderLine} from './documents.ts';
import {parseBuildName,lineKey} from './naming.ts';
import {parseListing} from './listing.ts';
import {isRecord} from './util.ts';
import {declareResourceTags} from './generated/vocabulary.ts';
import type {XmlModel,HtmlModel} from './types.ts';
const text=(value:unknown):string|null=>typeof value==='string'?value:Number.isSafeInteger(value)?String(value):null;
export function normalizeLine(input:unknown):{line:string|null}{const value=isRecord(input)&&typeof input.line==='string'?input.line:null;return {line:value===null?null:folderLine('rel_apv_'+value.replaceAll('.','_'))};}
const nativeLine=(value:string)=>{const line=normalizeLine({line:value}).line;if(line===null)throw Error('结构版本线不符合产品包完整语法');return line;};
export function verifyCommand(input:unknown):unknown{if(!isRecord(input)||!isRecord(input.tree)||!isRecord(input.command)||!Array.isArray(input.command.parameters)||typeof input.command.path!=='string')throw Error('缺完整命令身份与冻结树');const command=input.command;const words=(command.path as string).split('/').slice(2).map(decodeURIComponent);const parameters=[...command.parameters as Array<{position:number;raw:string}>].sort((a,b)=>a.position-b.position);return {identity:commandIdentity(commandCatalog(input.tree.model as XmlModel,input.tree.sha256 as string).catalog,[...words,...parameters.map(p=>p.raw)].join(' '))};}
const strings=(value:unknown,name:string):string[]=>{if(value===undefined||value===null)return [];if(!Array.isArray(value)||value.some(v=>typeof v!=='string'))throw Error(name+' 必须是原始字符串数组，不解析正文或分隔串');return value as string[];};
export default function project(input:unknown):unknown{
 if(!isRecord(input)||!isRecord(input.source)||typeof input.product!=='string')throw Error('缺原始来源和产品上下文；在带产品的运行中重新读取');
 const s=input.source,model=isRecord(input.model)?input.model:{},meta=isRecord(input.meta)?input.meta:{};
 const root=typeof input.root==='string'?input.root:null,base={product:input.product,root,path:null};
 // Only complete directory-folder names are parsed. Titles and descriptions are never fed to documentLines/locate.
 const directory=strings(meta.ancestors,'目录祖先'),lines=[...new Set(directory.map(folderLine).filter((line):line is string=>line!==null).map(lineKey))];
 const rows:Array<{body:Record<string,unknown>;identity:unknown;lines:string[];selector:string;grammar:string;conflict:boolean}>=[];
 if(s.system==='agile'&&input.parser==='kityminder@1'){
  const scan=caseNodes(model);if(scan.malformed||scan.deep)throw Error('脑图结构或位置不完整；修正原件后整份重读');
  const tree=isRecord(input.tree)?input.tree:null;
  const catalog=tree?commandCatalog(tree.model as XmlModel,tree.sha256 as string).catalog:null;
  const document=elementDocument({model,external:s.external})??text(s.key);if(!document)throw Error('缺文档身份；补原始文档字段后重读');
  for(const node of scan.cases){const declaration=declareResourceTags(node.resource);if(!declaration.valid)throw Error('resource 含未声明的闭集原文；作者按精确原文修正后整份重读');if(node.priority!==null&&typeof node.priority!=='number')throw Error('priority 不是原始整数');
   const steps=(node.stepTexts??[]).map(text=>({text})),expects=(node.expectedTexts??[]).map(text=>({text}));
   const parsed=catalog?textCommands(catalog,steps.map(step=>step.text)).results:[];
   const commands=parsed.flatMap(row=>row.identities??[]),unparsed_steps=steps.filter((_,index)=>!parsed[index]?.states?.length||parsed[index].identities?.length!==parsed[index].states?.length).length;
   const content={autoid:node.autoid,priority:node.priority,resources:node.resource===undefined?[]:node.resource,steps,expects};
   rows.push({body:{schema:'fed-case@1',...base,source:{system:'agile',document,element:node.id??node.selector,revision:text(s.revision),bytes:s.bytes},...content,commands,unparsed_steps,document_lines:lines},identity:content,lines,selector:node.selector,grammar:'apv-directory-folder@1',conflict:lines.length>1});
  }
 }else if(s.system==='plm'&&model.kind==='bug'){
  const fields=isRecord(model.fields)?model.fields:model,id=text(model.id)??text(fields.id)??text(s.key);if(!id)throw Error('PLM 导出缺 id；补原始结构字段后重读');if(text(s.key)!==id)throw Error('PLM 记录身份与读取地址不一致');
  const affected_lines=strings(fields.affected_lines,'affected_lines').map(nativeLine),resolved_lines=strings(fields.resolved_lines,'resolved_lines').map(nativeLine),fix_builds=strings(fields.fix_builds,'fix_builds');
  for(const name of fix_builds)if(parseBuildName(name).line===null)throw Error('fix_builds 含不符合完整构建名语法的值');
  rows.push({body:{schema:'fed-defect@1',...base,source:{system:'plm',ticket:id,revision:text(s.revision),bytes:s.bytes},id,status:text(fields.status),affected_lines,resolved_lines,fix_builds},identity:model,lines:[...new Set([...affected_lines,...resolved_lines,...fix_builds.map(name=>lineKey(parseBuildName(name).line!))])],selector:'p',grammar:'apv-structured-defect@1',conflict:false});
 }else if((s.system==='plm'&&s.type==='requirements')||(s.system==='manual'&&model.schema==='specification@1')){
  const fields=isRecord(model.fields)?model.fields:model,linked_builds=strings(fields.linked_builds,'linked_builds');for(const name of linked_builds)if(parseBuildName(name).line===null)throw Error('linked_builds 不符合完整构建名语法');
  rows.push({body:{schema:'fed-spec@1',...base,source:s.system==='plm'?{system:'plm-requirements',ticket:text(s.key),bytes:s.bytes}:{system:'manual-store',path:text(s.key),bytes:s.bytes},id:text(fields.id),title:text(fields.title)??'',linked_builds,document_lines:lines},identity:model,lines:[...new Set([...lines,...linked_builds.map(name=>lineKey(parseBuildName(name).line!))])],selector:'p',grammar:'apv-structured-specification@1',conflict:lines.length>1});
 }else if(s.system==='buildsite'&&input.parser==='html@1'){
  const listing=parseListing(model as unknown as HtmlModel);
  for(const build of listing.builds){const parsed=parseBuildName(build.name);if(parsed.line===null)throw Error('构建名称不能完整解析');const content={name:build.name,family:parsed.family,line:lineKey(parsed.line),platform:parsed.platform};rows.push({body:{schema:'fed-build@1',...base,source:{system:'build-site',page:text(s.key),bytes:s.bytes},...content,built_at:isoTime(build.built_raw??build.built).iso,released_at:isoTime(build.released).iso,tree:null,fixed_bugs:[]},identity:content,lines:[content.line],selector:'b/0',grammar:'apv-build-name@1',conflict:false});}
 }
 return {rows};
}
