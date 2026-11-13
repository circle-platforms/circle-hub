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

/** How one release condition discloses expectation/actual and next steps (generic registry). */
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
function discloseIdentity(fields: readonly ReleaseField[], callerIsAdmin: boolean, nouns: { target: string; manifest: string }): string {
  const target = fieldBy(fields, 'target');
  const manifest = fieldBy(fields, 'manifest_sha256') ?? fieldBy(fields, 'manifest');
  const actualTarget = target ? side(target, 'actual') : '未知';
  const actualManifest = manifest ? side(manifest, 'actual') : '未知';
  if (!callerIsAdmin) {
    return `${nouns.target}实际为 ${actualTarget}、${nouns.manifest} ${actualManifest}；与执行器声明的不一样`;
  }
  const expectedTarget = target ? side(target, 'expected') : '未知';
  const expectedManifest = manifest ? side(manifest, 'expected') : '未知';
  return `期望${nouns.target} ${expectedTarget}、${nouns.manifest} ${expectedManifest}；实际${nouns.target} ${actualTarget}、${nouns.manifest} ${actualManifest}`;
}

function discloseGeneric(fields: readonly ReleaseField[], callerIsAdmin: boolean): string {
  const mismatched = fields.filter((row) => row.matches === false);
  if (mismatched.length === 0) return '程序已判定为错误';
  if (!callerIsAdmin) return '看到的值与放行所需不一致';
  return mismatched.map((row) => `${row.field} 期望摘要 ${digest12(row.expected_sha256)}、实际摘要 ${digest12(row.actual_sha256)}`).join('；');
}

function explainCommand(input: RefusalTextInput): string {
  return `circle-hub job explain-release --run ${input.run} --executor ${input.executor}`;
}

function nextRedoMerge(input: RefusalTextInput): string {
  if (input.callerIsAdmin) {
    return `用与执行器一致的测试环境和清单重做脚本合并后原样重交；或登记与核验事实一致的执行器。逐条对照：${explainCommand(input)}`;
  }
  return '能在提交、自动化用例 Excel 或预订上改的，改后原样重交；请管理员按该运行的放行条件逐条对照处理';
}

function nextFixSubmission(input: RefusalTextInput): string {
  if (input.callerIsAdmin) {
    return `消除核验结果里的错误后原样重交。逐条对照：${explainCommand(input)}`;
  }
  return '消除核验结果里的错误后原样重交；请管理员查看放行条件逐条对照';
}

function nextGeneric(input: RefusalTextInput): string {
  if (input.callerIsAdmin) {
    return `按上面的错误补齐后原样重交。逐条对照：${explainCommand(input)}`;
  }
  return '能在提交、自动化用例 Excel 或预订上改的，改后原样重交；其余请管理员按放行条件逐条对照处理';
}

/**
 * Registry: one row per known condition id. Unlisted conditions use the generic disclose/next.
 * Labels stay the production check labels (no coined product names).
 */
export const REFUSAL_CONDITIONS: readonly RefusalConditionSpec[] = [
  {
    condition: 'proof.executor_identity',
    name: '核验目标与清单等于执行器声明',
    disclose: (fields, admin) => discloseIdentity(fields, admin, { target: '测试环境', manifest: '清单摘要' }),
    nextCaller: nextRedoMerge,
    nextAdmin: nextRedoMerge,
  },
  {
    condition: 'result.errors',
    name: '核验结果没有未消除错误',
    disclose: () => '核验结果里仍有错误',
    nextCaller: nextFixSubmission,
    nextAdmin: nextFixSubmission,
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
    return '放行条件尚未全部正确；请管理员查看放行条件逐条对照';
  }
  if (errors.length === 0) {
    const missing = unchecked.map((check) => check.missing_fact).filter((text): text is string => typeof text === 'string' && text.length > 0);
    const what = missing[0] ?? '放行条件还不能判定';
    const next = input.callerIsAdmin
      ? `补齐缺失事实后重跑。逐条对照：${explainCommand(input)}`
      : '请管理员补齐缺失事实并查看放行条件逐条对照；你这边暂不要原样重交指望这次放行';
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
  // One next-step block from the first error's registry row (caller and admin share the same wording keyed by role).
  const first = errors[0];
  const firstSpec = specFor(first.condition);
  const next = (input.callerIsAdmin ? firstSpec?.nextAdmin : firstSpec?.nextCaller)?.(input) ?? nextGeneric(input);
  const body = [`放行未通过：${errorLines.join('')}`, uncheckedLine, `现在可以做：${next}`].filter((part) => part.length > 0).join('');
  return body.endsWith('。') ? body : `${body}。`;
}

/** True when the note already states a diagnosed refusal (no「原因还没查清」suffix). */
export function releaseRefusalDiagnosed(message: string): boolean {
  return message.includes('放行未通过：') || (message.includes('另有 ') && message.includes('还没有核对'));
}
