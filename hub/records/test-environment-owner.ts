import { TestEnvironment } from '../../contracts/api.ts';
import { UserId } from '../../contracts/src/common.ts';
import { ConflictError } from './errors.ts';

export type TestEnvironmentOwnerChange = { prefix: string; owner: string } | { key: string; owner: string };

/** A new explicit responsibility decision; the prior immutable declaration and all use grants are untouched. */
export function prepareTestEnvironmentOwnerChange(environment: TestEnvironment, input: TestEnvironmentOwnerChange, at: string): TestEnvironment {
  UserId.parse(input.owner);
  const value = structuredClone(environment);
  if ('prefix' in input) {
    const row = value.prefixes.find(row => row.prefix === input.prefix);
    if (!row) throw new ConflictError('没有这个登记前缀');
    row.owner = input.owner; row.registered_at = at;
  } else {
    const row = value.resources.find(row => row.key === input.key);
    if (!row) throw new ConflictError('没有这个登记资源键');
    row.owner = input.owner; row.registered_at = at;
  }
  return TestEnvironment.parse(value);
}
