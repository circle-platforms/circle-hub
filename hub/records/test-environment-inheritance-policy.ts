import type { TestEnvironment } from '../../contracts/api.ts';

/** A formal workflow namespace must reach an actual registered target before its audience inherits all cutover environments. */
export function workflowBooksTestEnvironments(prefix: string, environments: readonly TestEnvironment[]): boolean {
  return environments.some(environment => environment.target !== null && (environment.prefixes.some(row => row.prefix.startsWith(prefix)) || environment.resources.some(row => row.key.startsWith(prefix))));
}
