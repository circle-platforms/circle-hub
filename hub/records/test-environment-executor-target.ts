import { ExecutorDefinition, checkedExecutorReferences, type ExecutorSource } from '../../contracts/src/resources.ts';
import { referencesIn, resolve, VariableValue, type OrdinaryVariableUse } from '../../contracts/src/variables.ts';
import type { OrdinaryVariableOverrides } from './environment-write-consistency.ts';
import type { Transaction } from './api.ts';
import type { VariableSnapshot } from './variables.ts';
import { IntegrityError } from './errors.ts';

export class ExecutorTargetValueError extends IntegrityError {}

/** Deliberately has no secret/vault reader. The caller supplies its already-held transaction. */
export interface TestEnvironmentVariableReader {
  resolveVariables(value: unknown, at: string, snapshot: VariableSnapshot | undefined, tx: Transaction): Promise<{ value: unknown; uses: OrdinaryVariableUse[] }>;
}

export async function resolveTestEnvironmentExecutorTarget(source: ExecutorSource, variables: TestEnvironmentVariableReader, tx: Transaction, overrides?: OrdinaryVariableOverrides): Promise<{ target: string; uses: OrdinaryVariableUse[] }> {
  checkedExecutorReferences(source);
  const input = { target: source.target };
  if (!referencesIn(input).length) return { target: ExecutorDefinition.shape.target.parse(source.target), uses: [] };
  const reference = referencesIn(input)[0];
  const replacement = overrides?.get(reference.name);
  let resolved: { value: unknown; uses: OrdinaryVariableUse[] };
  if (replacement !== undefined) {
    if ('revoked' in replacement) throw new ExecutorTargetValueError('候选变量撤回后，执行器 target 没有可用的普通变量值');
    const value = VariableValue.parse(replacement.value);
    resolved = { value: resolve(input, () => value), uses: [] };
  } else resolved = await variables.resolveVariables(input, source.id ?? 'executor', undefined, tx);
  const target = resolved.value !== null && typeof resolved.value === 'object' && !Array.isArray(resolved.value)
    ? (resolved.value as Record<string, unknown>).target : undefined;
  if (typeof target !== 'string') throw new ExecutorTargetValueError('执行器 target 的普通变量当前值不是字符串，不能确定测试环境目标');
  const checked = ExecutorDefinition.shape.target.safeParse(target);
  if (!checked.success) throw new ExecutorTargetValueError('执行器 target 的普通变量字符串不符合目标定义的长度要求');
  return { target: checked.data, uses: resolved.uses };
}
