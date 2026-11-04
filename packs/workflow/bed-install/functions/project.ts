// The bed-install projection (pack function, ProjectionInput -> ProjectionOutput). It reads the bed inventory named document
// (test-bed-manifest@1, json@1), the install profile named document (bed-install-profile@1, json@1: the deployment's upgrade
// cases and the image extensions they handle) and the uploaded install request, and returns one item per upgrade case: the
// profile's upgrade case of each dispatch-target device of the named bed, in inventory order (the test framework runs one
// upgrade case per device of its configuration). The frozen group carries what the install check recomputes from: the bed,
// all its devices, the dispatch targets, the three digests, the profile's cases and extensions and the request model.
import TABLE from '../policies/install.json' with { type: 'json' };
import { isRecord, readProfile, readTable } from './common.ts';

interface Bound {
  slot: string;
  external?: unknown;
  sha256?: unknown;
  model?: unknown;
}

interface Item {
  id: string;
  label: string;
  summary: string;
  location: { slot: string; parser: string; selector: string };
  fields: Record<string, unknown>;
}

interface Out {
  items: Item[];
  groups: Array<Record<string, unknown>>;
  warnings: Array<{ code: string; message: string }>;
}

interface Failure {
  error: { code: string; message: string; fix: string; pointer?: string; provenance?: 'declared'; grounds?: string[] };
  warnings: Array<{ code: string; message: string }>;
}

const failure = (code: string, message: string, fix: string, extra: Partial<Failure['error']> = {}): Failure => ({ error: { code, message, fix, ...extra }, warnings: [] });

/** The named document's name for the administrator's command, from the bound external id doc:doc:<name>[@<digest>]. */
function docName(slot: Bound | undefined, fallback: string): string {
  const match = typeof slot?.external === 'string' ? /^doc:doc:([a-z][a-z0-9-]{0,63})(?:@[0-9a-f]{64})?$/.exec(slot.external) : null;
  return match ? match[1] : fallback;
}

export default function project(input: unknown): Out | Failure {
  const raw = isRecord(input) ? input : {};
  const inputs = (Array.isArray(raw.inputs) ? raw.inputs : []).filter((value): value is Bound => isRecord(value) && typeof value.slot === 'string');
  const parameters = isRecord(raw.parameters) ? raw.parameters : {};
  const table = readTable(TABLE);
  if (table === null) return failure('bed-install.table_invalid', '任务包自带的装构建表不完整', '联系任务包作者修正 policies/install.json');
  const inventory = inputs.find((slot) => slot.slot === 'inventory');
  const profileSlot = inputs.find((slot) => slot.slot === 'profile');
  const request = inputs.find((slot) => slot.slot === 'request');
  if (inventory === undefined || !isRecord(inventory.model) || typeof inventory.sha256 !== 'string') {
    return failure('bed-install.no_inventory', '没有自动化测试环境清单', '在 inputs.inventory 里写命名文档 {"external": "doc:doc:<名字>"}（管理员发布的清单，缺省 doc:doc:bed-topology）', { pointer: '/inputs/inventory' });
  }
  const name = docName(profileSlot, 'bed-install-profile');
  if (profileSlot === undefined || typeof profileSlot.sha256 !== 'string' || profileSlot.model === undefined) {
    return failure('bed-install.no_profile', `没有装构建档案（${table.profile_schema}）：升级用例号和升级用例认的镜像扩展名是部署数据，本运行没有读到`, `在 inputs.profile 里写 {"external": "doc:doc:${name}"}；Hub 里还没有这份命名文档时请管理员按 ${table.profile_schema} 写好，用 circle-hub doc put ${name} <文件> 发布后重开运行`, { pointer: '/inputs/profile' });
  }
  const profileGrounds = [`src:${profileSlot.sha256}`];
  const read = readProfile(profileSlot.model, table.profile_schema);
  if (!read.ok) {
    return failure('bed-install.profile_invalid', `装构建档案 ${name} 不合 ${table.profile_schema}：${read.problems.join('；')}`, `请管理员按 ${table.profile_schema} 改好档案，用 circle-hub doc put ${name} <文件> 重新发布后重开运行`, { pointer: '/inputs/profile', provenance: 'declared', grounds: profileGrounds });
  }
  const profile = read.profile;
  if (request === undefined || typeof request.sha256 !== 'string') {
    return failure('bed-install.no_request', '没有装构建请求', '先在工作目录写装构建请求 JSON（{"schema":"bed-install@1","build":"<要装的构建>","image":"<构建库里的镜像文件名>"}），用 upload_file 上传，再在 inputs.request 里写它的引用', { pointer: '/inputs/request' });
  }
  const bed = typeof parameters.bed === 'string' ? parameters.bed : '';
  const beds = Array.isArray(inventory.model.beds) ? inventory.model.beds : [];
  const at = beds.findIndex((entry) => isRecord(entry) && entry.name === bed);
  if (bed === '' || at < 0) {
    const names = beds.flatMap((entry) => (isRecord(entry) && typeof entry.name === 'string' ? [entry.name] : []));
    return failure('bed-install.bed_unknown', bed === '' ? '没有写要装构建的自动化测试环境' : `清单里没有自动化测试环境 ${bed}`, `parameters.bed 写清单里的环境名${names.length ? `（有 ${names.join('、')}）` : ''}`, { pointer: '/parameters/bed', provenance: 'declared', grounds: [`src:${inventory.sha256}/json@1/p/beds`] });
  }
  const entry = beds[at] as Record<string, unknown>;
  const devices = (Array.isArray(entry.devices) ? entry.devices : []).map((device, index) => ({
    index,
    name: isRecord(device) && typeof device.name === 'string' ? device.name : '',
    type: isRecord(device) && typeof device.type === 'string' ? device.type : '',
  }));
  const targets = devices.filter((device) => table.device_types.includes(device.type));
  const grounds = [`src:${inventory.sha256}/json@1/p/beds/${at}`];
  if (targets.length === 0 || devices.some((device) => device.name === '')) {
    return failure('bed-install.no_targets', `清单里自动化测试环境 ${bed} 没有${devices.some((device) => device.name === '') ? '完整的设备名' : `类型为 ${table.device_types.join('、')} 的设备`}，没有可装构建的设备`, '请管理员核对清单的设备类型和名字后重新发布', { provenance: 'declared', grounds });
  }
  const cases = profile.upgrade_cases;
  if (targets.length > cases.length) {
    return failure('bed-install.too_many_targets', `自动化测试环境 ${bed} 有 ${targets.length} 台要装构建的设备，装构建档案 ${name} 只写了 ${cases.length} 个升级用例`, `请管理员在档案的 upgrade_cases 里按测试框架补齐到 ${targets.length} 个（第 i 台设备用第 i 个），用 circle-hub doc put ${name} <文件> 重新发布后重开运行`, { pointer: '/inputs/profile', provenance: 'declared', grounds: [...grounds, `src:${profileSlot.sha256}/json@1/p/upgrade_cases`] });
  }
  const items = targets.map((device, position) => ({
    id: cases[position],
    label: `${device.name} 的升级用例 ${cases[position]}`,
    summary: `${bed} 清单里第 ${position + 1} 台 ${device.type} ${device.name}：升级用例 ${cases[position]}`,
    location: { slot: 'inventory', parser: 'json@1', selector: `p/beds/${at}/devices/${device.index}` },
    fields: { bed, device: device.name, position, case: cases[position] },
  }));
  const groups = [{
    kind: 'bed-install',
    bed,
    devices: devices.map((device) => device.name),
    targets: targets.map((device) => device.name),
    manifest_sha256: inventory.sha256,
    bed_pointer: `p/beds/${at}`,
    profile_sha256: profileSlot.sha256,
    upgrade_cases: cases.slice(0, targets.length),
    image_extensions: profile.image_extensions,
    request_sha256: request.sha256,
    request: request.model ?? null,
  }];
  return { items, groups, warnings: [] };
}
