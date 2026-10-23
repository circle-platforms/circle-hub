import { isAttribution, type Attribution, type Verdict, type Nature, type SourceRole, type Layer, type StaticTerminal, type Acceptance, type ItemHandling } from '../../../contracts/generated/vocabulary.ts';
// Independent cited-command oracle. No Hub or pack implementation is imported.
// node scripts/real/gold/catalog-marks.ts --tree <locked command XML> --source <mindmap original>
//   --run <run-show.json> [--submission <original submission bytes>] [--gold <injection gold.json>]
//   [--hub-url <same endpoint as the draft session>] [--table <cited-commands.json>] --out <new private directory>
// --manifest <pack.json> binds the table bytes and run.pack_digest to the locked pack version.
// --argument-types <JSON array> supplies the locked-root overrides: [{command,position,type,origin}], including [].
// Only scope=resolved is implemented. Unknown types, constraints and missing receipts produce positioned requests.
import { canonicalJson } from './compile-check.ts';
import { SaxesParser } from 'saxes';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { caseGold, caseNodesOf, parseMindMap } from './cases.ts';
import type { CoreViolationCode } from '../../../contracts/generated/protocol.ts';

export const CATALOG_VALUES: {refute:Verdict;fact:Nature;subject:SourceRole;static:Layer;violation:StaticTerminal;accepted:Acceptance;skipped:ItemHandling;unattributed:Attribution} = {refute:'refute',fact:'fact',subject:'subject',static:'static',violation:'violation',accepted:'accepted',skipped:'skipped',unattributed:'unattributed'};

export interface Position { input: string; pointer: string; line?: number; column?: number }
export interface EvidenceRequest extends Position { fact: string; next_action: string; item?: string; command?: string; related?: Position[]; follow_up?: { program: string; args: string[] } }
interface Argument { name: string; type: string; limit?: string; length?: string; optional: boolean; optionalRaw?: string; help: string; at: Position }
interface Signature { args: Argument[]; at: Position }
interface Command { words: string[]; signatures: Signature[]; at: Position }
export interface Catalog { commands: Command[]; requests: EvidenceRequest[]; unnamedItems: number }
export interface CommandAnswer { in_scope: boolean; code: CoreViolationCode | null; requests: EvidenceRequest[] }
const RANGE: CoreViolationCode = 'core.catalog.param_out_of_range';
const TYPE: CoreViolationCode = 'core.catalog.param_type_mismatch';
const ARITY: CoreViolationCode = 'core.catalog.arity_mismatch';
export const fold = (value: string): string => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
const request = (at: Position, fact: string, next_action: string): EvidenceRequest => ({ ...at, fact, next_action });

export class CatalogInputError extends Error {
  readonly reason: 'tree_encoding' | 'tree_structure' | 'source_structure' | 'input_unreadable' | 'argument_types' | 'gold_structure' | 'input_in_git';
  constructor(reason: CatalogInputError['reason'], message: string) { super(message); this.reason = reason; this.name = 'CatalogInputError'; }
}
export class CatalogOutputError extends Error {
  readonly reason: 'path_in_git' | 'path_invalid' | 'output_exists';
  constructor(reason: CatalogOutputError['reason']) { super(reason); this.reason = reason; this.name = 'CatalogOutputError'; }
}
function readKnownInput(file: string | URL): Uint8Array {
  try { return readFileSync(file); } catch { throw new CatalogInputError('input_unreadable', '输入文件不可读'); }
}
export function decodeCatalog(bytes: Uint8Array): string {
  const declaration = Buffer.from(bytes.subarray(0, 256)).toString('ascii');
  const encoding = /encoding\s*=\s*["']([^"']+)["']/i.exec(declaration)?.[1].toLowerCase() ?? 'utf-8';
  if (encoding === 'iso-8859-1') return Buffer.from(bytes).toString('latin1');
  if (encoding !== 'utf-8' && encoding !== 'utf8' && encoding !== 'us-ascii') throw new CatalogInputError('tree_encoding', '命令树编码未实现');
  if (encoding === 'us-ascii' && bytes.some(b => b > 127)) throw new CatalogInputError('tree_encoding', 'ASCII 命令树含非 ASCII 字节');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new CatalogInputError('tree_encoding', '命令树字节不符合声明编码'); }
}
/** Repair only stray quotes inside an attribute; preserve offsets for positioned evidence. */
function tolerantStartTags(xml: string): string {
  let quote: string | null = null, tag = false;
  const chars = xml.split('');
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (!tag) { if (ch === '<') tag = true; continue; }
    if (quote !== null) {
      if (ch === quote) {
        const tail = chars.slice(i + 1, i + 150).join('');
        if (/^\s*(?:\/?[>?]|[\w:.-]+\s*=)/.test(tail)) quote = null;
        else chars[i] = quote === '"' ? "'" : '"';
      }
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') tag = false;
  }
  return chars.join('');
}

/** SAX is only an XML reader; menu paths, argument meaning and comparison are implemented here. */
export interface DeclaredArgumentType { command: string; position: number; type: string; origin: string }
export function readArgumentTypes(bytes: Uint8Array): DeclaredArgumentType[] {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes)); }
  catch (error) { if (error instanceof SyntaxError || error instanceof TypeError) throw new CatalogInputError('argument_types','类型声明不是有效 JSON'); throw error; }
  if (!Array.isArray(value) || !value.every(row => object(row) && typeof row.command === 'string' && row.command.trim() !== '' && typeof row.position === 'number' && Number.isSafeInteger(row.position) && row.position > 0 && typeof row.type === 'string' && row.type.trim() !== '' && typeof row.origin === 'string' && row.origin.trim() !== '')) throw new CatalogInputError('argument_types','类型声明数组格式不对');
  return value as DeclaredArgumentType[];
}
export function readCatalog(xml: string, argumentTypes: readonly DeclaredArgumentType[] = []): Catalog {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new CatalogInputError('tree_structure', '不支持 DTD 或实体声明');
  const catalog: Catalog = { commands: [], requests: [], unnamedItems: 0 };
  const byHead = new Map<string, Command>();
  type Frame = { tag: string; path: string; counts: Map<string, number>; words: string[]; command?: Command; signature?: Signature; arg?: Argument };
  const stack: Frame[] = [];
  const rootCounts = new Map<string, number>();
  const parser = new SaxesParser({ xmlns: false });
  const lines = [0]; for (let i = xml.indexOf('\n'); i >= 0; i = xml.indexOf('\n', i + 1)) lines.push(i + 1);
  const position = (pointer: string): Position => {
    const offset = xml.lastIndexOf('<', parser.position - 1);
    let low = 0, high = lines.length;
    while (low + 1 < high) { const mid = Math.floor((low + high) / 2); if (lines[mid] <= offset) low = mid; else high = mid; }
    return { input: 'tree', pointer, line: low + 1, column: offset - lines[low] + 1 };
  };
  parser.on('opentag', tag => {
    const parent = stack.at(-1), counts = parent?.counts ?? rootCounts;
    const ordinal = (counts.get(tag.name) ?? 0) + 1; counts.set(tag.name, ordinal);
    const path = `${parent?.path ?? ''}/${tag.name}[${ordinal}]`;
    const attrs = tag.attributes as Record<string, string>;
    const frame: Frame = { tag: tag.name, path, counts: new Map(), words: parent?.words ?? [], command: parent?.command, signature: parent?.signature, arg: parent?.arg };
    if (tag.name === 'menu' && !(attrs.name ?? '').trim()) catalog.requests.push(request(position(path), '未命名菜单及其子命令的路径规则', '请集成者在 case-review README 声明未命名菜单的处理规则，补充金标准实现与样例后重跑'));
    if (tag.name === 'menu') frame.words = [...frame.words, ...(attrs.name ?? '').normalize('NFKC').trim().split(/\s+/).filter(Boolean)];
    if (tag.name === 'item') {
      if (parent?.command) catalog.requests.push(request(position(path), '嵌套 item 的命令路径规则', '请集成者在 case-review README 或锁定表声明该 XML 结构的路径规则，补充金标准实现与样例，再按 follow_up 重跑'));
      const words = [...frame.words, ...(attrs.name ?? '').normalize('NFKC').trim().split(/\s+/).filter(Boolean)];
      if (!(attrs.name ?? '').trim()) { catalog.unnamedItems++; frame.command = undefined; frame.signature = undefined; frame.arg = undefined; stack.push(frame); return; }
      const key = fold(words.join(' '));
      const command = byHead.get(key) ?? { words, signatures: [], at: position(path) };
      byHead.set(key, command); frame.command = command; frame.signature = undefined; frame.arg = undefined;
    }
    if (tag.name === 'arguments' && frame.command) {
      frame.signature = { args: [], at: position(path) }; frame.command.signatures.push(frame.signature);
    }
    if (tag.name === 'arg' && frame.signature) {
      frame.arg = { name: attrs.name ?? `arg${frame.signature.args.length + 1}`, type: attrs.type ?? '', optional: /^(yes|y|true|1)$/i.test(attrs.optional ?? ''), ...(attrs.optional === undefined ? {} : { optionalRaw: attrs.optional }), ...(attrs.limit === undefined && attrs.range === undefined ? {} : { limit: attrs.limit ?? attrs.range }), ...(attrs.length === undefined ? {} : { length: attrs.length }), help: attrs.help_string ?? '', at: position(path) };
      const override = argumentTypes.find(row => fold(row.command) === fold(frame.command!.words.join(' ')) && row.position === frame.signature!.args.length + 1);
      if (override) frame.arg.type = override.type;
      else if (frame.arg.type.toUpperCase() === 'DOTTEDIP' && /\bor\b|host\s*names?|\burls?\b/i.test(frame.arg.help)) frame.arg.type = 'STRING';
      frame.signature.args.push(frame.arg);
    }
    stack.push(frame);
  });
  parser.on('text', text => { const arg = stack.at(-1)?.arg; if (arg) arg.help += text; });
  parser.on('closetag', () => { stack.pop(); });
  parser.on('error', error => { throw new CatalogInputError('tree_structure', error.message); });
  parser.write(tolerantStartTags(xml)).close();
  catalog.commands = [...byHead.values()];
  for (const command of catalog.commands) if (!command.signatures.length) command.signatures.push({ args: [], at: command.at });
  if (!catalog.commands.length) catalog.requests.push({ input: 'tree', pointer: '/', line: 1, column: 1, fact: '可识别的命令定义', next_action: '请集成者确认锁定根并重新导出命令树原件；如确为空目录，补充其声明' });
  return catalog;
}

/** Case quotation uses the table's matching form and cannot add or cut off command arguments. */
export function quoteFromCase(command: string, lines: readonly string[]): boolean {
  const phrase = fold(command);
  return phrase !== '' && lines.some(line => fold(line) === phrase);
}

function tokenize(line: string): string[] | null {
  const words: string[] = [];
  let word = '', quote: string | null = null, active = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\') return null;
    if (quote !== null) { if (ch === quote) quote = null; else word += ch; active = true; continue; }
    if (ch === '"' || ch === "'") { quote = ch; active = true; continue; }
    if (/\s/.test(ch)) { if (active) words.push(word); word = ''; active = false; }
    else { word += ch; active = true; }
  }
  if (quote !== null) return null;
  if (active) words.push(word);
  return words;
}
type Constraint = { low?: number; high?: number; values?: string[] };
function constraint(raw: string | undefined, at: Position, attribute: string, length: boolean): { value: Constraint; requests: EvidenceRequest[] } {
  if (raw === undefined || !raw.trim()) return { value: {}, requests: [] };
  const text = raw.normalize('NFKC').trim();
  const range = /^[\[(]?\s*(-?\d+)\s*(?:-|~|\.\.|to)\s*(-?\d+)\s*[\])]?$/.exec(text);
  const enumeration = /^[{[(]?\s*([^\s|,{}()[\]]+(?:\s*[|,]\s*[^\s|,{}()[\]]+)+)\s*[}\])]?$/.exec(text);
  if (range) {
    const low = Number(range[1]), high = Number(range[2]);
    if (Number.isSafeInteger(low) && Number.isSafeInteger(high) && low <= high && (!length || low >= 0)) return { value: { low, high }, requests: [] };
  } else if (attribute === 'length' && /^\d+$/.test(text) && Number.isSafeInteger(Number(text))) return { value: { high: Number(text) }, requests: [] };
  else if (enumeration && attribute !== 'length') return { value: { values: enumeration[1].split(/\s*[|,]\s*/) }, requests: [] };
  return { value: {}, requests: [request({ ...at, pointer: at.pointer + '/@' + attribute }, '参数约束的可解析语法：' + raw, '请集成者在 case-review README 或锁定表声明该位置约束的正式语法，补充金标准实现与正反样例，再按 follow_up 重跑独立核对')] };
}
interface Parameter { raw: Argument; type: string; limit: Constraint; length: Constraint; ambiguities: EvidenceRequest[] }
function parameter(raw: Argument): { value: Parameter; requests: EvidenceRequest[] } {
  const type = raw.type.toUpperCase(), requests: EvidenceRequest[] = [];
  if (!['STRING', 'XSTRING', 'U16', 'U32', 'DOTTEDIP', 'IPADDR', 'IPMASK'].includes(type)) requests.push(request({ ...raw.at, pointer: raw.at.pointer + '/@type' }, '不认识的参数类型：' + raw.type, '请集成者在 case-review README 或锁定表声明该位置类型定义，补充金标准实现与正反样例，再按 follow_up 重跑'));
  if (raw.optionalRaw !== undefined && !/^(yes|y|true|1|no|n|false|0)$/i.test(raw.optionalRaw)) requests.push(request({ ...raw.at, pointer: raw.at.pointer + '/@optional' }, '参数是否可省略的声明', '请集成者在 case-review README 或锁定表声明 optional 的布尔语义，补充金标准实现与样例，再按 follow_up 重跑'));

  const limit = constraint(raw.limit, raw.at, 'limit', type === 'STRING' || type === 'XSTRING');
  const length = constraint(raw.length, raw.at, 'length', true);
  if (['DOTTEDIP', 'IPADDR', 'IPMASK'].includes(type) && (limit.value.low !== undefined || limit.value.high !== undefined)) requests.push(request({ ...raw.at, pointer: raw.at.pointer + '/@limit' }, '地址类型 limit 的计量含义（地址范围还是字符长度）', '请集成者在 case-review README 或锁定表声明地址 limit 的正式含义，补充金标准实现与样例，再按 follow_up 重跑'));
  if (limit.value.values && type !== 'STRING' && type !== 'XSTRING') requests.push(request({ ...raw.at, pointer: raw.at.pointer + '/@limit' }, '枚举与数值或地址类型的覆盖规则', '请集成者在 case-review README 或锁定表声明枚举替换类型还是与类型相交，补充金标准实现与正反样例，再按 follow_up 重跑'));
  if (raw.length !== undefined && type !== 'STRING' && type !== 'XSTRING') requests.push(request({...raw.at,pointer:raw.at.pointer+'/@length'}, '非字符串类型 length 的适用规则', '请集成者在 case-review README 或锁定表声明此类型的长度语义，补充金标准实现和样例，再按 follow_up 重跑'));
  if ((type === 'U16' || type === 'U32') && ((limit.value.high !== undefined && limit.value.high < 0) || (limit.value.low !== undefined && limit.value.low > (type === 'U16' ? 65535 : 4294967295)))) requests.push(request({...raw.at,pointer:raw.at.pointer+'/@limit'}, '与整数类型范围不相交的 limit 的处理规则', '请集成者在 case-review README 或锁定表声明不相交约束规则，补充金标准实现和样例，再按 follow_up 重跑'));
  return { value: { raw, type, ambiguities: [], limit: limit.value, length: length.value }, requests: [...requests, ...limit.requests, ...length.requests] };
}
function parameterCode(p: Parameter, word: string): CoreViolationCode | null {
  const v = word.normalize('NFKC');
  const numeric = p.type === 'U16' || p.type === 'U32';
  if (p.limit.values && !p.limit.values.some(value => fold(value) === fold(v))) return TYPE;
  if (numeric && !/^[+-]?[0-9]+$/.test(v)) return TYPE;
  if (p.type === 'DOTTEDIP' && isIP(v) !== 4) return TYPE;
  if (p.type === 'IPADDR' && (!isIP(v) || v.includes('%'))) return TYPE;
  if (p.type === 'IPMASK') {
    const dotted = isIP(v) === 4 && /^1*0*$/.test(v.split('.').map(n => Number(n).toString(2).padStart(8, '0')).join(''));
    const prefix = /^[+-]?[0-9]+$/.test(v) && Number(v) >= 0 && Number(v) <= 128;
    if (!dotted && !prefix) { if (/^[+-]?[0-9]+$/.test(v)) p.ambiguities.push(request(p.raw.at, 'IPMASK 的两个分支均不符时采用的错误码', '请集成者在 case-review README 或锁定表声明掩码与前缀双分支失败的代码选择规则，补充金标准实现与样例，再按 follow_up 重跑')); return TYPE; }
  }
  if (numeric && (!Number.isSafeInteger(Number(v)) || Number(v) < 0 || Number(v) > (p.type === 'U16' ? 65535 : 4294967295))) return RANGE;
  const measured = numeric ? Number(v) : [...v].length;
  if ((p.limit.low !== undefined && measured < p.limit.low) || (p.limit.high !== undefined && measured > p.limit.high)) return RANGE;
  const length = [...v].length;
  if ((p.length.low !== undefined && length < p.length.low) || (p.length.high !== undefined && length > p.length.high)) return RANGE;
  return null;
}

/** A known fitting signature proves validity. Different possible failure codes require a rule, not a guess. */
export function judgeCommand(catalog: Catalog, line: string): CommandAnswer {
  if (!catalog.commands.length) return { in_scope: false, code: null, requests: catalog.requests };
  const normalized = line.normalize('NFKC').trim(), tokens = tokenize(normalized);
  const headWords = tokens ?? normalized.split(/\s+/);
  const matches = catalog.commands.filter(c => c.words.every((word, i) => headWords[i] !== undefined && fold(word) === fold(headWords[i]))).sort((a, b) => b.words.length - a.words.length);
  const command = matches[0]; if (!command) return { in_scope: false, code: null, requests: [] };
  const localRequests = catalog.requests.filter(r => r.pointer.startsWith(command.at.pointer + '/') || r.pointer === command.at.pointer || command.at.pointer.startsWith(r.pointer + '/'));
  if (localRequests.length) return { in_scope: true, code: null, requests: localRequests };
  if (tokens === null) return { in_scope: true, code: null, requests: [request(command.at, '命令行的引号或转义切分规则', '请集成者以 hub/rules/README.md 的 shell-like 引号、转义与末尾反斜杠拒绝规则为候选，在 case-review README 或锁定表确认，补充金标准实现与样例，再按 follow_up 重跑；保持原件字节不变')] };
  const args = tokens.slice(command.words.length);
  const signatures = command.signatures.map(signature => {
    let expansion = 1;
    return signature.args.map(raw => {
      if (raw.type.toUpperCase() === 'IPADDR' || raw.type.toUpperCase() === 'IPMASK') {
        if (expansion * 2 > 32) return parameter({...raw,type:'STRING'});
        expansion *= 2;
      }
      return parameter(raw);
    });
  });
  const requests = signatures.flatMap(signature => signature.flatMap(p => p.requests));
  if (requests.length) return { in_scope: true, code: null, requests };
  let arityFits = false;
  const failedCodes = new Set<CoreViolationCode>();
  const reachableAmbiguities: EvidenceRequest[] = [];
  for (const signature of signatures) {
    const params = signature.map(p => p.value);
    // Reachable assignments retain every possible failure code. Optional fields may precede required ones.
    let states = new Map<number, Set<CoreViolationCode>>([[0, new Set()]]);
    let validStates = new Set<number>([0]);
    let gaps = new Map<number,EvidenceRequest[]>([[0,[]]]);
    for (const param of params) {
      const next = new Map<number, Set<CoreViolationCode>>(), validNext = new Set<number>();
      const nextGaps = new Map<number,EvidenceRequest[]>();
      const carryGaps = (from:number, to:number, pending:EvidenceRequest[]=[]):void => {
        const merged=[...(nextGaps.get(to) ?? []),...(gaps.get(from) ?? []),...pending];
        nextGaps.set(to,[...new Map(merged.map(r=>[JSON.stringify([r.input,r.pointer,r.fact]),r])).values()]);
      };
      for (const [used, codes] of states) {
        if (param.raw.optional) { carryGaps(used, used); const kept = next.get(used) ?? new Set<CoreViolationCode>(); codes.forEach(c => kept.add(c)); next.set(used, kept); if (validStates.has(used)) validNext.add(used); }
        if (used < args.length) {
          param.ambiguities = [];
          const code = parameterCode(param, args[used]), kept = next.get(used + 1) ?? new Set<CoreViolationCode>();
          carryGaps(used, used + 1, param.ambiguities);
          codes.forEach(c => kept.add(c)); if (code) kept.add(code); next.set(used + 1, kept);
          if (validStates.has(used) && code === null) validNext.add(used + 1);
        }
      }
      states = next; validStates = validNext; gaps = nextGaps;
    }
    if (validStates.has(args.length)) return { in_scope: true, code: null, requests: [] };
    const codes = states.get(args.length);
    if (codes) { arityFits = true; codes.forEach(code => failedCodes.add(code)); reachableAmbiguities.push(...(gaps.get(args.length) ?? [])); }
  }
  const ambiguity = reachableAmbiguities;
  if (ambiguity.length) return { in_scope: true, code: null, requests: ambiguity };
  if (!arityFits) return { in_scope: true, code: ARITY, requests: [] };
  if (failedCodes.size === 1) return { in_scope: true, code: [...failedCodes][0], requests: [] };
  return { in_scope: true, code: null, requests: [request(command.at, '多个参数或签名失败时错误码的选择规则', '请集成者在 case-review README 或锁定表声明签名与参数之间的错误码选择规则，补充金标准实现与样例，再按 follow_up 重跑；不照抄被核实现的优先级')] };
}

export interface Mark { item: string; node: string; command: string; code: string; pointer: string; output_error?: string }
export interface CatalogComparison {
  not_compared: Array<{item:string;expected:Mark[];negative_expected:Mark[];hub:unknown[]}>;
  expected: Mark[]; observed: Mark[]; supported: Mark[]; missed: Mark[]; extra: Mark[];
  negative_expected: Mark[]; negative_observed: Mark[]; requests: EvidenceRequest[];
  summary: { not_compared: number; cases: number; cited: number; not_quoted: number; unresolved_heads: number; ignored_hub_claims: number; supported: number; missed: number; extra: number; design_gaps: number };
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const displayCommand = (value: string): string => fold((tokenize(value.normalize('NFKC')) ?? [value]).join(' '));
const markKey = (mark: Mark): string => JSON.stringify([mark.item, mark.pointer, displayCommand(mark.command), mark.code, mark.output_error ?? null]);

/** Validate input shape at its boundary; exceptions from the actual oracle remain gold defects. */
function parseCatalogSource(value: unknown): ReturnType<typeof parseMindMap> {
  if (!object(value)) throw new CatalogInputError('source_structure', '脑图不是对象');
  const root = value.root ?? value;
  if (!object(root)) throw new CatalogInputError('source_structure', '脑图缺 root');
  const queue: unknown[] = [root], seen = new Set<unknown>();
  while (queue.length) {
    const node = queue.pop();
    if (!object(node) || (node.data !== undefined && node.data !== null && !object(node.data))) throw new CatalogInputError('source_structure', '脑图节点结构无效');
    if (seen.has(node) || seen.size >= 100_000) throw new CatalogInputError('source_structure', '脑图节点重复或过多');
    seen.add(node); queue.push(...array(node.children).slice(0, 1000));
  }
  return parseMindMap(value);
}

/** Comparison uses the submitted phrases as its population, never the Hub's refutations as the oracle. */
export function compareCatalogMarks(input: { treeXml: string; source: unknown; submission: unknown; run: unknown; excludeNodes?: readonly string[]; caseRule?: 'marked' | 'tagged'; argumentTypes?: readonly DeclaredArgumentType[] }): CatalogComparison {
  const report: CatalogComparison = { not_compared: [], expected: [], observed: [], supported: [], missed: [], extra: [], negative_expected: [], negative_observed: [], requests: [], summary: { not_compared: 0, cases: 0, cited: 0, not_quoted: 0, unresolved_heads: 0, ignored_hub_claims: 0, supported: 0, missed: 0, extra: 0, design_gaps: 0 } };
  const catalog = readCatalog(input.treeXml, input.argumentTypes), parsed = parseCatalogSource(input.source);
  const cases = caseNodesOf(parsed, { caseRule: input.caseRule }), indices = new Set(cases.map(c => c.index));
  const unique = new Map<string, number>(); parsed.nodes.forEach(node => unique.set(node.id, (unique.get(node.id) ?? 0) + 1));
  const reading = cases.length ? caseGold([{ document: 'source', map: input.source }], { caseRule: input.caseRule }).documents[0].items : [];
  const excluded = new Set(input.excludeNodes ?? []);
  const sourcePointers: string[] = [];
  const walk = (value: unknown, path: string): void => {
    sourcePointers.push(path);
    if (object(value)) array(value.children).slice(0, 1000).forEach((child, i) => walk(child, `${path}/children/${i}`));
  };
  walk(object(input.source) ? input.source.root : null, '/root');
  type Own = { id: string; negative: boolean; lines: string[]; at: Position };
  const own = new Map<string, Own>();
  for (const [caseIndex, node] of cases.entries()) {
    if (excluded.has(node.id)) continue;
    const at = { input: 'source', pointer: `${sourcePointers[node.index]}/data/id` };
    const identity = node.id && unique.get(node.id) === 1 ? node.id : '@' + node.index;
    const item = reading[caseIndex];
    const preconditions: string[] = [];
    const visit = (index: number): void => { for (const child of parsed.nodes[index].children) { if (indices.has(child)) continue; const n = parsed.nodes[child]; if (!n.children.length && n.priority === 3) preconditions.push(n.text); visit(child); } };
    visit(node.index);
    own.set(identity, { id: identity, negative: item.negative, lines: [...item.title.split('\n'), ...item.steps.flatMap(step => step.text.split('\n')), ...item.expected, ...preconditions], at });
  }
  report.summary.cases = own.size;
  const run = object(input.run) ? input.run : {}, runRecord = object(run.run) ? run.run : {};
  const projections = array(runRecord.items);
  const mapped = new Map<string, Own | null>();
  const identify = (item: string, at: Position, needsEvidence = false): Own | null => {
    if (mapped.has(item)) return mapped.get(item)!;
    const projection = projections.find(p => object(p) && (p.id === item || p.item === item));
    const positional = object(projection) && typeof projection.location === 'string' ? /\/kityminder@1\/i((?:\/\d+)*)$/.exec(projection.location) : null;
    if (positional) {
      const pointer = '/root' + positional[1].split('/').filter(Boolean).map(k => '/children/' + Number(k)).join('') + '/data/id';
      const found = [...own.values()].find(o => o.at.pointer === pointer);
      if (found) { mapped.set(item, found); return found; }
    }
    const declared = object(projection) && object(projection.fields) ? projection.fields.nodeId : undefined;
    const matches = typeof declared === 'string' ? [...own.values()].filter(o => o.id === declared) : [...own.values()].filter(o => o.id === item || item.endsWith(':' + o.id));
    if (matches.length === 1) { mapped.set(item, matches[0]); return matches[0]; }
    if ([...excluded].some(node => node === item || item.endsWith(':' + node))) { mapped.set(item, null); return null; }
    if (needsEvidence) report.requests.push(request(at, '有命令引文的运行条目与原件位置的唯一对应', '请集成者重导出 run show 中本条目的 location 位置选择器后重跑，不能靠重复编号猜测'));
    return null;
  };
  const boundaryGaps = new Set<string>();
  const phrases = new Map<string, string[]>(), blocked = new Set<string>();
  const submitted = object(input.submission) ? input.submission : {};
  array(submitted.items).forEach((entry, i) => {
    if (!object(entry) || typeof entry.item !== 'string') { report.requests.push(request({ input: 'submission', pointer: `/items/${i}` }, '条目身份', '补取原始提交里这一项的 item 字段后重跑')); return; }
    const at = { input: 'submission', pointer: `/items/${i}` }, target = identify(entry.item, at, object(entry.slots) && array(entry.slots.findings).some(f => object(f) && array(f.commands).some(c => object(c) && typeof c.command === 'string' && c.present === undefined)));
    if (!target || entry.handling === CATALOG_VALUES.skipped || entry.reuse !== undefined) return;
    if (!object(entry.slots) || !Array.isArray(entry.slots.findings)) { report.requests.push(request({ ...at, pointer: at.pointer + '/slots/findings' }, '本条目明确的发现列表（可为空数组）', '导出本次最新受理提交的完整 slots.findings 后重跑；缺字段不能当空列表')); return; }
    const owned: Array<{ command: string; at: Position }> = [];
    entry.slots.findings.forEach((finding, j) => {
      if (!object(finding) || finding.commands === undefined) return;
      if (!Array.isArray(finding.commands)) { report.requests.push(request({ ...at, pointer: `${at.pointer}/slots/findings/${j}/commands` }, '命令引用数组', '补取该发现完整的 commands 数组后重跑')); return; }
      finding.commands.forEach((value, k) => {
        const location = { input: 'submission', pointer: `${at.pointer}/slots/findings/${j}/commands/${k}` };
        if (!object(value) || typeof value.command !== 'string') { report.requests.push(request(location, '模型原样引用的完整命令行', '按本位置补原始提交，不从 Hub 的标记反推命令行')); return; }
        if (typeof value.present === 'boolean') return; // These are model membership statements, not cited lines.
        if (value.present !== undefined) { report.requests.push(request({ ...location, pointer: location.pointer + '/present' }, '该命令是原样引用还是存在性陈述', '补取原始布尔值或确认未声明 present 后重跑')); return; }
        if (!quoteFromCase(value.command, target.lines)) {
          if (fold(value.command) && target.lines.some(line => fold(line).includes(fold(value.command as string)))) {
            boundaryGaps.add(entry.item as string);
            report.requests.push({ ...request({ input: 'table', pointer: '/match/boundary' }, '子串引文的完整词与参数边界规则', '请集成者在锁定版本的表或 case-review README 声明边界规则，补充金标准实现与正反样例，再按 follow_up 重跑；也可重新提交完整命令行引文，不能复制被核实现的切分算法'), related: [location, target.at] });
          } else report.summary.not_quoted++;
          return;
        }
        owned.push({ command: value.command, at: location });
      });
    });
    phrases.set(entry.item as string, owned.map(p => p.command));
    owned.forEach((phrase, index) => {
      report.summary.cited++;
      const judged = judgeCommand(catalog, phrase.command), pointer = `/phrases/${index}`;
      if (judged.requests.length) {
        blocked.add(JSON.stringify([entry.item, pointer]));
        report.requests.push(...judged.requests.map(r => ({ ...r, item: entry.item as string, command: phrase.command, related: [phrase.at, target.at] })));
      } else if (!judged.in_scope) report.summary.unresolved_heads++;
      else if (judged.code !== null) {
        const mark = { item: entry.item as string, node: target.id, command: phrase.command, code: judged.code, pointer };
        (target.negative ? report.negative_expected : report.expected).push(mark);
      }
    });
  });
  for (const item of boundaryGaps) {
    report.not_compared.push({item, expected:report.expected.filter(m=>m.item===item), negative_expected:report.negative_expected.filter(m=>m.item===item), hub:[]});
  }
  report.expected = report.expected.filter(m=>!boundaryGaps.has(m.item));
  report.negative_expected = report.negative_expected.filter(m=>!boundaryGaps.has(m.item));
  report.summary.not_compared = report.not_compared.length;
  const latest = object(run.latest) ? run.latest : {}, result = object(latest.result) ? latest.result : {};
  if (!object(result.partitions)) report.requests.push(request({ input: 'run', pointer: '/latest/result/partitions' }, '最新结构化评审结果', '重新执行 circle-hub run show <本次运行> --json 导出完整结果后重跑'));
  for (const [partition, values] of Object.entries(object(result.partitions) ? result.partitions : {})) array(values).forEach((value, i) => {
    if (!object(value) || typeof value.item !== 'string') return;
    const target = identify(value.item, { input: 'run', pointer: `/latest/result/partitions/${partition}/${i}/item` });
    if (!target) return;
    if (boundaryGaps.has(value.item)) { report.not_compared.find(row=>row.item===value.item)!.hub.push(value); return; }
    array(value.requirements).forEach((requirement, j) => {
      if (!object(requirement) || requirement.requirement !== 'catalog') return;
      const layers = array(requirement.layers), staticLayer = layers.find(l => object(l) && l.layer === CATALOG_VALUES.static);
      const attribution = object(staticLayer) && isAttribution(staticLayer.attribution) ? staticLayer.attribution : null;
      array(requirement.claims).forEach((claim, k) => {
        if (!object(claim) || !object(claim.statement) || !object(claim.qualifier)) return;
        const statement = claim.statement, qualifier = claim.qualifier;
        if (statement.verdict !== CATALOG_VALUES.refute || typeof statement.code !== 'string' || !statement.code.startsWith('core.catalog.') || qualifier.nature !== CATALOG_VALUES.fact || qualifier.source_role !== CATALOG_VALUES.subject) { report.summary.ignored_hub_claims++; return; }
        const at = { input: 'run', pointer: `/latest/result/partitions/${partition}/${i}/requirements/${j}/claims/${k}` };
        if (typeof claim.pointer !== 'string') { report.observed.push({item:value.item as string,node:target.id,command:object(statement.data) && typeof statement.data.command === 'string' ? statement.data.command : '',code:statement.code,pointer:'<missing>',output_error:'输出缺字段：pointer'}); return; }
        if (!/^\/phrases\/[0-9]+$/.test(claim.pointer)) { report.summary.ignored_hub_claims++; return; }
        if (!object(statement.data) || typeof statement.data.command !== 'string') { report.observed.push({item:value.item as string,node:target.id,command:'',code:statement.code,pointer:claim.pointer,output_error:'输出缺字段：data.command'}); return; }
        if (blocked.has(JSON.stringify([value.item, claim.pointer]))) return;
        const original = phrases.get(value.item as string)?.[Number(claim.pointer.slice('/phrases/'.length))];
        const command = original !== undefined && displayCommand(original) === fold(statement.data.command) ? original : statement.data.command;
        const mark = { item: value.item as string, node: target.id, command, code: statement.code, pointer: claim.pointer };
        const expectedNegative = target.negative && [RANGE, TYPE, ARITY].includes(statement.code as CoreViolationCode);
        if (expectedNegative) report.negative_observed.push(mark);
        else if (attribution === null || attribution === CATALOG_VALUES.unattributed) report.observed.push({ ...mark, output_error: '输出缺少或不一致的静态层归责' });
        else report.observed.push(mark);
      });
    });
  });
  const remaining = [...report.observed];
  for (const expected of report.expected) { const index = remaining.findIndex(actual => markKey(actual) === markKey(expected)); if (index < 0) report.missed.push(expected); else { report.supported.push(expected); remaining.splice(index, 1); } }
  report.extra = remaining;
  Object.assign(report.summary, { supported: report.supported.length, missed: report.missed.length, extra: report.extra.length, design_gaps: report.requests.length });
  return report;
}

export interface CatalogReport extends CatalogComparison {
  inputs: { tree_sha256: string | null; source_sha256: string | null; submission_sha256: string | null; expected_submission_sha256: string | null; locked_root: string | null };
}
export interface CatalogInputs {
  hubUrl?: string;
  treeXml: string; treeBytes?: Uint8Array; sourceBytes: Uint8Array; run: unknown; submissionBytes?: Uint8Array;
  table: unknown; packManifest?: unknown; tableBytes?: Uint8Array; excludeNodes?: readonly string[]; argumentTypes?: readonly DeclaredArgumentType[];
}
const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const parseJson = (bytes: Uint8Array): unknown => {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')); }
  catch (error) { if (error instanceof SyntaxError || error instanceof TypeError) throw new CatalogInputError('source_structure', '输入不是有效 UTF-8 JSON'); throw error; }
};

/** Versioned declaration drift is a gap, never silently interpreted as the current resolved table. */
export function tableRequests(value: unknown): EvidenceRequest[] {
  const problems: EvidenceRequest[] = [];
  const gap = (pointer: string, fact: string): void => { problems.push(request({ input: 'table', pointer }, fact, '请集成者确认锁定版本的 cited_commands 表；只实现了 scope=resolved 和当前匹配声明，补充新规则与样例后才能重跑')); };
  if (!object(value)) { gap('/', '可读的 cited_commands 目录表'); return problems; }
  if (value.scope !== 'resolved') gap('/scope', '只实现了 scope=resolved；实际声明为 ' + String(value.scope));
  if (value.schema !== 'catalog@1') gap('/schema', '只实现了 catalog@1');
  if (value.catalog !== 'commands@1') gap('/catalog', '只实现了 commands@1 命令目录');
  if (JSON.stringify(value.commands) !== JSON.stringify(['$.phrases']) || value.claims !== undefined) gap('/commands', '只核对 $.phrases，不能核对模型的存在性陈述');
  if (!object(value.match) || value.match.unicode !== 'nfkc' || value.match.case !== 'insensitive' || value.match.whitespace !== 'collapse') gap('/match', '只实现了 NFKC、大小写不敏感和空白折叠');
  const negative = object(value.negative) ? value.negative : {};
  if (negative.flag !== '/negative' || [RANGE, TYPE, ARITY].some(code => !array(negative.expect).includes(code)) || array(negative.expect).length !== 3) gap('/negative', '反向用例预期反驳的标志与三个参数错误码');
  return problems;
}

export function acceptedSubmissionReference(value: unknown): string | null {
  if (!object(value) || !object(value.latest)) return null;
  const latest = value.latest;
  const accepted = array(value.submissions).find(row => object(row) && row.result === latest.record);
  if (!object(accepted) || typeof accepted.record !== 'string') return null;
  const digest = accepted.record.replace(/^rec:/, '');
  return /^[a-f0-9]{64}$/.test(digest) ? 'rec:' + digest : null;
}

/** Receipt checks precede every adjudication. Submission identity uses the declared canonical JSON digest; raw source bytes retain byte identity. */
export function catalogMarks(input: CatalogInputs): CatalogReport {
  const empty: CatalogComparison = { not_compared: [], expected: [], observed: [], supported: [], missed: [], extra: [], negative_expected: [], negative_observed: [], requests: [], summary: { not_compared: 0, cases: 0, cited: 0, not_quoted: 0, unresolved_heads: 0, ignored_hub_claims: 0, supported: 0, missed: 0, extra: 0, design_gaps: 0 } };
  const run = object(input.run) ? input.run : {}, record = object(run.run) ? run.run : {}, latest = object(run.latest) ? run.latest : {}, result = object(latest.result) ? latest.result : {};
  const wanted = typeof result.submission === 'string' && /^[0-9a-f]{64}$/.test(result.submission) ? result.submission : null;
  const inputs = { tree_sha256: sha256(input.treeBytes ?? input.treeXml), source_sha256: sha256(input.sourceBytes), submission_sha256: input.submissionBytes === undefined ? null : (() => { try { return sha256(canonicalJson(parseJson(input.submissionBytes))); } catch { return null; } })(), expected_submission_sha256: wanted, locked_root: typeof record.root === 'string' ? record.root : null };
  const requests = tableRequests(input.table);
  const add = (where: string, pointer: string, fact: string, next_action: string): void => { requests.push(request({ input: where, pointer }, fact, next_action)); };
  const manifest = object(input.packManifest) ? input.packManifest : {};
  const tableEntry = array(manifest.files).find(f => object(f) && f.path === 'tables/cited-commands.json');
  if (record.pack !== manifest.id + '@' + manifest.version || record.pack_digest !== sha256(canonicalJson(manifest))) add('manifest', '/', '运行锁定包的版本与规范清单摘要', '请集成者取运行 run.pack 对应版本的 pack.json，通过 --manifest 传入；不能使用当前检出替代锁定版本');
  if (!input.tableBytes || !object(tableEntry) || tableEntry.sha256 !== sha256(input.tableBytes)) add('table', '/', '目录表原始字节与锁定清单的摘要', '请集成者取锁定包 tables/cited-commands.json 原字节，通过 --table 和 --manifest 传入后重跑');
  const recordRef = acceptedSubmissionReference(run) ?? '<run.submissions 中 result 等于 latest.record 的 record>';
  if (input.argumentTypes === undefined) add('argument-types', '/', '锁定根生产参数中的 argumentTypes 声明（允许空数组）', '请集成者从锁定根对应生产记录导出声明数组，每项为 {command, position, type, origin}，保存为 Git 外 JSON，通过 --argument-types 传入后重跑');
  const exportSubmission = '由集成者执行 node scripts/real/hub-call.ts' + (input.hubUrl === undefined ? '' : ' --url ' + JSON.stringify(input.hubUrl)) + ' --token-env HUB_REAL_TOKEN --structured <仓库外新输出.jsonl> get_nodes ' + JSON.stringify(JSON.stringify({ reference: recordRef })) + '，逐页跟随 next/cursor 拼接 content.text，保存为提交 JSON 后用 --submission <该文件> 重跑；缺记录映射时先重导出 circle-hub run show <运行> --json 的 submissions；按规范 JSON 摘要绑定，允许格式化';

  if (wanted === null) add('run', '/latest/result/submission', '最新受理提交的规范 JSON sha256', exportSubmission);
  if (input.submissionBytes === undefined) add('submission', '/', '最新受理提交的完整正文 JSON', exportSubmission);
  else if (wanted !== null && inputs.submission_sha256 !== wanted) add('submission', '/', '提交正文规范 JSON 摘要与最新受理提交不一致', exportSubmission);
  if (result.acceptance !== CATALOG_VALUES.accepted) add('run', '/latest/result/acceptance', '最新已受理的评审结果', '请集成者重导出本次 circle-hub run show <运行> --json 的最新受理结果');
  if (typeof record.run !== 'string' || result.run !== record.run) add('run', '/latest/result/run', '提交、最新受理结果和运行的同一身份', '重新导出同一次运行的 run show 与提交原件后重跑');
  if (typeof record.root !== 'string' || !/^[0-9a-f]{64}$/.test(record.root)) add('run', '/run/root', '本次运行锁定的知识树根', '重导出完整 run show，并由集成者从这个锁定根导出 --tree 命令树原件');
  const bound = array(record.sources).some(source => object(source) && source.role === CATALOG_VALUES.subject && typeof source.reference === 'string' && (source.reference === `src:${inputs.source_sha256}` || source.reference.startsWith(`src:${inputs.source_sha256}/`)));
  if (!bound) add('source', '/', '脑图原件与运行 subject 的字节摘要绑定', '按 run show 的 subject src 摘要由集成者执行 circle-hub original export 导出原件，再用 --source 重跑');
  let submission: unknown, source: unknown;
  try { source = parseJson(input.sourceBytes); } catch { add('source', '/', '可按 UTF-8 JSON 解析的脑图原件', '请集成者补取原件的编码声明或重新导出正确字节；不要用替换字符继续核对'); }
  if (input.submissionBytes !== undefined && wanted !== null && inputs.submission_sha256 === wanted) {
    try { submission = parseJson(input.submissionBytes); } catch { add('submission', '/', '可按 UTF-8 JSON 解析的提交正文', exportSubmission); }
    if (!object(submission) || submission.run !== record.run || !Array.isArray(submission.items)) add('submission', '/run', '属于本次运行的完整提交正文（含 items）', exportSubmission);
  }
  const parameters = object(record.parameters) ? record.parameters : {};
  for (const [name, value] of Object.entries({case_priority:2,group_priority:1,precondition_priority:3})) {
    if (parameters[name] !== undefined && parameters[name] !== value) add('run','/run/parameters/'+name,'金标准尚未实现此投影优先级参数','请集成者确认锁定版本的投影规则并补充该参数的金标准实现后重跑；不能套用默认值');
  }
  const rule = parameters.case_rule;
  if (rule !== undefined && rule !== 'marked' && rule !== 'tagged') add('run', '/run/parameters/case_rule', '识别用例的版本化规则', '请集成者确认 case_rule 的声明和锁定版本后补充金标准，不默认套用 marked');
  // Carry-over brings another submission's slot values; one current body cannot prove their exact cited commands.
  if (object(submission)) array(submission.items).forEach((entry, index) => { if (object(entry) && entry.reuse !== undefined) add('submission', `/items/${index}/reuse`, '沿用条目的原始发现和命令引用', '按沿用的记录引用补取前序受理提交及摘要绑定，再补充本次独立核对输入；不能借 Hub 的反驳还原'); });
  let compared = empty;
  if (!requests.length) {
    try { compared = compareCatalogMarks({ treeXml: input.treeXml, source, submission, run, excludeNodes: input.excludeNodes, argumentTypes: input.argumentTypes, caseRule: rule === 'tagged' ? 'tagged' : 'marked' }); }
    catch (error) { if (!(error instanceof CatalogInputError)) throw error; add(error.reason === 'tree_encoding' || error.reason === 'tree_structure' ? 'tree' : error.reason === 'argument_types' ? 'argument-types' : 'source', '/', '可解析的输入：' + error.reason, '请集成者按该固定原因补取原件或编码声明后重跑'); }
  }
  const allRequests = [...requests, ...compared.requests];
  return { ...compared, requests: allRequests, summary: { ...compared.summary, design_gaps: allRequests.length }, inputs };
}

/** Public declaration bytes are read, never imported as executable target code. */
export function readDeclaration(file?: string, manifestFile?: string): { table: unknown; bytes: Uint8Array; manifest: unknown } {
  const bytes = readKnownInput(file ?? new URL('../../../packs/workflow/case-review/tables/cited-commands.json', import.meta.url));
  return { table: parseJson(bytes), bytes, manifest: parseJson(readKnownInput(manifestFile ?? new URL('../../../packs/workflow/case-review/pack.json', import.meta.url))) };
}

export function outsideGit(path: string): string {
  const absolute = resolve(path);
  const check = (start: string): void => { for (let at = start; ; at = dirname(at)) { if (existsSync(join(at, '.git'))) throw new CatalogOutputError('path_in_git'); if (dirname(at) === at) break; } };
  check(absolute);
  let existing = absolute;
  while (!existsSync(existing)) { if (dirname(existing) === existing) throw new CatalogOutputError('path_invalid'); existing = dirname(existing); }
  const canonical = resolve(realpathSync(existing), relative(existing, absolute)); check(canonical);
  if (dirname(canonical) === canonical) throw new CatalogOutputError('path_invalid');
  return canonical;
}

/** New files only. Real identifiers and command text never enter a screen summary. */
export function writeCatalogReport(out: string, report: CatalogReport): void {
  const directory = outsideGit(out);
  const names = ['catalog-marks.json', 'evidence-requests.json'];
  if (names.some(name => existsSync(join(directory, name)))) throw new CatalogOutputError('output_exists');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, names[0]), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  writeFileSync(join(directory, names[1]), JSON.stringify(report.requests, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
export function catalogSummary(report: CatalogComparison): string {
  return `目录独立核对：一致 ${report.supported.length}，Hub 漏了 ${report.missed.length}，Hub 多了 ${report.extra.length}；未比较条目 ${report.not_compared.length}；反向预期反驳 ${report.negative_expected.length}，反向无归责反驳 ${report.negative_observed.length}；设计缺口 ${report.requests.length}`;
}
function emptyGap(at: Position, fact: string, next_action: string): CatalogReport {
  const requests = [request(at, fact, next_action)];
  return { not_compared: [], expected: [], observed: [], supported: [], missed: [], extra: [], negative_expected: [], negative_observed: [], requests, summary: { not_compared: 0, cases: 0, cited: 0, not_quoted: 0, unresolved_heads: 0, ignored_hub_claims: 0, supported: 0, missed: 0, extra: 0, design_gaps: 1 }, inputs: { tree_sha256: null, source_sha256: null, submission_sha256: null, expected_submission_sha256: null, locked_root: null } };
}

export function main(argv: string[], say: (line: string) => void = line => process.stdout.write(line + '\n')): number {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--hub-url', '--tree', '--source', '--run', '--out', '--submission', '--gold', '--table', '--manifest', '--argument-types'].includes(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--') || flags.has(argv[i])) { say('设计缺口 1；下一步：给出有效的输入参数与仓库外新输出目录'); return 1; }
    flags.set(argv[i], argv[i + 1]);
  }
  if (!['--tree', '--source', '--run', '--out'].every(key => flags.has(key))) { say('设计缺口 1；缺 --tree、--source、--run 或 --out；下一步：补齐这些输入后重跑'); return 1; }
  let out: string;
  try { out = outsideGit(flags.get('--out')!); } catch { say('设计缺口 1；下一步：改用 Git 外的独立新输出目录，不能覆盖旧证据'); return 1; }
  let report: CatalogReport;
  let stage = 'tree';
  try {
    const read = (key: string): Uint8Array => { stage = key; return readCatalogInput(flags.get('--' + key)!); };
    const treeBytes = read('tree'), treeXml = decodeCatalog(treeBytes);
    const sourceBytes = read('source'), runBytes = read('run'), run = parseJson(runBytes);
    stage = 'table'; const declaration = readDeclaration(flags.get('--table'), flags.get('--manifest'));
    let excludeNodes: string[] = [];
    if (flags.has('--gold')) {
      const value = parseJson(read('gold'));
      if (!Array.isArray(value) || !value.every(entry => object(entry) && typeof entry.node === 'string')) throw new CatalogInputError('gold_structure', '注入身份结构无效');
      excludeNodes = value.flatMap(entry => [entry.node, ...(typeof entry.copy === 'string' ? [entry.copy] : []), ...array(entry.deletedCases).filter((v): v is string => typeof v === 'string')]);
    }
    const submissionBytes = flags.has('--submission') ? read('submission') : undefined;
    const argumentTypes = flags.has('--argument-types') ? readArgumentTypes(read('argument-types')) : undefined;
    stage = 'compare';
    report = catalogMarks({ hubUrl:flags.get('--hub-url'), treeXml, treeBytes, sourceBytes, run, submissionBytes, table: declaration.table, tableBytes: declaration.bytes, packManifest: declaration.manifest, excludeNodes, argumentTypes });
    report.inputs.tree_sha256 = sha256(treeBytes);
    Object.assign(report.inputs, { table_sha256: sha256(declaration.bytes), run_sha256: sha256(runBytes) });
  } catch (error) {
    if (!(error instanceof CatalogInputError) && !(error instanceof CatalogOutputError)) { say('金标准缺陷 1；阶段 ' + stage + '；下一步修正脚本后重跑，不补猜测的输入'); return 1; }
    if (error instanceof CatalogInputError && error.reason === 'input_in_git') report = emptyGap({input:stage,pointer:'/'}, `--${stage} 输入在 Git 检出里`, '请将该输入原样移到 Git 外，再用对应参数重跑；不修改原件字节');
    else if (error instanceof CatalogInputError && error.reason === 'gold_structure') report = emptyGap({input:stage,pointer:'/'}, '--gold 注入身份结构无效', '请用当前 inject-defects.ts 重新注入并保存合法的 gold 数组，再用 --gold 重跑');
    else report = emptyGap({ input: stage, pointer: '/' }, `缺可读且完整的 --${stage} 输入`, `由集成者补取这份输入的原始文件和编码声明，再带 --${stage} 重跑；保留原字节，不把解析失败当零标记`);
  }
  try { writeCatalogReport(out, report); }
  catch { say('设计缺口 1；下一步：使用 Git 外的新目录重新保存明细，不覆盖已有文件'); return 1; }
  say(catalogSummary(report));
  say(`核对用例 ${report.summary.cases}，引用 ${report.summary.cited}，非本用例引文 ${report.summary.not_quoted}，开头不解析 ${report.summary.unresolved_heads}`);
  for (const [name, digest] of Object.entries(report.inputs)) if (typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest)) say(`${name} sha256 ${digest}`);
  if (report.requests.length) say(`设计缺口 ${report.requests.length}；下一步：由集成者按私有补证文件的位置补取事实或规则，再重跑`);
  const passed = !report.requests.length && !report.missed.length && !report.extra.length;
  say('通过：' + (passed ? '是' : '否'));
  return passed ? 0 : 1;
}
if (import.meta.main) process.exitCode = main(process.argv.slice(2));

/** Shared by the measurement driver; an unavailable input is a design gap, never an empty success. */
export function catalogGapReport(requests: EvidenceRequest[], inputs: Partial<CatalogReport['inputs']> = {}): CatalogReport {
  const report = emptyGap({ input: 'run', pointer: '/' }, '', '');
  return { ...report, requests, summary: { ...report.summary, design_gaps: requests.length }, inputs: { ...report.inputs, ...inputs } };
}
export function catalogPreflight(treeXml: string, table: unknown, binding?: { manifest: unknown; bytes: Uint8Array }): EvidenceRequest[] {
  const requests = tableRequests(table);
  if (binding) {
    const entry = object(binding.manifest) ? array(binding.manifest.files).find(f => object(f) && f.path === 'tables/cited-commands.json') : null;
    if (!object(entry) || entry.sha256 !== sha256(binding.bytes)) requests.push(request({input:'manifest',pointer:'/files'}, '目录表与包清单文件摘要相符', '请集成者提供同一锁定包版本的 --table 与 --catalog-manifest 后重跑'));
  }
  if (requests.length) return requests;
  try { return readCatalog(treeXml).requests; }
  catch (error) { if (!(error instanceof CatalogInputError)) throw error; return [request({ input: 'tree', pointer: '/' }, '可完整解析的锁定根命令树', '请集成者补取正确编码和结构的命令树原件后重跑；评审尚未启动')]; }
}
export function readCatalogInput(file: string): Uint8Array {
  let path: string;
  try { path = outsideGit(file); }
  catch(error) { if(error instanceof CatalogOutputError && error.reason === 'path_in_git') throw new CatalogInputError('input_in_git','输入在 Git 检出里'); throw error; }
  return readKnownInput(path);
}
