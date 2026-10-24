// Producer of command entries from a build's command tree (xml@1 model of command_tree-<build>.xml, ISO-8859-1 already
// decoded): commands > scope > menu[name] > item[name] > arguments > arg[name, type, length, limit, optional,
// default_value]. One entry per full command (menu words + item name) at /commands/<words>, a definition (K02 R[3]); the
// argument lists of one path are the overloads of that entry. Argument types map onto the generic catalog parameter types
// of hub/rules.
import type { CatalogParam, CatalogParamType, CatalogSignature, CatalogUncheckedConstraint } from '../../../../contracts/src/tables.ts';
import type { CommandEntryData, CommandTreeParams, CommandTreeResult, EntryKind, FragmentRef, ProducedEntry, XmlModel } from './types.ts';
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
  // An address of either family (the help texts of these arguments describe IPv4 and IPv6 forms).
  IPADDR: [{ type: 'ipv4' }, { type: 'ipv6' }],
  DOTTEDIP: [{ type: 'ipv4' }],
  // A dotted IPv4 netmask or a prefix length up to 128 (as the help texts of these arguments describe them).
  IPMASK: [{ type: 'mask' }, { type: 'int', minimum: 0, maximum: 128 }],
};

/**
 * Help texts that say an argument of a type takes more than the type's value set (pack data); such an argument is read as
 * a string unless the explicit hostname forms can be represented by the catalog. Origin: the help texts of the 66 DOTTEDIP arguments of the command tree sampled on 2026-10-21: the 10 that take
 * a host name, a URL, a parameter list or an empty value say so with "or ...", "hostname" or "URL"; the other 56 name an
 * IPv4 address only. IPADDR and IPMASK help texts use "or" for their IPv4 and IPv6 forms, which the unions cover.
 */
export const OTHER_FORMS: Readonly<{ [type: string]: readonly RegExp[] }> = {
  DOTTEDIP: [/\bor\b/i, /\bhost\s*names?\b/i, /\burls?\b/i],
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
    const type = typeof item.type==='string'?item.type.trim().toUpperCase():undefined;
    const role=typeof item.address_role==='string'?item.address_role.trim():undefined;
    if(!type&&!role){warnings.push(`第 ${row} 条声明没有参数类型或有效地址角色，已忽略`);return;}
    if (type!==undefined&&!Object.hasOwn(ARGUMENT_TYPES, type)) {
      warnings.push(`第 ${row} 条声明的参数类型 ${String(item.type).slice(0, 40)} 不在类型表里，已忽略`);
      return;
    }
    if (typeof item.origin !== 'string' || item.origin.trim() === '') {
      warnings.push(`第 ${row} 条声明的参数类型没有写来源（origin），已忽略`);
      return;
    }
    const command = squeeze(item.command).toLowerCase();
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

export type Limit = {kind:'range';low:number;high:number}|{kind:'unknown';text:string};
/** Only the documented inclusive bracket form is interpreted; other spellings retain a recovery diagnostic. */
export function parseLimit(text:string):Limit|null{
  const value=squeeze(text);if(value==='')return null;
  const match=/^\[\s*(-?[0-9]{1,15})\s*-\s*(-?[0-9]{1,15})\s*\]$/.exec(value);
  if(match){const low=Number(match[1]),high=Number(match[2]);if(Number.isSafeInteger(low)&&Number.isSafeInteger(high)&&low<=high)return {kind:'range',low,high};}
  return {kind:'unknown',text:value};
}

function optionalFlag(text: string, where: string, warnings: string[]): boolean {
  if (/^(?:yes|y|true|1)$/i.test(text)) return true;
  if (/^(?:no|n|false|0|)$/i.test(text)) return false;
  warnings.push(`${where} 的 optional 取值 ${text.slice(0, 20)} 认不出，按必填处理`);
  return false;
}

/** Default value as documented: character references decoded once more, one pair of surrounding double quotes removed. */
function defaultOf(text: string): string | undefined {
  const value = decodeEntities(text).replaceAll('\u0000', '').trim();
  if (value === '') return undefined;
  const quoted = /^"(.*)"$/s.exec(value);
  return quoted ? quoted[1] : value;
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
  return param.type;
}

type SourceParam = { name: string; alternatives: CatalogParam[]; optional: boolean; default?: string; description?: string; label: string };

type TypeCounters = { unknown: Map<string, number>; otherForms: Map<string, number> };

/** One argument: its catalog alternatives (several for a union type) and its text in the statement. */
function argumentParam(arg: XmlNode, position: number, where: string, warnings: string[], counters: TypeCounters, declared: Declared,parameterPath:string): SourceParam {
  const argName = attribute(arg, 'name');
  const name = argName === '' ? `arg${position}` : argName.replace(/\s+/g, '_');
  const at = `${where} 参数 ${name}`;
  const description = attribute(arg, 'help_string');
  let typeName = attribute(arg, 'type').toUpperCase();
  const declaration = declared.get(`${where.toLowerCase()}\u0000${position}`);
  if (declaration !== undefined) {
    declaration.used = true;
    if(declaration.type!==undefined)typeName = declaration.type;
  }
  if (declaration?.type===undefined && !/\bhost[ -]*names?\b/i.test(description) && Object.hasOwn(OTHER_FORMS, typeName) && OTHER_FORMS[typeName].some((pattern) => pattern.test(description))) {
    counters.otherForms.set(typeName, (counters.otherForms.get(typeName) ?? 0) + 1);
    typeName = 'STRING';
  }
  let alternatives: readonly Alternative[] = [{ type: 'string' }];
  if (Object.hasOwn(ARGUMENT_TYPES, typeName)) alternatives = ARGUMENT_TYPES[typeName];
  else {
    const key = typeName === '' ? '（空）' : typeName.slice(0, 40);
    counters.unknown.set(key, (counters.unknown.get(key) ?? 0) + 1);
  }
  if(declaration?.type===undefined&&(typeName==='DOTTEDIP'||typeName==='IPADDR')&&/\bhost[ -]*names?\b/i.test(description)){
    if(/\burls?\b|\blist\b|\bempty\b/i.test(description)){
      alternatives=[{type:'string'}];counters.otherForms.set(typeName,(counters.otherForms.get(typeName)??0)+1);
    }else if(!/\bip(?:v[46])?\b|\baddress(?:es)?\b/i.test(description))alternatives=[{type:'hostname'}];
    else alternatives=typeName==='DOTTEDIP'?[{type:'ipv4'},{type:'hostname'}]:[{type:'ip_or_hostname'}];
  }
  const optional = optionalFlag(attribute(arg, 'optional'), at, warnings);
  const defaultValue = defaultOf(arg.attributes.default_value ?? '');
  const params: CatalogParam[] = alternatives.map((alternative) => {
    const param: CatalogParam = { name, type: alternative.type };
    const role=declaration?.address_role??attribute(arg,'address_role');if(role)param.address_role=role;
    if (alternative.minimum !== undefined) param.minimum = alternative.minimum;
    if (alternative.maximum !== undefined) param.maximum = alternative.maximum;
    return param;
  });
  applyLimit(params,arg.attributes.limit??'','limit',parameterPath,warnings);
  applyLimit(params,arg.attributes.length??'','length',parameterPath,warnings);
  for (const param of params) {
    if (optional) param.optional = true;
    if (defaultValue !== undefined) param.default = defaultValue;
    if (description !== '') param.description = description;
  }
  const label = `<${name}:${params.map(typeLabel).join('/')}${defaultValue === undefined ? '' : `=${JSON.stringify(defaultValue)}`}>`;
  const out: SourceParam = { name, alternatives: params, optional, label: optional ? `[${label}]` : label };
  if (defaultValue !== undefined) out.default = defaultValue;
  if (description !== '') out.description = description;
  return out;
}

function asStringParam(param: SourceParam): CatalogParam {
  const out: CatalogParam = { name: param.name, type: 'string' };
  if (param.optional) out.optional = true;
  if (param.default !== undefined) out.default = param.default;
  if (param.description !== undefined) out.description = param.description;
  const role=param.alternatives[0]?.address_role;if(role)out.address_role=role;
  const gaps=param.alternatives.flatMap(alternative=>alternative.unchecked_constraints??[]);if(gaps.length)out.unchecked_constraints=[...new Map(gaps.map(gap=>[gap.path,gap])).values()];
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
  if (kept.size < unions.length) warnings.push(`${where} 的联合类型参数太多，有 ${unions.length - kept.size} 个按字符串处理`);
  let lists: CatalogParam[][] = [[]];
  for (const param of params) {
    const choices = param.alternatives.length === 1 || kept.has(param) ? param.alternatives : [asStringParam(param)];
    const next: CatalogParam[][] = [];
    for (const list of lists) for (const choice of choices) next.push([...list, { ...choice, ...(choice.values ? { values: [...choice.values] } : {}) }]);
    lists = next;
  }
  if (lists.length === 1) return [{ id, params: lists[0] }];
  return lists.map((list, j) => ({ id: `${id}.${j + 1}`, params: list }));
}

type Overload = { item: XmlNode; selector: string; argumentLists: Array<Array<{node:XmlNode;path:string}>> };
type Frame = { node: XmlNode; steps: string[]; words: string[] };

export function produceCommandEntries(model: XmlModel, params: CommandTreeParams = {}): CommandTreeResult {
  const warnings: string[] = [];
  try {
    const rootNode = isRecord(model) ? asNode(model.root) : null;
    if (rootNode === null) return { entries: [], warnings: ['输入不是 xml@1 模型（缺 root）'] };
    const base = isRecord(params) && typeof params.path === 'string' && /^\/[^\s]*$/.test(params.path) ? params.path : '/commands';
    const baseSegments = base.split('/').filter((segment) => segment !== '');
    const declared = declaredTypes(isRecord(params) ? params.argumentTypes : undefined, warnings);
    if (rootNode.name !== 'commands') warnings.push(`根元素是 ${rootNode.name.slice(0, 40)}，不是 commands；仍按菜单与命令读取`);
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
        for (const { node: part,step:partStep } of elementChildren(node)) {
          if (part.name === 'arguments') argumentLists.push(elementChildren(part).filter(({ node: arg }) => arg.name === 'arg').map(({ node: arg,step:argStep }) => ({node:arg,path:`${selector}/${partStep}/${argStep}`})));
        }
        if (argumentLists.length === 0) argumentLists.push([]);
        const key = words.join(' ');
        const slot = byPath.get(key) ?? { words, overloads: [] };
        slot.overloads.push({ item: node, selector, argumentLists });
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
          const name = attribute(child, 'name');
          const childWords = [...words, ...name.split(' ')];
          if (name === '') unnamed++;
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

    const counters: TypeCounters = { unknown: new Map(), otherForms: new Map() };
    const entries: ProducedEntry[] = [];
    for (const { words, overloads } of byPath.values()) {
      const where = words.join(' ');
      const path = pathText([...baseSegments, ...words]);
      if (path === null) {
        warnings.push(`命令 ${where.slice(0, 80)} 的路径写不出，已跳过`);
        continue;
      }
      const signatures: CatalogSignature[] = [];
      const lines: string[] = [];
      const fragments: FragmentRef[] = [];
      const summaries = new Set<string>();
      for (const overload of overloads) {
        const summary = attribute(overload.item, 'help_string');
        if (summary !== '') summaries.add(summary);
        for (const args of overload.argumentLists) {
          fragments.push({ parser: PARSER, selector: overload.selector });
          if (args.length > MAX_PARAMS) warnings.push(`${where} 的参数超过 ${MAX_PARAMS} 个，只取前 ${MAX_PARAMS} 个`);
          const sourceParams = args.slice(0, MAX_PARAMS).map((arg, index) => argumentParam(arg.node, index + 1, where, warnings, counters, declared,arg.path));
          signatures.push(...expand(sourceParams, String(fragments.length), where, warnings));
          lines.push([where, ...sourceParams.map((param) => param.label)].join(' '));
          if (summary !== '') lines.push(`  ${summary}`);
          for (const param of sourceParams){if (param.description !== undefined) lines.push(`  ${param.name}: ${param.description}`);for(const gap of param.alternatives[0].unchecked_constraints??[])lines.push(`  ${param.name} 约束未核对：${gap.path}；缺失事实：${gap.missing}；下一步：${gap.next_action}`);}
        }
      }
      const data: CommandEntryData = { words, signatures };
      if (summaries.size > 0) data.summary = [...summaries].join('\n');
      entries.push({ kind: KIND, path, statement: lines.join('\n'), data, fragments, applicability: null });
    }
    for (const [type, count] of counters.unknown) warnings.push(`参数类型 ${type} 不在类型表里（${count} 处），按字符串处理`);
    for (const [type, count] of counters.otherForms) warnings.push(`有 ${count} 个 ${type} 参数的说明写了地址以外的写法（主机名、URL 等），按字符串处理`);
    for (const item of declared.values()) {
      if (!item.used) warnings.push(`第 ${item.row} 条声明的参数类型（${item.command} 第 ${item.position} 个参数）在命令树里没有这个参数，未用上`);
    }
    return { entries, warnings };
  } catch (error) {
    return { entries: [], warnings: [...warnings, internalError(error)] };
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
