import { parseRuntimeContract } from '../../../packs/workflow/case-compile/functions/runtime-contract.ts';
import { parseManifest } from '../../../packs/workflow/case-compile/functions/manifest.ts';
import { parseProfile } from '../../../packs/workflow/case-compile/functions/profile.ts';
import { missingProbes } from '../../../packs/workflow/case-compile/functions/probes.ts';
import { argumentsOf, jsonBytes, main, output, readJson, requireFact, summary } from './io.ts';
export function draftProbes(rawContract: unknown, rawProfile: unknown, manifest: unknown, build: string) {
  requireFact(build !== '' && build.trim() === build && !/[\r\n\u0000]/.test(build), '缺少锁定构建；用 --build 指定本次预订锁定的构建');
  const contract = parseRuntimeContract(rawContract); const beds = parseManifest(manifest);
  requireFact(contract.ok && beds.ok, '合约或清单无效；重新核验接入文档');
  const parsed = parseProfile(rawProfile, contract.contract, beds.beds);
  requireFact(parsed.ok, '配置或探测声明无效；核对座位、启用组合、设备命令角色、用途表和命名捕获规则');
  const profile = parsed.profile; const bed = beds.beds.find((v) => v.name === profile.bed)!;
  const pending = missingProbes(profile.probes ?? [], profile.seats);
  const probes = (profile.probes ?? []).map((probe) => {
    const seat = profile.seats.find((v) => v.object === probe.seat)!; const device = bed.devices.find((v) => v.name === seat.device)!;
    requireFact(seat.ordinal < profile.device_count, '座位序号超出预检设备数；重新核对只读预检和配置');
    const expected = probe.purpose === 'build' ? build : [...device.ipv4, ...device.ipv6].map((v) => v.address);
    return { ...probe, device: seat.device, ordinal: seat.ordinal, expected };
  });
  return { bed: profile.bed, build, contract_sha256: contract.contract.digest, probes, pending };
}
export function run(args: string[]): void {
  const { files, options } = argumentsOf(args, 3, ['--out', '--build']);
  const draft = draftProbes(readJson(files[0]!), readJson(files[1]!), readJson(files[2]!), options['--build'] ?? '');
  const bytes = jsonBytes(draft); output(options['--out'] ?? '', 'probes.draft.json', bytes); summary(draft.probes.length, bytes);
}
main(import.meta.url, run);
