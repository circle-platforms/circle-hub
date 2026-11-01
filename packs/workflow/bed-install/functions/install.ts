// The install check (pack function, applies item): the uploaded install request is what the Hub will hand to the bed, so it
// is checked from frozen facts only.
// - the request is exactly {schema, build, image} and the image names the build the way InfoTest's upgrade case reads it
//   (common.ts imageVersion; the same reading of the build name is what the case compares show version with);
// - the submission's reason names the same build;
// - the run's predecessor holds every device of the bed (the frozen lease rows of bed/ at the start of the run);
// - the run is locked to a build: the build the devices run now, which the dispatch probes on every device before sending.
// Support carries the dispatch fact the executor binds: request digest, the upgrade cases, bed, manifest, locked build,
// predecessor. Nothing here proves the image exists in the build repository or installs on the devices.
import type { Reason, Verdict } from '../../../../contracts/generated/vocabulary.ts';
import { GENERATOR, imageVersion, isRecord, readRequest, readTable, versionOfBuild } from './common.ts';
import { groupFrom, type InstallSubject } from './subject.ts';

type CheckReason = Extract<Reason, 'check_error' | 'missing_input'>;

export interface Outcome {
  verdict: Extract<Verdict, 'support' | 'refute' | 'unknown'>;
  code?: string;
  reason?: CheckReason;
  missing?: string;
  statement: string;
  grounds: string[];
  tier: 'blocking';
  item?: string;
  data?: Record<string, unknown>;
}

const TIER = 'blocking' as const;

/** The subject as functions/subject.ts built it; anything else reads as an empty subject. */
function subjectOf(value: unknown): InstallSubject {
  if (!isRecord(value) || !isRecord(value.item)) return { item: { id: '', label: '', location: '', fields: {} }, claimed: null, group: null, predecessor: null, build: null, leases: [] };
  const item = value.item;
  const group = groupFrom(value.group);
  return {
    item: { id: typeof item.id === 'string' ? item.id : '', label: typeof item.label === 'string' ? item.label : '', location: typeof item.location === 'string' ? item.location : '', fields: isRecord(item.fields) ? item.fields : {} },
    claimed: typeof value.claimed === 'string' ? value.claimed : null,
    group,
    predecessor: typeof value.predecessor === 'string' ? value.predecessor : null,
    build: typeof value.build === 'string' ? value.build : null,
    leases: Array.isArray(value.leases) ? value.leases.filter((row): row is { key: string; run: string } => isRecord(row) && typeof row.key === 'string' && typeof row.run === 'string') : [],
  };
}

export function installOutcome(subjectInput: unknown, tableInput: unknown): Outcome {
  const table = readTable(tableInput);
  const subject = subjectOf(subjectInput);
  const item = subject.item.id;
  const unknown = (reason: CheckReason, missing: string): Outcome => ({ verdict: 'unknown', reason, missing, statement: missing, grounds: [], tier: TIER, ...(item ? { item } : {}) });
  if (table === null) return unknown('check_error', '任务包自带的装构建表不完整；联系任务包作者修正 policies/install.json');
  const group = subject.group;
  if (group === null) return unknown('missing_input', '运行记录里没有本包冻结的装构建分组；用本包重新开运行');
  const grounds = [`src:${group.request_sha256}`, `src:${group.manifest_sha256}/json@1/${group.bed_pointer}`];
  const refute = (code: string, statement: string): Outcome => ({ verdict: 'refute', code, statement, grounds, tier: TIER, ...(item ? { item } : {}) });
  const read = readRequest(group.request);
  if (!read.ok) return refute('bed-install.request_invalid', `${read.problem}；改好后重新上传，以新的引用开运行`);
  const { build, image } = read.request;
  const version = imageVersion(image, table.image_extensions);
  if (version === null) {
    return refute('bed-install.request_invalid', `镜像名 ${image} 不是构建库的镜像文件名（字母、数字和 . _ -，以 ${table.image_extensions.map((extension) => `.${extension}`).join(' 或 ')} 结尾，构建名前有 -）；照构建站列表页上 ${build} 条目里镜像链接的文件名写（source-read 的 build_page 从 buildsite:listing:index 读起，经版本线导航页到列有它的列表页），重新上传后开运行`);
  }
  if (version !== versionOfBuild(build)) {
    return refute('bed-install.request_invalid', `镜像 ${image} 装的是 ${version}（按 InfoTest 升级用例的读法：第一个 - 之后到最后一个 . 之前，_ 读作 .），不是 ${build}；照构建站列表页上 ${build} 条目里镜像链接的文件名写（source-read 的 build_page 从 buildsite:listing:index 读起，经版本线导航页到列有它的列表页），重新上传后开运行`);
  }
  if (subject.claimed === null) return unknown('missing_input', '提交里没有 reason（要装的构建和依据）；按包的提交格式补上后原样再交');
  if (subject.claimed !== build) return refute('bed-install.claim_mismatch', `提交的 reason 写要装 ${subject.claimed}，上传的装构建请求是 ${build}；两处写同一个构建`);
  if (subject.predecessor === null) return refute('bed-install.booking_missing', `运行没有前驱：先用 test-bed 预订整台 ${group.bed}，再以那次预订的运行号为 predecessor 开本运行`);
  const held = new Set(subject.leases.filter((row) => row.run === subject.predecessor).map((row) => row.key));
  const missing = group.devices.filter((name) => !held.has(`bed/${group.bed}/${name}`));
  if (missing.length > 0) {
    return refute('bed-install.booking_missing', `前驱 ${subject.predecessor} 在开运行时没有持有整台 ${group.bed}：缺 ${missing.map((name) => `bed/${group.bed}/${name}`).join('、')}；装构建要整台独占，先用 test-bed 预订整台，再以那次预订为 predecessor 开运行`);
  }
  if (subject.build === null) return refute('bed-install.build_unlocked', `运行没有锁定构建：开运行时 product 和 build 写设备现在装的构建（test-bed 预订时 Hub 在设备上看到的那个），派发前 Hub 在每台设备上核对`);
  const cases = table.cases.slice(0, group.targets.length);
  if (!cases.includes(item)) return unknown('check_error', `条目 ${item} 不是 ${group.bed} 的升级用例（${cases.join('、')}）；用本包重新开运行`);
  return {
    verdict: 'support',
    statement: `装构建请求核对通过：在 ${group.bed} 的 ${group.targets.join('、')} 上装 ${build}（镜像 ${image}，按 InfoTest 升级用例的读法是 ${version}）；前驱 ${subject.predecessor} 持有整台；运行锁定 ${subject.build}，派发前在每台设备上核对。不证明构建库里有这个镜像，也不证明设备装得上`,
    grounds,
    tier: TIER,
    ...(item ? { item } : {}),
    data: {
      sha256: group.request_sha256,
      autoids: cases,
      bed: { id: group.bed, manifest_sha256: group.manifest_sha256 },
      build: subject.build,
      generator: GENERATOR,
      plan_run: subject.predecessor,
      install: { build, image, version, targets: group.targets },
    },
  };
}

export default function check(input: unknown): Outcome[] {
  const raw = isRecord(input) ? input : {};
  return [installOutcome(raw.subject, raw.table)];
}
