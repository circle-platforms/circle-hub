import { QualifierMarkSchema, type Reason } from '../../../contracts/generated/vocabulary.ts';
import { Claim } from '../../../contracts/src/claim.ts';
import type { DeviceHelpPosition, DeviceHelpResult, DeviceObservation, DeviceReadResult } from '../../../contracts/src/pack.ts';
import { toolLocalMinute } from '../../telemetry/api.ts';

const PROBE_RULE = 'dispatch.version_probe@1';
const OBSERVE_RULE = 'runs.observe_devices@1';

const shaOf = (reference: string): string | null => /^src:([0-9a-f]{64})/.exec(reference)?.[1] ?? null;

export function observationClaims(result: { observed: DeviceObservation[]; missing: string | null }, at: string): Claim[] {
  const claims = result.observed.map((o) => {
    const sha = shaOf(o.reference);
    return Claim.parse({
      statement: {
        text: o.build !== null ? `${o.label} 装的是 ${o.build}（设备回显，观察于 ${toolLocalMinute(o.observed_at)}）` : `${o.label} 没看出装的是哪个构建：${o.note ?? '版本探针的回显里没有唯一的构建'}`,
        data: { label: o.label, inventory: o.inventory, device: o.device, build: o.build, values: o.values },
        ...(o.build === null ? { verdict: 'unknown', reason: 'missing_input' } : {}),
      },
      qualifier: { nature: o.build !== null ? 'fact' : 'unknown', provenance: 'observed', marks: [], collected_at: o.observed_at },
      grounds: sha !== null ? [o.reference] : [],
      warrant: { producer: 'function', id: PROBE_RULE },
      validity: { status: 'valid', bound: sha !== null ? [sha, o.inventory] : [o.inventory], premises: [] },
    });
  });
  if (result.missing !== null) {
    claims.push(Claim.parse({
      statement: { text: result.missing, data: { missing: result.missing, kind: 'no_command_devices' } },
      qualifier: { nature: 'fact', provenance: 'projected', marks: [], collected_at: at },
      grounds: [],
      warrant: { producer: 'function', id: OBSERVE_RULE },
      validity: { status: 'valid', bound: [], premises: [] },
    }));
  }
  return claims;
}

const HELP_RULE = 'dispatch.device_help@1';
const ASK_RULE = 'runs.ask_devices@1';
const HELP_MARKS = QualifierMarkSchema.extract(['target_reported', 'local_ops_not_excluded']).options;
const HELP_PREMISE = '目标这一版的问位置工具只读：不按回车、输入行总是清掉（premises.read_only，已认证）';

export function deviceHelpClaims(results: readonly DeviceHelpResult[], at: string): Claim[] {
  const claims: Claim[] = [];
  const data = (r: DeviceHelpResult) => ({ label: r.label, inventory: r.inventory, device: r.device, line: r.line, mode: r.mode });
  const unknown = (r: DeviceHelpResult, text: string, fact: string, next: string, reason: Reason, grounds: string[]): Claim => Claim.parse({
    statement: { text, data: { ...data(r), asked: r.positions.length > 0, missing_fact: fact, next_action: next }, verdict: 'unknown', reason },
    qualifier: { nature: 'unknown', provenance: 'projected', marks: [], collected_at: at },
    grounds,
    warrant: { producer: 'function', id: ASK_RULE },
    validity: { status: 'valid', bound: [r.inventory, ...grounds.flatMap((g) => shaOf(g) ?? [])], premises: [] },
  });
  for (const r of results) {
    if (r.positions.length === 0) {
      const fact = r.missing?.fact ?? `${r.label}：没有问成，原因不明`;
      const next = r.missing?.next_action ?? '再问一次';
      claims.push(unknown(r, `没有向设备问：${fact}。下一步：${next}`, fact, next, 'missing_input', []));
      continue;
    }
    const at0 = r.positions.findIndex((p) => p.described);
    const answered = at0 >= 0 ? r.positions[at0]! : null;
    const longer = at0 > 0 ? r.positions[at0 - 1]! : null;
    const none = (p: DeviceHelpPosition) => (p.caret_only === true ? '设备只回了一个插入符，没有文字' : '设备没有回说明');
    const summary = answered === null
      ? `问了 ${r.positions.length} 个位置，最短的“${r.positions.at(-1)!.prefix} ?”处设备也没有给出说明`
      : answered.next_word === null
        ? `设备在整行“${r.line} ?”处给出了说明`
        : longer === null
          ? `设备给出说明的最长的被问前缀是“${answered.prefix}”（比它长的前缀没有问）`
          : `设备给出说明的最长前缀是“${answered.prefix}”；它后面的词是“${answered.next_word}”，设备在“${longer.prefix} ?”处没有给出说明（${none(longer)}）`;
    const groundsOf = (p: DeviceHelpPosition) => [p.reference, ...(p.text_reference === null ? [] : [p.text_reference])];
    const refs = r.positions.flatMap(groundsOf);
    claims.push(Claim.parse({
      statement: { text: `${r.label} 上问“${r.line}”：${summary}`, data: { ...data(r), kind: 'summary', words: r.words, asked: r.positions.length, described_prefix: answered?.prefix ?? null, next_word: answered?.next_word ?? null } },
      qualifier: { nature: 'fact', provenance: 'projected', marks: HELP_MARKS, collected_at: r.positions[0]!.observed_at },
      grounds: refs,
      warrant: { producer: 'function', id: HELP_RULE },
      validity: { status: 'valid', bound: [r.inventory, ...refs.flatMap((g) => shaOf(g) ?? [])], premises: [HELP_PREMISE] },
    }));
    for (const p of r.positions) {
      const lines = p.text === null ? 0 : p.text.split('\n').length;
      const text = p.anomaly !== null
        ? `设备对“${p.prefix} ?”的应答不呈现：${p.anomaly}`
        : p.withheld
          ? `设备在“${p.prefix} ?”处给出了说明，但 Hub 的凭据扫描扣住了这一段，这里不引用；管理员能在原件里看`
          : p.described
            ? `设备在“${p.prefix} ?”处给出了说明（${lines} 行${p.truncated ? '，这里只列了前一部分，全文见原件' : ''}）`
            : `设备在“${p.prefix} ?”处：${none(p)}`;
      const base = { ...data(r), kind: 'position', prefix: p.prefix, words: p.words, next_word: p.next_word, described: p.described, caret_only: p.caret_only, help: p.text, truncated: p.truncated, withheld: p.withheld, anomaly: p.anomaly };
      claims.push(Claim.parse({
        statement: p.anomaly !== null ? { text, data: base, verdict: 'unknown', reason: 'integrity_unproven' } : { text, data: base },
        qualifier: { nature: p.anomaly !== null ? 'unknown' : 'fact', provenance: 'observed', marks: p.anomaly !== null ? [] : HELP_MARKS, collected_at: p.observed_at },
        grounds: groundsOf(p),
        warrant: { producer: 'function', id: HELP_RULE },
        validity: { status: 'valid', bound: [r.inventory, ...groundsOf(p).flatMap((g) => shaOf(g) ?? [])], premises: p.anomaly !== null ? [] : [HELP_PREMISE] },
      }));
    }
    if (r.missing !== null) claims.push(unknown(r, `没有问完：${r.missing.fact}。下一步：${r.missing.next_action}`, r.missing.fact, r.missing.next_action, r.positions.some((p) => p.anomaly !== null) ? 'integrity_unproven' : 'missing_input', []));
  }
  return claims;
}

const READ_RULE = 'dispatch.device_read@1';
const READ_MARKS = HELP_MARKS;
const READ_PREMISE = '设备的输出只说明这条命令当时在这台设备上的输出写法和排版：它不是运行的来源，不能作为期望值的依据';

export function deviceReadClaims(results: readonly DeviceReadResult[], at: string): Claim[] {
  return results.map((r) => {
    const data = { label: r.label, inventory: r.inventory, device: r.device, line: r.line };
    const a = r.answer;
    const grounds = a === null ? [] : [a.reference, ...(a.text_reference === null ? [] : [a.text_reference])];
    const bound = [r.inventory, ...grounds.flatMap((g) => shaOf(g) ?? [])];
    if (a === null || r.missing !== null || a.anomaly !== null) {
      const fact = r.missing?.fact ?? `${r.label}：没有读成，原因不明`;
      const next = r.missing?.next_action ?? '再读一次';
      return Claim.parse({
        statement: { text: `${r.sent ? '没有读成' : '没有读设备'}：${fact}。下一步：${next}`, data: { ...data, sent: r.sent, missing_fact: fact, next_action: next, ...(a === null ? {} : { anomaly: a.anomaly }) }, verdict: 'unknown', reason: a !== null && a.anomaly !== null ? 'integrity_unproven' : 'missing_input' },
        qualifier: { nature: 'unknown', provenance: 'projected', marks: [], collected_at: a?.observed_at ?? at },
        grounds,
        warrant: { producer: 'function', id: READ_RULE },
        validity: { status: 'valid', bound, premises: [] },
      });
    }
    const lines = a.output === null ? 0 : a.output.split(/\r\n|\r|\n/).length;
    const said = a.withheld
      ? '设备有输出，但 Hub 的凭据扫描扣住了这一段，这里不引用；管理员能在原件里看'
      : a.has_output
        ? `设备输出 ${lines} 行${a.truncated ? '，这里只列了前一部分，全文见原件' : ''}`
        : '设备没有输出文字';
    return Claim.parse({
      statement: { text: `在 ${r.label} 上读“${r.line}”：${said}`, data: { ...data, has_output: a.has_output, output: a.output, truncated: a.truncated, withheld: a.withheld } },
      qualifier: { nature: 'fact', provenance: 'observed', marks: READ_MARKS, collected_at: a.observed_at },
      grounds,
      warrant: { producer: 'function', id: READ_RULE },
      validity: { status: 'valid', bound, premises: [READ_PREMISE] },
    });
  });
}
