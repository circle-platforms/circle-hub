// Independent cited-command oracle. No Hub or pack implementation is imported.
// node scripts/real/gold/catalog-marks.ts --tree <locked command XML> --source <mindmap original>
//   --run <run-show.json> [--submission <original submission bytes>] [--gold <injection gold.json>]
//   [--table <cited-commands.json>] --out <new private directory>
// Only scope=resolved is implemented. Unknown types, constraints and missing receipts produce positioned requests.
import { SaxesParser } from 'saxes';
import { isIP } from 'node:net';
import type { CoreViolationCode } from '../../../contracts/generated/protocol.ts';

export interface Position { input: string; pointer: string; line?: number; column?: number }
export interface EvidenceRequest extends Position { fact: string; next_action: string }
interface Argument { name: string; type: string; limit?: string; length?: string; optional: boolean; optionalRaw?: string; help: string; at: Position }
interface Signature { args: Argument[]; at: Position }
interface Command { words: string[]; signatures: Signature[]; at: Position }
export interface Catalog { commands: Command[]; requests: EvidenceRequest[] }
export interface CommandAnswer { in_scope: boolean; code: CoreViolationCode | null; requests: EvidenceRequest[] }
const RANGE: CoreViolationCode = 'core.catalog.param_out_of_range';
const TYPE: CoreViolationCode = 'core.catalog.param_type_mismatch';
const ARITY: CoreViolationCode = 'core.catalog.arity_mismatch';
export const fold = (value: string): string => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
const request = (at: Position, fact: string, next_action: string): EvidenceRequest => ({ ...at, fact, next_action });

/** SAX is only an XML reader; menu paths, argument meaning and comparison are implemented here. */
export function readCatalog(xml: string): Catalog {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('不支持 DTD 或实体声明');
  const catalog: Catalog = { commands: [], requests: [] };
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
    if (tag.name === 'menu') frame.words = [...frame.words, ...(attrs.name ?? '').normalize('NFKC').trim().split(/\s+/).filter(Boolean)];
    if (tag.name === 'item') {
      if (parent?.command) catalog.requests.push(request(position(path), '嵌套 item 的命令路径规则', '请集成者提供该 XML 结构的路径规则或导出规范树后重跑'));
      const words = [...frame.words, ...(attrs.name ?? '').normalize('NFKC').trim().split(/\s+/).filter(Boolean)];
      if (!(attrs.name ?? '').trim()) catalog.requests.push(request(position(path + '/@name'), '命令名称', '请集成者补取该命令名称的原始声明后重新导出树'));
      const key = fold(words.join(' '));
      const command = byHead.get(key) ?? { words, signatures: [], at: position(path) };
      byHead.set(key, command); frame.command = command; frame.signature = undefined; frame.arg = undefined;
    }
    if (tag.name === 'arguments' && frame.command) {
      frame.signature = { args: [], at: position(path) }; frame.command.signatures.push(frame.signature);
    }
    if (tag.name === 'arg' && frame.signature) {
      frame.arg = { name: attrs.name ?? `arg${frame.signature.args.length + 1}`, type: attrs.type ?? '', optional: /^(yes|y|true|1)$/i.test(attrs.optional ?? ''), ...(attrs.optional === undefined ? {} : { optionalRaw: attrs.optional }), ...(attrs.limit === undefined && attrs.range === undefined ? {} : { limit: attrs.limit ?? attrs.range }), ...(attrs.length === undefined ? {} : { length: attrs.length }), help: attrs.help ?? '', at: position(path) };
      frame.signature.args.push(frame.arg);
    }
    stack.push(frame);
  });
  parser.on('text', text => { const arg = stack.at(-1)?.arg; if (arg) arg.help += text; });
  parser.on('closetag', () => { stack.pop(); });
  parser.on('error', error => { throw error; });
  parser.write(xml).close();
  catalog.commands = [...byHead.values()];
  for (const command of catalog.commands) if (!command.signatures.length) command.signatures.push({ args: [], at: command.at });
  if (!catalog.commands.length) catalog.requests.push({ input: 'tree', pointer: '/', line: 1, column: 1, fact: '可识别的命令定义', next_action: '请集成者确认锁定根并重新导出命令树原件；如确为空目录，补充其声明' });
  return catalog;
}

/** Case quotation uses the table's matching form and cannot add or cut off command arguments. */
export function quoteFromCase(command: string, lines: readonly string[]): boolean {
  const phrase = fold(command); if (!phrase) return false;
  for (const raw of lines) {
    const line = fold(raw);
    for (let at = line.indexOf(phrase); at >= 0; at = line.indexOf(phrase, at + 1)) {
      const before = line.slice(0, at), after = line.slice(at + phrase.length);
      if (/[a-z0-9_]$|[a-z0-9_"'] $/.test(before)) continue;
      if (/^[a-z0-9_]|^ [a-z0-9_"']|^[.\-/:][a-z0-9_]/.test(after)) continue;
      return true;
    }
  }
  return false;
}

function tokenize(line: string): string[] | null {
  const words: string[] = [];
  let word = '', quote: string | null = null, active = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\') { if (i + 1 >= line.length) return null; word += line[++i]; active = true; continue; }
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
  } else if (/^\d+$/.test(text) && Number.isSafeInteger(Number(text))) return { value: { high: Number(text) }, requests: [] };
  else if (enumeration && attribute !== 'length') return { value: { values: enumeration[1].split(/\s*[|,]\s*/) }, requests: [] };
  return { value: {}, requests: [request({ ...at, pointer: at.pointer + '/@' + attribute }, '参数约束的可解析语法：' + raw, '请集成者在该位置补取范围或枚举的正式声明；说明语法后重跑独立核对')] };
}
interface Parameter { raw: Argument; type: string; limit: Constraint; length: Constraint }
function parameter(raw: Argument): { value: Parameter; requests: EvidenceRequest[] } {
  const type = raw.type.toUpperCase(), requests: EvidenceRequest[] = [];
  if (!['STRING', 'XSTRING', 'U16', 'U32', 'DOTTEDIP', 'IPADDR', 'IPMASK'].includes(type)) requests.push(request({ ...raw.at, pointer: raw.at.pointer + '/@type' }, '不认识的参数类型：' + raw.type, '请集成者提供该位置类型的定义、合法样例与反例，再补充金标准后重跑'));
  if (raw.optionalRaw !== undefined && !/^(yes|y|true|1|no|n|false|0)$/i.test(raw.optionalRaw)) requests.push(request({ ...raw.at, pointer: raw.at.pointer + '/@optional' }, '参数是否可省略的声明', '请集成者补取该位置 optional 的布尔语义后重跑'));
  if (type === 'DOTTEDIP' && /\bor\b|host\s*name|https?:|\burl\b/i.test(raw.help)) requests.push(request(raw.at, 'IPv4 参数帮助中声明的其他输入形式', '请集成者补取该参数的正式类型或锁定根的类型覆盖声明，再核对；不能把其他形式硬判为 IPv4 错误'));
  const limit = constraint(raw.limit, raw.at, 'limit', type === 'STRING' || type === 'XSTRING');
  const length = constraint(raw.length, raw.at, 'length', true);
  return { value: { raw, type, limit: limit.value, length: length.value }, requests: [...requests, ...limit.requests, ...length.requests] };
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
    if (!dotted && !prefix) return TYPE;
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
  if (catalog.requests.length) return { in_scope: false, code: null, requests: catalog.requests };
  const normalized = line.normalize('NFKC').trim(), tokens = tokenize(normalized);
  const headWords = tokens ?? normalized.split(/\s+/);
  const matches = catalog.commands.filter(c => c.words.every((word, i) => headWords[i] !== undefined && fold(word) === fold(headWords[i]))).sort((a, b) => b.words.length - a.words.length);
  const command = matches[0]; if (!command) return { in_scope: false, code: null, requests: [] };
  if (tokens === null) return { in_scope: true, code: null, requests: [request(command.at, '命令行的引号或转义切分规则', '请集成者核对该用例原件中的完整命令行和转义方式，补齐后重跑')] };
  const args = tokens.slice(command.words.length);
  const signatures = command.signatures.map(signature => signature.args.map(parameter));
  const requests = signatures.flatMap(signature => signature.flatMap(p => p.requests));
  if (requests.length) return { in_scope: true, code: null, requests };
  let arityFits = false;
  const failedCodes = new Set<CoreViolationCode>();
  for (const signature of signatures) {
    const params = signature.map(p => p.value);
    // Reachable assignments retain every possible failure code. Optional fields may precede required ones.
    let states = new Map<number, Set<CoreViolationCode>>([[0, new Set()]]);
    let validStates = new Set<number>([0]);
    for (const param of params) {
      const next = new Map<number, Set<CoreViolationCode>>(), validNext = new Set<number>();
      for (const [used, codes] of states) {
        if (param.raw.optional) { const kept = next.get(used) ?? new Set<CoreViolationCode>(); codes.forEach(c => kept.add(c)); next.set(used, kept); if (validStates.has(used)) validNext.add(used); }
        if (used < args.length) {
          const code = parameterCode(param, args[used]), kept = next.get(used + 1) ?? new Set<CoreViolationCode>();
          codes.forEach(c => kept.add(c)); if (code) kept.add(code); next.set(used + 1, kept);
          if (validStates.has(used) && code === null) validNext.add(used + 1);
        }
      }
      states = next; validStates = validNext;
    }
    if (validStates.has(args.length)) return { in_scope: true, code: null, requests: [] };
    const codes = states.get(args.length);
    if (codes) { arityFits = true; codes.forEach(code => failedCodes.add(code)); }
  }
  if (!arityFits) return { in_scope: true, code: ARITY, requests: [] };
  if (failedCodes.size === 1) return { in_scope: true, code: [...failedCodes][0], requests: [] };
  return { in_scope: true, code: null, requests: [request(command.at, '多个参数或签名失败时错误码的选择规则', '请集成者明确这些签名及参数位置之间的错误码选择规则，补充规则和样例后重跑；不照抄被核实现的优先级')] };
}
