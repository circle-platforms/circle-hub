import type { TestEnvironment } from '../../contracts/api.ts';
import { ConflictError } from './errors.ts';

export type OrdinaryVariableWrite = { name: string; value: unknown } | { name: string; revoked: true };
export type OrdinaryVariableOverrides = ReadonlyMap<string, { value: unknown } | { revoked: true }>;
type Claim = { prefix: string } | { key: string };
const claims = (value: TestEnvironment): Claim[] => [...value.prefixes.map(row => ({ prefix: row.prefix })), ...value.resources.map(row => ({ key: row.key }))];
const valueOf = (claim: Claim) => 'prefix' in claim ? claim.prefix : claim.key;
const contains = (outer: Claim, inner: Claim) => 'prefix' in outer ? valueOf(inner).startsWith(outer.prefix) : 'key' in inner && outer.key === inner.key;
const overlap = (a: Claim, b: Claim) => contains(a, b) || contains(b, a);

export class EnvironmentWriteError extends ConflictError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message, { code: 'SUBMISSION_SCHEMA_VIOLATION', detail });
    this.name = 'EnvironmentWriteError';
  }
}

/** Check new namespace claims only; retained/narrowed historical claims do not require a globally clean catalog. */
export function assertNoNewEnvironmentOverlap(candidate: TestEnvironment, values: readonly TestEnvironment[], previous?: TestEnvironment): void {
  if (candidate.target === null) return;
  const old = previous ? claims(previous) : [];
  for (const left of claims(candidate)) {
    if (old.some(value => contains(value, left))) continue;
    for (const other of values) {
      if (other.id === candidate.id || other.target === null) continue;
      for (const right of claims(other)) if (overlap(left, right)) {
        throw new EnvironmentWriteError(`测试环境“${candidate.name ?? '尚未命名'}”的${'prefix' in left ? '前缀' : '资源键'}“${valueOf(left)}”与测试环境“${other.name ?? '尚未命名'}”的${'prefix' in right ? '前缀' : '资源键'}“${valueOf(right)}”重叠`, { environment: candidate.id, other_environment: other.id, proposed: left, existing: right });
      }
    }
  }
}

export function namespaceIsRetained(candidate: TestEnvironment, previous: TestEnvironment): boolean {
  return candidate.name === previous.name && candidate.target === previous.target && claims(candidate).every(value => claims(previous).some(old => contains(old, value)));
}
