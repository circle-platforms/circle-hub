// The compile contract (compile-contract@1): which (object, method) pairs a plan step may call, with how many and what
// typed parameters, which pairs are forbidden, and the synthetic declaration. The shape is defined by this pack (task
// page A.2); a contract that does not fit is refused whole, every problem named with its pointer and fix. Names and
// values in the pack's sample contract are invented, never copied from any old system.
import { isRecord } from './text.ts';

export const PARAM_TYPES = ['string', 'int', 'enum', 'ipv4', 'ipv6', 'mask', 'port', 'keyword'] as const;
export type ParamType = (typeof PARAM_TYPES)[number];

/** How a step's address parameter is used: listen (on the DUT), backend (a server), target, or virtual. */
export const ADDRESS_ROLES = ['listen', 'backend', 'target', 'virtual'] as const;
export type AddressRole = (typeof ADDRESS_ROLES)[number];

export interface ContractParam {
  name: string;
  type: ParamType;
  optional: boolean;
  default: string | null;
  minimum: number | null;
  maximum: number | null;
  minLength: number | null;
  maxLength: number | null;
  values: string[] | null;
  /** The literal keyword of a keyword parameter (defaults to its name). */
  keyword: string | null;
  /** Set when the parameter is a literal address used this way in the plan. */
  address: AddressRole | null;
  /** Set when the parameter's value is a command line checked against the build's command catalog. */
  command: boolean;
}

export interface ContractMethod {
  name: string;
  params: ContractParam[];
}

export interface ContractObject {
  name: string;
  methods: ContractMethod[];
}

export interface Contract {
  synthetic: boolean;
  objects: ContractObject[];
  forbidden: Array<{ object: string; method: string }>;
}

export interface Problem {
  pointer: string;
  message: string;
  fix: string;
}

export type ParsedContract = { ok: true; contract: Contract } | { ok: false; problems: Problem[] };

const NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_OBJECTS = 64;
const MAX_METHODS = 64;
const MAX_PARAMS = 16;
const MAX_FORBIDDEN = 256;

function problem(pointer: string, message: string, fix: string): Problem {
  return { pointer, message, fix };
}

function parseParam(raw: unknown, at: string, problems: Problem[]): ContractParam | null {
  if (!isRecord(raw)) {
    problems.push(problem(at, '参数不是对象', '参数写成对象：name、type，按需 optional、default、范围、values、address、command'));
    return null;
  }
  if (typeof raw.name !== 'string' || !NAME.test(raw.name)) {
    problems.push(problem(`${at}/name`, '参数名不对', '小写字母开头，只用小写字母、数字、下划线和连字符'));
    return null;
  }
  if (typeof raw.type !== 'string' || !(PARAM_TYPES as readonly string[]).includes(raw.type)) {
    problems.push(problem(`${at}/type`, `参数 ${raw.name} 的类型 ${String(raw.type)} 不在 ${PARAM_TYPES.join('、')} 里`, '按受支持的参数类型写'));
    return null;
  }
  const type = raw.type as ParamType;
  const out: ContractParam = {
    name: raw.name,
    type,
    optional: raw.optional === true,
    default: null,
    minimum: null,
    maximum: null,
    minLength: null,
    maxLength: null,
    values: null,
    keyword: null,
    address: null,
    command: raw.command === true,
  };
  if (raw.default !== undefined) {
    if (typeof raw.default !== 'string') problems.push(problem(`${at}/default`, `参数 ${out.name} 的 default 不是字符串`, '缺省值写成文档里的字符串形式'));
    else out.default = raw.default;
  }
  const number = (key: 'minimum' | 'maximum' | 'minLength' | 'maxLength'): void => {
    if (raw[key] === undefined) return;
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])) problems.push(problem(`${at}/${key}`, `参数 ${out.name} 的 ${key} 不是有限数字`, '范围写成数字'));
    else out[key] = raw[key] as number;
  };
  number('minimum');
  number('maximum');
  number('minLength');
  number('maxLength');
  if (out.minimum !== null && out.maximum !== null && out.minimum > out.maximum) problems.push(problem(at, `参数 ${out.name} 的 minimum 大于 maximum`, '把范围改正'));
  if (out.minLength !== null && out.maxLength !== null && out.minLength > out.maxLength) problems.push(problem(at, `参数 ${out.name} 的 minLength 大于 maxLength`, '把长度范围改正'));
  if (raw.values !== undefined) {
    if (!Array.isArray(raw.values) || raw.values.length === 0 || raw.values.some((v) => typeof v !== 'string' || v === '')) problems.push(problem(`${at}/values`, `参数 ${out.name} 的 values 不是非空字符串数组`, 'enum 的取值写成非空字符串数组'));
    else out.values = raw.values as string[];
  }
  if (type === 'enum' && out.values === null) problems.push(problem(at, `参数 ${out.name} 是 enum 却没有 values`, 'enum 参数要给 values'));
  if (raw.keyword !== undefined) {
    if (typeof raw.keyword !== 'string' || raw.keyword === '') problems.push(problem(`${at}/keyword`, `参数 ${out.name} 的 keyword 不是非空字符串`, 'keyword 写那个字面词'));
    else out.keyword = raw.keyword;
  }
  if (raw.address !== undefined) {
    if (typeof raw.address !== 'string' || !(ADDRESS_ROLES as readonly string[]).includes(raw.address)) problems.push(problem(`${at}/address`, `参数 ${out.name} 的 address 角色 ${String(raw.address)} 不在 ${ADDRESS_ROLES.join('、')} 里`, '地址角色写 listen、backend、target 或 virtual'));
    else out.address = raw.address as AddressRole;
  }
  if (out.address !== null && type !== 'ipv4' && type !== 'ipv6' && type !== 'string') problems.push(problem(at, `参数 ${out.name} 带地址角色却不是地址或字符串类型`, '地址参数的类型写 ipv4、ipv6 或 string'));
  if (out.command && type !== 'string') problems.push(problem(at, `参数 ${out.name} 是命令行却不是 string 类型`, '命令行参数的类型写 string'));
  return out;
}

/** Parses a compile-contract@1 value; never throws. Problems are listed whole, each with its pointer and fix. */
export function parseContract(input: unknown): ParsedContract {
  const problems: Problem[] = [];
  if (!isRecord(input)) return { ok: false, problems: [problem('', '合约不是对象', '按 compile-contract@1 的形状写')] };
  if (input.schema !== 'compile-contract@1') problems.push(problem('/schema', 'schema 不是 compile-contract@1', 'schema 写 compile-contract@1'));
  const synthetic = input.synthetic === true;
  if (input.synthetic !== undefined && typeof input.synthetic !== 'boolean') problems.push(problem('/synthetic', 'synthetic 不是布尔值', '合成合约写 "synthetic": true'));
  if (!Array.isArray(input.objects) || input.objects.length === 0) problems.push(problem('/objects', '合约没有对象数组', 'objects 写对象和方法的非空数组'));
  if (Array.isArray(input.objects) && input.objects.length > MAX_OBJECTS) problems.push(problem('/objects', `对象超过 ${MAX_OBJECTS} 个`, '减少对象'));
  const objects: ContractObject[] = [];
  const objectNames = new Set<string>();
  for (const [oi, rawObject] of (Array.isArray(input.objects) ? input.objects : []).entries()) {
    const at = `/objects/${oi}`;
    if (!isRecord(rawObject) || typeof rawObject.name !== 'string' || !NAME.test(rawObject.name)) {
      problems.push(problem(`${at}/name`, '对象名不对', '小写字母开头，只用小写字母、数字、下划线和连字符'));
      continue;
    }
    if (objectNames.has(rawObject.name)) problems.push(problem(at, `对象 ${rawObject.name} 重复`, '对象名不能重复'));
    objectNames.add(rawObject.name);
    if (!Array.isArray(rawObject.methods)) {
      problems.push(problem(`${at}/methods`, `对象 ${rawObject.name} 没有方法数组`, 'methods 写方法数组（可以为空）'));
      continue;
    }
    if (rawObject.methods.length > MAX_METHODS) problems.push(problem(`${at}/methods`, `对象 ${rawObject.name} 的方法超过 ${MAX_METHODS} 个`, '减少方法'));
    const methods: ContractMethod[] = [];
    const methodNames = new Set<string>();
    for (const [mi, rawMethod] of rawObject.methods.entries()) {
      const mat = `${at}/methods/${mi}`;
      if (!isRecord(rawMethod) || typeof rawMethod.name !== 'string' || !NAME.test(rawMethod.name)) {
        problems.push(problem(`${mat}/name`, '方法名不对', '小写字母开头，只用小写字母、数字、下划线和连字符'));
        continue;
      }
      if (methodNames.has(rawMethod.name)) problems.push(problem(mat, `对象 ${rawObject.name} 的方法 ${rawMethod.name} 重复`, '同一对象的方法名不能重复'));
      methodNames.add(rawMethod.name);
      if (!Array.isArray(rawMethod.params)) {
        problems.push(problem(`${mat}/params`, `方法 ${rawMethod.name} 没有参数数组`, 'params 写参数数组（没有参数写 []）'));
        continue;
      }
      if (rawMethod.params.length > MAX_PARAMS) problems.push(problem(`${mat}/params`, `方法 ${rawMethod.name} 的参数超过 ${MAX_PARAMS} 个`, '减少参数'));
      const params: ContractParam[] = [];
      const paramNames = new Set<string>();
      rawMethod.params.forEach((rawParam, pi) => {
        const parsed = parseParam(rawParam, `${mat}/params/${pi}`, problems);
        if (parsed === null) return;
        if (paramNames.has(parsed.name)) problems.push(problem(`${mat}/params/${pi}`, `参数 ${parsed.name} 重复`, '同一方法的参数名不能重复'));
        paramNames.add(parsed.name);
        params.push(parsed);
      });
      methods.push({ name: rawMethod.name, params });
    }
    objects.push({ name: rawObject.name, methods });
  }
  const forbidden: Array<{ object: string; method: string }> = [];
  if (input.forbidden !== undefined) {
    if (!Array.isArray(input.forbidden) || input.forbidden.length > MAX_FORBIDDEN) problems.push(problem('/forbidden', `禁用组合不是数组或超过 ${MAX_FORBIDDEN} 个`, 'forbidden 写 {object, method} 的数组'));
    else {
      const seen = new Set<string>();
      for (const [fi, raw] of input.forbidden.entries()) {
        const at = `/forbidden/${fi}`;
        if (!isRecord(raw) || typeof raw.object !== 'string' || typeof raw.method !== 'string') {
          problems.push(problem(at, '禁用组合不是 {object, method}', '禁用组合写成 {"object": "...", "method": "..."}'));
          continue;
        }
        const key = `${raw.object}.${raw.method}`;
        if (seen.has(key)) problems.push(problem(at, `禁用组合 ${key} 重复`, '禁用组合不能重复'));
        seen.add(key);
        forbidden.push({ object: raw.object, method: raw.method });
      }
    }
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, contract: { synthetic, objects, forbidden } };
}

export function lookupMethod(contract: Contract, object: string, method: string): ContractMethod | null {
  const found = contract.objects.find((candidate) => candidate.name === object);
  return found?.methods.find((candidate) => candidate.name === method) ?? null;
}

export function isForbidden(contract: Contract, object: string, method: string): boolean {
  return contract.forbidden.some((pair) => pair.object === object && pair.method === method);
}

/** Validates one parameter value against its contract declaration; the problem with its kind, or null when it fits. */
export function paramProblem(param: ContractParam, value: unknown): { kind: 'type' | 'range'; text: string } | null {
  const range = (text: string): { kind: 'type' | 'range'; text: string } => ({ kind: 'range', text });
  const type = (text: string): { kind: 'type' | 'range'; text: string } => ({ kind: 'type', text });
  if (value === undefined || value === null) return param.optional ? null : type(`缺参数 ${param.name}`);
  switch (param.type) {
    case 'string': {
      if (typeof value !== 'string') return type(`参数 ${param.name} 应为字符串`);
      if (param.minLength !== null && [...value].length < param.minLength) return range(`参数 ${param.name} 长度不到 ${param.minLength}`);
      if (param.maxLength !== null && [...value].length > param.maxLength) return range(`参数 ${param.name} 长度超过 ${param.maxLength}`);
      return null;
    }
    case 'int': {
      if (typeof value !== 'number' || !Number.isInteger(value)) return type(`参数 ${param.name} 应为整数`);
      if (param.minimum !== null && value < param.minimum) return range(`参数 ${param.name} 应为不小于 ${param.minimum} 的整数`);
      if (param.maximum !== null && value > param.maximum) return range(`参数 ${param.name} 应为不大于 ${param.maximum} 的整数`);
      return null;
    }
    case 'port': {
      if (typeof value !== 'number' || !Number.isInteger(value)) return type(`参数 ${param.name} 应为整数（端口）`);
      if (value < 0 || value > 65535) return range(`参数 ${param.name} 应为 0 到 65535 的端口`);
      if (param.minimum !== null && value < param.minimum) return range(`参数 ${param.name} 应为不小于 ${param.minimum} 的端口`);
      if (param.maximum !== null && value > param.maximum) return range(`参数 ${param.name} 应为不大于 ${param.maximum} 的端口`);
      return null;
    }
    case 'enum': {
      if (typeof value !== 'string' || !(param.values ?? []).includes(value)) return type(`参数 ${param.name} 应为 ${(param.values ?? []).join('、')} 之一`);
      return null;
    }
    case 'keyword': {
      const wanted = param.keyword ?? param.name;
      if (value !== wanted) return type(`参数 ${param.name} 应为字面词 ${wanted}`);
      return null;
    }
    case 'ipv4':
      if (typeof value !== 'string' || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) || value.split('.').some((part) => Number(part) > 255 || (part.length > 1 && part.startsWith('0')))) return type(`参数 ${param.name} 应为 IPv4 地址`);
      return null;
    case 'ipv6':
      if (typeof value !== 'string' || !/^[0-9a-fA-F:]+$/.test(value) || !value.includes(':')) return type(`参数 ${param.name} 应为 IPv6 地址`);
      return null;
    case 'mask':
      if (typeof value !== 'string' || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) return type(`参数 ${param.name} 应为点分掩码`);
      return null;
  }
}

/** The parameters of a step as the generator writes them: contract order, defaults filled; null when a required one is missing. */
export function orderedParams(method: ContractMethod, given: Record<string, unknown>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const param of method.params) {
    const value = given[param.name];
    if (value === undefined || value === null) {
      if (param.default !== null) out[param.name] = param.default;
      else if (!param.optional) return null;
    } else {
      out[param.name] = value;
    }
  }
  return out;
}
