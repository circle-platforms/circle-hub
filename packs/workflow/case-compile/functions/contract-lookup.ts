// Local lookup of the executor rules a run froze, and of the block format of its plans. A script writer otherwise learns which
// object.method a step may use, how its G, H and I cells read, what it is typed and budgeted to, and which fields a block takes
// by reading contract.json, profile.json, inventory.json, slots.schema.json and tables/blocks-format.json a window at a time: in
// round 35 the two writers read them 21 + 22 + 6 and 6 + 7 + 11 times.
//
// The reference implementation (InfoTest, lang_query) has three kinds for this. `contract` (main/ist_core/tools/device/
// lang_query_tool.py :175-357) lists the E values that have an enabled surface and those that have none with the dominant
// reasons, then one E's enabled, disabled and internal F names, then one E/F pair: status, reason, status authority, Python
// symbol, signature, G, H and I semantics, dispatch, source and the contract's digest; an unknown E or F is answered with the
// names that exist, never as a rejection. `signature` (:360-384) gives the required and optional parameters of one method, and
// `dispatch` (:387-441) how one name is dispatched. This is the same over what a Hub run freezes: the contract
// (runtime-contract@2, read by the Hub's own parser), the profile that opens a subset of it for this bed, and the bed manifest.
// A method is answered with the state the Hub itself gives it (the contract enables it AND the profile opens it: the common
// allowed set of functions/call-boundaries.ts), its signature and the contract's own G, H and I texts, the typed authority the
// Hub checks a plan against (roles and types of the parameters, the effects with their budgets, the full literal commands and the
// programs a host line may use), the block model's facts (what it returns, whether it is a cell method, the single-cell input),
// the access levels its prompt refuses, the seat it maps to on the bed, and every place it rests on with the reference to cite.
// A block kind is answered from the frozen slot schema of the run, the pack's block table and, when the pack has one, its sample.
//
// Facts by structure only, never by matching words: a name is found by exact match; a miss names the names that start the same
// (case-sensitive; a name that differs only in case is told as that), and the objects or kinds there are. Nothing is ranked or
// guessed, nothing is written, and every answer states its bounds and whether it cut anything.
import FORMAT from '../tables/runtime-contract-format.json' with { type: 'json' };
import { parseManifest, type ManifestBed, type ManifestDevice } from './manifest.ts';
import { parseProfile, type AllowedCall, type RuntimeProfile } from './profile.ts';
import { parseRuntimeContract, refusedAccess, runtimeMethod, sourceDocument, type RuntimeContract, type Problem } from './runtime-contract.ts';
import { commandLine, type Authority, type Effect, type ValueType } from './typed-contract.ts';
import { CallFailure, clip, isRecord } from './text.ts';

type Row = { [key: string]: any };

/** What one answer holds at most. */
export const CONTRACT_BOUNDS = {
  /** Parameters of one method. */
  parameters: 32,
  /** Effects of one method. */
  effects: 8,
  /** Commands an effect allows one by one. */
  commands: 12,
  /** Full literal commands an effect allows, and the characters of one. */
  literals: 40,
  literalChars: 300,
  /** Addresses of one family of the seat's device. */
  addresses: 8,
  /** Lines of the contract's own sources. */
  sources: 24,
  /** Parameter rows of a profile's unopened record. */
  unopenedRows: 6,
  /** Characters of a reason or a text the contract or the profile records. */
  reasonChars: 400,
  textChars: 600,
  /** Methods of one group of a methods listing. */
  methods: 60,
  /** Names of a list of names that start the same, and objects. */
  near: 12,
  objects: 60,
  /** Fields of one block kind, the characters of a field's description, the characters of the example line, kinds of a listing. */
  fields: 40,
  fieldChars: 900,
  exampleChars: 1200,
  kinds: 40,
} as const;

const RETRY = '重新下载本次运行完整的 run.json、sources.json 和 sources/，不拼接其他运行的文件';

export interface SourceFile { file: string; reference: string | null }
export interface MethodSource {
  /** The contract as the Hub's reader takes it: what it enables, with the typed authority it can read. */
  contract: RuntimeContract;
  profile: RuntimeProfile;
  /** The profile as written: it holds what the reader drops (the reasons a method is not opened). */
  profileDoc: Row;
  beds: readonly ManifestBed[];
  /** Where each document stands in the download, with the reference the run gives it. */
  files: { contract: SourceFile; profile: SourceFile; inventory: SourceFile };
}

const firstProblem = (problems: readonly Problem[]): string => (problems[0] === undefined ? '' : `${problems[0].pointer || '/'} ${problems[0].message}`);

/** The three documents of a download read by the Hub's own readers; a document they refuse is refused here with their first problem. */
export function methodSourceOf(documents: { contract: unknown; profile: unknown; inventory: unknown }, files: MethodSource['files']): MethodSource {
  const contract = parseRuntimeContract(documents.contract);
  if (!contract.ok) throw new CallFailure('invalid_parameters', `${files.contract.file} 不是有效的冻结合约：${firstProblem(contract.problems)}`, RETRY);
  const manifest = parseManifest(documents.inventory);
  if (!manifest.ok) throw new CallFailure('invalid_parameters', `${files.inventory.file} 不是有效的测试环境清单：${firstProblem(manifest.problems)}`, RETRY);
  const profile = parseProfile(documents.profile, contract.contract, manifest.beds);
  if (!profile.ok) throw new CallFailure('invalid_parameters', `${files.profile.file} 不是和冻结合约、清单一致的运行环境配置：${firstProblem(profile.problems)}`, RETRY);
  return { contract: contract.contract, profile: profile.profile, profileDoc: documents.profile as Row, beds: manifest.beds, files };
}

// ----------------------------------------------------------------------------------------------------------------------------
// What the contract and the profile hold, indexed once per source.

type State = 'usable' | 'unopened' | 'candidate' | 'disabled' | 'internal';
const TAG: Readonly<Record<State, string>> = { usable: '可写进计划', unopened: '合约启用，本次未开放', candidate: '认证候选，没有推广', disabled: '禁用', internal: '内部' };

interface Method { object: string; name: string; index: number; entry: Row; state: State }
interface ObjectRow { name: string; raw: Row; methods: Method[] }
interface Index {
  objects: ObjectRow[];
  byName: Map<string, ObjectRow>;
  /** Methods of one name across the objects, in the contract's order. */
  byMethod: Map<string, Method[]>;
  allowed: Map<string, { call: AllowedCall; index: number }>;
  unopened: Map<string, { row: Row; index: number }>;
  promotions: Map<string, { row: Row; index: number }>;
}
const indexes = new WeakMap<MethodSource, Index>();
const pair = (object: string, method: string): string => JSON.stringify([object, method]);
const list = (words: readonly string[]): string => words.join('、');
const into = <K, V>(map: Map<K, V[]>, key: K): V[] => map.get(key) ?? map.set(key, []).get(key)!;

function indexOf(source: MethodSource): Index {
  const known = indexes.get(source);
  if (known !== undefined) return known;
  const doc = sourceDocument(source.contract) ?? {};
  const index: Index = { objects: [], byName: new Map(), byMethod: new Map(), allowed: new Map(), unopened: new Map(), promotions: new Map() };
  for (const raw of (Array.isArray(doc.objects) ? doc.objects : []) as Row[]) {
    if (!isRecord(raw)) continue;
    const name = String(raw.e ?? raw.name);
    const row: ObjectRow = { name, raw, methods: [] };
    index.objects.push(row);
    index.byName.set(name, row);
  }
  for (const [at, rawAllowed] of ((Array.isArray(source.profileDoc.allowed) ? source.profileDoc.allowed : []) as Row[]).entries()) {
    const call = source.profile.allowed.find((candidate) => candidate.object === rawAllowed?.object && candidate.method === rawAllowed?.method);
    if (call !== undefined) index.allowed.set(pair(call.object, call.method), { call, index: at });
  }
  for (const [at, row] of ((Array.isArray(source.profileDoc.unopened) ? source.profileDoc.unopened : []) as Row[]).entries()) if (isRecord(row)) index.unopened.set(pair(String(row.object), String(row.method)), { row, index: at });
  for (const [at, row] of ((Array.isArray(doc.promotions) ? doc.promotions : []) as Row[]).entries()) if (isRecord(row)) index.promotions.set(pair(String(row.object), String(row.method)), { row, index: at });
  for (const [at, entry] of ((Array.isArray(doc.entries) ? doc.entries : []) as Row[]).entries()) {
    if (!isRecord(entry)) continue;
    const object = String(entry.e), name = String(entry.f);
    const status = String(entry.status);
    // The contract's reader keeps an enabled certification candidate only when the contract promotes it.
    const state: State = status === 'disabled' ? 'disabled' : status === 'internal' ? 'internal' : runtimeMethod(source.contract, object, name) === null ? 'candidate' : index.allowed.has(pair(object, name)) ? 'usable' : 'unopened';
    const method: Method = { object, name, index: at, entry, state };
    index.byName.get(object)?.methods.push(method);
    into(index.byMethod, name).push(method);
  }
  indexes.set(source, index);
  return index;
}

// ----------------------------------------------------------------------------------------------------------------------------
// Pieces shared by the answers.

/** The cuts an answer made, for its last line. */
class Cuts {
  readonly list: string[] = [];
  note(text: string): void { this.list.push(text); }
}
function limits(cuts: Cuts, shown: string): string {
  return `# 上限：${shown}；${cuts.list.length === 0 ? '本次没有截断' : `本次截断：${cuts.list.join('；')}`}。`;
}
const METHOD_LIMITS = `参数最多列 ${CONTRACT_BOUNDS.parameters} 个，效果最多列 ${CONTRACT_BOUNDS.effects} 个，逐条允许的完整命令最多列 ${CONTRACT_BOUNDS.commands} 条，允许的字面命令最多列 ${CONTRACT_BOUNDS.literals} 条（每条最多 ${CONTRACT_BOUNDS.literalChars} 字符），设备地址每类最多列 ${CONTRACT_BOUNDS.addresses} 个，方法每组最多列 ${CONTRACT_BOUNDS.methods} 个，名字最多列 ${CONTRACT_BOUNDS.near} 个，对象最多列 ${CONTRACT_BOUNDS.objects} 个`;

/** The words a value may be made of when it names an object, a method or a kind: no space, no quote, no dot. */
const WORD = /^[^\s'"`.]+$/u;

/** A place in a document of the download, with the reference to cite it by when the run gives the document one. */
const sourceAt = (file: SourceFile, pointer: string): string => `${file.file} 的 ${pointer}${file.reference === null ? '' : `（${file.reference}/json@1/p${pointer}）`}`;

/** Names that start with the typed ones, in the order given, and the names that differ from the typed one only in case. */
function sameStart<T>(items: readonly T[], name: (item: T) => string, typed: string): { starts: T[]; caseOnly: string[] } {
  const starts = items.filter((item) => name(item).startsWith(typed));
  const caseOnly = [...new Set(items.map(name))].filter((word) => word !== typed && word.toLowerCase() === typed.toLowerCase());
  return { starts, caseOnly };
}

function objectsLine(index: Index, cuts: Cuts): string {
  const names = index.objects.map((row) => row.name);
  const shown = names.slice(0, CONTRACT_BOUNDS.objects);
  if (names.length > shown.length) cuts.note(`对象 ${names.length} 个只列 ${shown.length} 个`);
  return `# 合约里的对象（${names.length} 个）：${list(shown)}${names.length > shown.length ? `（只列前 ${shown.length} 个）` : ''}。`;
}

function objectLine(row: ObjectRow): string {
  const status = String(row.raw.status);
  const type = typeof row.raw.python_type === 'string' ? `类型 ${row.raw.python_type}，` : '';
  const reason = status !== 'enabled' && typeof row.raw.reason === 'string' && row.raw.reason !== '' ? `：${clip(row.raw.reason, CONTRACT_BOUNDS.reasonChars)}` : '';
  return `# 对象 ${row.name}：${type}合约状态 ${status}${reason}。`;
}

// ----------------------------------------------------------------------------------------------------------------------------
// The seat on the bed.

const addressesOf = (device: ManifestDevice, cuts: Cuts): string => {
  const parts: string[] = [];
  for (const [family, label] of [[device.ipv4, 'IPv4'], [device.ipv6, 'IPv6']] as const) {
    const shown = family.slice(0, CONTRACT_BOUNDS.addresses).map((address) => `${address.address}/${address.prefix}`);
    parts.push(...shown);
    if (family.length > shown.length) cuts.note(`${device.name} 的 ${label} 地址 ${family.length} 个只列 ${shown.length} 个`);
  }
  return parts.length === 0 ? '没有登记地址' : list(parts);
};
const deviceOf = (source: MethodSource, name: string): { device: ManifestDevice; bed: number; at: number } | null => {
  const bed = source.beds.findIndex((candidate) => candidate.name === source.profile.bed);
  if (bed < 0) return null;
  const at = source.beds[bed]!.devices.findIndex((candidate) => candidate.name === name);
  return at < 0 ? null : { device: source.beds[bed]!.devices[at]!, bed, at };
};
const buildOf = (device: ManifestDevice): string => (device.installed === null ? '' : `，已装构建 ${device.installed.build}`);

interface Seat { line: string; cites: string[] }
/** The seat of an object (a device the profile seats it at) or of a host method (the test host it runs on); the line says when it has none. */
function seatOf(source: MethodSource, object: string, method: string | null, cuts: Cuts): Seat[] {
  const out: Seat[] = [];
  const describe = (name: string, extra: string): { text: string; cite: string | null } => {
    const found = deviceOf(source, name);
    if (found === null) return { text: `设备 ${name}`, cite: null };
    const { device } = found;
    return { text: `设备 ${name}（${extra}${device.type}${buildOf(device)}）；地址 ${addressesOf(device, cuts)}`, cite: `设备 ${sourceAt(source.files.inventory, `/beds/${found.bed}/devices/${found.at}`)}` };
  };
  const seat = source.profile.seats.findIndex((row) => row.object === object);
  const hostRows = source.profile.hosts.map((row, at) => ({ row, at })).filter(({ row }) => row.object === object && (method === null || row.method === method));
  const bed = source.profile.bed;
  // An object seated at a device is told by its seat; a host method by the test host it runs on (an object may have both).
  if (seat >= 0 && (method === null || hostRows.length === 0)) {
    const row = source.profile.seats[seat]!;
    const made = describe(row.device, `序号 ${row.ordinal}，`);
    out.push({ line: `# 座位：对象 ${object} 对应测试环境 ${bed} 的${made.text}。`, cites: [`座位 ${sourceAt(source.files.profile, `/seats/${seat}`)}`, ...(made.cite === null ? [] : [made.cite])] });
  }
  for (const { row, at } of hostRows) {
    const made = describe(row.device, row.ordinal === undefined ? '' : `序号 ${row.ordinal}，`);
    const subject = method === null ? `对象 ${object} 的方法 ${row.method} 是主机方法，对应` : `主机方法 ${object}.${row.method} 对应`;
    out.push({ line: `# 座位：${subject}测试环境 ${bed} 的${made.text}。`, cites: [`主机方法 ${sourceAt(source.files.profile, `/hosts/${at}`)}`, ...(made.cite === null ? [] : [made.cite])] });
  }
  if (out.length === 0) out.push({ line: `# 座位：本次配置的 seats 和 hosts 没有列${method === null ? `对象 ${object}` : ` ${object}.${method}`}，它不对应测试环境里的设备。`, cites: [] });
  return out;
}

// ----------------------------------------------------------------------------------------------------------------------------
// The typed authority of a method.

function typeText(type: ValueType): string {
  const kind = type.address_kind ?? type.declaration.catalog_type;
  const parts: string[] = [];
  if (type.values !== undefined) parts.push(type.values.join('|'));
  if (type.literal !== undefined) parts.push(`字面 ${type.literal}`);
  if (type.minimum !== undefined || type.maximum !== undefined) parts.push(`${type.minimum ?? ''}..${type.maximum ?? ''}`);
  if (type.minLength !== undefined || type.maxLength !== undefined) parts.push(`长度 ${type.minLength ?? ''}..${type.maxLength ?? ''}`);
  if (type.pattern !== undefined) parts.push(`形状 ${type.pattern}`);
  return `${kind}${parts.length ? ` ${parts.join(' ')}` : ''}（合约类型 ${type.declaration.name}）`;
}

function parameterLines(entry: Row, allowed: AllowedCall | undefined, authority: Authority | null | undefined, cuts: Cuts): string[] {
  const parameters = (Array.isArray(entry.signature?.parameters) ? entry.signature.parameters : []) as Row[];
  const shown = parameters.slice(0, CONTRACT_BOUNDS.parameters);
  if (parameters.length > shown.length) cuts.note(`参数 ${parameters.length} 个只列 ${shown.length} 个`);
  const out = [`# 参数（共 ${parameters.length} 个，按签名顺序；角色来自本次配置，类型来自合约的类型化权限）：`];
  for (const parameter of shown) {
    const name = String(parameter.name);
    const parts = [`${name}：${parameter.required === true ? '必填' : `可选${parameter.default === null || parameter.default === undefined ? '' : `（默认 ${parameter.default}）`}`}${parameter.kind === 'positional_or_keyword' ? '' : `（kind ${parameter.kind}）`}`];
    const role = allowed?.parameters[name];
    if (parameter.default === FORMAT.redacted_default) parts.push('脱敏凭据，不许写进计划');
    else if (allowed?.unsupplied?.includes(name)) parts.push('本次配置声明永不传入（unsupplied），不要写');
    else if (role !== undefined) parts.push(`角色 ${role}`);
    const typed = authority?.parameters[name];
    if (typed !== undefined) parts.push(`类型 ${typeText(typed.type)}`);
    out.push(`#   ${parts.join('；')}`);
  }
  return out;
}

const HOST_LINE = '命令写成静态一行，不含 shell 动态写法：$、反引号、引号外的 * ? [ ] { } ~ ; | & < >';

function effectLines(source: MethodSource, effect: Effect, cuts: Cuts): string[] {
  const out = [`#   效果 ${effect.id}：预算 ${effect.budget} 次（一份计划里这个效果被调用的总次数超过它会被拒）；角色 ${list(effect.roles)}。`];
  if (effect.commands !== undefined && (effect.commands.length > 0 || effect.roles.includes('device_cli'))) {
    const lines = effect.commands.map((identity) => commandLine(identity)).filter((line): line is string => line !== null);
    const shown = lines.slice(0, CONTRACT_BOUNDS.commands);
    out.push(`#     逐条允许的完整命令（commands，共 ${lines.length} 条${lines.length > shown.length ? `，显示前 ${shown.length} 条` : ''}）：`, ...shown);
    if (lines.length > shown.length) cuts.note(`效果 ${effect.id} 的逐条允许命令 ${lines.length} 条只显示 ${shown.length} 条`);
  }
  if (effect.command_scope !== undefined) out.push(`#     命令范围（command_scope）：${list(effect.command_scope)} 及其下的命令`);
  else if (effect.commands === undefined && effect.roles.includes('device_cli')) {
    const destructive = source.contract.destructive;
    out.push(destructive === undefined
      ? '#     没有声明命令范围，合约也没有破坏性命令声明：设备命令不能按命令树放行。'
      : `#     没有声明命令范围：锁定命令树里的命令都在范围内，除了合约声明的破坏性命令（exact ${destructive.exact.length} 条、prefixes ${destructive.prefixes.length} 条、segments ${destructive.segments.length} 个）。`);
  }
  for (const program of effect.allowed_programs ?? []) out.push(`#     允许的程序：${program.program}（${program.addressPrefix === undefined ? '' : `以 ${program.addressPrefix} 开头的词必须是地址；`}${HOST_LINE}）`);
  if (effect.allowed_literals.length > 0) {
    const shown = effect.allowed_literals.slice(0, CONTRACT_BOUNDS.literals);
    out.push(`#     允许的字面命令（合约原文，主机命令可以整条等于其中之一；共 ${effect.allowed_literals.length} 条${effect.allowed_literals.length > shown.length ? `，显示前 ${shown.length} 条` : ''}）：`);
    let clipped = 0;
    for (const literal of shown) {
      const text = clip(literal, CONTRACT_BOUNDS.literalChars);
      if (text !== literal) clipped++;
      out.push(text);
    }
    if (clipped > 0) cuts.note(`效果 ${effect.id} 的字面命令有 ${clipped} 条超过 ${CONTRACT_BOUNDS.literalChars} 字符被截短`);
    if (effect.allowed_literals.length > shown.length) {
      out.push(`#     还有 ${effect.allowed_literals.length - shown.length} 条没有列出：在 ${source.files.contract.file} 的 /effects/${effect.id}/allowed_literals 第 ${shown.length + 1} 条起。`);
      cuts.note(`允许的字面命令 ${effect.allowed_literals.length} 条只显示 ${shown.length} 条`);
    }
  }
  if (effect.command_roles.length > 0) out.push(`#     命令参数位置的角色声明 ${effect.command_roles.length} 条（command_roles：命令树的签名加位置，对应角色 ${list([...new Set(effect.command_roles.map((row) => row.role))])}）`);
  return out;
}

// ----------------------------------------------------------------------------------------------------------------------------
// What the block model says of a method.

function blockModelLines(doc: Row, method: Method, firstPositional: string | undefined): string[] {
  const model = isRecord(doc.runtime) && isRecord(doc.runtime.block_model) ? doc.runtime.block_model : null;
  if (model === null) return ['# 取格方法与输出：这份合约没有 runtime.block_model，计划不能用块（blocks）。'];
  const out: string[] = [];
  const same = (row: unknown): boolean => isRecord(row) && row.object === method.object && row.method === method.name;
  const output = (Array.isArray(model.output_methods) ? model.output_methods : []).find(same) as Row | undefined;
  if (output === undefined) out.push('# 输出：执行器规则没有登记它产生完整原文输出：不能作观察块的 call。');
  else if (output.output === 'raw_text') out.push('# 输出：执行器规则（runtime.block_model.output_methods）登记它的返回是 raw_text：能作观察块（需要原文输出的块）的 call。');
  else out.push(`# 输出：执行器规则（runtime.block_model.output_methods）登记它的返回是 ${String(output.output)}。`);
  const cells = (Array.isArray(model.cell_methods) ? model.cell_methods : []).filter(isRecord);
  if (cells.some(same)) out.push('# 取格方法：是（runtime.block_model.cell_methods 登记）：SELECT_CELL 块的 call 用它。');
  else out.push(`# 取格方法：不是；本次执行器规则登记的取格方法：${cells.length === 0 ? '无' : list(cells.map((row) => `${String(row.object)}.${String(row.method)}`))}。`);
  const effect = method.entry.cell_effect;
  if (isRecord(effect)) {
    const policy = isRecord(effect.value_policy) ? effect.value_policy : {};
    out.push(`# 取格值的策略（合约 cell_effect）：${String(policy.schema)}；允许的字符 ${String(policy.characters)}；长度 ${String(policy.min_length)}..${String(policy.max_length)}；预算 ${String(effect.budget)} 次；${effect.device_calls === false ? '不调设备（device_calls 为 false）' : `device_calls 为 ${String(effect.device_calls)}`}。`);
    // What the bound is a bound of: in a real run a writer took it for a bound on the name a later command needs, concluded the case
    // could not be written and looked for other commands for an hour (Langfuse, 2026-11-19).
    out.push('# 这项策略只管取出的这一格；把这一格回填进去之后的整条命令不受它限制。取出的一格可以只是一个名字里由设备生成的那一段，名字里已知的各段写在用它的命令里。');
  }
  if (firstPositional !== undefined) {
    out.push(model.cell_inputs === true
      ? `# 单格输入：执行器规则登记了 cell_inputs；CONFIG 和 STEP 块的 input_register 可把取出的单格回填到首个位置参数里的 {}（或 {0}）；这个方法的首个位置参数是 ${firstPositional}。`
      : '# 单格输入：执行器规则没有登记单格输入（cell_inputs），不能用 input_register。');
  }
  return out;
}

// ----------------------------------------------------------------------------------------------------------------------------
// The answers.

function missObjectLines(index: Index, typed: string, cuts: Cuts, next: string): string[] {
  const { starts, caseOnly } = sameStart(index.objects, (row) => row.name, typed);
  const shown = starts.slice(0, CONTRACT_BOUNDS.near);
  if (starts.length > shown.length) cuts.note(`对象名 ${starts.length} 个只列 ${shown.length} 个`);
  return [
    `# 合约里没有对象 ${typed}。`,
    ...(caseOnly.length > 0 ? [`# 对象名区分大小写，合约不折叠：合约里的名字是 ${list(caseOnly)}，写的是 ${typed}。`] : []),
    `# 以 ${typed} 开头的对象：${starts.length === 0 ? '无' : list(shown.map((row) => row.name))}${starts.length > shown.length ? `（共 ${starts.length} 个，只列前 ${shown.length} 个）` : ''}。`,
    objectsLine(index, cuts),
    next,
  ];
}

const NEXT_STEP = (object: string): string => `# 下一步：--methods '${object}' 列出这个对象本次可用的方法；原要求改用已开放的方法完成，对应关系写进计划说明。`;

const stateSentence = (state: State): string => {
  switch (state) {
    case 'usable': return '合约启用，本次配置已开放，可以写进计划。';
    case 'unopened': return '合约启用，本次配置没有开放；写进计划会被 Hub 拒绝（方法不在合约与发布配置的共同允许集合）。';
    case 'candidate': return '合约里是认证候选（certification_candidate）且没有被推广；Hub 不把它当作启用的方法，写进计划会被拒绝。';
    case 'disabled': return '合约禁用，不能写进计划。';
    case 'internal': return '合约标为内部，不能写进计划。';
  }
};

/** `--method '<object>.<method>'`: what the frozen executor rules say of one method, and the way to cite each fact. */
export function lookupMethod(source: MethodSource, query: string): string {
  const text = query.trim();
  const index = indexOf(source);
  const cuts = new Cuts();
  const usage = "写法：--method '<对象>.<方法>'";
  if (text === '' || /\s/u.test(text) || /['"`]/.test(text) || text.startsWith('.') || text.endsWith('.')) throw new CallFailure('invalid_parameters', `--method 的值要写成 <对象>.<方法>，不含空白和引号（现在是 ${JSON.stringify(query)}）`, usage);
  const dot = text.indexOf('.');
  if (dot < 0) {
    const named = index.byMethod.get(text);
    if (named !== undefined) return `${[`# ${text} 不是 <对象>.<方法> 的写法；方法名 ${text} 在这些对象上有：${list(named.map((row) => `${row.object}（${TAG[row.state]}）`))}。`, "# 下一步：--method '<对象>.<方法>' 看某一个。", limits(cuts, METHOD_LIMITS)].join('\n')}\n`;
    if (index.byName.has(text)) return `${[`# ${text} 是合约里的对象，写法是 <对象>.<方法>；--methods '${text}' 列出它的方法。`, limits(cuts, METHOD_LIMITS)].join('\n')}\n`;
    throw new CallFailure('invalid_parameters', `--method 的值要写成 <对象>.<方法>（${JSON.stringify(text)} 没有点，它既不是合约里的对象，也不是任何对象的方法名）`, usage);
  }
  const objectName = text.slice(0, dot), methodName = text.slice(dot + 1);
  const object = index.byName.get(objectName);
  if (object === undefined) return `${[...missObjectLines(index, objectName, cuts, "# 下一步：--methods '<对象>' 列出某个对象本次可用的方法。"), limits(cuts, METHOD_LIMITS)].join('\n')}\n`;
  const method = object.methods.find((row) => row.name === methodName);
  if (method === undefined) {
    const { starts, caseOnly } = sameStart(object.methods, (row) => row.name, methodName);
    const shown = starts.slice(0, CONTRACT_BOUNDS.near);
    if (starts.length > shown.length) cuts.note(`名字 ${starts.length} 个只列 ${shown.length} 个`);
    const lines = [
      `# 对象 ${objectName} 没有方法 ${methodName}。`,
      ...(caseOnly.length > 0 ? [`# 方法名区分大小写，合约不折叠：这个对象里的名字是 ${list(caseOnly)}，写的是 ${methodName}。`] : []),
      `# 以 ${methodName} 开头的方法：${starts.length === 0 ? '无' : list(shown.map((row) => `${objectName}.${row.name}（${TAG[row.state]}）`))}${starts.length > shown.length ? `（共 ${starts.length} 个，只列前 ${shown.length} 个）` : ''}。`,
      starts.length === 0 ? `# 下一步：--methods '${objectName}' 列出这个对象本次可用的方法。` : `# 下一步：--method '${objectName}.<完整方法名>' 看某一个方法；--methods '${objectName}' 列出这个对象本次可用的方法。`,
      limits(cuts, METHOD_LIMITS),
    ];
    return `${lines.join('\n')}\n`;
  }
  return `${methodLines(source, index, object, method, cuts).join('\n')}\n`;
}

function methodLines(source: MethodSource, index: Index, object: ObjectRow, method: Method, cuts: Cuts): string[] {
  const doc = sourceDocument(source.contract) ?? {};
  const entry = method.entry;
  const key = pair(method.object, method.name);
  const header = Array.isArray(source.profile.workbook.header) ? source.profile.workbook.header : [];
  const column = (at: number, letter: string): string => `${letter} 列${typeof header[at] === 'string' ? `（${header[at]}）` : ''}`;
  const out: string[] = [`# 方法 ${method.object}.${method.name}：${stateSentence(method.state)}`, objectLine(object)];
  const status = `# 状态来源：${String(entry.status_authority)}${typeof entry.reason === 'string' && entry.reason !== '' ? `；${clip(entry.reason, CONTRACT_BOUNDS.reasonChars)}` : ''}`;
  out.push(status);
  const promotion = index.promotions.get(key);
  if (promotion !== undefined && method.state === 'usable') out.push(`# 这是认证候选，合约推广了它（promotions 第 ${promotion.index + 1} 条，${String(promotion.row.status_authority)}）：${clip(String(promotion.row.reason), CONTRACT_BOUNDS.reasonChars)}`);
  const signature = isRecord(entry.signature) ? entry.signature : {};
  const required = (Array.isArray(signature.required) ? signature.required : []) as string[], optional = (Array.isArray(signature.optional) ? signature.optional : []) as string[];

  const cites: string[] = [`合约条目 ${sourceAt(source.files.contract, `/entries/${method.index}`)}`];
  const typedSource = isRecord(entry.typed_authority) ? String(entry.typed_authority.source) : null;
  if (method.state !== 'usable') {
    if (method.state === 'unopened') {
      const record = index.unopened.get(key);
      if (record === undefined) out.push('# 本次配置没有开放它，配置的 unopened 里也没有记原因。');
      else {
        out.push(`# 本次配置没有开放它（${source.files.profile.file} 的 /unopened/${record.index}）：`);
        cites.push(`未开放记录 ${sourceAt(source.files.profile, `/unopened/${record.index}`)}`);
        const rows = (Array.isArray(record.row.parameters) ? record.row.parameters : []).filter(isRecord) as Row[];
        for (const row of rows.slice(0, CONTRACT_BOUNDS.unopenedRows)) out.push(`#   参数 ${String(row.name)}：${clip(String(row.missing), CONTRACT_BOUNDS.reasonChars)}；原因：${clip(String(row.reason), CONTRACT_BOUNDS.reasonChars)}；下一步：${clip(String(row.next), CONTRACT_BOUNDS.reasonChars)}`);
        if (rows.length > CONTRACT_BOUNDS.unopenedRows) { out.push(`#   还有 ${rows.length - CONTRACT_BOUNDS.unopenedRows} 个参数的记录没有列出：在 ${source.files.profile.file} 的 /unopened/${record.index}/parameters。`); cuts.note(`未开放记录的参数 ${rows.length} 个只列 ${CONTRACT_BOUNDS.unopenedRows} 个`); }
      }
      if (typedSource === null) out.push('# 合约没有给它类型化权限（typed_authority）。');
    }
    out.push(`# 签名：${String(signature.text)}；必填 ${required.length === 0 ? '无' : list(required)}，可选 ${optional.length === 0 ? '无' : list(optional)}。`);
    out.push(`# 派发方式：${String(entry.dispatch)}；实现 ${String(entry.python_symbol)}（${String(entry.source?.path)} 行 ${String(entry.source?.line)}）。`);
    out.push(NEXT_STEP(method.object), `# 引用：${cites.join('；')}。`, limits(cuts, METHOD_LIMITS));
    return out;
  }

  const allowed = index.allowed.get(key)!;
  const runtime = runtimeMethod(source.contract, method.object, method.name);
  const authority = runtime?.authority ?? null;
  out.push(`# 签名：${String(signature.text)}；必填 ${required.length === 0 ? '无' : list(required)}，可选 ${optional.length === 0 ? '无' : list(optional)}。`);
  out.push(`# 派发方式：${String(entry.dispatch)}；实现 ${String(entry.python_symbol)}（${String(entry.source?.path)} 行 ${String(entry.source?.line)}）。`);
  out.push(`# ${column(6, 'G')}：${clip(String(entry.g_syntax), CONTRACT_BOUNDS.textChars)}`, `# ${column(7, 'H')}：${clip(String(entry.h_semantics), CONTRACT_BOUNDS.textChars)}`, `# ${column(8, 'I')}：${clip(String(entry.i_semantics), CONTRACT_BOUNDS.textChars)}`);
  out.push(...parameterLines(entry, allowed.call, authority, cuts));
  const used = new Set<string>(), usedTypes = new Set<string>();
  if (authority === null) out.push('# 合约没有给它类型化权限（typed_authority）。');
  else {
    out.push('# 类型化权限（合约 typed_authority）：');
    const effects = authority.effects.slice(0, CONTRACT_BOUNDS.effects);
    if (authority.effects.length > effects.length) cuts.note(`效果 ${authority.effects.length} 个只列 ${effects.length} 个`);
    for (const effect of effects) { out.push(...effectLines(source, effect, cuts)); for (const role of effect.roles) used.add(role); }
    for (const parameter of Object.values(authority.parameters)) { used.add(parameter.role); usedTypes.add(parameter.type.declaration.name); }
  }
  out.push(...blockModelLines(doc, method, ((Array.isArray(signature.parameters) ? signature.parameters : []) as Row[]).find((row) => row.kind === 'positional_only' || row.kind === 'positional_or_keyword')?.name));
  const refused = refusedAccess(source.contract, method.object, method.name);
  if (refused.length > 0) out.push(`# 提示符不接受的命令级别（合约 refused_access，来源 ${source.contract.refusedAccess!.source}）：${list(refused)}；命令树里级别是这些的命令不能用这个方法发。`);
  const seats = seatOf(source, method.object, method.name, cuts);
  for (const seat of seats) out.push(seat.line);
  cites.push(`开放项 ${sourceAt(source.files.profile, `/allowed/${allowed.index}`)}`);
  for (const seat of seats) cites.push(...seat.cites);
  out.push(`# 引用：${cites.join('；')}。`);
  if (authority !== null) {
    const rows: string[] = [];
    if (typedSource !== null) rows.push(`#   类型化权限的来源：${typedSource}`);
    for (const effect of authority.effects) rows.push(`#   效果 ${effect.id} 的来源：${effect.source}`);
    for (const role of used) { const declared = authority.roles[role]; if (declared !== undefined) rows.push(`#   角色 ${role} 的来源：${declared.source}${declared.bed_member === true ? '；bed_member 为 true' : ''}`); }
    for (const parameter of Object.values(authority.parameters)) if (usedTypes.delete(parameter.type.declaration.name)) rows.push(`#   类型 ${parameter.type.declaration.name} 的声明：${parameter.type.declaration.declaration}`);
    const kept = rows.slice(0, CONTRACT_BOUNDS.sources);
    if (rows.length > kept.length) cuts.note(`来源 ${rows.length} 条只列 ${kept.length} 条`);
    out.push('# 合约自己记录的这些依据的来源（引用照抄）：', ...kept);
  }
  out.push(limits(cuts, METHOD_LIMITS));
  return out;
}

const commonPrefix = (words: readonly string[]): string => {
  let prefix = words[0] ?? '';
  for (const word of words) while (!word.startsWith(prefix)) prefix = prefix.slice(0, -1);
  return prefix;
};

/** `--methods '<object>'`: the methods of one object by what the contract and the profile make of them. */
export function lookupMethods(source: MethodSource, name: string): string {
  const text = name.trim();
  if (text === '' || !WORD.test(text)) throw new CallFailure('invalid_parameters', `--methods 的值是一个对象名，不含点、空白和引号（现在是 ${JSON.stringify(name)}）`, "写法：--methods '<对象>'");
  const index = indexOf(source);
  const cuts = new Cuts();
  const object = index.byName.get(text);
  if (object === undefined) return `${[...missObjectLines(index, text, cuts, "# 下一步：--methods '<对象>' 列出某个对象本次可用的方法。"), limits(cuts, METHOD_LIMITS)].join('\n')}\n`;
  const out: string[] = [objectLine(object), ...seatOf(source, object.name, null, cuts).map((seat) => seat.line)];
  const count = (state: (method: Method) => boolean) => object.methods.filter(state).length;
  const enabled = object.methods.filter((method) => method.state === 'usable' || method.state === 'unopened' || method.state === 'candidate');
  out.push(`# 合约里 ${object.name} 有 ${object.methods.length} 个方法：启用 ${enabled.length} 个、禁用 ${count((method) => method.state === 'disabled')} 个、内部 ${count((method) => method.state === 'internal')} 个。启用的 ${enabled.length} 个按本次配置分：`);
  const groups: Array<{ state: State; title: (n: number, shownCount: number) => string; what: string }> = [
    { state: 'usable', what: '可写进计划的', title: (n, k) => `# 可以写进计划（合约启用，本次配置已开放，${n > k ? `${n} 个，显示前 ${k} 个` : `${n} 个`}）：` },
    { state: 'unopened', what: '本次未开放的', title: (n, k) => `# 合约启用但本次配置没有开放（${n > k ? `${n} 个，显示前 ${k} 个` : `${n} 个`}；写进计划会被拒绝）：` },
    { state: 'candidate', what: '认证候选', title: (n, k) => `# 合约里是认证候选、没有推广的（${n > k ? `${n} 个，显示前 ${k} 个` : `${n} 个`}；Hub 不把它们当作启用的方法）：` },
  ];
  for (const group of groups) {
    const rows = object.methods.filter((method) => method.state === group.state);
    if (rows.length === 0) continue;
    const shown = rows.slice(0, CONTRACT_BOUNDS.methods);
    out.push(group.title(rows.length, shown.length));
    for (const method of shown) {
      const signature = clip(String(method.entry.signature?.text), 300);
      const reason = group.state === 'unopened' ? (() => { const record = index.unopened.get(pair(method.object, method.name)); const first = record === undefined ? undefined : (Array.isArray(record.row.parameters) ? record.row.parameters : []).find(isRecord) as Row | undefined; return `  —  ${first === undefined ? '配置没有记原因' : clip(String(first.reason), 200)}`; })() : '';
      out.push(`${method.object}.${method.name} ${signature}  [${String(method.entry.dispatch)}]${reason}`);
    }
    if (rows.length > shown.length) {
      const hidden = rows.slice(shown.length).map((method) => method.name);
      const prefix = commonPrefix(hidden) || hidden[0]![0]!;
      out.push(`# 还有 ${rows.length - shown.length} 个没有列出：--method '${object.name}.<前缀>' 按前缀找，例如 --method '${object.name}.${prefix}'。`);
      cuts.note(`${group.what}${group.state === 'candidate' ? '' : '方法'} ${rows.length} 个只显示 ${shown.length} 个`);
    }
  }
  if (enabled.length === 0) out.push('# 没有启用的方法：这个对象本次没有可写进计划的方法。');
  out.push(`# 禁用的 ${count((method) => method.state === 'disabled')} 个、内部的 ${count((method) => method.state === 'internal')} 个不逐个列出；--method '${object.name}.<方法>' 看某个方法的状态和原因。`, objectsLine(index, cuts), limits(cuts, METHOD_LIMITS));
  return `${out.join('\n')}\n`;
}

// ----------------------------------------------------------------------------------------------------------------------------
// Block kinds.

export interface BlockExample { file: string; /** One-based place of the block in the sample and how many blocks the sample has. */ index: number; count: number; block: unknown }
export interface BlockSource {
  /** run.json's slots.schema: what the run froze for the plan. */
  schema: unknown;
  schemaSha256: string | null;
  /** tables/blocks-format.json of the pack. */
  table: Row;
  /** The sample the pack has of a kind, or null. */
  example: (kind: string) => BlockExample | null;
}

const BLOCK_LIMITS = `字段最多列 ${CONTRACT_BOUNDS.fields} 个，字段说明每条最多 ${CONTRACT_BOUNDS.fieldChars} 字符，示例最多 ${CONTRACT_BOUNDS.exampleChars} 字符，块种类最多列 ${CONTRACT_BOUNDS.kinds} 个`;
/**
 * The fields whose values the block table closes, by the scope (a block kind or a plan member) and the path of the field in it, and
 * the list of the table that holds the values. Each is a membership the Hub's own checks make against that list.
 */
const CLOSED_FIELDS: Readonly<Record<string, string>> = {
  'CAPTURE_COMPARE:relation': 'relations',
  'EXPECT_FROM:op': 'assertion_ops',
  'OBSERVE_ASSERT:assertions.op': 'assertion_ops',
  'block_context:preconditions.state': 'precondition_states',
  'block_context:responders.kind': 'responder_kinds',
  'criteria:kind': 'criterion_kinds',
  'obligations:status': 'obligation_states',
};

const scalar = (node: Row): boolean => ['string', 'integer', 'number', 'boolean'].includes(String(node.type)) && node.enum === undefined;
function bounds(node: Row): string | null {
  const low = node.minItems, high = node.maxItems;
  if (low !== undefined && high !== undefined) return `${low}..${high} 项`;
  if (low !== undefined) return `至少 ${low} 项`;
  return high !== undefined ? `至多 ${high} 项` : null;
}
function constraints(node: Row): string[] {
  const out: string[] = [];
  if (Array.isArray(node.enum)) out.push(`取值 ${list(node.enum.map(String))}`);
  if (node.type === 'string') {
    if (typeof node.maxLength === 'number') out.push(`至多 ${node.maxLength} 个字符`);
    if (typeof node.minLength === 'number' && node.minLength > 1) out.push(`至少 ${node.minLength} 个字符`);
    if (typeof node.pattern === 'string') out.push(`形状 ${node.pattern}`);
  }
  return out;
}
const scalarWord = (node: Row): string => (node.type === 'string' ? '字符串' : node.type === 'boolean' ? '布尔' : '整数');
function integerText(node: Row): string {
  const low = node.minimum, high = node.maximum;
  if (low !== undefined && high !== undefined) return ` ${low}..${high}`;
  if (low !== undefined) return ` ≥${low}`;
  return high !== undefined ? ` ≤${high}` : '';
}

/** What a field holds, as one line: structure only, from the schema. Objects nest to two levels with their types, then by names. */
function summarize(node: unknown, level = 0): string {
  if (!isRecord(node)) return '任意值';
  if (node.const !== undefined) return `固定为 ${JSON.stringify(node.const)}`;
  const arms = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : null;
  if (arms !== null) return arms.every((arm) => isRecord(arm) && scalar(arm)) ? arms.map((arm) => summarize(arm, level)).join('或') : `以下之一：${arms.map((arm, at) => `（${at + 1}）${summarize(arm, level)}`).join('；')}`;
  if (node.type === 'string') { const more = constraints(node); return `字符串${more.length ? `，${more.join('，')}` : ''}`; }
  if (node.type === 'integer' || node.type === 'number') return `整数${integerText(node)}`;
  if (node.type === 'boolean') return '布尔';
  if (node.type === 'array') {
    const items = isRecord(node.items) ? node.items : {};
    const range = bounds(node);
    if (scalar(items)) { const item = constraints(items).filter((text) => !text.startsWith('取值')); const parts = [...(range === null ? [] : [range]), ...(item.length ? [`每项${item.join('，')}`] : [])]; return `${scalarWord(items)}数组${parts.length ? `（${parts.join('，')}）` : ''}`; }
    return `数组${range === null ? '' : `（${range}）`}，每项${summarize(items, level)}`;
  }
  if (node.type === 'object') {
    const properties = isRecord(node.properties) ? node.properties : {};
    const names = Object.keys(properties);
    if (names.length === 0) return isRecord(node.additionalProperties) ? `对象，值为${summarize(node.additionalProperties, level)}` : node.additionalProperties === true ? '对象（内容不限）' : '对象';
    if (level >= 2) return `对象（${list(names)}）`;
    const required = (Array.isArray(node.required) ? node.required : []).filter((name: unknown): name is string => typeof name === 'string' && names.includes(name));
    const optional = names.filter((name) => !required.includes(name));
    const part = (name: string): string => `${name}（${summarize(properties[name], level + 1)}）`;
    return `对象：${[required.length ? `必填 ${list(required.map(part))}` : '', optional.length ? `可选 ${list(optional.map(part))}` : ''].filter(Boolean).join('；')}`;
  }
  return '任意值';
}

/** The descriptions of nested fields: path, text; an array's items are told as `每项的`. */
function nestedDescriptions(node: unknown, path: string, out: Array<[string, string]> = []): Array<[string, string]> {
  if (!isRecord(node)) return out;
  if (node.type === 'array' && isRecord(node.items)) return nestedDescriptions(node.items, `${path} 每项的`, out);
  for (const arm of Array.isArray(node.anyOf) ? node.anyOf : []) nestedDescriptions(arm, path, out);
  if (isRecord(node.properties)) for (const [name, child] of Object.entries(node.properties)) {
    const here = path.endsWith('的') ? `${path} ${name}` : `${path}.${name}`;
    if (isRecord(child) && typeof child.description === 'string') out.push([here, child.description]);
    nestedDescriptions(child, here, out);
  }
  return out;
}
/** The paths of the fields of a node (a field of an array's items is told by the array's name), as `a.b`. */
function fieldPaths(node: unknown, prefix = '', out = new Set<string>()): Set<string> {
  if (!isRecord(node)) return out;
  if (isRecord(node.properties)) for (const [name, child] of Object.entries(node.properties)) { const path = prefix === '' ? name : `${prefix}.${name}`; out.add(path); fieldPaths(child, path, out); }
  if (isRecord(node.items)) fieldPaths(node.items, prefix, out);
  for (const arm of Array.isArray(node.anyOf) ? node.anyOf : []) fieldPaths(arm, prefix, out);
  return out;
}

const KIND = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The frozen plan schema's `data` object: its members, the kinds of its blocks and which members it requires. */
function planOf(schema: unknown): { arms: Map<string, Row>; members: Map<string, Row>; required: string[] } {
  const at = (node: unknown, ...path: string[]): unknown => path.reduce<unknown>((current, key) => (isRecord(current) ? current[key] : undefined), node);
  const data = at(schema, 'properties', 'plan', 'items', 'properties', 'data');
  const arms = at(data, 'properties', 'blocks', 'items', 'anyOf');
  if (!Array.isArray(arms) || !isRecord(at(data, 'properties'))) throw new CallFailure('invalid_parameters', 'run.json 里冻结的 slots.schema 没有 plan 的块种类定义（properties.plan.items.properties.data.properties.blocks.items.anyOf）', '重新下载本次运行完整的 run.json；只有 case-compile 的脚本编写运行有这份定义');
  const kinds = new Map<string, Row>();
  for (const arm of arms) { const kind = isRecord(arm) ? at(arm, 'properties', 'kind', 'const') : undefined; if (typeof kind === 'string' && isRecord(arm)) kinds.set(kind, arm); }
  const members = new Map<string, Row>();
  for (const [name, node] of Object.entries(at(data, 'properties') as Row)) if (name !== 'blocks' && isRecord(node)) members.set(name, node);
  const required = at(data, 'required');
  return { arms: kinds, members, required: Array.isArray(required) ? required.filter((name): name is string => typeof name === 'string') : [] };
}

/**
 * `--block '<name>'`: the fields a block kind takes, or the fields of one of the plan's other members (block_context, criteria,
 * obligations and the rest), from the frozen slot schema, the pack's block table and its sample.
 */
export function lookupBlock(source: BlockSource, query: string): string {
  const typed = query.trim();
  if (!KIND.test(typed)) throw new CallFailure('invalid_parameters', `--block 的值是一个块种类名或计划成员名（字母、数字、下划线；现在是 ${JSON.stringify(query)}）`, "写法：--block '<块种类>'，例如 --block 'CAPTURE_COMPARE'；或 --block 'block_context'");
  const { arms, members, required: planRequired } = planOf(source.schema);
  const rows = (Array.isArray(source.table.kinds) ? source.table.kinds : []).filter(isRecord) as Row[];
  const declared = (kind: string): Row | undefined => rows.find((row) => row.kind === kind);
  const cuts = new Cuts();
  const frozen = '本次运行冻结的计划结构';
  const where = `${frozen}（run.json 的 slots.schema${source.schemaSha256 === null ? '' : `，摘要 ${source.schemaSha256.slice(0, 12)}`}）`;
  const kind = arms.get(typed);
  const member = kind === undefined ? members.get(typed) : undefined;
  if (kind === undefined && member === undefined) {
    const kinds = [...arms.keys()], names = [...members.keys()];
    const found = sameStart(kinds, (name) => name, typed), foundMembers = sameStart(names, (name) => name, typed);
    const caseOnly = [...found.caseOnly, ...foundMembers.caseOnly];
    const told = (what: string, all: readonly string[], starts: readonly string[]): string => {
      const shown = starts.slice(0, CONTRACT_BOUNDS.near);
      if (starts.length > shown.length) cuts.note(`${what} ${starts.length} 个只列 ${shown.length} 个`);
      return `# 以 ${typed} 开头的${what}：${starts.length === 0 ? '无' : list(shown)}${starts.length > shown.length ? `（共 ${starts.length} 个，只列前 ${shown.length} 个）` : ''}。`;
    };
    const all = kinds.slice(0, CONTRACT_BOUNDS.kinds);
    if (kinds.length > all.length) cuts.note(`块种类 ${kinds.length} 个只列 ${all.length} 个`);
    const lines = [
      `# ${frozen}里没有块种类或计划成员 ${typed}。`,
      ...(caseOnly.length > 0 ? [`# 名字区分大小写，计划结构不折叠：这里的名字是 ${list(caseOnly)}，写的是 ${typed}。`] : []),
      told('块种类', kinds, found.starts),
      told('计划成员', names, foundMembers.starts),
      `# 全部块种类（${kinds.length} 个）：${list(all.map((name) => (declared(name)?.enabled === false ? `${name}（未启用）` : name)))}。`,
      `# 全部计划成员（${names.length} 个）：${list(names)}。`,
      "# 下一步：--block '<块种类或计划成员>' 看它的必填和可选字段。",
      limits(cuts, BLOCK_LIMITS),
    ];
    return `${lines.join('\n')}\n`;
  }

  const out: string[] = [];
  let node: Row, scope: string;
  if (kind !== undefined) {
    const row = declared(typed);
    out.push(`# 块种类 ${typed}：${where}里有它；分块表（tables/blocks-format.json）${row === undefined ? '没有它的声明，不知道它是否启用' : row.enabled === false ? '标为未启用' : '标为启用'}。`);
    if (row?.enabled === false) out.push(`# 分块表记的原因：${String(row.missing)}；下一步：${String(row.next_action)}。`, '# 计划里写了它，Hub 核对时记为未知并点名缺什么，不是拒绝；要完成这条期望，改用已启用的块种类。');
    node = kind;
    scope = typed;
  } else {
    node = member!;
    scope = typed;
    out.push(`# 计划成员 ${typed}：${where}里有它；是计划 data 的${planRequired.includes(typed) ? '必填' : '可选'}成员。`);
    const items = isRecord(node.items) ? node.items : null;
    const range = bounds(node);
    out.push(`# 形状：${node.type === 'array' ? `数组${range === null ? '' : `（${range}）`}，每项${items !== null && items.type === 'object' ? '是一个对象' : summarize(items)}` : node.type === 'object' ? '对象' : summarize(node)}`);
    if (typeof node.description === 'string') out.push(`# 说明：${clip(node.description, CONTRACT_BOUNDS.fieldChars)}`);
    // The fields of a member are those of the object it is, or of the objects an array of it holds.
    node = node.type === 'array' && isRecord(node.items) ? node.items : node;
    if (!isRecord(node.properties)) out.push(`# 每项没有逐字段的声明：${summarize(node)}`);
  }
  const properties = isRecord(node.properties) ? node.properties : {};
  const required = (Array.isArray(node.required) ? node.required : []).filter((name: unknown): name is string => typeof name === 'string' && name in properties);
  const optional = Object.keys(properties).filter((name) => !required.includes(name));
  let room = CONTRACT_BOUNDS.fields, clippedCount = 0;
  const clipped = (text: string): string => { const made = clip(text, CONTRACT_BOUNDS.fieldChars); if (made !== text) clippedCount++; return made; };
  const field = (name: string): string[] => {
    const child = properties[name] as Row;
    const lines = [`#   ${name}：${summarize(child)}${typeof child.description === 'string' ? `。${clipped(child.description)}` : ''}`];
    for (const [path, text] of nestedDescriptions(child, name)) lines.push(`#     ${path}：${clipped(text)}`);
    return lines;
  };
  for (const [title, group] of [['必填字段', required], ['可选字段', optional]] as const) {
    if (group.length === 0) continue;
    out.push(`# ${title}（${group.length}）：`);
    for (const name of group) { if (room-- > 0) out.push(...field(name)); }
  }
  if (required.length + optional.length > CONTRACT_BOUNDS.fields) cuts.note(`字段 ${required.length + optional.length} 个只列 ${CONTRACT_BOUNDS.fields} 个`);
  if (clippedCount > 0) cuts.note(`字段说明 ${clippedCount} 条被截短到 ${CONTRACT_BOUNDS.fieldChars} 字符`);
  if (node.additionalProperties === false && Object.keys(properties).length > 0) out.push(`# 不接受这些之外的字段（计划结构的 additionalProperties 为 false）。`);
  const closed: string[] = [];
  for (const path of fieldPaths(node)) {
    const table = CLOSED_FIELDS[`${scope}:${path}`];
    const values = table === undefined ? undefined : source.table[table];
    if (Array.isArray(values) && values.length > 0) closed.push(`${path}：${list(values.map((value) => (isRecord(value) ? String(value.op) : String(value))))}`);
  }
  if (closed.length > 0) out.push(`# 分块表给的封闭取值：${closed.join('；')}。`);
  if (kind !== undefined) {
    const example = source.example(typed);
    if (example === null) out.push('# 包里没有这个块种类的示例。');
    else {
      const line = JSON.stringify(example.block);
      out.push(`# 示例（包里的合成样例 ${example.file} 的第 ${example.index} 块，共 ${example.count} 块；对象、命令和引用都是虚构的，只看字段怎么写，不要照抄）：`, clip(line, CONTRACT_BOUNDS.exampleChars));
      if (line.length > CONTRACT_BOUNDS.exampleChars) cuts.note(`示例 ${line.length} 字符只显示 ${CONTRACT_BOUNDS.exampleChars} 字符`);
    }
  }
  out.push(limits(cuts, BLOCK_LIMITS));
  return `${out.join('\n')}\n`;
}
