/**
 * C14: reader wording when上机验证 is refused at release checks.
 * Judgment (satisfied true/false/null) is unchanged; this module only formats text from checks.
 */
import type { ReleaseCheck, ReleaseField } from './release-diagnostics.ts';

export interface RefusalTextInput {
  checks: readonly ReleaseCheck[];
  run: string;
  executor: string;
  /** The run's runner (发起人), not the acting administrator of dispatchAccepted. */
  callerIsAdmin: boolean;
}

/** How one release condition discloses sides and next steps (generic registry). */
export interface RefusalConditionSpec {
  /** Exact condition id, or prefix ending with `.` / known id. */
  condition: string;
  /** Fixed reader label (must match the check's label when registered for that id). */
  name: string;
  disclose(fields: readonly ReleaseField[], callerIsAdmin: boolean): string;
  nextCaller(input: RefusalTextInput): string;
  nextAdmin(input: RefusalTextInput): string;
}

const digest12 = (hex: string): string => (hex.length >= 12 ? hex.slice(0, 12) : hex);

/** Prefer plain disclosure; else first 12 of the field digest. Never invent values. */
function side(field: ReleaseField, which: 'expected' | 'actual'): string {
  const plain = which === 'expected' ? field.expected : field.actual;
  if (typeof plain === 'string' && plain.length > 0) return plain;
  const digest = which === 'expected' ? field.expected_sha256 : field.actual_sha256;
  return digest12(digest);
}

function fieldBy(fields: readonly ReleaseField[], name: string): ReleaseField | undefined {
  return fields.find((row) => row.field === name || row.field.endsWith('/' + name) || row.field.endsWith('.' + name));
}

/** Identity vs executor declaration: runner values always; declaration only for administrators. */
function discloseIdentity(fields: readonly ReleaseField[], callerIsAdmin: boolean): string {
  const target = fieldBy(fields, 'target');
  const manifest = fieldBy(fields, 'manifest_sha256') ?? fieldBy(fields, 'manifest');
  const actualTarget = target ? side(target, 'actual') : '未知';
  const actualManifest = manifest ? side(manifest, 'actual') : '未知';
  if (!callerIsAdmin) {
    return `这次脚本合并核对的是：测试环境 ${actualTarget}，清单 ${actualManifest}，和执行器声明的不一样`;
  }
  const expectedTarget = target ? side(target, 'expected') : '未知';
  const expectedManifest = manifest ? side(manifest, 'expected') : '未知';
  return `执行器声明的是：测试环境 ${expectedTarget}，清单 ${expectedManifest}。这次脚本合并核对的是：测试环境 ${actualTarget}，清单 ${actualManifest}`;
}

function discloseGeneric(fields: readonly ReleaseField[], callerIsAdmin: boolean): string {
  const mismatched = fields.filter((row) => row.matches === false);
  if (mismatched.length === 0) return '程序已判定为错误';
  if (!callerIsAdmin) return '这次脚本合并核对的值与放行所需不一致';
  return mismatched.map((row) => `${row.field} 执行器或放行所需摘要 ${digest12(row.expected_sha256)}，这次核对摘要 ${digest12(row.actual_sha256)}`).join('；');
}

function explainCommand(input: RefusalTextInput): string {
  return `circle-hub job explain-release --run ${input.run} --executor ${input.executor}`;
}

function withExplain(input: RefusalTextInput, body: string): string {
  return input.callerIsAdmin ? `${body}。逐条对照：${explainCommand(input)}` : body;
}

function nextIdentity(input: RefusalTextInput): string {
  if (input.callerIsAdmin) {
    return withExplain(input, '按执行器声明的测试环境和清单重新做脚本编写和脚本合并，再发起上机验证；或者登记一个和这次核对一致的执行器');
  }
  return '先确认预订的是哪个测试环境，用它对应的运行环境配置重新做脚本编写和脚本合并，再发起上机验证；预订和配置都没错时，请管理员核对执行器的声明';
}

function nextResultErrors(input: RefusalTextInput): string {
  return withExplain(input, '按脚本合并返回的错误逐条改正，脚本合并正确后再发起上机验证');
}

function nextGeneric(input: RefusalTextInput): string {
  if (input.callerIsAdmin) {
    return withExplain(input, '按上面的错误补齐后，再发起上机验证');
  }
  return '能在自动化用例 Excel 或预订上改的，改正后再发起上机验证；其余请管理员按放行条件逐条对照处理';
}

/**
 * Registry: one row per known condition id. Unlisted conditions use the generic disclose/next.
 * Quoted names stay the production check labels.
 */
export const REFUSAL_CONDITIONS: readonly RefusalConditionSpec[] = [
  {
    condition: 'proof.executor_identity',
    name: '核验目标与清单等于执行器声明',
    disclose: (fields, admin) => discloseIdentity(fields, admin),
    nextCaller: nextIdentity,
    nextAdmin: nextIdentity,
  },
  {
    condition: 'result.errors',
    name: '核验结果没有未消除错误',
    disclose: () => '脚本合并的结果里还有错误',
    nextCaller: nextResultErrors,
    nextAdmin: nextResultErrors,
  },
  {
    condition: 'release.parameters.keys',
    name: '派发参数字段集合与核验事实一致',
    disclose: discloseGeneric,
    nextCaller: nextGeneric,
    nextAdmin: nextGeneric,
  },
  {
    condition: 'release.parameters.',
    name: '派发参数与重新读取的核验事实一致',
    disclose: discloseGeneric,
    nextCaller: nextGeneric,
    nextAdmin: nextGeneric,
  },
];

function specFor(condition: string): RefusalConditionSpec | undefined {
  return REFUSAL_CONDITIONS.find((row) => condition === row.condition || (row.condition.endsWith('.') && condition.startsWith(row.condition)));
}

function flattenUnique(checks: readonly ReleaseCheck[]): ReleaseCheck[] {
  const seen = new Set<string>();
  const out: ReleaseCheck[] = [];
  for (const check of checks) {
    const key = check.condition + '\0' + check.label;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(check);
  }
  return out;
}

/**
 * Builds the refusal reason (without the leading「上机验证没有发出：」).
 * Errors only; unchecked become one summary line. No「已记下」.
 */
export function formatReleaseRefusal(input: RefusalTextInput): string {
  const checks = flattenUnique(input.checks);
  const errors = checks.filter((check) => check.satisfied === false);
  const unchecked = checks.filter((check) => check.satisfied === null);
  if (errors.length === 0 && unchecked.length === 0) {
    return '放行条件里没有可展示的错误条目；请管理员查看放行条件逐条对照';
  }
  if (errors.length === 0) {
    const missing = unchecked.map((check) => check.missing_fact).filter((text): text is string => typeof text === 'string' && text.length > 0);
    const what = missing[0] ?? '放行条件还不能判定';
    const next = input.callerIsAdmin
      ? withExplain(input, '补齐缺失事实后再发起上机验证')
      : '请管理员补齐缺失事实并查看放行条件逐条对照；当前账户先不要再发起这次上机验证';
    return `${what}；现在可以做：${next}；原因还没查清`;
  }
  const errorLines = errors.map((check) => {
    const spec = specFor(check.condition);
    const name = spec?.name ?? check.label;
    const detail = (spec ?? { disclose: discloseGeneric }).disclose(check.fields, input.callerIsAdmin);
    return `「${name}」判定为错误。${detail}。`;
  });
  const uncheckedLine =
    unchecked.length === 0
      ? ''
      : `另有 ${unchecked.length} 条因为上面的错误还没有核对。`;
  const first = errors[0];
  const firstSpec = specFor(first.condition);
  const next = (input.callerIsAdmin ? firstSpec?.nextAdmin : firstSpec?.nextCaller)?.(input) ?? nextGeneric(input);
  return [
    `放行条件里有 ${errors.length} 条错误。`,
    errorLines.join(''),
    uncheckedLine,
    `现在可以做：${next}`,
  ].filter((part) => part.length > 0).join('');
}

/** True when the note already states a diagnosed refusal (no「原因还没查清」suffix). */
export function releaseRefusalDiagnosed(message: string): boolean {
  return message.includes('放行条件里有 ') || (message.includes('另有 ') && message.includes('还没有核对'));
}
