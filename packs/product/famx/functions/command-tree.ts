// Producer of command entries from a build's command tree (xml@1 model of command_tree-<build>.xml, ISO-8859-1 already
// decoded): commands > scope > menu[name] > item[name] > arguments > arg[name, type, length, limit, optional,
// default_value]. One entry per full command (menu words + item name) at /commands/<words>, a definition (K02 R[3]); the
// argument lists of one path are the overloads of that entry. Argument types map onto the generic catalog parameter types
// of hub/rules.
import {commandTokens} from './commands.ts';
import {labelOf} from './generated/vocabulary.ts';
import type {ProducerDiagnostic} from '../../../../contracts/src/product.ts';
import type { CatalogParam, CatalogParamType, CatalogSignature, CatalogUncheckedConstraint } from '../../../../contracts/src/tables.ts';
import type { CommandEntryData, CommandTreeParams, CommandTreeResult, DeclarationsByPath, EntryKind, FragmentRef, ProducedEntry, SignatureDeclarations, XmlModel } from './types.ts';
import { asArray, decodeEntities, guarded, internalError, isRecord, pathText, selectorText, squeeze } from './util.ts';

type Alternative = { type: CatalogParamType; minimum?: number; maximum?: number };

/** Argument types of the command tree and the catalog types whose union is their value set (product knowledge). */
export const ARGUMENT_TYPES: Readonly<{ [type: string]: readonly Alternative[] }> = {
  STRING: [{ type: 'string' }],
  XSTRING: [{ type: 'string' }],
  HOSTNAME: [{ type: 'hostname' }],
  IP_OR_HOSTNAME: [{ type: 'ip_or_hostname' }],
  U16: [{ type: 'int', minimum: 0, maximum: 65535 }],
  U32: [{ type: 'int', minimum: 0, maximum: 4294967295 }],
  // IPADDR is the declared union of IPv4/IPv6; descriptions never alter it.
  IPADDR: [{ type: 'ipv4' }, { type: 'ipv6' }],
  DOTTEDIP: [{ type: 'ipv4' }],
  // IPMASK is the declared dotted mask / prefix-length union; descriptions never alter it.
  IPMASK: [{ type: 'mask' }, { type: 'int', minimum: 0, maximum: 128 }],
};

const KIND: EntryKind = 'definition';

type Declared = Map<string, { type?: string; address_role?:string; row: number; command: string; position: number; used: boolean }>;

/** The declared argument types of the producer parameters, by command words and position; malformed rows are warned. */
function declaredTypes(value: unknown, warnings: string[]): Declared {
  const out: Declared = new Map();
  asArray(value).forEach((item, k) => {
    const row = k + 1;
    if (!isRecord(item) || typeof item.command !== 'string' || squeeze(item.command) === '' || !Number.isSafeInteger(item.position) || (item.position as number) < 1 || (typeof item.type!=='string'&&typeof item.address_role!=='string')) {
      warnings.push(`第 ${row} 条声明的参数类型格式不对（要 command、position、type、origin），已忽略`);
      return;
    }
    if(item.schema!=='famx-command-argument-types@1'||item.origin!=='product:famx/README.md#command-grammar'){
      warnings.push(`第 ${row} 条参数声明没有本包授权的精确 schema/origin，未覆盖原类型；下一步：包作者在下一次生产前核验发布声明后重产`);
      return;
    }
    const type = typeof item.type==='string'?item.type:undefined;
    const role=typeof item.address_role==='string'?item.address_role:undefined;
    if(!type&&!role){warnings.push(`第 ${row} 条声明没有参数类型或有效地址角色，已忽略`);return;}
    if (type!==undefined&&!Object.hasOwn(ARGUMENT_TYPES, type)) {
      warnings.push(`第 ${row} 条声明的参数类型 ${String(item.type).slice(0, 40)} 不在类型表里，已忽略`);
      return;
    }
    if (typeof item.origin !== 'string' || item.origin.trim() === '') {
      warnings.push(`第 ${row} 条声明的参数类型没有写来源（origin），已忽略`);
      return;
    }
    const command = item.command;
    const key = `${command}\u0000${item.position}`;
    if (!out.has(key)) out.set(key, { ...(type?{type}:{}),...(role?{address_role:role}:{}), row, command, position: item.position as number, used: false });
  });
  return out;
}

/** Overloads one argument list may expand into when union types multiply (2^5). */
const MAX_EXPANSION = 32;
const MAX_WORDS = 64;
const MAX_PARAMS = 256;
const MAX_ELEMENTS = 2_000_000;
/** A selector holds at most 256 segments (hub/refs), so nothing deeper can be cited. */
const MAX_DEPTH = 256;
const PARSER = 'xml@1';

type XmlNode = { raw: object; name: string; attributes: { [name: string]: string }; children: unknown[] };

function asNode(value: unknown): XmlNode | null {
  if (!isRecord(value) || typeof value.name !== 'string' || !Array.isArray(value.children)) return null;
  const attributes: { [name: string]: string } = {};
  if (isRecord(value.attributes)) for (const [key, item] of Object.entries(value.attributes)) if (typeof item === 'string') attributes[key] = item;
  return { raw: value, name: value.name, attributes, children: value.children };
}

/** Element children with their xml@1 name steps (`name`, or `name[k]` when the name repeats among siblings). */
function elementChildren(node: XmlNode): Array<{ node: XmlNode; step: string }> {
  const elements: XmlNode[] = [];
  for (const child of node.children) {
    const element = asNode(child);
    if (element !== null) elements.push(element);
  }
  const counts = new Map<string, number>();
  for (const element of elements) counts.set(element.name, (counts.get(element.name) ?? 0) + 1);
  const ordinal = new Map<string, number>();
  return elements.map((element) => {
    const k = (ordinal.get(element.name) ?? 0) + 1;
    ordinal.set(element.name, k);
    return { node: element, step: (counts.get(element.name) ?? 0) > 1 ? `${element.name}[${k}]` : element.name };
  });
}

function attribute(node: XmlNode, name: string): string {
  return squeeze(decodeEntities(node.attributes[name] ?? ''));
}

export type Limit = {kind:'range';low:number;high:number}|{kind:'enum';values:string[]}|{kind:'unknown';text:string};
/** Only the documented inclusive bracket form is interpreted; other spellings retain a recovery diagnostic. */
export function parseLimit(text:string):Limit|null{
  // A blank attribute declares nothing: it is absent, not an unknown spelling. Only a nonempty spelling the pack cannot
  // read becomes a gap with the missing fact and the author's exit (famx-command-tree@2, famx README 命令语法).
  const value=text;if(value.trim()==='')return null;
  if(value.startsWith('{')&&value.endsWith('}')){const values=value.slice(1,-1).split('|');if(values.length>0&&values.every(value=>value.length>0&&!value.includes('{')&&!value.includes('}')&&!value.includes('\n')&&!value.includes('\r'))&&new Set(values).size===values.length)return {kind:'enum',values};}
  const match=/^\[\s*(-?[0-9]{1,15})\s*-\s*(-?[0-9]{1,15})\s*\]$/.exec(value);
  if(match){const low=Number(match[1]),high=Number(match[2]);if(Number.isSafeInteger(low)&&Number.isSafeInteger(high)&&low<=high)return {kind:'range',low,high};}
  return {kind:'unknown',text:value};
}

/** famx-command-tree@2 in README: absent/NO is required, YES is optional; exact case, no aliases. */
function optionalFlag(text: string | undefined): boolean | null {
  if (text === 'YES') return true;
  if (text === undefined || text === 'NO') return false;
  return null;
}

/** Default value as documented (famx-command-tree@2): the character references are decoded once more, because the
 * produced tree escapes them twice, and then one pair of surrounding double quotes is removed. Only the five XML
 * character references are decoded and only once; anything else is kept exactly as written. */
const DOCUMENTED_REFERENCES: Readonly<Record<string, string>> = Object.freeze({ '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' });

function defaultOf(text: string): string | undefined {
  if(text==='')return undefined;
  const decoded = text.replace(/&(?:quot|apos|lt|gt|amp);/gu, (reference) => DOCUMENTED_REFERENCES[reference] ?? reference);
  return decoded.startsWith('"')&&decoded.endsWith('"')&&decoded.length>=2?decoded.slice(1,-1):decoded;
}

/** Unknown source syntax stays independently unchecked, not a guessed generic constraint. */
function applyLimit(params:CatalogParam[],raw:string,attributeName:'limit'|'length',path:string,warnings:string[]):void{
  const parsed=parseLimit(raw);if(parsed===null)return;
  let warned=false;
  const unchecked=(param:CatalogParam)=>{
    const relative='.'+path.slice(path.lastIndexOf('/arguments'));
    const gap:CatalogUncheckedConstraint={path:`${relative}/@${attributeName}`,reason:'missing_input',missing:'这种 limit 写法的含义',next_action:'包作者在 README 声明这种 limit 写法的含义后重产',source_value:raw};
    (param.unchecked_constraints??=[]).push(gap);
    if(!warned){warnings.push(`${path}/@${attributeName}（参数内路径 ${gap.path}）的 limit 写法不认识（${attributeName}=${JSON.stringify(raw)}），这条约束未核对；缺失事实：${gap.missing}；下一步：${gap.next_action}`);warned=true;}
  };
  for(const param of params){
    if(attributeName==='limit'&&parsed.kind==='enum'&&param.type==='string'){param.type='enum';param.values=parsed.values;continue;}
    if(attributeName!=='limit'||parsed.kind!=='range'){unchecked(param);continue;}
    if(param.type==='string'||param.type==='hostname'||param.type==='ip_or_hostname'){
      if(parsed.low<0){unchecked(param);continue;}param.minLength=parsed.low;param.maxLength=parsed.high;continue;
    }
    if(param.type==='int'||param.type==='port'){
      const low=Math.max(parsed.low,param.minimum??parsed.low),high=Math.min(parsed.high,param.maximum??parsed.high);
      if(low>high){unchecked(param);continue;}param.minimum=low;param.maximum=high;continue;
    }
    unchecked(param);
  }
}

/** Type text of one alternative in a statement: string 1..40, int 0..65535, {tcp|udp}, ipv4. */
function typeLabel(param: CatalogParam): string {
  if (param.type === 'enum') return `{${(param.values ?? []).map((value) => (/^[A-Za-z0-9_.:-]+$/.test(value) ? value : JSON.stringify(value))).join('|')}}`;
  if (param.type === 'int' || param.type === 'port') {
    return param.minimum === undefined && param.maximum === undefined ? param.type : `${param.type} ${param.minimum ?? ''}..${param.maximum ?? ''}`;
  }
  if (param.type === 'string' && (param.minLength !== undefined || param.maxLength !== undefined)) return `string ${param.minLength ?? 0}..${param.maxLength ?? ''}`;
  return param.type ?? labelOf('type_declaration_status','undeclared');
}

type SourceParam = { sourceNative:boolean; nativeType:string; selector:string; name: string; alternatives: CatalogParam[]; optional: boolean; default?: string; description?: string; label: string };

type TypeCounters = { unknown: Map<string, number>; diagnostics:ProducerDiagnostic[] };

/** One argument: its catalog alternatives (several for a union type) and its text in the statement. */
function argumentParam(arg: XmlNode, position: number, where: string, warnings: string[], counters: TypeCounters, declared: Declared,parameterPath:string): SourceParam | null {
  const argName = attribute(arg, 'name');
  const name = argName === '' ? `arg${position}` : argName.replace(/\s+/g, '_');
  const description = attribute(arg, 'help_string');
  let typeName = arg.attributes.type ?? '';
  const declaration = declared.get(`${where}\u0000${position}`);
  if (declaration !== undefined) {
    declaration.used = true;
    if(declaration.type!==undefined)typeName = declaration.type;
  }
  const declaredType = Object.hasOwn(ARGUMENT_TYPES,typeName);
  const optional = optionalFlag(arg.attributes.optional);
  if (optional === null) {
    counters.diagnostics.push({command:where.split(' '),path:parameterPath+'/@optional',attribute:'optional',position,type_declaration_status:declaredType?'declared':'undeclared',command_parse_status:'parameters_unchecked',syntax_valid:false,reason:'missing_input',missing:'famx-command-tree@2 的精确 optional 字段',next_action:'修订结构字段后重产',audience:'命令树维护者',due:'下一次生产之前',source_value:arg.attributes.optional});
    return null;
  }
  const defaultValue = defaultOf(arg.attributes.default_value ?? '');
  let params:CatalogParam[];
  if(!declaredType){
    counters.unknown.set(typeName,(counters.unknown.get(typeName)??0)+1);
    const gap={path:'./arguments/'+parameterPath.slice(parameterPath.lastIndexOf('/')+1)+'/@type',reason:'missing_input' as const,missing:'命令树结构化参数类型及版本化定义',next_action:'命令树维护者或包作者在下一次生产之前补类型声明后重产',source_value:typeName};
    params=[{name,type_declaration_status:'undeclared',unchecked_constraints:[gap]}];
    counters.diagnostics.push({command:where.split(' '),path:parameterPath+'/@type',attribute:'type',position,type_declaration_status:'undeclared',command_parse_status:'parameters_unchecked',syntax_valid:true,reason:'missing_input',missing:gap.missing,next_action:gap.next_action,audience:'命令树维护者或包作者',due:'下一次生产之前',source_value:typeName});
  }else params=ARGUMENT_TYPES[typeName].map(alternative=>{
    const param:CatalogParam={name,type:alternative.type};
    const role=declaration?.address_role??arg.attributes.address_role;if(role)param.address_role=role;
    if(alternative.minimum!==undefined)param.minimum=alternative.minimum;
    if(alternative.maximum!==undefined)param.maximum=alternative.maximum;
    return param;
  });
  applyLimit(params,arg.attributes.limit??'','limit',parameterPath,warnings);
  applyLimit(params,arg.attributes.length??'','length',parameterPath,warnings);
  for(const param of params) for(const gap of param.unchecked_constraints??[]){
    if(param.type===undefined)continue;
    const sourceAttribute=gap.path.endsWith('/@limit')?'limit':'length';
    counters.diagnostics.push({command:where.split(' '),path:parameterPath+'/@'+sourceAttribute,attribute:sourceAttribute,position,type_declaration_status:'declared',command_parse_status:'parameters_unchecked',syntax_valid:true,reason:gap.reason,missing:gap.missing,next_action:gap.next_action,audience:'包作者',due:'下一次生产之前',source_value:gap.source_value});
  }
  for (const param of params) {
    if (optional) param.optional = true;
    if (defaultValue !== undefined) param.default = defaultValue;
    if (description !== '') param.description = description;
  }
  const label = `<${name}:${params.map(typeLabel).join('/')}${defaultValue === undefined ? '' : `=${JSON.stringify(defaultValue)}`}>`;
  const out: SourceParam = { sourceNative:typeName===arg.attributes.type,nativeType:arg.attributes.type??'',selector:parameterPath,name, alternatives: params, optional, label: optional ? `[${label}]` : label };
  if (defaultValue !== undefined) out.default = defaultValue;
  if (description !== '') out.description = description;
  return out;
}

/** Signatures of one argument list: the product of the union alternatives, at most MAX_EXPANSION; ids k or k.j. */
function expand(params: SourceParam[], id: string, where: string, warnings: string[]): CatalogSignature[] {
  const unions = params.filter((param) => param.alternatives.length > 1);
  let budget = 1;
  const kept = new Set<SourceParam>();
  for (const param of unions) {
    if (budget * param.alternatives.length > MAX_EXPANSION) continue;
    budget *= param.alternatives.length;
    kept.add(param);
  }
  if (kept.size < unions.length) {
    warnings.push(`${where} 的联合类型展开超过 ${MAX_EXPANSION}；参数未核对，缺少可完整处理的类型语法；下一步：包作者在下一次生产前拆分声明后重产`);
    return [];
  }
  let lists: CatalogParam[][] = [[]];
  for (const param of params) {
    const choices = param.alternatives;
    const next: CatalogParam[][] = [];
    for (const list of lists) for (const choice of choices) next.push([...list, { ...choice, ...(choice.values ? { values: [...choice.values] } : {}) }]);
    lists = next;
  }
  if (lists.length === 1) return [{ id, params: lists[0] }];
  return lists.map((list, j) => ({ id: `${id}.${j + 1}`, params: list }));
}

type Overload = { item: XmlNode; selector: string; argumentSelectors:string[]; argumentLists: Array<Array<{node:XmlNode;path:string}>> };
type Frame = { node: XmlNode; steps: string[]; words: string[] };

export function produceCommandEntries(model: XmlModel, params: CommandTreeParams = {}): CommandTreeResult {
  const warnings: string[] = [];
  const diagnostics:ProducerDiagnostic[]=[];
  // Provenance of the produced signatures, keyed by entry path. It rides beside the entries in the pack's own result:
  // neither `data` (catalog-entry@1) nor an entry (producer-output@1) may carry a key its contract does not declare.
  const declarationsByPath:DeclarationsByPath={};
  const output=(entries:ProducedEntry[],notes:string[]):CommandTreeResult=>({entries,declarations:declarationsByPath,warnings:notes,diagnostics,grammar:{id:'famx-command-tree@2',source:'product:famx/README.md#command-grammar',complete:diagnostics.length===0}});
  const invalid=(note:string,path='x/commands',attribute='syntax'):CommandTreeResult=>{
    diagnostics.push({command:[],path,attribute,type_declaration_status:'undeclared',command_parse_status:'parameters_unchecked',syntax_valid:false,reason:'missing_input',missing:note,next_action:'修订 famx-command-tree@2 原件或补完整语法后重产',audience:'命令树维护者或包作者',due:'下一次生产之前'});
    return output([],[...warnings,note+'；下一步：命令树维护者或包作者在下一次生产之前修订原件后重产']);
  };
  try {
    const rootNode = isRecord(model) ? asNode(model.root) : null;
    if (rootNode === null) return invalid('输入不是 xml@1 模型（缺 root）');
    // xml@1 retains explicit repair flags. A repaired source is not the declared complete XML grammar.
    const structural:Array<{item:unknown;parent:string|null;opaque?:boolean}>=[{item:rootNode.raw,parent:null}];const checked=new WeakSet<object>();let structuralCount=0;
    // This is the declared XML production grammar, not a word list over free text.
    const childrenByElement:Record<string,readonly string[]>={commands:['scope','menu','item'],scope:['menu','item'],menu:['menu','item'],item:['arguments','results'],arguments:['arg'],arg:[],results:[]};
    while(structural.length){
      const {item,parent,opaque}=structural.pop()!;if(typeof item==='string')continue;if(!isRecord(item))return invalid('XML 子元素不是声明结构');if(checked.has(item))return invalid('XML 元素共享或循环，不能核验完整结构');checked.add(item);
      if(++structuralCount>MAX_ELEMENTS)return invalid('XML 元素超过完整解析限额');
      if(typeof item.name!=='string'||!opaque&&(!Object.hasOwn(childrenByElement,item.name)||parent!==null&&!childrenByElement[parent]?.includes(item.name)))return invalid('XML 元素不符合 famx-command-tree@2 的容器语法');
      if(Array.isArray(item.irregular)&&item.irregular.length>0||Number(model.nulRemoved??0)>0)return invalid('XML 原件含容错恢复或 NUL，缺完整权威 XML');
      if(Array.isArray(item.children))for(const child of item.children)structural.push({item:child,parent:item.name as string,opaque:opaque||item.name==='results'});
    }
    const base = isRecord(params) && typeof params.path === 'string' && /^\/[^\s]*$/.test(params.path) ? params.path : '/commands';
    const baseSegments = base.split('/').filter((segment) => segment !== '');
    const declared = declaredTypes(isRecord(params) ? params.argumentTypes : undefined, warnings);
    if (rootNode.name !== 'commands') return invalid('XML 根不是 commands，结构违规');
    const byPath = new Map<string, { words: string[]; overloads: Overload[] }>();
    const scopes = new Set<string>();
    const seen = new WeakSet<object>([rootNode.raw]);
    let visited = 0;
    let unnamed = 0;
    let badSelector = 0;
    let tooLong = 0;
    let tooDeep = 0;
    // Pre-order walk in document order with an explicit stack; a scope starts new words, a menu or item adds its name.
    const stack: Frame[] = [{ node: rootNode, steps: [rootNode.name], words: [] }];
    while (stack.length > 0) {
      const { node, steps, words } = stack.pop() as Frame;
      if (++visited > MAX_ELEMENTS) {
        warnings.push(`元素超过 ${MAX_ELEMENTS} 个，其余未读`);
        break;
      }
      if (node.name === 'item' && node !== rootNode) {
        const selector = selectorText(['x', ...steps]);
        if (selector === null) {
          badSelector++;
          continue;
        }
        const argumentLists: Overload['argumentLists'] = [];
        const argumentSelectors:string[]=[];
        for (const { node: part,step:partStep } of elementChildren(node)) {
          if (part.name === 'arguments') {argumentSelectors.push(`${selector}/${partStep}`);argumentLists.push(elementChildren(part).filter(({ node: arg }) => arg.name === 'arg').map(({ node: arg,step:argStep }) => ({node:arg,path:`${selector}/${partStep}/${argStep}`})));}
        }
        if (argumentLists.length === 0) {argumentLists.push([]);argumentSelectors.push(selector);}
        const key = words.join(' ');
        const slot = byPath.get(key) ?? { words, overloads: [] };
        slot.overloads.push({ item: node, selector, argumentLists, argumentSelectors });
        byPath.set(key, slot);
        continue;
      }
      if (steps.length >= MAX_DEPTH) {
        tooDeep++;
        continue;
      }
      const pending: Frame[] = [];
      for (const { node: child, step } of elementChildren(node)) {
        if (seen.has(child.raw)) continue;
        seen.add(child.raw);
        const childSteps = [...steps, step];
        if (child.name === 'scope') {
          scopes.add(attribute(child, 'type'));
          pending.push({ node: child, steps: childSteps, words: [] });
        } else if (child.name === 'menu' || child.name === 'item') {
          const name = child.attributes.name ?? '';
          const tokens=commandTokens(name);
          if(tokens===null||tokens.some(token=>token.quoted))return invalid('命令路径不符合完整词语法',selectorText(['x',...childSteps])??'x/commands','name');
          const childWords = [...words, ...tokens.map(token=>token.value)];
          if (tokens.length === 0) unnamed++;
          else if (childWords.length > MAX_WORDS) tooLong++;
          else pending.push({ node: child, steps: childSteps, words: childWords });
        } else pending.push({ node: child, steps: childSteps, words });
      }
      for (let k = pending.length - 1; k >= 0; k--) stack.push(pending[k]);
    }
    if (unnamed > 0) warnings.push(`有 ${unnamed} 个菜单或命令没有 name，已跳过（菜单连同其下的命令）`);
    if (badSelector > 0) warnings.push(`有 ${badSelector} 个命令的片段定位写不出（元素名含不成对代理字符），已跳过`);
    if (tooLong > 0) warnings.push(`有 ${tooLong} 个命令超过 ${MAX_WORDS} 个词，已跳过`);
    if (tooDeep > 0) warnings.push(`有 ${tooDeep} 处元素嵌套超过 ${MAX_DEPTH} 层，其下的内容未读`);
    if (scopes.size > 1) warnings.push(`命令树有 ${scopes.size} 个作用域（${[...scopes].join('、')}），同一路径的参数表按重载合并`);

    if(unnamed||badSelector||tooLong||tooDeep||visited>MAX_ELEMENTS)return invalid('命令结构缺失、无法精确引用或超过完整解析限额');
    const counters: TypeCounters = { unknown: new Map(), diagnostics };
    const entries: ProducedEntry[] = [];
    for (const { words, overloads } of byPath.values()) {
      const where = words.join(' ');
      const path = pathText([...baseSegments, ...words]);
      if (path === null) {
        warnings.push(`命令 ${where.slice(0, 80)} 的路径写不出，已跳过`);
        continue;
      }
      const signatures: CatalogSignature[] = [];
      const declarations: SignatureDeclarations = {};
      const lines: string[] = [];
      const fragments: FragmentRef[] = [];
      const summaries = new Set<string>();
      for (const overload of overloads) {
        const summary = attribute(overload.item, 'help_string');
        if (summary !== '') summaries.add(summary);
        for (const [argumentIndex,args] of overload.argumentLists.entries()) {
          fragments.push({ parser: PARSER, selector: overload.selector });
          if (args.length > MAX_PARAMS) return invalid('参数数量超过完整解析限额',overload.selector,'arguments');
          const sourceParams = args.slice(0, MAX_PARAMS).map((arg, index) => argumentParam(arg.node, index + 1, where, warnings, counters, declared,arg.path));
          if (sourceParams.some(param => param === null)) continue;
          const complete = sourceParams as SourceParam[];
          const expanded = expand(complete, String(fragments.length), where, warnings);
          if (expanded.length === 0) return invalid('联合类型展开超过完整解析限额',overload.selector,'arguments');
          signatures.push(...expanded);
          for(const signature of expanded)declarations[signature.id!]={selector:overload.argumentSelectors[argumentIndex],parameters:complete.map(param=>({name:param.nativeType,selector:param.selector,native:param.sourceNative}))};
          lines.push([where, ...complete.map((param) => param.label)].join(' '));
          if (summary !== '') lines.push(`  ${summary}`);
          for (const param of complete){if (param.description !== undefined) lines.push(`  ${param.name}: ${param.description}`);for(const gap of param.alternatives[0].unchecked_constraints??[])lines.push(`  ${param.name} 约束未核对：${gap.path}；缺失事实：${gap.missing}；下一步：${gap.next_action}`);}
        }
      }
      if (signatures.length === 0) continue;
      // `data` stays exactly catalog-entry@1 (famx README): the provenance map rides beside it on the entry.
      const data: CommandEntryData = { words, signatures };
      if (summaries.size > 0) data.summary = [...summaries].join('\n');
      declarationsByPath[path] = declarations;
      entries.push({ kind: KIND, path, statement: lines.join('\n'), data, fragments, applicability: null });
    }
    // Aggregate by the parsed attribute, never by matching warning prose. Retain every
    // positional diagnostic, while keeping repeated invalid fields out of capped warnings.
    const invalidOptional = diagnostics.filter(diagnostic => diagnostic.attribute === 'optional');
    if (invalidOptional.length > 0) warnings.push(`optional 不符合 famx-command-tree@2（仅 YES/NO，或字段省略；同类 ${invalidOptional.length} 处）；结构违规，下一步：命令树维护者在下次生产前修订字段后重产`);
    for (const [type, count] of counters.unknown) warnings.push(`参数类型 ${type} 不在类型表里（${count} 处），类型未声明、参数未核对；下一步：命令树维护者或包作者在下一次生产前补结构化类型声明后重产`);
    for (const item of declared.values()) {
      if (!item.used) warnings.push(`第 ${item.row} 条声明的参数类型（${item.command} 第 ${item.position} 个参数）在命令树里没有这个参数，未用上`);
    }
    return output(entries,warnings);
  } catch (error) {
    return invalid(internalError(error));
  }
}

/** Pack function entry: the xml@1 model, or `{ model, params }`. */
export default function commandTree(input: unknown): CommandTreeResult {
  return guarded(
    () => {
      if (isRecord(input) && isRecord(input.model) && !isRecord(input.root)) {
        return produceCommandEntries(input.model as unknown as XmlModel, isRecord(input.params) ? (input.params as CommandTreeParams) : {});
      }
      return produceCommandEntries(input as XmlModel);
    },
    (warning) => ({ entries: [], warnings: [warning] }),
  );
}

/** Attach immutable source declarations after the producer receives the original tree digest. */
export function bindCommandSource(entries:ProducedEntry[],source:string,byPath:DeclarationsByPath={}):ProducedEntry[]{return entries.map(entry=>{const own=entry.path===null?undefined:byPath[entry.path];if(!isRecord(entry.data)||!Array.isArray(entry.data.signatures)||!isRecord(own))return entry;const declarations=own;return {...entry,data:{...entry.data,signatures:(entry.data.signatures as CatalogSignature[]).map(signature=>{const d=declarations[signature.id??''];if(!isRecord(d)||typeof d.selector!=='string'||!Array.isArray(d.parameters))return signature;const parameters=d.parameters;return {...signature,reference:'src:'+source+'/xml@1/'+d.selector,params:signature.params.map((p,index)=>{const raw=parameters[index];return isRecord(raw)&&raw.native!==false&&typeof raw.name==='string'&&raw.name.length>0&&typeof raw.selector==='string'&&p.type!==undefined?{...p,native_type:{name:raw.name,declaration:'src:'+source+'/xml@1/'+raw.selector,grammar:'famx-command-tree@2'}}:p;})};})}};});}
