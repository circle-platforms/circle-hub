// Gold verification for case compilation (docs/hub-r4-tasks/case-compile.md, capability E1-E3).
// Independent by design: imports nothing from hub/, packs/ or contracts/.
//
// Re-calculates step-by-step checks defined in section A.4:
//   1. Contract method: (object, method) in contract, not disabled, argument count and parameter types match;
//   2. Test bed addresses:
//      - all literal addresses must resolve to device interface or allocated addresses on the bed;
//      - addresses outside the bed are rejected;
//      - listener address must be on a load-balancer (SUT) interface and have trigger devices (router, client) on the same subnet;
//      - blind addresses (load-balancer on a subnet without trigger device) cannot be used as listeners or VIPs;
//      - backend address must be on a server device;
//   3. Command catalog: commands and parameters exist in the target build command tree, values within bounds;
//   4. Expected sources: each expectation has a source reference and verbatim quotation;
//   5. Output mandatory conclusions: "按合成合约核对" (when synthetic) and "不证明在真实设备上跑得通".
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------- IP & Subnet Helpers

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

  if (leftParts.length + rightParts.length > 8) return null;

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

// ---------------------------------------------------------------- Test Bed Manifest & Facts

export interface RawDevice {
  name: string;
  type: 'load-balancer' | 'router' | 'client' | 'server' | 'console' | string;
  ipv4?: Array<{ address: string; subnet?: string } | string>;
  ipv6?: Array<{ address: string; subnet?: string } | string>;
  interfaces?: Array<{ address: string; subnet?: string } | string>;
}

export interface RawBedManifest {
  name?: string;
  devices: RawDevice[];
  services?: Array<{ host: string; ip: string; port: number; proto: string }>;
  reserved?: Array<{ start?: string; end?: string; range?: string } | string>;
}

export interface BedInterface {
  device: string;
  deviceType: string;
  address: string;
  subnetStr: string;
  subnet: ParsedSubnet | null;
}

export interface TestBedFacts {
  bedName: string;
  allDeviceIps: Set<string>;
  allReservedIps: Set<string>;
  deviceByIp: Map<string, { name: string; type: string }>;
  interfaces: BedInterface[];
  listenerCandidates: Set<string>;
  blindAddresses: Set<string>;
  backendCandidates: Set<string>;
  subnets: Array<{
    subnet: string;
    parsed: ParsedSubnet | null;
    devices: Array<{ name: string; type: string; address: string }>;
    hasTrigger: boolean;
  }>;
}

const TRIGGER_TYPES = new Set(['router', 'client']);

export function computeTestBedFacts(manifest: RawBedManifest): TestBedFacts {
  const bedName = manifest.name ?? 'test-bed';
  const allDeviceIps = new Set<string>();
  const allReservedIps = new Set<string>();
  const deviceByIp = new Map<string, { name: string; type: string }>();
  const interfaces: BedInterface[] = [];

  for (const dev of manifest.devices ?? []) {
    const devIps: Array<{ ip: string; subnetText?: string }> = [];
    const collect = (item: { address: string; subnet?: string } | string) => {
      if (typeof item === 'string') {
        const slash = item.indexOf('/');
        const ip = cleanIp(item);
        devIps.push({ ip, subnetText: slash >= 0 ? item : undefined });
      } else if (item && typeof item === 'object') {
        const ip = cleanIp(item.address);
        devIps.push({ ip, subnetText: item.subnet ?? item.address });
      }
    };

    for (const item of dev.ipv4 ?? []) collect(item);
    for (const item of dev.ipv6 ?? []) collect(item);
    for (const item of dev.interfaces ?? []) collect(item);

    for (const { ip, subnetText } of devIps) {
      allDeviceIps.add(ip);
      deviceByIp.set(ip, { name: dev.name, type: dev.type });
      const parsed = subnetText ? parseSubnet(subnetText) : null;
      interfaces.push({
        device: dev.name,
        deviceType: dev.type,
        address: ip,
        subnetStr: subnetText ?? '',
        subnet: parsed,
      });
    }
  }

  // Group interfaces by subnet
  const subnetMap = new Map<string, {
    parsed: ParsedSubnet | null;
    devices: Array<{ name: string; type: string; address: string }>;
    hasTrigger: boolean;
  }>();

  for (const iface of interfaces) {
    if (!iface.subnetStr) continue;
    let entry = subnetMap.get(iface.subnetStr);
    if (!entry) {
      entry = { parsed: iface.subnet, devices: [], hasTrigger: false };
      subnetMap.set(iface.subnetStr, entry);
    }
    entry.devices.push({ name: iface.device, type: iface.deviceType, address: iface.address });
    if (TRIGGER_TYPES.has(iface.deviceType)) {
      entry.hasTrigger = true;
    }
  }

  // Classify listener, blind, backend
  const listenerCandidates = new Set<string>();
  const blindAddresses = new Set<string>();
  const backendCandidates = new Set<string>();

  for (const iface of interfaces) {
    if (iface.deviceType === 'server') {
      backendCandidates.add(iface.address);
    }
    if (iface.deviceType === 'load-balancer') {
      const subInfo = iface.subnetStr ? subnetMap.get(iface.subnetStr) : undefined;
      if (subInfo && subInfo.hasTrigger) {
        listenerCandidates.add(iface.address);
      } else {
        blindAddresses.add(iface.address);
      }
    }
  }

  // Also services count as backend candidates
  for (const s of manifest.services ?? []) {
    const sIp = cleanIp(s.ip);
    backendCandidates.add(sIp);
    allDeviceIps.add(sIp);
  }

  const subnetsList = [...subnetMap.entries()].map(([subnet, data]) => ({
    subnet,
    parsed: data.parsed,
    devices: data.devices,
    hasTrigger: data.hasTrigger,
  }));

  return {
    bedName,
    allDeviceIps,
    allReservedIps,
    deviceByIp,
    interfaces,
    listenerCandidates,
    blindAddresses,
    backendCandidates,
    subnets: subnetsList,
  };
}

export type AddressRole = 'listener' | 'backend' | 'client' | 'any';

export function checkBedAddress(
  facts: TestBedFacts,
  rawAddress: string,
  role: AddressRole = 'any',
): { ok: boolean; verdict: 'pass' | 'fail'; reason?: string } {
  const ip = cleanIp(rawAddress);

  // Rule 1: Every address must exist on the bed
  const onBed = facts.allDeviceIps.has(ip) || facts.allReservedIps.has(ip);
  if (!onBed) {
    return { ok: false, verdict: 'fail', reason: `台架之外的地址一律拒绝：地址 ${ip} 未在台架清单中声明` };
  }

  if (role === 'listener') {
    // Must be on load-balancer
    const dev = facts.deviceByIp.get(ip);
    if (!dev || dev.type !== 'load-balancer') {
      return { ok: false, verdict: 'fail', reason: `监听地址必须是被测设备的接口地址：地址 ${ip} 属于 ${dev?.type ?? '非负载均衡设备'}` };
    }
    // Must not be blind (subnet must have trigger device)
    if (facts.blindAddresses.has(ip)) {
      return { ok: false, verdict: 'fail', reason: `盲地址不能当监听或虚拟地址：地址 ${ip} 所在网段没有触发设备` };
    }
    if (!facts.listenerCandidates.has(ip)) {
      return { ok: false, verdict: 'fail', reason: `监听地址所在网段没有触发设备（盲地址）：地址 ${ip}` };
    }
    return { ok: true, verdict: 'pass' };
  }

  if (role === 'backend') {
    if (!facts.backendCandidates.has(ip)) {
      const dev = facts.deviceByIp.get(ip);
      return { ok: false, verdict: 'fail', reason: `后端地址必须是服务器设备的地址：地址 ${ip} 属于 ${dev?.type ?? '未知设备'}` };
    }
    return { ok: true, verdict: 'pass' };
  }

  return { ok: true, verdict: 'pass' };
}

// ---------------------------------------------------------------- Command Tree XML Parser

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
      if (roots.length > 200) break;
    }
    return roots;
  }
  private element(): XmlNode {
    this.at++; // skip <
    const nameMatch = /^[A-Za-z0-9_.-]+/.exec(this.text.slice(this.at));
    const name = nameMatch ? nameMatch[0] : '';
    this.at += name.length;
    const attributes: Record<string, string> = {};
    for (;;) {
      this.spaces();
      if (this.at >= this.text.length || this.text[this.at] === '>' || this.text.startsWith('/>', this.at)) break;
      const keyMatch = /^[A-Za-z0-9_.-]+/.exec(this.text.slice(this.at));
      if (!keyMatch) break;
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
          const val = endQuote >= 0 ? this.text.slice(this.at, endQuote) : '';
          attributes[key] = val;
          this.at = endQuote >= 0 ? endQuote + 1 : this.text.length;
        }
      }
    }
    this.spaces();
    if (this.text.startsWith('/>', this.at)) {
      this.at += 2;
      return { name, attributes, children: [] };
    }
    if (this.text[this.at] === '>') this.at++;
    const children: XmlElementChild[] = [];
    for (;;) {
      const nextTag = this.text.indexOf('<', this.at);
      if (nextTag < 0) break;
      if (nextTag > this.at) {
        children.push({ text: this.text.slice(this.at, nextTag) });
        this.at = nextTag;
      }
      if (this.text.startsWith('</', this.at)) {
        const closeEnd = this.text.indexOf('>', this.at);
        this.at = closeEnd >= 0 ? closeEnd + 1 : this.text.length;
        break;
      }
      children.push({ element: this.element() });
    }
    return { name, attributes, children };
  }
  private spaces(): void {
    while (this.at < this.text.length && /\s/.test(this.text[this.at])) this.at++;
  }
}

export interface CommandArgDef {
  name: string;
  type?: string;
  length?: string;
  range?: string;
  optional?: boolean;
}

export interface CatalogCommand {
  path: string;
  words: string[];
  arguments: CommandArgDef[];
}

export interface CommandCatalog {
  commandsByPath: Map<string, CatalogCommand>;
}

export function parseCommandTree(xml: string): CommandCatalog {
  const roots = XmlReader.read(xml);
  const commandsByPath = new Map<string, CatalogCommand>();

  const walk = (node: XmlNode, prefixWords: string[]) => {
    if (node.name === 'item') {
      const itemName = (node.attributes.name ?? '').trim();
      const itemWords = itemName.split(/\s+/).filter(Boolean);
      if (itemWords.length === 0) return;
      const fullWords = [...prefixWords, ...itemWords];
      const path = `/commands/${fullWords.join('/')}`;

      const argsList: CommandArgDef[] = [];
      for (const ch of node.children) {
        if ('element' in ch && ch.element.name === 'arguments') {
          for (const argChild of ch.element.children) {
            if ('element' in argChild && argChild.element.name === 'arg') {
              const a = argChild.element.attributes;
              argsList.push({
                name: a.name ?? '',
                type: a.type,
                length: a.length,
                range: a.range,
                optional: a.optional === 'yes' || a.optional === 'true',
              });
            }
          }
        }
      }

      commandsByPath.set(path, { path, words: fullWords, arguments: argsList });
      return;
    }

    for (const ch of node.children) {
      if ('element' in ch) {
        const elem = ch.element;
        if (elem.name === 'item') {
          walk(elem, prefixWords);
        } else if (elem.name === 'menu') {
          const menuName = (elem.attributes.name ?? '').trim();
          const menuWords = menuName.split(/\s+/).filter(Boolean);
          walk(elem, [...prefixWords, ...menuWords]);
        } else if (elem.name !== 'arguments' && elem.name !== 'arg') {
          walk(elem, prefixWords);
        }
      }
    }
  };

  for (const root of roots) {
    walk(root, []);
  }

  return { commandsByPath };
}

export function checkCatalogCommand(
  catalog: CommandCatalog,
  commandPath: string,
  args?: Record<string, string | number>,
): { ok: boolean; verdict: 'pass' | 'fail'; reason?: string } {
  const normPath = commandPath.startsWith('/commands/') ? commandPath : `/commands/${commandPath.replace(/^\/+/, '')}`;
  const def = catalog.commandsByPath.get(normPath);
  if (!def) {
    return { ok: false, verdict: 'fail', reason: `命令不存在于目标构建的命令树中：${normPath}` };
  }

  if (args) {
    for (const [argName, val] of Object.entries(args)) {
      const argDef = def.arguments.find((a) => a.name === argName);
      if (!argDef) {
        return { ok: false, verdict: 'fail', reason: `命令 ${normPath} 没有声明参数 ${argName}` };
      }

      // Check numeric bounds if range specified
      if (argDef.range && typeof val === 'number') {
        const [minStr, maxStr] = argDef.range.split('..');
        const min = Number(minStr);
        const max = Number(maxStr);
        if (val < min || val > max) {
          return { ok: false, verdict: 'fail', reason: `参数 ${argName} 的取值 ${val} 超出范围 ${argDef.range}` };
        }
      }

      // Check integer types
      if (argDef.type === 'U16') {
        const n = Number(val);
        if (!Number.isSafeInteger(n) || n < 0 || n > 65535) {
          return { ok: false, verdict: 'fail', reason: `参数 ${argName} 必须是 U16（0..65535），收到 ${val}` };
        }
      }
      if (argDef.type === 'U32') {
        const n = Number(val);
        if (!Number.isSafeInteger(n) || n < 0 || n > 4294967295) {
          return { ok: false, verdict: 'fail', reason: `参数 ${argName} 必须是 U32（0..4294967295），收到 ${val}` };
        }
      }
    }
  }

  return { ok: true, verdict: 'pass' };
}

// ---------------------------------------------------------------- Verbatim Quotation Verification

export function collapseWhitespace(text: string): string {
  let out = '';
  let word = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (word !== '') {
        out = out === '' ? word : `${out} ${word}`;
        word = '';
      }
    } else {
      word += ch;
    }
  }
  if (word !== '') out = out === '' ? word : `${out} ${word}`;
  return out;
}

export function quoteMatches(fragmentText: string, quote: string): boolean {
  const q = collapseWhitespace(quote);
  return q !== '' && collapseWhitespace(fragmentText).includes(q);
}

export function checkVerbatimQuote(
  sources: ReadonlyMap<string, string>,
  sourceRef: string,
  quote: string,
): { ok: boolean; verdict: 'pass' | 'fail' | 'unknown'; reason?: string } {
  if (!quote || quote.trim() === '') {
    return { ok: false, verdict: 'fail', reason: '期望结果缺少逐字引文' };
  }
  if (!sourceRef || sourceRef.trim() === '') {
    return { ok: false, verdict: 'fail', reason: '期望结果缺少来源引用' };
  }
  const fragment = sources.get(sourceRef);
  if (fragment === undefined) {
    return { ok: false, verdict: 'unknown', reason: `引用的来源片段 ${sourceRef} 无法读取或未绑定` };
  }
  if (!quoteMatches(fragment, quote)) {
    return { ok: false, verdict: 'fail', reason: `期望结果的引文不是来源 ${sourceRef} 的逐字片段` };
  }
  return { ok: true, verdict: 'pass' };
}

// ---------------------------------------------------------------- Contract Method Verification

export interface ContractParamDef {
  name: string;
  type?: 'string' | 'number' | 'boolean' | 'object' | 'array' | string;
  required?: boolean;
}

export interface ContractMethodDef {
  object: string;
  method: string;
  params?: ContractParamDef[];
  disabled?: boolean;
}

export interface CompileContract {
  synthetic?: boolean;
  methods: ContractMethodDef[];
  disabledCombinations?: Array<{ object: string; method: string }>;
}

export function checkContractMethod(
  contract: CompileContract,
  object: string,
  method: string,
  args?: Record<string, unknown>,
): { ok: boolean; verdict: 'pass' | 'fail'; reason?: string } {
  const def = contract.methods.find((m) => m.object === object && m.method === method);
  if (!def) {
    return { ok: false, verdict: 'fail', reason: `（对象，方法）组合 （${object}, ${method}）未在合约中定义` };
  }

  // Check disabled
  const explicitlyDisabled = def.disabled === true;
  const inDisabledList = (contract.disabledCombinations ?? []).some(
    (c) => c.object === object && c.method === method,
  );
  if (explicitlyDisabled || inDisabledList) {
    return { ok: false, verdict: 'fail', reason: `方法 （${object}, ${method}）已被合约禁用（例如重启类操作）` };
  }

  // Check arguments
  if (def.params && args) {
    for (const p of def.params) {
      if (p.required && !(p.name in args)) {
        return { ok: false, verdict: 'fail', reason: `方法 （${object}, ${method}）缺少必填参数 ${p.name}` };
      }
      if (p.name in args && p.type) {
        const actualVal = args[p.name];
        const actualType = typeof actualVal;
        if (p.type === 'number' && actualType !== 'number') {
          return { ok: false, verdict: 'fail', reason: `参数 ${p.name} 类型不匹配：期望 number，收到 ${actualType}` };
        }
        if (p.type === 'string' && actualType !== 'string') {
          return { ok: false, verdict: 'fail', reason: `参数 ${p.name} 类型不匹配：期望 string，收到 ${actualType}` };
        }
        if (p.type === 'boolean' && actualType !== 'boolean') {
          return { ok: false, verdict: 'fail', reason: `参数 ${p.name} 类型不匹配：期望 boolean，收到 ${actualType}` };
        }
      }
    }
  }

  return { ok: true, verdict: 'pass' };
}

// ---------------------------------------------------------------- Overall Compile Verification

export interface ExecutionPlanStep {
  id?: string;
  name?: string;
  object?: string;
  method?: string;
  args?: Record<string, unknown>;
  addresses?: Array<{ ip: string; role?: AddressRole }>;
  command?: { path: string; args?: Record<string, string | number> };
  expectation?: { sourceRef: string; quote: string };
}

export interface ExecutionPlan {
  caseId?: string;
  name?: string;
  steps: ExecutionPlanStep[];
}

export interface StepVerdict {
  stepIndex: number;
  stepId?: string;
  checkType: 'contract' | 'address' | 'command' | 'quotation';
  verdict: 'pass' | 'fail' | 'unknown';
  reason?: string;
}

export interface CompileCheckResult {
  allPassed: boolean;
  notes: string[];
  stepVerdicts: StepVerdict[];
}

export function compileCheck(inputs: {
  plan: ExecutionPlan;
  contract: CompileContract;
  bed: RawBedManifest;
  commandTreeXml?: string;
  sources?: Map<string, string>;
}): CompileCheckResult {
  const facts = computeTestBedFacts(inputs.bed);
  const catalog = inputs.commandTreeXml ? parseCommandTree(inputs.commandTreeXml) : null;
  const sources = inputs.sources ?? new Map<string, string>();

  const stepVerdicts: StepVerdict[] = [];
  const notes: string[] = [];

  if (inputs.contract.synthetic) {
    notes.push('按合成合约核对');
  }
  notes.push('不证明在真实设备上跑得通');

  for (let i = 0; i < inputs.plan.steps.length; i++) {
    const step = inputs.plan.steps[i];
    const stepId = step.id ?? `step_${i + 1}`;

    // 1. Contract check
    if (step.object && step.method) {
      const cRes = checkContractMethod(inputs.contract, step.object, step.method, step.args);
      stepVerdicts.push({
        stepIndex: i + 1,
        stepId,
        checkType: 'contract',
        verdict: cRes.verdict,
        reason: cRes.reason,
      });
    }

    // 2. Address check
    if (step.addresses && step.addresses.length > 0) {
      for (const addr of step.addresses) {
        const aRes = checkBedAddress(facts, addr.ip, addr.role ?? 'any');
        stepVerdicts.push({
          stepIndex: i + 1,
          stepId,
          checkType: 'address',
          verdict: aRes.verdict,
          reason: aRes.reason,
        });
      }
    }

    // 3. Command catalog check
    if (step.command) {
      if (!catalog) {
        stepVerdicts.push({
          stepIndex: i + 1,
          stepId,
          checkType: 'command',
          verdict: 'unknown',
          reason: '缺少命令树原件，无法核对命令目录',
        });
      } else {
        const cmdRes = checkCatalogCommand(catalog, step.command.path, step.command.args);
        stepVerdicts.push({
          stepIndex: i + 1,
          stepId,
          checkType: 'command',
          verdict: cmdRes.verdict,
          reason: cmdRes.reason,
        });
      }
    }

    // 4. Expectation / quotation check
    if (step.expectation) {
      const qRes = checkVerbatimQuote(sources, step.expectation.sourceRef, step.expectation.quote);
      stepVerdicts.push({
        stepIndex: i + 1,
        stepId,
        checkType: 'quotation',
        verdict: qRes.verdict,
        reason: qRes.reason,
      });
    }
  }

  const allPassed = stepVerdicts.length > 0 && stepVerdicts.every((v) => v.verdict === 'pass');

  return {
    allPassed,
    notes,
    stepVerdicts,
  };
}

export function compareCompileVerdicts(
  hubVerdicts: readonly StepVerdict[],
  goldVerdicts: readonly StepVerdict[],
): { equal: boolean; differences: string[] } {
  const differences: string[] = [];

  if (hubVerdicts.length !== goldVerdicts.length) {
    differences.push(`判定步数不一致：Hub 判定 ${hubVerdicts.length} 项，独立答案判定 ${goldVerdicts.length} 项`);
  }

  const maxLen = Math.max(hubVerdicts.length, goldVerdicts.length);
  for (let i = 0; i < maxLen; i++) {
    const h = hubVerdicts[i];
    const g = goldVerdicts[i];
    if (!h) {
      differences.push(`第 ${i + 1} 项缺少 Hub 判定，独立答案判定为 ${g.verdict}（${g.checkType}）`);
      continue;
    }
    if (!g) {
      differences.push(`第 ${i + 1} 项缺少独立答案判定，Hub 判定为 ${h.verdict}（${h.checkType}）`);
      continue;
    }
    if (h.verdict !== g.verdict) {
      differences.push(`第 ${i + 1} 项判定不同（${h.checkType}）：Hub 为 ${h.verdict}，独立答案为 ${g.verdict}`);
    }
  }

  return { equal: differences.length === 0, differences };
}

// ---------------------------------------------------------------- CLI

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const value = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : undefined;
  };

  const planPath = value('plan');
  const contractPath = value('contract');
  const bedPath = value('bed');
  const commandsPath = value('commands');
  const sourcesPath = value('sources');

  if (!planPath || !contractPath || !bedPath) {
    process.stderr.write('用法：node scripts/real/gold/compile-check.ts --plan <plan.json> --contract <contract.json> --bed <bed.json> [--commands <tree.xml>] [--sources <sources.json>]\n');
    return 2;
  }

  try {
    const plan = JSON.parse(readFileSync(resolve(planPath), 'utf8')) as ExecutionPlan;
    const contract = JSON.parse(readFileSync(resolve(contractPath), 'utf8')) as CompileContract;
    const bed = JSON.parse(readFileSync(resolve(bedPath), 'utf8')) as RawBedManifest;
    const commandTreeXml = commandsPath ? readFileSync(resolve(commandsPath), 'utf8') : undefined;
    const sources = sourcesPath
      ? new Map<string, string>(Object.entries(JSON.parse(readFileSync(resolve(sourcesPath), 'utf8')) as Record<string, string>))
      : undefined;

    const result = compileCheck({ plan, contract, bed, commandTreeXml, sources });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.allPassed ? 0 : 1;
  } catch (error) {
    process.stderr.write(`读取输入出错：${(error as Error).message}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('gold/compile-check.ts')) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
