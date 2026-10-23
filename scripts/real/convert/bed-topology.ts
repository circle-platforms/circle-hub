import { isIP } from 'node:net';
import { parseInterface, parseIp, subnetContains } from '../../../packs/workflow/test-bed/functions/addresses.ts';
import { readFileSync } from 'node:fs';
import { parseManifest, type DeviceType } from '../../../packs/workflow/test-bed/functions/manifest.ts';
import { parseManifest as parseCompileManifest } from '../../../packs/workflow/case-compile/functions/manifest.ts';
import { argumentsOf, jsonBytes, main, output, record, requireFact, sha256 } from './io.ts';
// Source label translation, derived from the gateway topology format; no device-name inference.
const SOURCE_LABELS: Readonly<Record<string, DeviceType>> = { '负载均衡': 'load-balancer', '路由器': 'router', '客户端': 'client', '服务器': 'server', '控制台': 'console' };
const SERVICE_PROTOCOLS: Readonly<Record<string, 'tcp' | 'udp'>> = { http: 'tcp', https: 'tcp', dns: 'udp' };
export function topologyReport(raw: unknown) {
  requireFact(record(raw) && record(raw.topology), '缺少 topology；重新只读取得完整拓扑回答');
  const topology = raw.topology;
  requireFact(record(topology._bed) && typeof topology._bed.conf === 'string', '缺少 topology._bed.conf；重新取得带台架身份的回答');
  requireFact(Array.isArray(topology.devices) && topology.devices.length, '缺少 topology.devices；重新取得设备接口事实');
  requireFact(Array.isArray(raw.services), '缺少 services；重新只读取得带服务列表的拓扑回答');
  requireFact(record(raw.observation) && record(raw.observation.unregistered_neighbours), '缺少 observation.unregistered_neighbours；重新取得邻居观察');
  const devices = topology.devices.map((device: unknown) => {
    requireFact(record(device) && typeof device.name === 'string', '设备缺少名字；重新取得完整拓扑');
    requireFact(typeof device.type === 'string' && Object.hasOwn(SOURCE_LABELS, device.type), '设备标签不认识；先核对源标签映射，禁止猜测设备类型');
    requireFact(device._mask_assumed !== true && (device._mask_assumed === undefined || device._mask_assumed === false), '接口掩码是假定或标志无效；先只读取得真实接口前缀');
    requireFact(Array.isArray(device.ipv4) && Array.isArray(device.ipv6), '缺少地址族列表；补取接口地址和前缀');
    for (const address of [...device.ipv4, ...device.ipv6]) requireFact(typeof address === 'string' && address.includes('/'), '接口地址没有前缀；先只读取得真实掩码，不使用默认掩码');
    return { name: device.name.toLowerCase(), type: SOURCE_LABELS[device.type]!, ipv4: device.ipv4, ipv6: device.ipv6 };
  });
  const reserved = new Set<string>(); const ignored = new Set<string>();
  const subnets = devices.flatMap(d => d.ipv4.map(address => { const parsed = parseInterface(address); requireFact(parsed && parsed.family === 4, '设备 IPv4 接口不合法；重新取得完整接口事实'); return parsed.subnet; }));
  for (const neighbours of Object.values(raw.observation.unregistered_neighbours)) {
    requireFact(Array.isArray(neighbours) && neighbours.every((ip) => typeof ip === 'string'), '邻居观察不是地址列表；重新取得完整邻居观察');
    for (const ip of neighbours) {
      requireFact(isIP(ip) === 4, 'observation.unregistered_neighbours 包含非 IPv4 文字；重新只读取得 ARP 观察');
      const value = parseIp(ip)!; if (subnets.some(subnet => subnetContains(subnet, value))) reserved.add(`${ip}-${ip}`); else ignored.add(ip);
    }
  }
  const protocols: Record<string, number> = { http: 0, https: 0, dns: 0 };
  const services = raw.services.map((service: unknown, index: number) => {
    requireFact(record(service) && typeof service.host === 'string', '服务缺少 host；重新取得完整服务事实');
    requireFact(typeof service.proto === 'string' && Object.hasOwn(SERVICE_PROTOCOLS, service.proto), `services/${index}/proto 不在源协议对照表；请管理员核对这个服务的协议后重跑，不猜协议`);
    protocols[service.proto]++;
    return { host: service.host.toLowerCase(), ip: service.ip, proto: SERVICE_PROTOCOLS[service.proto], port: service.port };
  });
  const manifest = { schema: 'test-bed-manifest@1', beds: [{ name: topology._bed.conf.toLowerCase(), devices, services, reserved: [...reserved] }] };
  const bed = parseManifest(manifest); const compile = parseCompileManifest(manifest);
  requireFact(bed.ok && compile.ok, '清单未同时通过两个包：核对名字冲突、地址重复、前缀、服务和保留地址所属网段；补取并改正源事实后重跑');
  return { manifest, protocols, ignored_neighbours: [...ignored] };
}
export function convertTopology(raw: unknown) { return topologyReport(raw).manifest; }
export function run(args: string[]): void {
  const { files, options } = argumentsOf(args, 1, ['--out']); const bytes = readFileSync(files[0]!);
  const report = topologyReport(JSON.parse(bytes.toString('utf8'))); const { manifest } = report;
  output(options['--out'] ?? '', 'test-bed-manifest.json', jsonBytes(manifest));
  output(options['--out'] ?? '', 'topology-accounting.json', jsonBytes({ ignored_neighbours: report.ignored_neighbours }));
  process.stdout.write(JSON.stringify({ count: manifest.beds[0]!.devices.length, sha256: sha256(bytes), services: report.protocols, reserved: manifest.beds[0]!.reserved.length, ignored_neighbours: report.ignored_neighbours.length }) + '\n');
  process.stdout.write('circle-hub doc put bed-topology test-bed-manifest.json\n');
}
main(import.meta.url, run);
