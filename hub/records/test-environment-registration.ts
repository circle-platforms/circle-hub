import { TestEnvironment, TestEnvironmentInput } from '../../contracts/api.ts';
import { ConflictError } from './errors.ts';
import { newId } from './ids.ts';

/** Preserve exact-key responsibility; new owner selection is an administrator decision, never a historical claim. */
export function prepareTestEnvironmentRegistration(input: TestEnvironmentInput, actor: string, at: string, previous?: TestEnvironment): TestEnvironment {
  const value = TestEnvironmentInput.parse(input);
  if (previous && previous.target !== value.target) throw new ConflictError('测试环境的目标身份不能更换；请登记新的测试环境');
  return TestEnvironment.parse({
    ...value, schema: 'test-environment@1', id: previous?.id ?? newId('env'),
    prefixes: value.prefixes.map(row => {
      const old = previous?.prefixes.find(old => old.prefix === row.prefix);
      if (old && row.owner !== old.owner) throw new ConflictError('已有前缀的责任人不能通过普通修改更换');
      return old ?? { prefix: row.prefix, owner: row.owner ?? actor, registered_at: at };
    }),
    resources: value.resources.map(row => {
      const old = previous?.resources.find(old => old.key === row.key);
      if (old && row.owner !== old.owner) throw new ConflictError('已有资源的责任人不能通过普通修改更换');
      return old ?? { key: row.key, owner: row.owner ?? actor, registered_at: at };
    }),
  });
}
