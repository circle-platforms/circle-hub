// parseManifest: the admin-uploaded bed manifest (test-bed-manifest@1), every problem listed at once with a JSON
// pointer, a Chinese sentence and a fix; the normalized model on success. Total: any input answers, nothing throws.
// The address rules live in addresses.ts; this file owns the manifest's shape.
import { isRecord } from './common.ts';
import { expandRange, formatIp, parseInterface, parseIp, parseIpv4ish, parseSubnet, subnetContains, type Family, type Subnet } from './addresses.ts';

export const DEVICE_TYPES = ['load-balancer', 'router', 'client', 'server', 'console'] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];
export const DEVICE_TYPE_LABEL: Record<DeviceType, string> = {
  'load-balancer': '负载均衡',
  router: '路由器',
  client: '客户端',
  server: '服务器',
  console: '控制台',
};

export const LIMITS = {
  maxBeds: 200,
  maxDevicesPerBed: 100,
  maxAddressesPerDevice: 16,
  maxBytes: 2 * 1024 * 1024,
} as const;

export const PROTOCOLS = ['tcp', 'udp'] as const;

export interface InterfaceAddress {
  family: Family;
  /** The interface address (host bits set). */
  address: string;
  value: bigint;
  /** The segment the address sits in (the parsed subnet text). */
  subnet: string;
}

export interface ManifestDevice {
  name: string;
  type: DeviceType;
  /** Free string, carried verbatim (which product line the device belongs to); null when absent. */
  product: string | null;
  /** The build the manifest declares the device holds (build required, base its base build when it has another name);
   * a declaration, never checked against the device (阶段 1; observations come with the executor). Absent: no record. */
  installed?: { build: string; base: string | null } | null;
  ipv4: InterfaceAddress[];
  ipv6: InterfaceAddress[];
}

export interface ManifestService {
  host: string;
  ip: string;
  proto: 'tcp' | 'udp';
  port: number;
}

export interface ReservedRange {
  /** The range as written, "start-end". */
  range: string;
  start: string;
  end: string;
  /** The addresses of the range (bounded; a range larger than the bound is refused at parse time). */
  addresses: bigint[];
}

export interface BaselineEntry {
  id: string;
  values: Record<string, string>;
}

export interface ManifestBed {
  name: string;
  devices: ManifestDevice[];
  services: ManifestService[];
  reserved: ReservedRange[];
  /** Declared config the bed is supposed to hold. Absent in the document means an empty list. */
  baseline: BaselineEntry[];
}

export interface ManifestProblem {
  /** JSON pointer of the offending part; '' for the whole document. */
  pointer: string;
  /** What is wrong, in Chinese. */
  message: string;
  /** How to fix it, in Chinese. */
  fix: string;
}

export type ParsedManifest = { ok: true; beds: ManifestBed[] } | { ok: false; problems: ManifestProblem[] };

const BED_NAME = /^[a-z0-9-]{1,64}$/;
const DEVICE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RANGE = /^[^-\s]+-[^-\s]+$/;

const pointer = (parts: ReadonlyArray<string | number>): string => (parts.length === 0 ? '' : `/${parts.join('/')}`);

/** parseManifest of an unknown value; total for every input. */
export function parseManifest(input: unknown): ParsedManifest {
  const problems: ManifestProblem[] = [];
  // Overall size first: a document over the limit is refused as a whole.
  let size = 0;
  try {
    size = JSON.stringify(input)?.length ?? 0;
  } catch {
    problems.push({ pointer: '', message: '清单不是能序列化的 JSON（可能有循环引用）', fix: '上传一份普通的 JSON 文档' });
    return { ok: false, problems };
  }
  if (size > LIMITS.maxBytes) {
    problems.push({ pointer: '', message: `清单 ${size} 字节，超过上限 ${LIMITS.maxBytes} 字节（2 MiB）`, fix: '拆成几份清单，或删掉不需要的内容' });
    return { ok: false, problems };
  }
  if (!isRecord(input)) {
    problems.push({ pointer: '', message: '清单必须是一个 JSON 对象', fix: '上传 { "schema": "test-bed-manifest@1", "beds": [...] }' });
    return { ok: false, problems };
  }
  if (input.schema !== 'test-bed-manifest@1') {
    problems.push({ pointer: '/schema', message: `schema 要写成 "test-bed-manifest@1"，收到 ${JSON.stringify(String(input.schema ?? ''))}`, fix: '把 schema 字段改成 "test-bed-manifest@1"' });
  }
  if (!Array.isArray(input.beds)) {
    if (!('beds' in input)) {
      problems.push({ pointer: '/beds', message: '清单没有 beds 列表', fix: '写一个 beds 数组，每项一个台架' });
    } else {
      problems.push({ pointer: '/beds', message: 'beds 必须是一个数组', fix: '把 beds 写成数组，每项一个台架' });
    }
    return { ok: false, problems };
  }
  if (input.beds.length > LIMITS.maxBeds) {
    problems.push({ pointer: '/beds', message: `清单里有 ${input.beds.length} 个台架，超过上限 ${LIMITS.maxBeds}`, fix: '一份清单至多 200 个台架，请拆分' });
    return { ok: false, problems };
  }
  const beds: ManifestBed[] = [];
  const bedNames = new Set<string>();
  input.beds.forEach((rawBed, bedAt): void => {
    const bedPointer = pointer(['beds', bedAt]);
    if (!isRecord(rawBed)) {
      problems.push({ pointer: bedPointer, message: '台架必须是一个对象', fix: `第 ${bedAt + 1} 个台架写成 { "name": …, "devices": […] }` });
      return;
    }
    const name = typeof rawBed.name === 'string' ? rawBed.name : '';
    if (!BED_NAME.test(name)) {
      problems.push({ pointer: `${bedPointer}/name`, message: `台架名 ${JSON.stringify(name)} 不合规矩：小写字母、数字和连字符，1 到 64 个字符`, fix: '用 bed-a 这样的名字' });
    } else if (bedNames.has(name)) {
      problems.push({ pointer: `${bedPointer}/name`, message: `台架名 ${name} 在清单里重复出现`, fix: '每个台架一个名字，重复的条目请删除' });
    } else {
      bedNames.add(name);
    }
    if (!Array.isArray(rawBed.devices)) {
      problems.push({ pointer: `${bedPointer}/devices`, message: '台架的 devices 必须是一个数组', fix: '把 devices 写成数组，每项一台设备' });
      return;
    }
    if (rawBed.devices.length > LIMITS.maxDevicesPerBed) {
      problems.push({ pointer: `${bedPointer}/devices`, message: `台架 ${name || bedAt} 有 ${rawBed.devices.length} 台设备，超过上限 ${LIMITS.maxDevicesPerBed}`, fix: '一个台架至多 100 台设备' });
      return;
    }
    // Devices, addresses; duplicate detection within the bed.
    const devices: ManifestDevice[] = [];
    const deviceNames = new Set<string>();
    const addressOwner = new Map<string, string>(); // family:value → first owner's pointer
    rawBed.devices.forEach((rawDevice, deviceAt): void => {
      const devicePointer = pointer(['beds', bedAt, 'devices', deviceAt]);
      if (!isRecord(rawDevice)) {
        problems.push({ pointer: devicePointer, message: '设备必须是一个对象', fix: `第 ${deviceAt + 1} 台设备写成 { "name": …, "type": …, "ipv4": […], "ipv6": […] }` });
        return;
      }
      const dName = typeof rawDevice.name === 'string' ? rawDevice.name : '';
      if (!DEVICE_NAME.test(dName)) {
        problems.push({ pointer: `${devicePointer}/name`, message: `设备名 ${JSON.stringify(dName)} 不合规矩：小写字母开头，小写字母、数字、_ 和 -，最长 64 个字符`, fix: '用 afamx0、router0 这样的名字' });
      } else if (deviceNames.has(dName)) {
        problems.push({ pointer: `${devicePointer}/name`, message: `设备名 ${dName} 在台架 ${name || bedAt} 里重复出现`, fix: '每台设备一个名字' });
      } else {
        deviceNames.add(dName);
      }
      const type = rawDevice.type;
      if (typeof type !== 'string' || !(DEVICE_TYPES as readonly string[]).includes(type)) {
        problems.push({ pointer: `${devicePointer}/type`, message: `设备类型 ${JSON.stringify(String(type ?? ''))} 不在五种里（${DEVICE_TYPES.map((t) => DEVICE_TYPE_LABEL[t]).join('、')}）`, fix: `type 写 ${DEVICE_TYPES.join('、')} 之一` });
      }
      const product = typeof rawDevice.product === 'string' ? rawDevice.product : null;
      if (product !== null && product.length > 100) {
        problems.push({ pointer: `${devicePointer}/product`, message: 'product 至多 100 个字符', fix: '缩短或删掉 product' });
      }
      let installed: ManifestDevice['installed'] = null;
      const installedRaw = rawDevice.installed;
      if (installedRaw !== undefined && installedRaw !== null) {
        if (!isRecord(installedRaw)) {
          problems.push({ pointer: `${devicePointer}/installed`, message: 'installed 必须是一个对象', fix: '写 { "build": "Rel_FAMX_10_6_1_8" }（可选 "base"：这个构建基于的基础构建）' });
        } else {
          const build = typeof installedRaw.build === 'string' ? installedRaw.build : '';
          const baseRaw = installedRaw.base;
          const base = baseRaw === undefined || baseRaw === null ? null : baseRaw;
          if (build === '' || build.length > 200) {
            problems.push({ pointer: `${devicePointer}/installed/build`, message: `installed.build 要写 1 到 200 个字符的构建名，收到 ${JSON.stringify(installedRaw.build ?? '')}`, fix: '例如 "Rel_FAMX_10_6_1_8"' });
          }
          if (base !== null && (typeof base !== 'string' || base === '' || base.length > 200)) {
            problems.push({ pointer: `${devicePointer}/installed/base`, message: `installed.base 要写构建名（这个构建基于的基础构建），收到 ${JSON.stringify(baseRaw ?? '')}`, fix: '例如 FAMY 构建基于的 FAMX 构建名；没有就删掉 base' });
          }
          if (build !== '' && build.length <= 200 && (base === null || (typeof base === 'string' && base !== '' && base.length <= 200))) {
            installed = { build, base: base as string | null };
          }
        }
      }
      const readAddresses = (family: Family, key: 'ipv4' | 'ipv6'): InterfaceAddress[] => {
        const raw = rawDevice[key];
        const at = `${devicePointer}/${key}`;
        if (raw === undefined || raw === null) {
          problems.push({ pointer: at, message: `设备没有 ${key} 列表`, fix: `写 "${key}": []（没有地址就写空列表）` });
          return [];
        }
        if (!Array.isArray(raw)) {
          problems.push({ pointer: at, message: `${key} 必须是一个数组`, fix: `把 ${key} 写成数组，每项 "地址/前缀"` });
          return [];
        }
        if (raw.length > LIMITS.maxAddressesPerDevice) {
          problems.push({ pointer: at, message: `设备的 ${key} 有 ${raw.length} 项，超过上限 ${LIMITS.maxAddressesPerDevice}`, fix: '每台设备每个地址族至多 16 个接口地址' });
          return [];
        }
        const out: InterfaceAddress[] = [];
        const seenOnDevice = new Set<string>();
        raw.forEach((entry, entryAt): void => {
          const entryAtPointer = `${at}/${entryAt}`;
          if (typeof entry !== 'string') {
            problems.push({ pointer: entryAtPointer, message: '接口地址必须是 "地址/前缀" 的字符串', fix: '例如 "192.0.2.10/26" 或 "2001:db8:1::10/64"' });
            return;
          }
          const iface = parseInterface(entry);
          if (iface === null) {
            const slash = entry.lastIndexOf('/');
            const addressPart = slash > 0 ? entry.slice(0, slash) : entry;
            if (parseIp(addressPart) === null) {
              problems.push({ pointer: entryAtPointer, message: `${JSON.stringify(entry)} 不是合法的 ${family === 4 ? 'IPv4 点分十进制' : 'IPv6 压缩写法'}地址`, fix: family === 4 ? '写成 192.0.2.10/26 这样：四组 0-255 的十进制数' : '写成 2001:db8:1::10/64 这样：压缩写法' });
            } else {
              problems.push({ pointer: entryAtPointer, message: `${JSON.stringify(entry)} 的前缀不对`, fix: family === 4 ? '前缀写 0-32 的整数' : '前缀写 0-128 的整数' });
            }
            return;
          }
          if (iface.family !== family) {
            problems.push({ pointer: entryAtPointer, message: `${JSON.stringify(entry)} 是 ${iface.family === 4 ? 'IPv4' : 'IPv6'} 地址，不能放在 ${key} 里`, fix: iface.family === 4 ? '把它放到 ipv4 列表里' : '把它放到 ipv6 列表里' });
            return;
          }
          const value = iface.address;
          const key2 = `${family}:${value}`;
          if (seenOnDevice.has(key2)) {
            problems.push({ pointer: entryAtPointer, message: `同一地址 ${formatIp(family, value)} 在设备 ${dName || deviceAt} 上写了两次`, fix: '删掉重复的一项' });
            return;
          }
          seenOnDevice.add(key2);
          const owner = addressOwner.get(key2);
          if (owner !== undefined) {
            problems.push({ pointer: entryAtPointer, message: `地址 ${formatIp(family, value)} 同时属于设备 ${owner} 和设备 ${dName || deviceAt}`, fix: '同一台架里一个地址只能属于一台设备，请改正其中一处' });
            return;
          }
          addressOwner.set(key2, dName || `#${deviceAt}`);
          out.push({ family, address: formatIp(family, value), value, subnet: `${formatIp(family, iface.subnet.address)}/${iface.subnet.prefix}` });
        });
        return out;
      };
      devices.push({
        name: dName,
        type: (DEVICE_TYPES as readonly string[]).includes(type as string) ? (type as DeviceType) : 'client',
        product,
        installed,
        ipv4: readAddresses(4, 'ipv4'),
        ipv6: readAddresses(6, 'ipv6'),
      });
      // A device no interface address at all cannot be reached on the bed: refuse it at import (task hub-pack-findings 9).
      const pushed = devices[devices.length - 1];
      if (pushed.ipv4.length === 0 && pushed.ipv6.length === 0) {
        problems.push({ pointer: devicePointer, message: `设备 ${dName || deviceAt} 没有接口地址（ipv4 和 ipv6 都是空的），上台架后无法访问`, fix: '至少写一个接口地址，例如 "ipv4": ["192.0.2.10/26"]；没有地址的占位设备请从清单里删掉' });
      }
    });
    // Services.
    const services: ManifestService[] = [];
    const rawServices = rawBed.services;
    if (rawServices === undefined || rawServices === null) {
      problems.push({ pointer: `${bedPointer}/services`, message: '台架没有 services 列表', fix: '写 "services": []（没有服务就写空列表）' });
    } else if (!Array.isArray(rawServices)) {
      problems.push({ pointer: `${bedPointer}/services`, message: 'services 必须是一个数组', fix: '把 services 写成数组，每项 { "host": …, "ip": …, "proto": …, "port": … }' });
    } else {
      const byName = new Map(devices.map((d) => [d.name, d]));
      rawServices.forEach((rawService, serviceAt): void => {
        const at = pointer(['beds', bedAt, 'services', serviceAt]);
        if (!isRecord(rawService)) {
          problems.push({ pointer: at, message: '服务必须是一个对象', fix: '写成 { "host": "server0", "ip": "192.0.2.90", "proto": "tcp", "port": 80 }' });
          return;
        }
        const host = typeof rawService.host === 'string' ? rawService.host : '';
        const ip = typeof rawService.ip === 'string' ? rawService.ip : '';
        const proto = rawService.proto;
        const port = rawService.port;
        const device = byName.get(host);
        if (device === undefined) {
          problems.push({ pointer: `${at}/host`, message: `服务的 host ${JSON.stringify(host)} 不是台架 ${name || bedAt} 里的设备`, fix: 'host 写该台架 devices 里的一个设备名' });
        }
        const parsedIp = parseIp(ip);
        if (parsedIp === null) {
          problems.push({ pointer: `${at}/ip`, message: `服务的 ip ${JSON.stringify(ip)} 不是合法地址`, fix: '写设备的接口地址（不带前缀）' });
        } else if (device !== undefined && ![...device.ipv4, ...device.ipv6].some((a) => a.value === parsedIp)) {
          problems.push({ pointer: `${at}/ip`, message: `服务的 ip ${ip} 不是设备 ${host} 的接口地址`, fix: `从设备 ${host} 的 ipv4/ipv6 列表里选一个地址（不带前缀）` });
        }
        if (proto !== 'tcp' && proto !== 'udp') {
          problems.push({ pointer: `${at}/proto`, message: `proto 要写 tcp 或 udp，收到 ${JSON.stringify(String(proto ?? ''))}`, fix: 'proto 写 "tcp" 或 "udp"' });
        }
        if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
          problems.push({ pointer: `${at}/port`, message: `端口要写 1 到 65535 的整数，收到 ${JSON.stringify(String(port ?? ''))}`, fix: 'port 写 1-65535 的整数' });
        }
        if (device !== undefined && parsedIp !== null && (proto === 'tcp' || proto === 'udp') && typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535) {
          services.push({ host, ip: formatIp(parseIpv4ish(ip) ? 4 : 6, parsedIp), proto, port });
        }
      });
    }
    // Reserved ranges.
    const reserved: ReservedRange[] = [];
    const rawReserved = rawBed.reserved;
    if (rawReserved === undefined || rawReserved === null) {
      problems.push({ pointer: `${bedPointer}/reserved`, message: '台架没有 reserved 列表', fix: '写 "reserved": []（没有保留段就写空列表）' });
    } else if (!Array.isArray(rawReserved)) {
      problems.push({ pointer: `${bedPointer}/reserved`, message: 'reserved 必须是一个数组', fix: '把 reserved 写成数组，每项 "起始地址-结束地址"' });
    } else {
      const segments = new Set<string>();
      for (const device of devices) for (const a of [...device.ipv4, ...device.ipv6]) segments.add(a.subnet);
      const parsedSegments: Subnet[] = [];
      for (const text of segments) {
        const s = parseSubnet(text);
        if (s !== null) parsedSegments.push(s);
      }
      rawReserved.forEach((entry, entryAt): void => {
        const at = pointer(['beds', bedAt, 'reserved', entryAt]);
        if (typeof entry !== 'string' || !RANGE.test(entry)) {
          problems.push({ pointer: at, message: `保留段要写成 "起始地址-结束地址"，收到 ${JSON.stringify(String(entry ?? ''))}`, fix: '例如 "192.0.2.1-192.0.2.9"' });
          return;
        }
        const dash = entry.indexOf('-');
        const startText = entry.slice(0, dash);
        const endText = entry.slice(dash + 1);
        const start = parseIp(startText);
        const end = parseIp(endText);
        if (start === null || end === null) {
          problems.push({ pointer: at, message: `保留段 ${JSON.stringify(entry)} 的地址写法不合法`, fix: '两端都写合法的 IPv4 或 IPv6 地址' });
          return;
        }
        if ((parseIpv4ish(startText) ? 4 : 6) !== (parseIpv4ish(endText) ? 4 : 6)) {
          problems.push({ pointer: at, message: `保留段 ${JSON.stringify(entry)} 两端是不同的地址族`, fix: '一段保留区间的两端用同一个地址族' });
          return;
        }
        if (start > end) {
          problems.push({ pointer: at, message: `保留段 ${JSON.stringify(entry)} 的起点大于终点`, fix: '把小的地址写在前面' });
          return;
        }
        const family: Family = parseIpv4ish(startText) ? 4 : 6;
        let inside = false;
        for (const segment of parsedSegments) {
          if (segment.family === family && subnetContains(segment, start) && subnetContains(segment, end)) {
            inside = true;
            break;
          }
        }
        if (!inside) {
          problems.push({ pointer: at, message: `保留段 ${JSON.stringify(entry)} 不落在台架 ${name || bedAt} 的任何网段里`, fix: '保留段要落在某台设备的接口地址所在网段内' });
          return;
        }
        const addresses = [...expandRange(startText, endText, 4096)];
        if (addresses.length === 0 && start === end) {
          addresses.push(start);
        }
        reserved.push({ range: entry, start: formatIp(family, start), end: formatIp(family, end), addresses });
      });
    }
    const baseline: BaselineEntry[] = [];
    const rawBaseline = rawBed.baseline;
    if (rawBaseline !== undefined && rawBaseline !== null) {
      if (!Array.isArray(rawBaseline)) {
        problems.push({ pointer: `${bedPointer}/baseline`, message: 'baseline 必须是一个数组', fix: '把 baseline 写成数组，每项 { "id": …, "values": { … } }；没有基线配置就删掉 baseline' });
      } else if (rawBaseline.length > 64) {
        problems.push({ pointer: `${bedPointer}/baseline`, message: `基线配置有 ${rawBaseline.length} 项，超过上限 64`, fix: '一份台架的基线配置至多 64 项' });
      } else {
        const ids = new Set<string>();
        rawBaseline.forEach((entry, entryAt): void => {
          const at = pointer(['beds', bedAt, 'baseline', entryAt]);
          if (!isRecord(entry)) {
            problems.push({ pointer: at, message: '基线配置必须是一个对象', fix: '写成 { "id": "pool", "values": { "mode": "off" } }' });
            return;
          }
          const id = typeof entry.id === 'string' ? entry.id : '';
          if (!DEVICE_NAME.test(id)) {
            problems.push({ pointer: `${at}/id`, message: `基线配置的 id ${JSON.stringify(id)} 不合规矩：小写字母开头，小写字母、数字、_ 和 -，最长 64 个字符`, fix: '用 pool 这样的 id' });
          } else if (ids.has(id)) {
            problems.push({ pointer: `${at}/id`, message: `基线配置 id ${id} 在台架 ${name || bedAt} 里重复`, fix: '每个 id 只写一项' });
          } else {
            ids.add(id);
          }
          const values = entry.values;
          if (!isRecord(values)) {
            problems.push({ pointer: `${at}/values`, message: '基线配置的 values 必须是一个对象', fix: '写成 { "mode": "off" } 这样的字符串字段' });
            return;
          }
          const fields = Object.keys(values);
          if (fields.length === 0 || fields.length > 16) {
            problems.push({ pointer: `${at}/values`, message: `基线配置 ${id || entryAt} 要有 1 到 16 个字段，收到 ${fields.length} 个`, fix: '每个字段一个字符串值' });
            return;
          }
          const parsed: Record<string, string> = {};
          for (const field of fields) {
            if (!/^[a-z][a-z0-9_]{0,63}$/.test(field)) {
              problems.push({ pointer: `${at}/values/${field}`, message: `字段名 ${JSON.stringify(field)} 不合规矩：小写字母开头，小写字母、数字和 _，最长 64 个字符`, fix: '用 mode 这样的字段名' });
              continue;
            }
            const value = values[field];
            if (typeof value !== 'string' || value.length > 200) {
              problems.push({ pointer: `${at}/values/${field}`, message: '基线字段的值必须是至多 200 个字符的字符串', fix: '把该字段写成字符串' });
              continue;
            }
            parsed[field] = value;
          }
          if (Object.keys(parsed).length === fields.length && DEVICE_NAME.test(id)) baseline.push({ id, values: parsed });
        });
      }
    }
    beds.push({
      name,
      devices: devices.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      services,
      reserved,
      baseline: baseline.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    });
  });
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, beds: beds.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) };
}
