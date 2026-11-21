import type { ReleaseCheck, ReleaseField } from './release-diagnostics.ts';

export interface RefusalTextInput {
  checks: readonly ReleaseCheck[];
  run: string;
  executor: string;
  callerIsAdmin: boolean;
}

type NextInput = Pick<RefusalTextInput, 'callerIsAdmin'> & Partial<Pick<RefusalTextInput, 'run' | 'executor'>>;

export interface RefusalConditionSpec {
  condition: string;
  name: string;
  disclose(fields: readonly ReleaseField[], callerIsAdmin: boolean): string;
  nextCaller(input: NextInput): string;
  nextAdmin(input: NextInput): string;
}

const digest12 = (hex: string): string => (hex.length >= 12 ? hex.slice(0, 12) : hex);

function side(field: ReleaseField, which: 'expected' | 'actual'): string {
  const plain = which === 'expected' ? field.expected : field.actual;
  if (typeof plain === 'string' && plain.length > 0) return plain;
  const digest = which === 'expected' ? field.expected_sha256 : field.actual_sha256;
  return digest12(digest);
}

function fieldBy(fields: readonly ReleaseField[], name: string): ReleaseField | undefined {
  return fields.find((row) => row.field === name || row.field.endsWith('/' + name) || row.field.endsWith('.' + name));
}

function discloseIdentity(fields: readonly ReleaseField[], callerIsAdmin: boolean): string {
  const target = fieldBy(fields, 'target');
  const manifest = fieldBy(fields, 'manifest_sha256') ?? fieldBy(fields, 'manifest');
  const actualTarget = target ? side(target, 'actual') : '未知';
  const actualManifest = manifest ? side(manifest, 'actual') : '未知';
  if (!callerIsAdmin) {
    return `这次核验的是：测试环境 ${actualTarget}，清单 ${actualManifest}，和执行器声明的不一样`;
  }
  const expectedTarget = target ? side(target, 'expected') : '未知';
  const expectedManifest = manifest ? side(manifest, 'expected') : '未知';
  return `执行器声明的是：测试环境 ${expectedTarget}，清单 ${expectedManifest}。这次核验的是：测试环境 ${actualTarget}，清单 ${actualManifest}`;
}

function discloseGeneric(fields: readonly ReleaseField[], callerIsAdmin: boolean): string {
  const mismatched = fields.filter((row) => row.matches === false);
  if (mismatched.length === 0) return '程序已判定为错误';
  if (!callerIsAdmin) return '这次核验的值与放行所需不一致';
  return mismatched.map((row) => `${row.field} 执行器或放行所需摘要 ${digest12(row.expected_sha256)}，这次核对摘要 ${digest12(row.actual_sha256)}`).join('；');
}

function withExplain(input: NextInput, body: string): string {
  return input.callerIsAdmin && input.run && input.executor ? `${body}。逐条对照：circle-hub job explain-release --run ${input.run} --executor ${input.executor}` : body;
}

function nextIdentity(input: NextInput): string {
  if (input.callerIsAdmin) {
    return withExplain(input, '按执行器声明的测试环境和清单重新开始运行并重新核验，再发起上机验证；或者登记一个和这次核验一致的执行器');
  }
  return '先确认预订的是哪个测试环境，用它对应的运行环境配置重新开始运行并重新核验，再发起上机验证；预订和配置都没错时，请管理员核对执行器的声明';
}

function nextResultErrors(input: NextInput): string {
  return withExplain(input, '按核验返回的错误逐条改正，核验正确后再发起上机验证');
}

function nextGeneric(input: NextInput): string {
  if (input.callerIsAdmin) {
    return withExplain(input, '按上面的错误补齐后，再发起上机验证');
  }
  return '能在产物或预订上改的，改正后再发起上机验证；其余请管理员按放行条件逐条对照处理';
}

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
    disclose: () => '这次核验返回的错误还没有改正',
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

export function releaseNextStep(check: Pick<ReleaseCheck, 'condition' | 'satisfied'>, input: NextInput): string {
  if (check.satisfied === null) {
    return input.callerIsAdmin
      ? withExplain(input, '补齐缺失事实后再发起上机验证')
      : '请管理员补齐缺失事实并查看放行条件逐条对照；当前账户先不要再发起这次上机验证';
  }
  const spec = specFor(check.condition);
  return (input.callerIsAdmin ? spec?.nextAdmin : spec?.nextCaller)?.(input) ?? nextGeneric(input);
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
    return `${what}；现在可以做：${releaseNextStep(unchecked[0], input)}；原因还没查清`;
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
  return [
    `放行条件里有 ${errors.length} 条错误。`,
    errorLines.join(''),
    uncheckedLine,
    `现在可以做：${releaseNextStep(errors[0], input)}`,
  ].filter((part) => part.length > 0).join('');
}

export function releaseRefusalDiagnosed(message: string): boolean {
  return message.includes('放行条件里有 ') || (message.includes('另有 ') && message.includes('还没有核对'));
}
