import { TestEnvironment, type TestEnvironmentInput } from '../../contracts/api.ts';
import { ConflictError } from './errors.ts';

/** Move exact unregistered facts into a new identity without changing their old responsibility or time. */
export function adoptUnregisteredPrefixes(environment: TestEnvironment, input: TestEnvironmentInput, unregistered: readonly TestEnvironment[]): {
  environment: TestEnvironment; retained: TestEnvironment[]; archived: string[];
} {
  const result = structuredClone(environment), retained: TestEnvironment[] = [], archived: string[] = [];
  for (const old of unregistered) {
    if (old.target !== null) continue;
    const movedPrefixes = new Set<string>(), movedResources = new Set<string>();
    for (const row of old.prefixes) {
      const index = result.prefixes.findIndex(value => value.prefix === row.prefix);
      if (index < 0) continue;
      const requested = input.prefixes.find(value => value.prefix === row.prefix)!;
      if (row.owner !== null && requested.owner !== null && requested.owner !== row.owner) throw new ConflictError('原前缀的责任人不能通过登记测试环境更换');
      result.prefixes[index] = { ...row }; movedPrefixes.add(row.prefix);
    }
    for (const row of old.resources) {
      const index = result.resources.findIndex(value => value.key === row.key);
      if (index < 0) continue;
      const requested = input.resources.find(value => value.key === row.key)!;
      if (row.owner !== null && requested.owner !== null && requested.owner !== row.owner) throw new ConflictError('原资源的责任人不能通过登记测试环境更换');
      result.resources[index] = { ...row }; movedResources.add(row.key);
    }
    if (!movedPrefixes.size && !movedResources.size) continue;
    const prefixes = old.prefixes.filter(row => !movedPrefixes.has(row.prefix));
    const resources = old.resources.filter(row => !movedResources.has(row.key));
    if (!prefixes.length && !resources.length) archived.push(old.id);
    else retained.push(TestEnvironment.parse({ ...old, prefixes, resources }));
  }
  if ([...result.prefixes, ...result.resources].some(row => row.owner === null || row.registered_at === null))
    result.missing_facts = [...new Set([...result.missing_facts, '原登记的责任信息尚未完整'])];
  return { environment: TestEnvironment.parse(result), retained, archived };
}
