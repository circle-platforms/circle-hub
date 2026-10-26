// Typed parameter checks of catalog signatures. Pure functions of the declared parameter and one argument word.
import type { CatalogParam, CatalogParamType } from '../../../contracts/src/tables.ts';
import { codePoints } from '../text.ts';
import { foldWord } from './view.ts';

export type ParamProblem = 'core.catalog.param_type_mismatch' | 'core.catalog.param_out_of_range';

export type ParamCheck = { ok: true } | { ok: false; code: ParamProblem; expected: string };

/** Chinese names of the parameter types, for statements. */
export const PARAM_TYPE_TEXT: Record<CatalogParamType, string> = {
  string: '字符串',
  int: '整数',
  enum: '枚举值',
  ipv4: 'IPv4 地址',
  ipv6: 'IPv6 地址',
  mask: 'IPv4 掩码',
  port: '端口号',
  keyword: '关键字',
  hostname: '主机名',
  ip_or_hostname: 'IPv4、IPv6 地址或主机名',
};

export function parseIpv4(value: string): number[] | undefined {
  const parts = value.split('.');
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return undefined;
    const n = Number(part);
    if (n > 255) return undefined;
    octets.push(n);
  }
  return octets;
}

/** RFC 4291 section 2.2 text forms, including `::` and a trailing dotted IPv4 part; no zone index. */
export function isIpv6(value: string): boolean {
  if (value.length === 0 || value.length > 45 || !/^[0-9A-Fa-f:.]+$/.test(value)) return false;
  const halves = value.split('::');
  if (halves.length > 2) return false;
  const groups = (part: string): string[] | undefined => (part === '' ? [] : part.split(':'));
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  if (!head || !tail) return false;
  const all = [...head, ...tail];
  // A dotted IPv4 part may only end the address text, never precede `::`.
  const endsText = halves.length === 1 || tail.length > 0;
  let count = 0;
  for (let i = 0; i < all.length; i++) {
    const g = all[i];
    const last = i === all.length - 1 && endsText;
    if (last && g.includes('.')) {
      if (!parseIpv4(g)) return false;
      count += 2;
    } else if (/^[0-9A-Fa-f]{1,4}$/.test(g)) {
      count += 1;
    } else {
      return false;
    }
  }
  if (halves.length === 2) return count <= 7;
  return count === 8;
}

/** Bounded ASCII DNS labels (including single-label and trailing-dot names); never resolve or coerce a URL/IP. */
export function isHostname(value:string):boolean {
  if(!value.length||value.length>254)return false;
  const name=value.endsWith('.')?value.slice(0,-1):value;
  if(!name.length||name.length>253||!/^[A-Za-z0-9.-]+$/.test(name))return false;
  if(name.includes('.')&&/^[0-9.]+$/.test(name))return false;
  return name.split('.').every(label=>label.length>=1&&label.length<=63&&/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
}

/** Dotted IPv4 netmask: contiguous one bits followed by zero bits. */
export function isMask(value: string): boolean {
  const octets = parseIpv4(value);
  if (!octets) return false;
  const bits = octets.map((o) => o.toString(2).padStart(8, '0')).join('');
  return /^1*0*$/.test(bits);
}

function boundsText(min: number | undefined, max: number | undefined): string {
  if (min !== undefined && max !== undefined) return `${min}–${max}`;
  if (min !== undefined) return `不小于 ${min}`;
  if (max !== undefined) return `不大于 ${max}`;
  return '';
}

function inBounds(n: number, min: number | undefined, max: number | undefined): boolean {
  return (min === undefined || n >= min) && (max === undefined || n <= max);
}

/** Checks one argument against one parameter. `fold`: compare enum values and keywords without case. */
export function checkParam(param: CatalogParam, value: string, fold: boolean): ParamCheck {
  // CatalogParam admits an absent type only together with undeclared+unchecked recovery.
  // No type is inferred here; matchSignatures carries the constraint to an unknown outcome.
  if(param.type===undefined)return {ok:true};
  const same = (a: string, b: string): boolean => (fold ? foldWord(a) === foldWord(b) : a === b);
  switch (param.type) {
    case 'string': {
      const length = codePoints(value);
      if (!inBounds(length, param.minLength, param.maxLength)) {
        return { ok: false, code: 'core.catalog.param_out_of_range', expected: `长度${boundsText(param.minLength, param.maxLength)}的字符串` };
      }
      return { ok: true };
    }
    case 'int': {
      if (!/^[+-]?[0-9]+$/.test(value)) return { ok: false, code: 'core.catalog.param_type_mismatch', expected: PARAM_TYPE_TEXT.int };
      const n = Number(value);
      if (!Number.isSafeInteger(n) || !inBounds(n, param.minimum, param.maximum)) {
        const bounds = boundsText(param.minimum, param.maximum);
        return { ok: false, code: 'core.catalog.param_out_of_range', expected: bounds ? `${bounds} 的整数` : '安全范围内的整数' };
      }
      return { ok: true };
    }
    case 'port': {
      if (!/^[0-9]+$/.test(value)) return { ok: false, code: 'core.catalog.param_type_mismatch', expected: PARAM_TYPE_TEXT.port };
      const n = Number(value);
      const min = Math.max(0, param.minimum ?? 0);
      const max = Math.min(65535, param.maximum ?? 65535);
      if (!inBounds(n, min, max)) return { ok: false, code: 'core.catalog.param_out_of_range', expected: `端口号 ${min}–${max}` };
      return { ok: true };
    }
    case 'enum': {
      const values = param.values ?? [];
      if (values.some((v) => same(v, value))) return { ok: true };
      return { ok: false, code: 'core.catalog.param_type_mismatch', expected: `以下取值之一：${values.join('、')}` };
    }
    case 'keyword': {
      const keyword = param.keyword ?? param.name;
      return same(keyword, value) ? { ok: true } : { ok: false, code: 'core.catalog.param_type_mismatch', expected: `关键字“${keyword}”` };
    }
    case 'ipv4':
      return parseIpv4(value) ? { ok: true } : { ok: false, code: 'core.catalog.param_type_mismatch', expected: PARAM_TYPE_TEXT.ipv4 };
    case 'ipv6':
      return isIpv6(value) ? { ok: true } : { ok: false, code: 'core.catalog.param_type_mismatch', expected: PARAM_TYPE_TEXT.ipv6 };
    case 'hostname':
    case 'ip_or_hostname': {
      const valid=param.type==='hostname'?isHostname(value):parseIpv4(value)!==undefined||isIpv6(value)||isHostname(value);
      if(!valid)return {ok:false,code:'core.catalog.param_type_mismatch',expected:PARAM_TYPE_TEXT[param.type]};
      if(!inBounds(codePoints(value),param.minLength,param.maxLength))return {ok:false,code:'core.catalog.param_out_of_range',expected:PARAM_TYPE_TEXT[param.type]+'；长度'+boundsText(param.minLength,param.maxLength)};
      return {ok:true};
    }
    case 'mask':
      return isMask(value) ? { ok: true } : { ok: false, code: 'core.catalog.param_type_mismatch', expected: `${PARAM_TYPE_TEXT.mask}（连续的 1 位）` };
  }
}
