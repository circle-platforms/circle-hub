// Deployment declarations only. No network I/O, command inference, or target verdicts.
import FORMAT from '../tables/probe-format.json' with { type: 'json' };
import { isRecord } from './text.ts';
import type { RuntimeContract, Problem } from './runtime-contract.ts';
export interface Probe { seat: string; object: string; method: string; command: string; purpose: string; extract: { pattern: string; group: string } }
export const PROBE_FORMAT = FORMAT;
export function probeCommand(value: unknown): value is string {
  if (typeof value !== 'string' || value !== value.trim() || value.length > FORMAT.max_command_chars || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) return false;
  const tokens = value.split(/ +/);
  if (!/^(show|get)$/i.test(tokens.shift() ?? '')) return false;
  if (!tokens.every((token) => token !== '' && [...token].every((char) => /[A-Za-z0-9_.,:/@%+=*"'\-]/.test(char)))) return false;
  return (value.match(/"/g)?.length ?? 0) % 2 === 0 && (value.match(/'/g)?.length ?? 0) % 2 === 0;
}
function extraction(value: unknown): value is Probe['extract'] {
  if (!isRecord(value) || typeof value.pattern !== 'string' || value.pattern.length === 0 || value.pattern.length > FORMAT.max_pattern_chars || typeof value.group !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(value.group)) return false;
  try { new RegExp(value.pattern, 'gu'); } catch { return false; }
  // Require exactly one capture, named by group. Escaped parentheses and character classes are literals.
  let escaped = false; let inClass = false; let captures = 0; let named = '';
  for (let i = 0; i < value.pattern.length; i++) {
    const char = value.pattern[i];
    if (escaped) { escaped = false; continue; } if (char === '\\') { escaped = true; continue; }
    if (char === '[') inClass = true; if (char === ']') inClass = false;
    if (inClass || char !== '(') continue;
    if (value.pattern[i + 1] !== '?') captures++;
    else if (value.pattern[i + 2] === '<' && !['=', '!'].includes(value.pattern[i + 3] ?? '')) { captures++; named = value.pattern.slice(i + 3, value.pattern.indexOf('>', i + 3)); }
  }
  return captures === 1 && named === value.group;
}
export function parseProbes(value: unknown, contract: RuntimeContract, seats: readonly { object: string }[], allowed: readonly { object: string; method: string; parameters: Record<string, string> }[]): { probes: Probe[]; problems: Problem[] } {
  const probes: Probe[] = []; const problems: Problem[] = []; const seen = new Set<string>();
  const issue = (pointer: string, message: string) => problems.push({ pointer, message, fix: '集成者只读核对该座位探测命令及命名捕获规则，按包的用途表改正配置后重新发布' });
  if (value === undefined) return { probes, problems }; // Older profiles declare no probes; dispatch must demand completeness.
  if (!Array.isArray(value)) return { probes, problems: [{ pointer: '/probes', message: '探测必须是列表', fix: '按配置格式填写 probes 列表' }] };
  for (const [i, raw] of value.entries()) {
    const at = `/probes/${i}`; const before = problems.length;
    if (!isRecord(raw)) { issue(at, '探测不是对象'); continue; }
    if (typeof raw.seat !== 'string' || !seats.some((s) => s.object === raw.seat)) issue(`${at}/seat`, '探测座位未登记');
    if (raw.object !== raw.seat || !contract.enabled.some((m) => m.object === raw.object && m.method === raw.method)) issue(at, '探测不是该座位的合约启用组合');
    const call = allowed.find((v) => v.object === raw.object && v.method === raw.method);
    if (!call || !Object.values(call.parameters).includes('device_cli')) issue(at, '探测组合没有设备命令角色；先在配置中定角色');
    if (!probeCommand(raw.command)) issue(`${at}/command`, '探测命令不合网关只读形状：show 或 get 开头、最多 200 字符的一行，参数字符受限且引号配对');
    if (typeof raw.purpose !== 'string' || !FORMAT.purposes.some((p) => p.code === raw.purpose)) issue(`${at}/purpose`, '探测用途不在包表中');
    if (!extraction(raw.extract)) issue(`${at}/extract`, '回显提取必须是可编译正则，且恰有一个与 group 同名的命名捕获组');
    const key = JSON.stringify([raw.seat, raw.purpose]); if (seen.has(key)) issue(at, '座位和用途重复'); seen.add(key);
    if (before === problems.length) probes.push(raw as unknown as Probe);
  }
  return { probes, problems };
}
export function extractProbeValues(probe: Probe, reply: string): { values: string[]; missing: boolean } {
  const values: string[] = [];
  for (const match of reply.matchAll(new RegExp(probe.extract.pattern, 'gu'))) { const value = match.groups?.[probe.extract.group]; if (value !== undefined && value !== '') values.push(value); }
  return { values, missing: values.length === 0 };
}
/** Missing deployment facts for the client/integrator, never an inference about device state. */
export function missingProbes(probes: readonly Probe[], seats: readonly { object: string; device: string }[]): Array<{ seat: string; device: string; purpose: string; missing: string; next: string }> {
  return seats.flatMap((seat) => FORMAT.purposes.filter((purpose) => !probes.some((p) => p.seat === seat.object && p.purpose === purpose.code)).map((purpose) => ({ seat: seat.object, device: seat.device, purpose: purpose.code, missing: `缺少该座位的${purpose.label}探测命令与命名捕获规则`, next: '集成者从台架只读核对后填写 probes，重新运行配置 --check 和 probes 转换' })));
}
