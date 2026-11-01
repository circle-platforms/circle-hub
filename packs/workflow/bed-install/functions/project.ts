// The bed-install projection (pack function, ProjectionInput -> ProjectionOutput). It reads the bed inventory named
// document (test-bed-manifest@1, json@1) and the uploaded install request, and returns one item per upgrade case: the
// framework's upgrade case of each dispatch-target device of the named bed, in inventory order (policies/install.json:
// the device types and the cases, as InfoTest runs one upgrade case per conf device). The frozen group carries what the
// install check recomputes from: the bed, all its devices, the dispatch targets, both digests and the request model.
import TABLE from '../policies/install.json' with { type: 'json' };
import { isRecord, readTable } from './common.ts';

interface Bound {
  slot: string;
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

export default function project(input: unknown): Out | Failure {
  const raw = isRecord(input) ? input : {};
  const inputs = (Array.isArray(raw.inputs) ? raw.inputs : []).filter((value): value is Bound => isRecord(value) && typeof value.slot === 'string');
  const parameters = isRecord(raw.parameters) ? raw.parameters : {};
  const table = readTable(TABLE);
  if (table === null) return failure('bed-install.table_invalid', '任务包自带的装构建表不完整', '联系任务包作者修正 policies/install.json');
  const inventory = inputs.find((slot) => slot.slot === 'inventory');
  const request = inputs.find((slot) => slot.slot === 'request');
  if (inventory === undefined || !isRecord(inventory.model) || typeof inventory.sha256 !== 'string') {
    return failure('bed-install.no_inventory', '没有自动化测试环境清单', '在 inputs.inventory 里写命名文档 {"external": "doc:doc:<名字>"}（管理员发布的清单，缺省 doc:doc:bed-topology）', { pointer: '/inputs/inventory' });
  }
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
  if (targets.length > table.cases.length) {
    return failure('bed-install.too_many_targets', `自动化测试环境 ${bed} 有 ${targets.length} 台要装构建的设备，框架只有 ${table.cases.length} 个升级用例`, '联系任务包作者按框架补齐升级用例的声明', { provenance: 'declared', grounds });
  }
  const items = targets.map((device, position) => ({
    id: table.cases[position],
    label: `${device.name} 的升级用例 ${table.cases[position]}`,
    summary: `${bed} 清单里第 ${position + 1} 台 ${device.type} ${device.name}：框架升级用例 ${table.cases[position]}`,
    location: { slot: 'inventory', parser: 'json@1', selector: `p/beds/${at}/devices/${device.index}` },
    fields: { bed, device: device.name, position, case: table.cases[position] },
  }));
  const groups = [{
    kind: 'bed-install',
    bed,
    devices: devices.map((device) => device.name),
    targets: targets.map((device) => device.name),
    manifest_sha256: inventory.sha256,
    bed_pointer: `p/beds/${at}`,
    request_sha256: request.sha256,
    request: request.model ?? null,
  }];
  return { items, groups, warnings: [] };
}
