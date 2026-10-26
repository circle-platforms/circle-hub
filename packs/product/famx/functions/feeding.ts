import {structuredDefect} from './fixed-bugs.ts';
import {structuredSpecification} from './specifications.ts';
import {commandIdentity} from './commands.ts';
import {isoTime} from './sync.ts';
// Feeding projection composes existing FAMX structural readers. It never classifies free text or guesses a version.
import {caseNodes} from './cases-nodes.ts';
import {elementDocument,caseBody} from './cases.ts';
import {commandCatalog,stepCommands} from './cases-commands.ts';
import {folderLine} from './documents.ts';
import {parseBuildName,lineKey} from './naming.ts';
import {parseListing} from './listing.ts';
import {isRecord} from './util.ts';
import {declareResourceTags,TEST_TYPE_IDS,RESOURCE_TAG_TEXTS} from './generated/vocabulary.ts';
import type {XmlModel,HtmlModel} from './types.ts';
const text=(value:unknown):string|null=>typeof value==='string'?value:Number.isSafeInteger(value)?String(value):null;
export function normalizeLine(input:unknown):{line:string|null}{const value=isRecord(input)&&typeof input.line==='string'?input.line:null;return {line:value===null?null:folderLine('rel_famx_'+value.replaceAll('.','_'))};}
const nativeLine=(value:string)=>{const line=normalizeLine({line:value}).line;if(line===null)throw Error('结构版本线不符合产品包完整语法');return line;};
export function verifyCommand(input:unknown):unknown{if(!isRecord(input)||!isRecord(input.tree)||!isRecord(input.command)||!Array.isArray(input.command.parameters)||typeof input.command.path!=='string')throw Error('缺完整命令身份与冻结树');const command=input.command;const words=(command.path as string).split('/').slice(2).map(decodeURIComponent);const parameters=[...command.parameters as Array<{position:number;raw:string}>].sort((a,b)=>a.position-b.position);return {identity:commandIdentity(commandCatalog(input.tree.model as XmlModel,input.tree.sha256 as string).catalog,[...words,...parameters.map(p=>p.raw)].join(' '))};}
const strings=(value:unknown,name:string):string[]=>{if(value===undefined||value===null)return [];if(!Array.isArray(value)||value.some(v=>typeof v!=='string'))throw Error(name+' 必须是原始字符串数组，不解析正文或分隔串');return value as string[];};
export default function project(input:unknown):unknown{
 if(!isRecord(input)||!isRecord(input.source)||typeof input.product!=='string')throw Error('缺原始来源和产品上下文；在带产品的运行中重新读取');
 const s=input.source,model=isRecord(input.model)?input.model:{},meta=isRecord(input.meta)?input.meta:{};
 const root=typeof input.root==='string'?input.root:null,base={product:input.product,root,path:null};
 // Only complete directory-folder names are parsed. Titles and descriptions are never fed to documentLines/locate.
 const directory=strings(meta.ancestors,'目录祖先'),lines=[...new Set(directory.map(folderLine).filter((line):line is string=>line!==null).map(lineKey))];
 const rows:Array<{body:Record<string,unknown>;identity:unknown;lines:string[];selector:string;grammar:string;conflict:boolean;missing?:Array<{missing:string;next_action:string}>}>=[];
 if(s.system==='agile'&&input.parser==='kityminder@1'){
  const scan=caseNodes(model);if(scan.malformed||scan.deep)throw Error('脑图结构或位置不完整；修正原件后整份重读');
  const tree=isRecord(input.tree)?input.tree:null;
  const catalog=tree?commandCatalog(tree.model as XmlModel,tree.sha256 as string).catalog:null;
  const document=elementDocument({model,external:s.external})??text(s.key);if(!document)throw Error('缺文档身份；补原始文档字段后重读');
  for(const node of scan.cases){const declaration=declareResourceTags(node.resource);if(node.priority!==null&&typeof node.priority!=='number')throw Error('priority 不是原始整数');
   const {steps,expects}=caseBody(node);
   const {commands,unparsed_steps}=stepCommands(catalog,steps);
   // Identity retains the source value. An invalid tag declaration is local evidence, never a document exception.
   const content={autoid:node.autoid,priority:node.priority,resources:node.resource===undefined?[]:node.resource,steps,expects};
   const resource_declaration={status:declaration.status,present:declaration.present,raw_json:JSON.stringify(declaration.raw),types:declaration.types,table:declaration.table,missing:declaration.missing,next_action:declaration.next_action,violations:declaration.valid?[]:[{field:'resource',tier:'advisory',allowed_values:[...RESOURCE_TAG_TEXTS],statement:'未声明的标签：'+declaration.issues.map(issue=>JSON.stringify(issue.raw)).join('、')+'；resource 应改为发布闭集的精确原文：'+RESOURCE_TAG_TEXTS.join('、')+'；不推测原值对应哪项',next_action:declaration.next_action!}]};
   const resources=declaration.valid&&Array.isArray(node.resource)?[...new Set(node.resource)]:[];
   rows.push({body:{schema:'fed-case@1',...base,source:{system:'agile',document,element:node.id??node.selector,revision:text(s.revision),bytes:s.bytes},...content,resources,resource_declaration,commands,unparsed_steps,document_lines:lines},identity:content,lines,selector:node.selector,grammar:'famx-directory-folder@1',conflict:lines.length>1,...(unparsed_steps?{missing:[{missing:unparsed_steps+' 个步骤缺可核对的完整命令身份',next_action:'包作者核对锁定命令树的完整签名，或作者补完整命令后重新读取；不猜命令'}]}:{})});
  }
 }else if(s.system==='plm'&&model.kind==='bug'){
  const original=structuredDefect(model)!;if(text(s.key)!==original.id)throw Error('PLM 记录身份与读取地址不一致');const {id,status,fix_builds}=original,affected_lines=original.affected_lines.map(nativeLine),resolved_lines=original.resolved_lines.map(nativeLine);
  for(const name of fix_builds)if(parseBuildName(name).line===null)throw Error('fix_builds 含不符合完整构建名语法的值');
  rows.push({body:{schema:'fed-defect@1',...base,source:{system:'plm',ticket:id,revision:text(s.revision),bytes:s.bytes},id,status,affected_lines,resolved_lines,fix_builds},identity:model,lines:[...new Set([...affected_lines,...resolved_lines,...fix_builds.map(name=>lineKey(parseBuildName(name).line!))])],selector:'p',grammar:'famx-structured-defect@1',conflict:false,...(status===null?{missing:[{missing:'缺陷原始结构未声明 status',next_action:'缺陷维护者补结构状态后重读；依赖该状态的判断保持未知'}]}:{})});
 }else if((s.system==='plm'&&(s.type==='requirements'||s.type==='story'&&model.kind==='story'))||(s.system==='manual'&&model.schema==='specification@1')){
  const fields=structuredSpecification(model),linked_builds=fields.linked_builds;for(const name of linked_builds)if(parseBuildName(name).line===null)throw Error('linked_builds 不符合完整构建名语法');
  rows.push({body:{schema:'fed-spec@1',...base,source:s.system==='plm'?{system:'plm-requirements',ticket:text(s.key),bytes:s.bytes}:{system:'manual-store',path:text(s.key),bytes:s.bytes},id:text(fields.id),title:text(fields.title)??'',linked_builds,document_lines:lines},identity:model,lines:[...new Set([...lines,...linked_builds.map(name=>lineKey(parseBuildName(name).line!))])],selector:'p',grammar:'famx-structured-specification@1',conflict:lines.length>1});
 }else if(s.system==='buildsite'&&input.parser==='html@1'){
  const listing=parseListing(model as unknown as HtmlModel);
  for(const build of listing.builds){const parsed=parseBuildName(build.name);if(parsed.line===null)throw Error('构建名称不能完整解析');const content={name:build.name,family:parsed.family,line:lineKey(parsed.line),platform:parsed.platform};rows.push({body:{schema:'fed-build@1',...base,source:{system:'build-site',page:text(s.key),bytes:s.bytes},...content,built_at:isoTime(build.built_raw??build.built).iso,released_at:isoTime(build.released).iso,tree:null,fixed_bugs:[]},identity:content,lines:[content.line],selector:'b/0',grammar:'famx-build-name@1',conflict:false,missing:[{missing:'本次清单只声明构建信息，未读到该构建的命令树摘要与原始修复清单；tree=null 与 fixed_bugs=[] 不证明不存在',next_action:'经 Hub 读取该构建命令树及带结构状态的发布说明后补喂入；依赖这些字段的要求项保持未知'}]});}
 }
 return {rows};
}

export function classificationValues(){return [...TEST_TYPE_IDS];}
