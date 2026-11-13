// Retired keychain names refuse startup; errors contain names only.
import { RETIRED_NAMES, isRetiredName } from './names.ts';

export class HubEnvironmentError extends Error {
  readonly keys: readonly string[];
  constructor(message: string, keys: readonly string[]) {
    super(message);
    this.name = 'HubEnvironmentError';
    this.keys = Object.freeze([...keys]);
  }
}

export function retiredEnvironmentKeys(environment: Readonly<Record<string, string | undefined>> = process.env): string[] {
  return Object.keys(environment)
    .filter((key) => isRetiredName(key) && environment[key] !== undefined)
    .sort();
}

export function assertNoRetiredEnvironment(environment: Readonly<Record<string, string | undefined>> = process.env): void {
  const keys = retiredEnvironmentKeys(environment);
  if (keys.length === 0) return;
  const problems: string[] = [];
  for (const key of keys) if (isRetiredName(key)) problems.push(`circle-hub 不再读取 ${key}，只要设置了就拒绝启动。${RETIRED_NAMES[key]}`);
  throw new HubEnvironmentError(problems.join('\n'), keys);
}
