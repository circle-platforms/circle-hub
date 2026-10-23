// The bed inventory document (test-bed-manifest@1), re-validated by this pack: beds, their devices with typed
// interface addresses, services and reserved ranges. Same shape as the test-bed pack's manifest (the inventory named
// document is shared); the parser here is this pack's own compact copy — pack functions may not import across packs
// (see README, Needs). Any problem refuses the whole document, each with its pointer and fix.
import FORMAT from '../tables/runtime-profile-format.json' with { type: 'json' };
import { isRecord } from './text.ts';

export const DEVICE_TYPES = FORMAT.manifest_device_types;
export type DeviceType = (typeof DEVICE_TYPES)[number];

export interface IfaceAddress {
  family: 'ipv4' | 'ipv6';
  address: string;
  value: bigint;
  prefix: number;
  /** The network address with the prefix, rendered in the family's format (the segment key). */
  subnet: string;
}

export interface ManifestDevice {
  name: string;
  type: DeviceType;
  product: string | null;
  installed: { build: string; base: string | null } | null;
  ipv4: IfaceAddress[];
  ipv6: IfaceAddress[];
}

export interface ManifestService {
  host: string;
  ip: string;
  proto: 'tcp' | 'udp';
  port: number;
}

export interface ManifestBed {
  name: string;
  devices: ManifestDevice[];
  services: ManifestService[];
  reserved: Array<{ family: 'ipv4' | 'ipv6'; addresses: bigint[]; text: string }>;
}

export interface Problem {
  pointer: string;
  message: string;
  fix: string;
}

export type ParsedManifest = { ok: true; beds: ManifestBed[] } | { ok: false; problems: Problem[] };

const LIMITS = { beds: 200, devices: 100, addressesPerFamily: 16, reserved: 4096 };
const BED_NAME = /^[a-z0-9-]{1,64}$/;
const DEVICE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function problem(pointer: string, message: string, fix: string): Problem {
  return { pointer, message, fix };
}

function parseV4(text: string): bigint | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255 || (part.length > 1 && part.startsWith('0'))) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

function renderV4(value: bigint): string {
  return [24, 16, 8, 0].map((shift) => Number((value >> BigInt(shift)) & 255n)).join('.');
}

function parseV6(text: string): bigint | null {
  if(text.includes('.')){const colon=text.lastIndexOf(':');if(colon<0)return null;const tail=parseV4(text.slice(colon+1));if(tail===null)return null;text=text.slice(0,colon+1)+((tail>>16n)&0xffffn).toString(16)+':'+(tail&0xffffn).toString(16);}
  if (!/^[0-9a-fA-F:]+$/.test(text)) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (side: string): number[] | null => {
    if (side === '') return [];
    const groups = side.split(':');
    const out: number[] = [];
    for (const group of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      out.push(Number(`0x${group}`));
    }
    return out;
  };
  const left = groupsOf(halves[0] ?? '');
  const right = halves.length === 2 ? groupsOf(halves[1] ?? '') : [];
  if (left === null || right === null) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 2 && missing === 0) || (halves.length === 1 && left.length !== 8)) return null;
  const groups = [...left, ...Array<number>(missing).fill(0), ...right];
  let value = 0n;
  for (const group of groups) value = (value << 16n) | BigInt(group);
  return value;
}

function renderV6(value: bigint): string {
  const groups: string[] = [];
  for (let shift = 112; shift >= 0; shift -= 16) groups.push(((value >> BigInt(shift)) & 0xffffn).toString(16));
  return groups.join(':');
}

function mask(family: 'ipv4' | 'ipv6', prefix: number): bigint {
  const bits = family === 'ipv4' ? 32n : 128n;
  return ((1n << bits) - 1n) ^ ((1n << (bits - BigInt(prefix))) - 1n);
}

/** Parses "address/prefix" into an interface address with its subnet; null when the text is not that. */
export function parseInterface(family: 'ipv4' | 'ipv6', text: string): IfaceAddress | null {
  const slash = text.indexOf('/');
  if (slash < 0) return null;
  const address = text.slice(0, slash);
  if (!/^\d{1,3}$/.test(text.slice(slash + 1))) return null;
  const prefix = Number(text.slice(slash + 1));
  const bits = family === 'ipv4' ? 32 : 128;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return null;
  const value = family === 'ipv4' ? parseV4(address) : parseV6(address);
  if (value === null) return null;
  const network = value & mask(family, prefix);
  const subnet = `${family === 'ipv4' ? renderV4(network) : renderV6(network)}/${prefix}`;
  return { family, address, value, prefix, subnet };
}

/** The bare address text (no prefix) as a bigint, for reserved ranges and services. */
export function addressValue(family: 'ipv4' | 'ipv6', text: string): bigint | null {
  return family === 'ipv4' ? parseV4(text) : parseV6(text);
}

/**
 * An address text as a numeric key (`<family>:<value>`), whatever its notation: 2001:DB8::10 and 2001:db8:0:0::10
 * key the same. Null when the text is no address. Every address comparison in this pack is by this key, never by string.
 */
export function addressKey(text: string): string | null {
  const v4 = addressValue('ipv4', text);
  if (v4 !== null) return `ipv4:${v4.toString(16)}`;
  const v6 = addressValue('ipv6', text);
  if(v6!==null&&(v6>>32n)===0xffffn)return `ipv4:${(v6&0xffffffffn).toString(16)}`;
  return v6 === null ? null : `ipv6:${v6.toString(16)}`;
}

function parseDevice(raw: unknown, at: string, problems: Problem[]): ManifestDevice | null {
  if (!isRecord(raw)) {
    problems.push(problem(at, '设备不是对象', '设备写成对象：name、type、ipv4、ipv6，按需 product、installed'));
    return null;
  }
  if (typeof raw.name !== 'string' || !DEVICE_NAME.test(raw.name)) {
    problems.push(problem(`${at}/name`, '设备名不对', '小写字母或数字开头，只用小写字母、数字、下划线和连字符，至多 64 个字符'));
    return null;
  }
  if (typeof raw.type !== 'string' || !(DEVICE_TYPES as readonly string[]).includes(raw.type)) {
    problems.push(problem(`${at}/type`, `设备 ${raw.name} 的类型 ${String(raw.type)} 不在 ${DEVICE_TYPES.join('、')} 里`, '按受支持的设备类型写'));
    return null;
  }
  let product: string | null = null;
  if (raw.product !== undefined && raw.product !== null) {
    if (typeof raw.product !== 'string' || raw.product.length > 100) problems.push(problem(`${at}/product`, `设备 ${raw.name} 的 product 不是字符串或超过 100 个字符`, 'product 写成短字符串或不写'));
    else product = raw.product;
  }
  let installed: ManifestDevice['installed'] = null;
  if (raw.installed !== undefined && raw.installed !== null) {
    if (!isRecord(raw.installed) || typeof raw.installed.build !== 'string' || raw.installed.build === '' || raw.installed.build.length > 200) {
      problems.push(problem(`${at}/installed`, `设备 ${raw.name} 的 installed 没有 build`, 'installed 写 {"build": "<构建名>", "base": "<基础构建>"}（base 可不写）'));
    } else {
      installed = { build: raw.installed.build, base: typeof raw.installed.base === 'string' && raw.installed.base !== '' ? raw.installed.base : null };
    }
  }
  const family = (key: 'ipv4' | 'ipv6'): IfaceAddress[] => {
    const out: IfaceAddress[] = [];
    const list = raw[key];
    if (!Array.isArray(list)) {
      problems.push(problem(`${at}/${key}`, `设备 ${raw.name} 没有 ${key} 数组`, `${key} 写接口地址数组（没有写 []），每项 "地址/前缀"`));
      return out;
    }
    if (list.length > LIMITS.addressesPerFamily) problems.push(problem(`${at}/${key}`, `设备 ${raw.name} 的 ${key} 超过 ${LIMITS.addressesPerFamily} 个`, '减少接口地址'));
    for (const [ai, item] of list.entries()) {
      if (typeof item !== 'string') {
        problems.push(problem(`${at}/${key}/${ai}`, '接口地址不是字符串', '接口地址写成 "地址/前缀"'));
        continue;
      }
      const parsed = parseInterface(key, item);
      if (parsed === null) problems.push(problem(`${at}/${key}/${ai}`, `接口地址 ${item} 不是合法的 ${key} "地址/前缀"`, '写成如 192.0.2.10/26 或 2001:db8:1::10/64'));
      else out.push(parsed);
    }
    return out;
  };
  return { name: raw.name, type: raw.type as DeviceType, product, installed, ipv4: family('ipv4'), ipv6: family('ipv6') };
}

/** Parses a test-bed-manifest@1 value; never throws. */
export function parseManifest(input: unknown): ParsedManifest {
  const problems: Problem[] = [];
  if (!isRecord(input)) return { ok: false, problems: [problem('', '清单不是对象', '按 test-bed-manifest@1 的形状写')] };
  if (input.schema !== 'test-bed-manifest@1') problems.push(problem('/schema', 'schema 不是 test-bed-manifest@1', 'schema 写 test-bed-manifest@1'));
  if (!Array.isArray(input.beds) || input.beds.length === 0) problems.push(problem('/beds', '清单没有台架数组', 'beds 写台架的非空数组'));
  if (Array.isArray(input.beds) && input.beds.length > LIMITS.beds) problems.push(problem('/beds', `台架超过 ${LIMITS.beds} 个`, '减少台架'));
  const beds: ManifestBed[] = [];
  const bedNames = new Set<string>();
  for (const [bi, rawBed] of (Array.isArray(input.beds) ? input.beds : []).entries()) {
    const at = `/beds/${bi}`;
    if (!isRecord(rawBed) || typeof rawBed.name !== 'string' || !BED_NAME.test(rawBed.name)) {
      problems.push(problem(`${at}/name`, '台架名不对', '台架名只用小写字母、数字和连字符，至多 64 个字符'));
      continue;
    }
    if (bedNames.has(rawBed.name)) problems.push(problem(at, `台架 ${rawBed.name} 重复`, '台架名不能重复'));
    bedNames.add(rawBed.name);
    const devices: ManifestDevice[] = [];
    if (!Array.isArray(rawBed.devices)) problems.push(problem(`${at}/devices`, `台架 ${rawBed.name} 没有设备数组`, 'devices 写设备数组'));
    else {
      if (rawBed.devices.length > LIMITS.devices) problems.push(problem(`${at}/devices`, `台架 ${rawBed.name} 的设备超过 ${LIMITS.devices} 台`, '减少设备'));
      const deviceNames = new Set<string>();
      const addressOwners = new Map<string, string>();
      rawBed.devices.forEach((rawDevice, di) => {
        const device = parseDevice(rawDevice, `${at}/devices/${di}`, problems);
        if (device === null) return;
        if (deviceNames.has(device.name)) problems.push(problem(`${at}/devices/${di}`, `设备 ${device.name} 重复`, '同一台架内设备名不能重复'));
        deviceNames.add(device.name);
        for (const iface of [...device.ipv4, ...device.ipv6]) {
          const key = `${iface.family}:${iface.value.toString(16)}`;
          const held = addressOwners.get(key);
          if (held !== undefined) problems.push(problem(`${at}/devices/${di}`, `地址 ${iface.address} 同时属于 ${held} 和 ${device.name}`, '同一台架内一个地址只能属于一台设备'));
          else addressOwners.set(key, device.name);
        }
        devices.push(device);
      });
    }
    const services: ManifestService[] = [];
    if (rawBed.services === undefined) problems.push(problem(`${at}/services`, '缺少 services 数组', '没有服务也要写 services: []'));
    if (rawBed.services !== undefined) {
      if (!Array.isArray(rawBed.services)) problems.push(problem(`${at}/services`, `台架 ${rawBed.name} 的 services 不是数组`, 'services 写 {host, ip, proto, port} 的数组'));
      else {
        for (const [si, rawService] of rawBed.services.entries()) {
          const sat = `${at}/services/${si}`;
          if (!isRecord(rawService) || typeof rawService.host !== 'string' || typeof rawService.ip !== 'string') {
            problems.push(problem(sat, '服务不是 {host, ip, proto, port}', '服务写成 {"host": "<设备名>", "ip": "<地址>", "proto": "tcp", "port": 80}'));
            continue;
          }
          const host = devices.find((device) => device.name === rawService.host);
          if (host === undefined) problems.push(problem(`${sat}/host`, `服务的主机 ${rawService.host} 不是这台架的设备`, 'host 写这台架 devices 里的设备名'));
          const onHost = host !== undefined && [...host.ipv4, ...host.ipv6].some((iface) => addressKey(iface.address) === addressKey(rawService.ip as string));
          if (host !== undefined && !onHost) problems.push(problem(`${sat}/ip`, `服务的地址 ${rawService.ip} 不是 ${rawService.host} 的接口地址`, 'ip 写该设备的接口地址（不带前缀）'));
          const proto = rawService.proto === 'udp' ? 'udp' : rawService.proto === 'tcp' ? 'tcp' : null;
          if (proto === null) problems.push(problem(`${sat}/proto`, `服务的协议 ${String(rawService.proto)} 不是 tcp 或 udp`, 'proto 写 tcp 或 udp'));
          const port = typeof rawService.port === 'number' && Number.isInteger(rawService.port) && rawService.port >= 1 && rawService.port <= 65535 ? rawService.port : null;
          if (port === null) problems.push(problem(`${sat}/port`, `服务的端口 ${String(rawService.port)} 不是 1 到 65535 的整数`, 'port 写 1 到 65535 的整数'));
          if (host !== undefined && proto !== null && port !== null) services.push({ host: rawService.host, ip: rawService.ip, proto, port });
        }
      }
    }
    const reserved: ManifestBed['reserved'] = [];
    if (rawBed.reserved === undefined) problems.push(problem(`${at}/reserved`, '缺少 reserved 数组', '没有保留段也要写 reserved: []'));
    if (rawBed.reserved !== undefined) {
      if (!Array.isArray(rawBed.reserved)) problems.push(problem(`${at}/reserved`, `台架 ${rawBed.name} 的 reserved 不是数组`, 'reserved 写 "起始地址-结束地址" 的数组'));
      else {
        for (const [ri, item] of rawBed.reserved.entries()) {
          const rat = `${at}/reserved/${ri}`;
          if (typeof item !== 'string' || !/^[^-\s]+-[^-\s]+$/.test(item)) {
            problems.push(problem(rat, `保留段 ${String(item)} 不是 "起始地址-结束地址"`, '保留段写成 "起始地址-结束地址"'));
            continue;
          }
          const [startText, endText] = item.split('-', 2);
          const family: 'ipv4' | 'ipv6' = startText.includes(':') ? 'ipv6' : 'ipv4';
          const start = addressValue(family, startText);
          const end = addressValue(family, endText);
          if (start === null || end === null) {
            problems.push(problem(rat, `保留段 ${item} 的地址不是合法的 ${family} 地址`, '保留段两端写同一地址族的地址'));
            continue;
          }
          if (start > end) {
            problems.push(problem(rat, `保留段 ${item} 的起点大于终点`, '把保留段写成正序'));
            continue;
          }
          if (end - start + 1n > BigInt(LIMITS.reserved)) {
            problems.push(problem(rat, `保留段 ${item} 超过 ${LIMITS.reserved} 个地址`, '把保留段划小'));
            continue;
          }
          const inside = devices.some((device) => [...device.ipv4, ...device.ipv6].some((iface) => iface.family === family && (start & mask(family, iface.prefix)) === (iface.value & mask(family, iface.prefix)) && (end & mask(family, iface.prefix)) === (iface.value & mask(family, iface.prefix))));
          if (!inside) { problems.push(problem(rat, '保留段不在台架任何网段里', '保留段两端必须在台架的同一个网段内')); continue; }
          const addresses: bigint[] = [];
          for (let value = start; value <= end; value += 1n) addresses.push(value);
          reserved.push({ family, addresses, text: item });
        }
      }
    }
    beds.push({ name: rawBed.name, devices, services, reserved });
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, beds };
}
