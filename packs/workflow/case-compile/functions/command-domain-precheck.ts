// Disclosure-only command-domain collection. No verdict, cleanup or resource-policy decision is produced.
import { createHash } from 'node:crypto';
import { parseRuntimeContract, type CommandDomainProbe } from './runtime-contract.ts';
import { parseManifest } from './manifest.ts';
import { parseProfile } from './profile.ts';
import { readSlots } from './slots.ts';
import { deviceCommandLines, planCommands } from './plan-commands.ts';
import { commandDefinitions, runnerRule, type CatalogCommandDefinition } from './command-obligations.ts';
import { commandIdentity, compileGrammar } from './generated/skills/command-tools/command-check/grammar.ts';
import { readCommandPolicy, within } from './generated/skills/command-tools/command-check/command-policy.ts';
import { identityOf } from './typed-contract.ts';
import { isRecord } from './text.ts';
import { planDataOf } from './subject.ts';
import { planStateOf } from './plan-state.ts';
import type { CommandIdentity } from '../../../../contracts/generated/shared-interfaces.ts';

export interface PrecheckInputs { root: string; contract: unknown; profile: unknown; inventory: unknown; catalog: unknown; plan: unknown }
export interface DisclosureGap { pointer: string; missing: string; next_action: string }
export interface ReadOnlyQuery { object: string; command: string; reference: string; identity: CommandIdentity; mapping: { contract_sha256: string; pointer: string; cleanup_source: string; cleanup_sha256: string } }
export interface ProbeObservation { reference: string; sha256: string; bytes: Uint8Array; complete: boolean }
/** Implementations must be the caller's already-authorized, read-only transport, never an arbitrary command runner. */
export interface ReadOnlyProbeReader { read(query: ReadOnlyQuery): Promise<ProbeObservation> }
export interface PrecheckRow {
  object: string; operation: { pointer: string; line: string; identity: CommandIdentity | null };
  rule: { index: number; source: string; sha256: string; line: number | null; pinned: boolean } | null;
  query: ReadOnlyQuery | null; observation?: { reference: string; sha256: string; bytes: number; complete: boolean };
  gaps: DisclosureGap[];
}
export interface CommandDomainReport {
  schema: 'command-domain-precheck@1'; disclosure_only: true; frozen_root: string; contract_sha256: string | null;
  rows: PrecheckRow[]; gaps: DisclosureGap[];
  limits: string[];
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const gap = (pointer: string, missing: string, next_action: string): DisclosureGap => ({ pointer, missing, next_action });
const LIMITS = [
  '本地预检不证明计划已由 Hub 受理；所需派发权限仍由既有运输和资源政策核对',
  '本报告只披露命令域映射和读取证据，不判断设备是否干净，不清理、不挂起、不授权或阻止派发',
  '只读属性来自版本化声明与调用方运输边界，未在此认证目标行为；原有资源政策独立生效',
  '观察的本地摘要核对不证明所附引用已由 Hub 存储，也不认证目标的只读运输前提',
  'probe 映射是发布者的显式声明，不宣称从清理源码提取；缺映射时不得猜测探测命令',
];
export function commandDomainPrecheck(input: PrecheckInputs): CommandDomainReport {
  const report: CommandDomainReport = { schema: 'command-domain-precheck@1', disclosure_only: true, frozen_root: input.root, contract_sha256: null, rows: [], gaps: [], limits: [...LIMITS] };
  if (!/^[a-f0-9]{64}$/.test(input.root) || !isRecord(input.catalog) || input.catalog.root !== input.root) {
    report.gaps.push(gap('/catalog/root', '目录身份未与冻结根绑定', '读取本运行冻结根对应的目录原件后重做报告')); return report;
  }
  const contract = parseRuntimeContract(input.contract), inventory = parseManifest(input.inventory);
  if (!contract.ok) { report.gaps.push(...contract.problems.map(p => gap('/contract' + p.pointer, p.message, p.fix))); return report; }
  report.contract_sha256 = contract.contract.digest;
  if (!inventory.ok) { report.gaps.push(...inventory.problems.map(p => gap('/inventory' + p.pointer, p.message, p.fix))); return report; }
  const profile = parseProfile(input.profile, contract.contract, inventory.beds);
  if (!profile.ok) { report.gaps.push(...profile.problems.map(p => gap('/profile' + p.pointer, p.message, p.fix))); return report; }
  const item = isRecord(input.plan) && typeof input.plan.item === 'string' ? input.plan : null;
  if (item && !planStateOf(item).process) { report.gaps.push(gap('/plan/handling', '该条声明跳过，没有待采证的计划命令', '保留跳过声明及其未确认依据，不以本报告证明不可编写')); return report; }
  const data = item ? planDataOf(item) : input.plan;
  const slots = readSlots(data);
  if (!slots.ok) { report.gaps.push(...slots.problems.map(p => gap('/plan' + p.pointer, p.message, '按冻结计划形状补齐资料后重新生成报告'))); return report; }
  const parsed = planCommands(contract.contract, profile.profile, slots.slots, input.catalog);
  report.gaps.push(...parsed.problems.map(p => gap(p.pointer, p.message, '从原运行补齐明确的目录或计划材料，不猜测命令身份')));
  if (input.catalog.complete !== true) report.gaps.push(gap('/catalog/complete', '命令目录覆盖未声明完整', '补齐冻结目录；本报告只列出能解析的已知部分'));
  const definitions = commandDefinitions(input.catalog), grammar = compileGrammar(definitions), policy = readCommandPolicy(input.catalog.policy);
  const cleanup = contract.contract.cleanup;
  const lines = deviceCommandLines(contract.contract, profile.profile, slots.slots, parsed.answers);
  for (const operation of lines) {
    const identity = identityOf(commandIdentity(grammar, operation.line));
    const row: PrecheckRow = { object: operation.object, operation: { pointer: operation.pointer, line: operation.line, identity }, rule: null, query: null, gaps: [] };
    report.rows.push(row);
    if (!identity) { row.gaps.push(gap(operation.pointer, '没有与冻结根绑定的完整且唯一类型化命令身份', '使用冻结命令树完整解析，不按命令文字猜测域')); continue; }
    if (policy?.read_only.some(path => within(identity.path, path))) continue;
    const matched = runnerRule(cleanup, operation.object, operation.line);
    if (!cleanup || !matched) { row.gaps.push(gap(operation.pointer, '没有覆盖该命令的已声明清理域', '由执行器规则发布者核对权威生成源并发布域映射')); continue; }
    const rule = cleanup.rules[matched.rule];
    row.rule = { index: matched.rule, source: cleanup.source, sha256: cleanup.sha256, line: rule.line, pinned: cleanup.pinned };
    if (!rule.probe) { row.gaps.push(gap(`/cleanup/rules/${matched.rule}/probe`, '该域没有显式只读探测映射', '由规则发布者在权威声明中给出冻结命令引用和完整命令，不从前缀造 show 命令')); continue; }
    row.query = queryFor(rule.probe, operation.object, grammar, definitions, policy, contract.contract.digest, cleanup.source, cleanup.sha256, matched.rule, row.gaps);
  }
  return report;
}
function queryFor(probe: CommandDomainProbe, object: string, grammar: ReturnType<typeof compileGrammar>, definitions: readonly CatalogCommandDefinition[], policy: ReturnType<typeof readCommandPolicy>, contract: string, source: string, sha256: string, rule: number, gaps: DisclosureGap[]): ReadOnlyQuery | null {
  const identity = identityOf(commandIdentity(grammar, probe.command));
  // Resolve the exact catalog reference through the same frozen declarations used by the full grammar.
  const bound = definitions.filter(entry => entry.reference === probe.reference && entry.path === identity?.path);
  const declaredIdentity = identityOf(commandIdentity(compileGrammar(bound), probe.command));
  if (!identity || !declaredIdentity || JSON.stringify(identity) !== JSON.stringify(declaredIdentity) || !policy?.read_only.some(path => within(identity.path, path))) {
    gaps.push(gap(`/cleanup/rules/${rule}/probe`, '探测命令引用、完整参数或只读策略未被同一冻结命令树核对', '补齐合法的完整查询及其只读声明；不执行当前探测')); return null;
  }
  return { object, command: probe.command, reference: probe.reference, identity, mapping: { contract_sha256: contract, pointer: `/cleanup/rules/${rule}/probe`, cleanup_source: source, cleanup_sha256: sha256 } };
}
/** Returns observations as evidence only. Reader failures never become cleanliness verdicts or dispatch decisions. */
export async function collectCommandDomainObservations(input: PrecheckInputs, reader: ReadOnlyProbeReader): Promise<CommandDomainReport> {
  // Rebuild from frozen inputs at the collection boundary; a serialized/edited report is not execution authority.
  const output = commandDomainPrecheck(structuredClone(input)), observed = new Map<string, Promise<ProbeObservation>>();
  for (const row of output.rows) {
    const query = row.query; if (!query) continue;
    const key = JSON.stringify([query.object, query.identity]);
    try {
      let request = observed.get(key); if (!request) { request = Promise.resolve().then(() => reader.read(structuredClone(query))); observed.set(key, request); }
      const result = await request;
      if (!result || !(result.bytes instanceof Uint8Array) || typeof result.complete !== 'boolean') { row.gaps.push(gap(query.mapping.pointer, '读取回执的字节或完整性字段未符合声明', '由运输维护者修复结构化回执，再重新采证')); continue; }
      const actual = digest(result.bytes);
      if (result.sha256 !== actual || result.reference !== 'src:' + actual) { row.gaps.push(gap(query.mapping.pointer, '读取字节与观察引用或摘要不符', '恢复可对应的原件；不把当前字节作为已核验证据')); continue; }
      row.observation = { reference: result.reference, sha256: actual, bytes: result.bytes.byteLength, complete: result.complete };
      if (!result.complete) row.gaps.push(gap(query.mapping.pointer, '探测输出不完整', '由运输维护者核对分页和提示符完整性后重新采证'));
    } catch { row.gaps.push(gap(query.mapping.pointer, '只读探测没有交付可核验观察', '由运输维护者核对原请求与只读回执；不据此判断设备状态')); }
  }
  return output;
}
