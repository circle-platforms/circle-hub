import { TestEnvironmentPrefix, type TestEnvironment } from '../../contracts/api.ts';
import { newId } from './ids.ts';

/** A known responsibility registration without a target is not an environment or a use permission. */
export function prepareBookingPrefixRegistration(input: { prefix: string; owner: string }, at: string): TestEnvironment {
  const prefix = TestEnvironmentPrefix.parse({ ...input, registered_at: at });
  return { schema: 'test-environment@1', id: newId('env'), name: null, target: null, prefixes: [prefix], resources: [], executors: [], enabled: true, missing_facts: [] };
}

export function isBookingPrefixRegistration(value: TestEnvironment): boolean {
  return value.target === null && value.resources.length === 0 && value.executors.length === 0 && value.prefixes.length > 0
    && value.prefixes.every(row => row.owner !== null && row.registered_at !== null) && value.missing_facts.length === 0;
}
