import { TestEnvironment, TestEnvironmentInput } from '../../contracts/api.ts';
import { ConflictError } from './errors.ts';
import { newId } from './ids.ts';

/** Existing responsibility is immutable per exact key; newly declared keys are this administrator's new facts. */
export function prepareTestEnvironmentRegistration(input: TestEnvironmentInput, actor: string, at: string, previous?: TestEnvironment): TestEnvironment {
  const value = TestEnvironmentInput.parse(input);
  if (previous && previous.target !== value.target) throw new ConflictError('测试环境的目标身份不能更换；请登记新的测试环境');
  return TestEnvironment.parse({
    ...value, schema: 'test-environment@1', id: previous?.id ?? newId('env'),
    prefixes: value.prefixes.map(row => previous?.prefixes.find(old => old.prefix === row.prefix) ?? { prefix: row.prefix, owner: actor, registered_at: at }),
    resources: value.resources.map(row => previous?.resources.find(old => old.key === row.key) ?? { key: row.key, owner: actor, registered_at: at }),
  });
}
