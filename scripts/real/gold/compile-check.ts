// Independent compile-contract@1 / test-bed-manifest@1 reader. No Hub or pack imports.
// node scripts/real/gold/compile-check.ts --run run.json --submission submission.json
//   --contract contract.json --bed bed.json [--commands tree.xml --product product.json] [--sources sources.json]
// Sources must be independently exported reference -> fragment text, never the model's quotes.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { goldQuoteContains, normalizeGoldQuote } from './quote-widths.ts';

export function parseIpv4(ip: string): bigint | null {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  let val = 0n;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    val = (val << 8n) | BigInt(n);
  }
  return val;
}

export function parseIpv6(ip: string): bigint | null {
  const s = ip.trim().toLowerCase();
  if (!s.includes(':')) return null;

  const doubleColon = s.indexOf('::');
  if (doubleColon >= 0 && s.indexOf('::', doubleColon + 1) >= 0) return null;

  let leftParts: string[] = [];
  let rightParts: string[] = [];

  if (doubleColon >= 0) {
    const leftStr = s.slice(0, doubleColon);
    const rightStr = s.slice(doubleColon + 2);
    leftParts = leftStr.length > 0 ? leftStr.split(':') : [];
    rightParts = rightStr.length > 0 ? rightStr.split(':') : [];
  } else {
    leftParts = s.split(':');
  }

  if (doubleColon < 0 && leftParts.length !== 8) return null;
  if (doubleColon >= 0 && leftParts.length + rightParts.length >= 8) return null;

  const fillZeros = 8 - (leftParts.length + rightParts.length);
  const fullParts = [
    ...leftParts,
    ...new Array(fillZeros).fill('0'),
    ...rightParts,
  ];

  if (fullParts.length !== 8) return null;

  let val = 0n;
  for (const part of fullParts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    val = (val << 16n) | BigInt(parseInt(part, 16));
  }
  return val;
}

export interface ParsedSubnet {
  family: 4 | 6;
  network: bigint;
  mask: bigint;
  prefix: number;
  text: string;
}

export function parseSubnet(cidr: string): ParsedSubnet | null {
  const slash = cidr.indexOf('/');
  if (slash < 0) return null;
  const ipStr = cidr.slice(0, slash).trim();
  const prefixStr = cidr.slice(slash + 1).trim();
  if (!/^\d+$/.test(prefixStr)) return null;
  const prefix = Number(prefixStr);

  const v4 = parseIpv4(ipStr);
  if (v4 !== null) {
    if (prefix < 0 || prefix > 32) return null;
    const mask = prefix === 0 ? 0n : ((0xffffffffn << BigInt(32 - prefix)) & 0xffffffffn);
    const network = v4 & mask;
    return { family: 4, network, mask, prefix, text: cidr };
  }

  const v6 = parseIpv6(ipStr);
  if (v6 !== null) {
    if (prefix < 0 || prefix > 128) return null;
    const allOnes = (1n << 128n) - 1n;
    const mask = prefix === 0 ? 0n : ((allOnes << BigInt(128 - prefix)) & allOnes);
    const network = v6 & mask;
    return { family: 6, network, mask, prefix, text: cidr };
  }

  return null;
}

export function isIpInSubnet(ip: string, subnet: ParsedSubnet): boolean {
  if (subnet.family === 4) {
    const val = parseIpv4(ip);
    if (val === null) return false;
    return (val & subnet.mask) === subnet.network;
  } else {
    const val = parseIpv6(ip);
    if (val === null) return false;
    return (val & subnet.mask) === subnet.network;
  }
}

export function cleanIp(ipWithOptionalPrefix: string): string {
  const slash = ipWithOptionalPrefix.indexOf('/');
  return slash >= 0 ? ipWithOptionalPrefix.slice(0, slash).trim() : ipWithOptionalPrefix.trim();
}


type Obj = Record<string, unknown>;
const obj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
export type Verdict = 'pass' | 'fail' | 'unknown';
interface Answer { verdict: Verdict; reason?: string; code?: string }
const pass = (): Answer => ({ verdict: 'pass' });
const fail = (reason: string, code?: string): Answer => ({ verdict:'fail',reason,...(code === undefined ? {} : {code}) });
const unknown = (reason: string): Answer => ({ verdict: 'unknown', reason });
const ipKey = (s: string): string => isIP(s) === 4 ? `4:${parseIpv4(s)}` : isIP(s) === 6 ? `6:${parseIpv6(s)}` : '';

export interface ContractParamDef {
  name: string; type: string; optional?: boolean; default?: string;
  minimum?: number; maximum?: number; minLength?: number; maxLength?: number;
  values?: string[]; keyword?: string; address?: 'listen' | 'backend' | 'target' | 'virtual'; command?: boolean;
}
export interface CompileContract {
  schema: 'compile-contract@1'; synthetic: boolean;
  objects: Array<{name: string; methods: Array<{name: string; params: ContractParamDef[]}>}>;
  forbidden: Array<{object: string; method: string}>;
}
export interface RawBedManifest {
  schema: 'test-bed-manifest@1';
  beds: Array<{name: string; devices: Array<{name: string; type: string; product: string | null; ipv4: string[]; ipv6: string[]}>;
    services: Array<{host: string; ip: string; proto: string; port: number}>; reserved: unknown[]}>;
}
export interface PlanData {
  bucket: string; blocks: string[];
  steps: Array<{object: string; method: string; params: Record<string, unknown>}>;
  expects: Array<{text: string; quote: {reference: string; text: string}}>;
}
export interface Submission {
  run: string; model: string;
  items: Array<{item: string; handling: string; slots?: {plan?: Array<{text: string; quotes?: Array<{reference: string; text: string}>; data: PlanData}>}}>;
}
export interface HubClaim { pointer?: string; statement: {text: string; verdict?: string; data?: Obj; code?: string} }
/** A requirement row of the result: the status (satisfied/unsatisfied/pending) beside the layer terminals, and the
 * incomplete terminal's reason (case-compile 1.3.0: repair_exhausted when the model's fix rounds are used up). */
export interface HubRequirement {
  requirement: string; layers: Array<{layer: string; terminal: string; reason?: string}>; status: 'satisfied' | 'unsatisfied' | 'pending'; claims: HubClaim[];
}
/** The partition names of validation@1: delivered, rejected, quarantined, incomplete (unfinished in exports). */
export type PartitionName = 'delivered' | 'rejected' | 'quarantined' | 'incomplete' | 'unfinished';
export interface RunShowExport {
  run: {run: string; started_at: string; items: Array<{id: string}>;
    lease_context?: Array<{key: string; until: string; mine: boolean}>};
  latest?: {submission?: unknown; result?: {run: string; submission: string; partitions: Partial<Record<PartitionName, Array<{item: string; requirements: HubRequirement[]}>>>}} | null;
}
export type CheckType = 'contract' | 'address' | 'command' | 'quotation' | 'plan';
export interface StepVerdict extends Answer { item: string; stepIndex: number; checkType: CheckType; pointer: string; check?: 'function' | 'catalog' | 'quote' }
export interface PlanReceipt { item: string; plan: string; sha256: string }
export interface CompileCheckResult {
  allPassed: boolean; notes: string[]; stepVerdicts: StepVerdict[]; plans: PlanReceipt[];
  position_comparisons: Array<{item:string;requirement:string;check:NonNullable<StepVerdict['check']>;equal:boolean;unknown:boolean;gold:Array<string|null>;hub:Array<string|null>}>;
  comparison: {equal: boolean; differences: string[]};
}

/** Validate exported documents instead of assuming a cast proves their shape. */
function contractProblem(v: unknown): string | null {
  if (!obj(v) || v.schema !== 'compile-contract@1' || typeof v.synthetic !== 'boolean' || !Array.isArray(v.objects) || !Array.isArray(v.forbidden)) return '合约不是 compile-contract@1';
  const names = new Set<string>();
  for (const o of v.objects) {
    if (!obj(o) || !str(o.name) || !o.name || names.has(o.name) || !Array.isArray(o.methods)) return '合约对象格式错误或重名';
    names.add(o.name);
    const methods = new Set<string>();
    for (const m of o.methods) {
      if (!obj(m) || !str(m.name) || !m.name || methods.has(m.name) || !Array.isArray(m.params)) return '合约方法格式错误或重名';
      methods.add(m.name);
      const params = new Set<string>();
      for (const p of m.params) {
        if (!obj(p) || !str(p.name) || !p.name || params.has(p.name) || !['string','int','number','boolean','ipv4','ipv6','mask','port','enum','keyword'].includes(String(p.type))) return '合约参数格式或类型未知';
        params.add(p.name);
        if (p.optional !== undefined && typeof p.optional !== 'boolean' || p.default !== undefined && !str(p.default) || p.command !== undefined && typeof p.command !== 'boolean') return '合约可选参数格式错误';
        if (p.address !== undefined && !['listen','backend','target','virtual'].includes(String(p.address))) return '合约地址角色未知';
        for (const k of ['minimum','maximum','minLength','maxLength']) if (p[k] !== undefined && (typeof p[k] !== 'number' || !Number.isFinite(p[k]))) return '合约参数范围错误';
        if (p.type === 'enum' && (!Array.isArray(p.values) || p.values.length === 0 || !p.values.every(str))) return '合约枚举错误';
        if (p.type === 'keyword' && p.keyword !== undefined && !str(p.keyword)) return '合约关键字错误';
      }
    }
  }
  if (!v.forbidden.every(f => obj(f) && str(f.object) && str(f.method))) return '合约禁用组合格式错误';
  return null;
}
function bedProblem(v: unknown): string | null {
  if (!obj(v) || v.schema !== 'test-bed-manifest@1' || !Array.isArray(v.beds)) return '清单不是 test-bed-manifest@1';
  const beds = new Set<string>();
  for (const b of v.beds) {
    if (!obj(b) || !str(b.name) || beds.has(b.name) || !Array.isArray(b.devices) || !Array.isArray(b.services) || !Array.isArray(b.reserved)) return '台架格式错误或重名';
    beds.add(b.name);
    const devices = new Set<string>();
    const ips = new Set<string>();
    for (const d of b.devices) {
      if (!obj(d) || !str(d.name) || devices.has(d.name) || !['load-balancer','router','client','server','console'].includes(String(d.type)) || !(d.product === null || str(d.product))) return '台架设备格式错误';
      devices.add(d.name);
      for (const [key, family] of [['ipv4',4],['ipv6',6]] as const) {
        if (!Array.isArray(d[key])) return '台架接口列表缺失';
        for (const cidr of d[key]) {
          if (!str(cidr) || !parseSubnet(cidr) || isIP(cleanIp(cidr)) !== family || ips.has(ipKey(cleanIp(cidr)))) return '台架接口格式错误或重复';
          ips.add(ipKey(cleanIp(cidr)));
        }
      }
    }
    for (const s of b.services) if (!obj(s) || !str(s.host) || !devices.has(s.host) || !str(s.ip) || !isIP(s.ip) || !ips.has(ipKey(s.ip))) return '台架服务地址无设备接口来源';
  }
  return null;
}
function planProblem(v: unknown): string | null {
  if (!obj(v) || !str(v.bucket) || !v.bucket || !Array.isArray(v.blocks)) return '计划 bucket 或 blocks 格式错误';
  if (!Array.isArray(v.steps) || v.steps.length === 0 || !v.steps.every(s => obj(s) && str(s.object) && str(s.method) && obj(s.params))) return '计划 steps 格式错误';
  if (!Array.isArray(v.expects) || v.expects.length === 0 || !v.expects.every(e => obj(e) && str(e.text) && e.text.trim() && obj(e.quote) && str(e.quote.reference) && str(e.quote.text))) return '计划 expects 缺少期望或逐字来源';
  return null;
}
function methodOf(c: CompileContract, object: string, method: string) {
  return c.objects.find(o => o.name === object)?.methods.find(m => m.name === method);
}
function valueProblem(p: ContractParamDef, value: unknown, lexical = false): string | null {
  const n = lexical && str(value) && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) ? Number(value) : value;
  let ok: boolean;
  switch (p.type) {
    case 'int': case 'port': ok = typeof n === 'number' && Number.isSafeInteger(n) && (p.type !== 'port' || n >= 0 && n <= 65535); break;
    case 'number': ok = typeof n === 'number' && Number.isFinite(n); break;
    case 'boolean': ok = typeof value === 'boolean' || lexical && (value === 'true' || value === 'false'); break;
    case 'ipv4': ok = str(value) && isIP(value) === 4; break;
    case 'ipv6': ok = str(value) && isIP(value) === 6; break;
    case 'enum': ok = str(value) && !!p.values?.includes(value); break;
    case 'keyword': ok = value === (p.keyword ?? p.name); break;
    case 'mask': {
      const mask = str(value) && isIP(value) === 4 ? parseIpv4(value) : null;
      const inverse = mask === null ? -1n : 0xffffffffn ^ mask;
      ok = inverse >= 0n && (inverse & (inverse+1n)) === 0n; break;
    }
    default: ok = str(value);
  }
  if (!ok) return `参数 ${p.name} 类型或枚举不匹配（${p.type}）`;
  if (typeof n === 'number' && (p.minimum !== undefined && n < p.minimum || p.maximum !== undefined && n > p.maximum)) return `参数 ${p.name} 超出范围`;
  if (str(value) && (p.minLength !== undefined && [...value].length < p.minLength || p.maxLength !== undefined && [...value].length > p.maxLength)) return `参数 ${p.name} 长度超出范围`;
  return null;
}
function contractChecks(c: CompileContract, object: string, method: string, params: Record<string,unknown>): Answer[] {
  const m = methodOf(c,object,method);
  if (!m) return [fail(`（${object}，${method}）未在合约中定义`)];
  const answers: Answer[] = [];
  if (c.forbidden.some(f => f.object === object && f.method === method)) answers.push(fail(`（${object}，${method}）已被合约禁用`));
  for (const key of Object.keys(params)) if (!m.params.some(p => p.name === key)) answers.push(fail(`未声明参数 ${key}`));
  for (const p of m.params) {
    if (!Object.hasOwn(params,p.name)) {
      if (!p.optional && p.default === undefined) answers.push(fail(`缺少必填参数 ${p.name}`));
    } else {
      const problem = valueProblem(p,params[p.name]);
      if (problem) answers.push(fail(problem));
    }
  }
  return answers.length ? answers : [pass()];
}
export function checkContractMethod(c: CompileContract, object: string, method: string, params: Record<string,unknown>): Answer {
  return contractChecks(c,object,method,params)[0];
}

export function checkBedAddress(bed: RawBedManifest['beds'][number], raw: string, role: string, allocated: readonly string[] = []): Answer {
  const key = ipKey(raw);
  if (!key) return fail(`无效字面地址 ${raw}`);
  const interfaces = bed.devices.flatMap(d => [...d.ipv4,...d.ipv6].map(cidr => ({device: d, ip: cleanIp(cidr), subnet: parseSubnet(cidr)!})));
  const match = interfaces.find(i => ipKey(i.ip) === key);
  if (!match && !allocated.some(a => ipKey(a) === key)) return fail(`台架之外的地址一律拒绝：${raw}`,'case-compile.address_outside_bed');
  if (role === 'listen' && match?.device.type !== 'load-balancer') return fail('监听地址必须是被测设备的接口地址');
  if (role === 'backend' && match?.device.type !== 'server') return fail('后端地址必须是服务器设备的接口地址','case-compile.backend_not_server');
  if ((role === 'listen' || role === 'virtual') && match?.device.type === 'load-balancer') {
    const trigger = interfaces.some(i => ['router','client'].includes(i.device.type) && i.subnet.family === match.subnet.family && i.subnet.prefix === match.subnet.prefix && i.subnet.network === match.subnet.network);
    if (!trigger) return fail('盲地址不能当监听或虚拟地址：同网段没有触发设备');
  }
  return pass();
}

type XmlNode = { name: string; attributes: Record<string, string>; children: XmlElementChild[] };
type XmlElementChild = { text: string } | { element: XmlNode };

class XmlReader {
  private at = 0;
  private readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
  static read(text: string): XmlNode[] {
    return new XmlReader(text).document();
  }
  private document(): XmlNode[] {
    const roots: XmlNode[] = [];
    for (;;) {
      const open = this.text.indexOf('<', this.at);
      if (open < 0) break;
      this.at = open;
      if (this.text.startsWith('<?', this.at) || this.text.startsWith('<!--', this.at)) {
        const end = this.text.startsWith('<?', this.at) ? this.text.indexOf('?>', this.at) : this.text.indexOf('-->', this.at);
        this.at = end < 0 ? this.text.length : end + (this.text.startsWith('<?', this.at) ? 2 : 3);
        continue;
      }
      roots.push(this.element());
      if (roots.length > 200) throw new Error('XML 根节点过多');
    }
    return roots;
  }
  private element(): XmlNode {
    this.at++; // skip <
    const nameMatch = /^[A-Za-z0-9_.-]+/.exec(this.text.slice(this.at));
    if (!nameMatch) throw new Error('XML 元素名无效');
    const name = nameMatch[0];
    this.at += name.length;
    const attributes: Record<string, string> = {};
    for (;;) {
      this.spaces();
      if (this.at >= this.text.length || this.text[this.at] === '>' || this.text.startsWith('/>', this.at)) break;
      const keyMatch = /^[A-Za-z0-9_.-]+/.exec(this.text.slice(this.at));
      if (!keyMatch) throw new Error('XML 属性无效');
      const key = keyMatch[0];
      this.at += key.length;
      this.spaces();
      if (this.text[this.at] === '=') {
        this.at++;
        this.spaces();
        const quote = this.text[this.at];
        if (quote === '"' || quote === "'") {
          this.at++;
          const endQuote = this.text.indexOf(quote, this.at);
          if (endQuote < 0) throw new Error('XML 属性未闭合');
          const val = this.text.slice(this.at, endQuote);
          attributes[key] = val;
          this.at = endQuote >= 0 ? endQuote + 1 : this.text.length;
        } else throw new Error('XML 属性需要引号');
      } else throw new Error('XML 属性缺少等号');
    }
    this.spaces();
    if (this.text.startsWith('/>', this.at)) {
      this.at += 2;
      return { name, attributes, children: [] };
    }
    if (this.text[this.at] !== '>') throw new Error('XML 开始标签未闭合');
    this.at++;
    const children: XmlElementChild[] = [];
    for (;;) {
      const nextTag = this.text.indexOf('<', this.at);
      if (nextTag < 0) throw new Error('XML 元素未闭合');
      if (nextTag > this.at) {
        children.push({ text: this.text.slice(this.at, nextTag) });
        this.at = nextTag;
      }
      if (this.text.startsWith('</', this.at)) {
        const closeEnd = this.text.indexOf('>', this.at);
        if (closeEnd < 0 || this.text.slice(this.at+2,closeEnd).trim() !== name) throw new Error('XML 结束标签不匹配');
        this.at = closeEnd >= 0 ? closeEnd + 1 : this.text.length;
        break;
      }
      if (this.text.startsWith('<!--',this.at) || this.text.startsWith('<?',this.at)) {
        const endMarker = this.text.startsWith('<!--',this.at) ? '-->' : '?>';
        const end = this.text.indexOf(endMarker,this.at);
        if (end < 0) throw new Error('XML 注释未闭合');
        this.at = end + endMarker.length;
      } else children.push({ element: this.element() });
    }
    return { name, attributes, children };
  }
  private spaces(): void {
    while (this.at < this.text.length && /\s/.test(this.text[this.at])) this.at++;
  }
}


interface CommandArg { name: string; type: string; limit?: string; length?: string; optional: boolean; default?: string }
export interface CatalogCommand { words: string[]; overloads: CommandArg[][] }
export interface CommandCatalogDeclaration { complete: boolean; case_sensitive: boolean }
/** Read only the public commands@1 declaration, never a product's executable modules. */
export function commandCatalogDeclaration(product: unknown): CommandCatalogDeclaration {
  if (!obj(product) || product.schema !== 'product@1' || !Array.isArray(product.catalogs)) throw new Error('产品声明不是 product@1');
  const declarations = product.catalogs.filter(c => obj(c) && c.id === 'commands@1');
  if (declarations.length !== 1 || !obj(declarations[0]) || typeof declarations[0].complete !== 'boolean' || typeof declarations[0].case_sensitive !== 'boolean') throw new Error('缺少或无效的 commands@1 完备性和大小写声明');
  return {complete:declarations[0].complete,case_sensitive:declarations[0].case_sensitive};
}
export function parseCommandTree(xml: string): CatalogCommand[] {
  // Reject unsupported XML rather than silently invent an empty catalog.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || !xml.includes('<')) throw new Error('命令树不是受支持的 XML');
  const decode = (v: string) => v.replace(/&(amp|lt|gt|quot|apos);/g, (_, k: string) => ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[k]!)).replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, k: string) => String.fromCodePoint(k[0].toLowerCase() === 'x' ? parseInt(k.slice(1),16) : Number(k)));
  const children = (n: XmlNode) => n.children.flatMap(c => 'element' in c ? [c.element] : []);
  const byPath = new Map<string, CatalogCommand>();
  const walk = (n: XmlNode, prefix: string[]): void => {
    const words = decode(n.attributes.name ?? '').trim().split(/\s+/).filter(Boolean);
    if (n.name === 'item') {
      if (!words.length) return;
      const all = [...prefix,...words];
      const key = all.join(' ');
      const entry = byPath.get(key) ?? {words: all, overloads: []};
      const lists = children(n).filter(c => c.name === 'arguments');
      for (const list of lists) entry.overloads.push(children(list).filter(c => c.name === 'arg').map((a, i) => ({
        name: decode(a.attributes.name ?? `arg${i+1}`), type: a.attributes.type ?? 'STRING', limit: a.attributes.limit !== undefined ? decode(a.attributes.limit) : a.attributes.range === undefined ? undefined : decode(a.attributes.range),
        length: a.attributes.length, optional: /^(yes|y|true|1)$/i.test(a.attributes.optional ?? ''),
        default: a.attributes.default_value === undefined ? undefined : decode(decode(a.attributes.default_value)),
      })));
      if (!lists.length) entry.overloads.push([]);
      byPath.set(key, entry); return;
    }
    for (const c of children(n)) if (!['arguments','arg','results'].includes(c.name)) walk(c, n.name === 'menu' ? [...prefix,...words] : prefix);
  };
  for (const root of XmlReader.read(xml)) walk(root, []);
  if (!byPath.size) throw new Error('命令树没有命令定义');
  return [...byPath.values()];
}
function tokens(line: string): string[] | null {
  const matches = line.match(/"[^"\\]*(?:\\.[^"\\]*)*"|'[^']*'|[^\s"']+/g) ?? [];
  let rest = line;
  for (const t of matches) rest = rest.replace(t, '');
  if (rest.trim()) return null;
  return matches.map(t => t.startsWith('"') ? JSON.parse(t) as string : t.startsWith("'") ? t.slice(1,-1) : t);
}
function argProblem(a: CommandArg, v: string): string | null {
  const type = a.type.toUpperCase();
  const int = /^(0|[1-9]\d*)$/.test(v) ? Number(v) : NaN;
  if (type === 'U16' && (!Number.isSafeInteger(int) || int > 65535) || type === 'U32' && (!Number.isSafeInteger(int) || int > 4294967295)) return `参数 ${a.name} 整数类型不匹配`;
  if (type === 'DOTTEDIP' && isIP(v) !== 4 || type === 'IPADDR' && !isIP(v) || type === 'IPMASK' && !(isIP(v) === 4 || Number.isInteger(int) && int <= 128)) return `参数 ${a.name} 地址类型不匹配`;
  for (const [raw, length] of [[a.limit, !['U16','U32'].includes(type)], [a.length,true]] as const) {
    if (!raw) continue;
    const r = /^[\[(]?\s*(-?\d+)\s*(?:-|~|\.\.|to)\s*(-?\d+)\s*[\])]?$/.exec(raw);
    const en = /^[{[(]?\s*([^\s|,{}()[\]]+(?:\s*[|,]\s*[^\s|,{}()[\]]+)+)\s*[}\])]?$/.exec(raw);
    const n = length ? v.length : int;
    if (r ? n < Number(r[1]) || n > Number(r[2]) : /^\d+$/.test(raw) ? n > Number(raw) : en ? !en[1].split(/\s*[|,]\s*/).includes(v) : false) return `参数 ${a.name} 超出范围 ${raw}`;
    if (!r && !en && !/^\d+$/.test(raw)) return `未知参数约束 ${raw}`;
  }
  return null;
}
export function checkCatalogCommand(catalog: CatalogCommand[], line: string, declaration?: CommandCatalogDeclaration): Answer {
  line = line.trim();
  if (!line) return pass();
  if (!declaration) return unknown('缺少 commands@1 的完备性和大小写声明');
  const fold = (word: string) => declaration.case_sensitive ? word : word.toLowerCase();
  let ts: string[] | null;
  try { ts = tokens(line); } catch { return fail('命令行引号格式错误'); }
  if (!ts) return fail('命令行引号格式错误');
  const words = ts;
  const candidates = catalog.filter(c => c.words.every((w,i) => words[i] !== undefined && fold(w) === fold(words[i]))).sort((a,b) => b.words.length-a.words.length);
  const cmd = candidates[0];
  if (!cmd) return declaration.complete ? fail('命令不存在于目标构建的命令树中') : unknown('命令未在不完备的目录中找到');
  const args = words.slice(cmd.words.length);
  const problems: string[] = [];
  for (const overload of candidates.filter(c => c.words.length === cmd.words.length).flatMap(c => c.overloads)) {
    // Optional arguments can appear before required ones; explore both consume and omit.
    const match = (i: number, j: number): boolean => {
      if (i === overload.length) return j === args.length;
      const a = overload[i];
      if ((a.optional || a.default !== undefined) && match(i+1,j)) return true;
      if (j >= args.length) { problems.push(`缺少命令参数 ${a.name}`); return false; }
      const p = argProblem(a,args[j]);
      if (p) { problems.push(p); return false; }
      return match(i+1,j+1);
    };
    if (match(0,0)) return pass();
  }
  return fail(problems.join('；') || '命令参数个数错误');
}
export const collapseWhitespace = (s: string): string => s.replace(/\s+/g,' ').trim();
export function checkVerbatimQuote(sources: ReadonlyMap<string,string>, reference: string, quote: string): Answer {
  if (!quote.isWellFormed() || !normalizeGoldQuote(quote) || !reference.trim()) return fail('期望结果缺少完整的逐字引文或来源');
  if (!/^(src|rec|tree):/.test(reference)) return fail('期望来源不是 src:/rec:/tree: 引用');
  const fragment = sources.get(reference);
  if (fragment === undefined) return unknown(`来源 ${reference} 无法读取或未绑定`);
  return goldQuoteContains(fragment,quote) ? pass() : fail('引文不是来源的逐字片段');
}
// Serialize directly: JSON.stringify on a sorted object would re-order integer-like keys.
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (obj(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  const text = JSON.stringify(v);
  if (text === undefined) throw new Error('非 JSON 值');
  return text;
}
export function generatePlan(item: string, data: PlanData, contract: CompileContract): PlanReceipt {
  const plan = canonicalJson({schema:'exec-plan@1',case:item,bed:data.bucket,blocks:[...data.blocks].sort(),
    steps:data.steps.map((s,i) => {
      const params: Record<string,unknown> = Object.create(null) as Record<string,unknown>;
      const method = methodOf(contract,s.object,s.method);
      if (!method) throw new Error('方法不在合约内，不能生成计划');
      for (const p of method.params) {
        if (Object.hasOwn(s.params,p.name)) params[p.name] = s.params[p.name];
        else if (p.default !== undefined) params[p.name] = p.default;
        else if (!p.optional) throw new Error(`必填参数 ${p.name} 没有值或 default`);
      }
      return {n:i+1,object:s.object,method:s.method,params};
    }), expects:data.expects.map(e => ({text:e.text,source:e.quote.reference}))});
  return {item,plan,sha256:createHash('sha256').update(plan,'utf8').digest('hex')};
}
const requirementOf: Record<CheckType,string> = {contract:'contract_methods',address:'bed_addresses',command:'commands_known',quotation:'expected_grounded',plan:'plan_deterministic'};
const aggregate = (answers: readonly Answer[]): Verdict => answers.some(a => a.verdict === 'fail') ? 'fail' : answers.some(a => a.verdict === 'unknown') ? 'unknown' : 'pass';
export function compareCompileVerdicts(hub: readonly StepVerdict[], gold: readonly StepVerdict[]): {equal:boolean; differences:string[]} {
  const differences: string[] = [];
  const key = (v: StepVerdict) => `${v.item}/${v.checkType}/${v.stepIndex}/${v.pointer}`;
  const hm = new Map<string,StepVerdict>();
  for (const h of hub) { if (hm.has(key(h))) differences.push(`重复 Hub 判定 ${key(h)}`); hm.set(key(h),h); }
  for (const g of gold) {
    const h = hm.get(key(g));
    if(g.verdict==='unknown'||h?.verdict==='unknown')differences.push(`未形成确定判定 ${key(g)}：${g.reason ?? h?.reason ?? '缺少事实'}；下一步补齐该事实并重新核对`);
    if (!h || h.verdict !== g.verdict) differences.push(`判定不同 ${key(g)}：Hub ${h?.verdict ?? '缺失'}，独立答案 ${g.verdict}`);
    hm.delete(key(g));
  }
  for (const k of hm.keys()) differences.push(`多余 Hub 判定 ${k}`);
  return {equal: differences.length === 0,differences};
}

/** Public README Pointers: interpreter positions are in subject order, never sorted by path. */
function pointerMaps(data: PlanData | undefined, contract: CompileContract): {phrases:number[];quotes:number[]} {
  const phrases: number[] = [], quotes: number[] = [];
  for (const [i,step] of (data?.steps ?? []).entries()) {
    for (const p of methodOf(contract,step.object,step.method)?.params ?? []) {
      const v = Object.hasOwn(step.params,p.name) ? step.params[p.name] : p.default;
      if (p.command && str(v) && v.trim()) phrases.push(i);
    }
  }
  for (const [i,expect] of (data?.expects ?? []).entries()) if (expect.quote.reference.trim() && expect.quote.text.trim()) quotes.push(i);
  return {phrases,quotes};
}
function judgedUnit(pointer: string | undefined, base: string, maps: {phrases:number[];quotes:number[]}): string | null {
  if (pointer === undefined) return null;
  let p = pointer === base ? '/' : pointer.startsWith(`${base}/`) ? pointer.slice(base.length) : pointer;
  if (p === '/data') p = '/'; else if (p.startsWith('/data/')) p = p.slice(5);
  const phrase = /^\/phrases\/(0|[1-9]\d*)$/.exec(p);
  if (phrase) return maps.phrases[Number(phrase[1])] === undefined ? null : `/steps/${maps.phrases[Number(phrase[1])]}`;
  const quote = /^\/quotes\/(0|[1-9]\d*)\/text$/.exec(p);
  if (quote) return maps.quotes[Number(quote[1])] === undefined ? null : `/expects/${maps.quotes[Number(quote[1])]}`;
  if (p === '/bucket' || p.startsWith('/bucket/')) return '/bucket';
  if (p === '/plan_json' || p.startsWith('/plan_json/')) return '/plan_json';
  const indexed = /^\/(blocks|steps|expects)\/(0|[1-9]\d*)(?:\/|$)/.exec(p);
  if (indexed) return `/${indexed[1]}/${indexed[2]}`;
  // Other shape pointers judge the whole plan, as do generation/re-read failures.
  return p === '/' || p.startsWith('/') && !p.startsWith('/phrases') && !p.startsWith('/quotes') ? '/' : null;
}
const checkOfPointer = (pointer: string | undefined): 'function' | 'catalog' | 'quote' =>
  pointer?.startsWith('/phrases/') ? 'catalog' : pointer?.startsWith('/quotes/') ? 'quote' : 'function';

export function compileCheck(inputs: {run: RunShowExport; submission: Submission; contract: unknown; bed: unknown; commandTreeXml?: string; commandCatalog?: CommandCatalogDeclaration; sources?: ReadonlyMap<string,string>}): CompileCheckResult {
  const {run,submission} = inputs;
  const stepVerdicts: StepVerdict[] = [], plans: PlanReceipt[] = [], differences: string[] = [];
  const position_comparisons:CompileCheckResult['position_comparisons']=[];
  const notes = ['不证明在真实设备上跑得通'];
  if (obj(inputs.contract) && inputs.contract.synthetic === true) notes.unshift('按合成合约核对');
  const cp = contractProblem(inputs.contract), bp = bedProblem(inputs.bed);
  const contract = inputs.contract as CompileContract, manifest = inputs.bed as RawBedManifest;
  let catalog: CatalogCommand[] | undefined, catalogError = '缺少命令树原件';
  if (inputs.commandTreeXml !== undefined) try { catalog = parseCommandTree(inputs.commandTreeXml); } catch (e) { catalogError = `命令树不可读：${(e as Error).message}`; }
  const runItems = run.run?.items;
  if (!Array.isArray(runItems) || !runItems.length) differences.push('缺少运行条目');
  if (!submission.run || submission.run !== run.run?.run) differences.push('提交与运行编号不一致');
  const submitted = submission.items ?? [];
  const ids = submitted.map(i => i.item);
  if (!ids.length || new Set(ids).size !== ids.length) differences.push('提交条目为空或重复');
  const expectedIds = new Set((runItems ?? []).map(i => i.id));
  if (ids.length !== expectedIds.size || ids.some(i => !expectedIds.has(i))) differences.push('提交与运行条目集合不一致');
  const result = run.latest?.result;
  if (result?.run !== submission.run || result?.submission !== createHash('sha256').update(canonicalJson(submission)).digest('hex')) differences.push('结论没有绑定这份提交的运行编号和摘要');
  const resultItems = Object.values(result?.partitions ?? {}).flat();
  if (!resultItems.length) differences.push('缺少 latest.result.partitions 结构化结论');
  if (resultItems.length !== expectedIds.size || new Set(resultItems.map(i => i.item)).size !== resultItems.length || resultItems.some(i => !expectedIds.has(i.item))) differences.push('结论与运行条目集合不一致');
  for (const [index, entry] of submitted.entries()) {
    const base = `/items/${index}/slots/plan/0/data`;
    const add = (type: CheckType, step: number, pointer: string, a: Answer, check: StepVerdict['check'] = type === 'command' ? 'catalog' : 'function') => stepVerdicts.push({item:entry.item,stepIndex:step,checkType:type,pointer,check,...a});
    const claims = entry.slots?.plan;
    const data = claims?.[0]?.data;
    const shape = entry.handling !== 'handled' || !Array.isArray(claims) || claims.length !== 1 ? '条目必须 handled 并提交一份 plan 主张' : planProblem(data);
    if (shape || cp || bp) {
      add('contract',0,base,shape ? fail(shape) : unknown(cp ?? bp!));
      for (const t of ['address','command','quotation','plan'] as const) add(t,0,base,unknown(shape ?? cp ?? bp!));
    } else {
      const d = data!;
      d.blocks.forEach((block,i) => { if (block !== 'setup' && block !== 'teardown') add('contract',0,`${base}/blocks/${i}`,fail('块不在有限集中','case-compile.block_unknown')); });
      const bed = manifest.beds.find(b => b.name === d.bucket);
      const leases = run.run.lease_context;
      const start = Date.parse(run.run.started_at);
      const allocated = (leases ?? []).filter(l => l.mine && Date.parse(l.until) > start && l.key.startsWith(`bed/${d.bucket}/ip/`)).map(l => l.key.slice(`bed/${d.bucket}/ip/`.length));
      const address = (v: string, role: string): Answer => {
        if (!bed) return unknown('台架不存在');
        const answer = checkBedAddress(bed,v,role,allocated);
        // Route on the closed reason code, never on the message prose; the missing fact gets its own field.
        return answer.verdict === 'fail' && answer.code === 'case-compile.address_outside_bed' && (!leases || !Number.isFinite(start))
          ? unknown('缺少冻结的租约视图或运行时间，无法判断分配地址') : answer;
      };
      if (!bed) add('address',0,`${base}/bucket`,fail('台架不存在'));
      for (const [i,s] of d.steps.entries()) {
        const ptr = `${base}/steps/${i}`;
        for (const answer of contractChecks(contract,s.object,s.method,s.params)) add('contract',i+1,ptr,answer);
        const m = methodOf(contract,s.object,s.method);
        if (!m) {
          add('address',i+1,ptr,unknown('方法未知，无法确定地址参数'));
          add('command',i+1,ptr,unknown('方法未知，无法确定命令参数')); continue;
        }
        for (const p of m.params) {
          const v = s.params[p.name] ?? p.default;
          if (p.address && v !== undefined) add('address',i+1,`${ptr}/params/${p.name}`,!str(v) ? fail('地址参数不是字面地址') : address(v,p.address));
          if (p.command && v !== undefined && (!str(v) || v.trim())) add('command',i+1,`${ptr}/params/${p.name}`,!str(v) ? fail('命令不是字符串') : catalog ? checkCatalogCommand(catalog,v.trim(),inputs.commandCatalog) : unknown(catalogError));
        }
      }
      for (const [i,e] of d.expects.entries()) {
        const pointer = `${base}/expects/${i}`;
        if (!e.quote.reference.trim() || !e.quote.text.trim()) add('quotation',i+1,pointer,fail('期望结果缺少逐字引文或来源','case-compile.expect_without_source'));
        else {
          add('quotation',i+1,pointer,goldQuoteContains(e.quote.text, e.text) ? pass() : fail('期望结果不是所引原文的逐字片段','case-compile.expect_not_in_quote'));
          add('quotation',i+1,pointer,checkVerbatimQuote(inputs.sources ?? new Map(),e.quote.reference,e.quote.text),'quote');
        }
      }
      if (Object.hasOwn(d,'plan_json')) add('plan',0,`${base}/plan_json`,{...fail('槽位不能提交 plan_json；执行计划由 Hub 生成'),code:'case-compile.plan_in_slots'});
      else try {
        {
          const receipt = generatePlan(entry.item,d,contract); plans.push(receipt);
          const reqs = resultItems.filter(i => i.item === entry.item).flatMap(i => i.requirements).filter(r => r.requirement === 'plan_deterministic');
          const planClaims = reqs.flatMap(r => r.claims).filter(c => c.statement.verdict === 'support' && (c.statement.data?.plan !== undefined || c.statement.data?.sha256 !== undefined));
          if (planClaims.length !== 1) add('plan',0,base,unknown('缺少或重复 Hub 计划文本和 sha256 结论'));
          else {
            const h = planClaims[0].statement.data!;
            add('plan',0,base,h.plan === receipt.plan && h.sha256 === receipt.sha256 ? pass() : fail('Hub 计划文本或 sha256 与独立生成不一致'));
          }
        }
      } catch (e) { add('plan',0,base,unknown(`出件失败（output_failed）：${(e as Error).message}`)); }
    }
    // Public Hub results expose requirement terminals, not one positive claim per step.
    // Compare at that actual granularity; independent per-parameter outcomes remain above.
    const rows = resultItems.filter(i => i.item === entry.item);
    // Delivered is not passed: with refutes and rounds left the item stays delivered, its requirement unsatisfied
    // (case-compile 1.3.0). The partition never decides the comparison; the one partition rule is checked below.
    const partitionOf = Object.entries(result?.partitions ?? {}).find(([, items]) => items.some(i => i.item === entry.item))?.[0];
    const anyIncomplete = rows.some(i => i.requirements.some(r => r.layers.some(l => l.terminal === 'incomplete')));
    const unfinished = partitionOf === 'unfinished' || partitionOf === 'incomplete';
    if (unfinished !== anyIncomplete) differences.push(`${entry.item}：分区 ${partitionOf ?? '缺失'}与要求项${anyIncomplete ? '有不完成（应进未完成）' : '都已完成（不应在未完成）'}`);
    for (const type of Object.keys(requirementOf) as CheckType[]) {
      const key = requirementOf[type];
      const reqs = rows.flatMap(i => i.requirements).filter(r => r.requirement === key);
      const layers = reqs.flatMap(r => r.layers).filter(l => l.layer === 'static');
      const gold = aggregate(stepVerdicts.filter(v => v.item === entry.item && v.checkType === type));
      const expectedStatus = gold === 'pass' ? 'satisfied' : gold === 'fail' ? 'unsatisfied' : 'pending';
      const rawTerminal = layers.length !== 1 ? undefined : layers[0].terminal;
      const exhausted = rawTerminal === 'incomplete' && layers[0].reason === 'repair_exhausted';
      // Repair rounds used up (1.3.0): the static layer ends incomplete and the item leaves delivered — a model-failure
      // the independent answer counts as fail, like a violation. Any other incomplete stays the difference it is.
      const actual = exhausted ? 'fail' : rawTerminal === 'pass' ? 'pass' : rawTerminal === 'violation' ? 'fail' : rawTerminal === 'unchecked' ? 'unknown' : undefined;
      if (reqs.length !== 1 || actual !== gold) differences.push(`${entry.item}/${key}：Hub ${actual ?? '缺失或非事实终态'}${rawTerminal === 'incomplete' ? `（incomplete：${layers[0].reason ?? '无理由'}）` : ''}，独立答案 ${gold}`);
      for (const r of reqs) if (r.status !== expectedStatus) differences.push(`${entry.item}/${key}：Hub 状态 ${r.status}，独立答案 ${expectedStatus}`);
      if(actual==='unknown'||gold==='unknown')differences.push(`${entry.item}/${key}：检查仍未知：${stepVerdicts.filter(v=>v.item===entry.item&&v.checkType===type&&v.verdict==='unknown').map(v=>v.reason).join('；')||'Hub 没有给确定判定'}；下一步补齐对应输入并重新核对`);
      if (actual === 'fail' && gold === 'fail') {
        const maps = !shape && !cp ? pointerMaps(data,contract) : {phrases:[],quotes:[]};
        const local = stepVerdicts.filter(v => v.item === entry.item && v.checkType === type && v.verdict === 'fail');
        const refutes = reqs.flatMap(r => r.claims).filter(c => c.statement.verdict === 'refute');
        if (!refutes.length || refutes.some(c => c.pointer === undefined)) differences.push(`${entry.item}/${key}：不通过的位置缺失，不能确认逐步一致`);
        for (const check of ['function','catalog','quote'] as const) {
          const localCheck = stepVerdicts.filter(v => v.item === entry.item && v.checkType === type && (v.check ?? 'function') === check);
          const hubCheck = reqs.flatMap(r => r.claims).filter(c => checkOfPointer(c.pointer) === check);
          if(localCheck.some(v=>v.verdict==='unknown')||hubCheck.some(c=>c.statement.verdict==='unknown'))differences.push(`${entry.item}/${key}/${check}：仍有未知判定，不能跳过位置核对；下一步补齐对应来源或判定后重跑`);
          // Cap diagnostics per check before coalescing parameter errors to their judged step.
          const ours = local.filter(v => (v.check ?? 'function') === check).slice(0,10).map(v => judgedUnit(v.pointer,base,maps));
          const theirs = refutes.filter(c => checkOfPointer(c.pointer) === check).slice(0,10).map(c => judgedUnit(c.pointer,base,maps));
          const a = [...new Set(ours)], b = [...new Set(theirs)];
          const unresolved=localCheck.some(v=>v.verdict==='unknown')||hubCheck.some(c=>c.statement.verdict==='unknown');
          const equal=!unresolved&&!a.includes(null)&&!b.includes(null)&&JSON.stringify(a)===JSON.stringify(b);
          position_comparisons.push({item:entry.item,requirement:key,check,equal,unknown:unresolved,gold:a,hub:b});
          if (!equal) differences.push(`${entry.item}/${key}/${check}：前 10 条不通过的位置或次序不同，不能确认逐步一致`);
        }
      }

    }
  }
  return {position_comparisons,allPassed:stepVerdicts.length > 0 && stepVerdicts.every(v => v.verdict === 'pass') && differences.length === 0,notes,stepVerdicts,plans,comparison:{equal:differences.length === 0,differences}};
}
export function main(argv: string[] = process.argv.slice(2)): number {
  const value = (k: string) => { const i = argv.indexOf(`--${k}`); return i < 0 ? undefined : argv[i+1]; };
  if (!['run','submission','contract','bed'].every(k => value(k))) {
    process.stderr.write('用法：compile-check.ts --run <运行.json> --submission <提交.json> --contract <合约.json> --bed <台架.json> [--commands <命令树.xml> --product <产品声明.json>] [--sources <来源.json>]\n'); return 2;
  }
  try {
    const json = (k: string): unknown => JSON.parse(readFileSync(value(k)!,'utf8'));
    const sources = value('sources') ? json('sources') : {};
    if (!obj(sources) || !Object.values(sources).every(str)) throw new Error('来源必须是引用到原文字符串的映射');
    const result = compileCheck({run:json('run') as RunShowExport,submission:json('submission') as Submission,contract:json('contract'),bed:json('bed'),
      commandTreeXml:value('commands') ? readFileSync(value('commands')!,'utf8') : undefined,
      commandCatalog:value('product') ? commandCatalogDeclaration(json('product')) : undefined,sources:new Map(Object.entries(sources) as Array<[string,string]>)});
    process.stdout.write(`${JSON.stringify(result,null,2)}\n`); return result.allPassed ? 0 : 1;
  } catch (e) { process.stderr.write(`输入不可读取：${(e as Error).message}\n`); return 1; }
}
if (process.argv[1]?.endsWith('gold/compile-check.ts')) process.exitCode = main();
