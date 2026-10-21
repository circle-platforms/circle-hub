// Retired-name guard (adapted from the earlier hub-environment guard). The pre-rename CIRCLE_SERVER_* names were retired on
// 2026-10-16 and are never read, copied or aliased. A process that still carries one, even empty or beside its replacement,
// refuses to start instead of silently running with defaults such as another database. Errors name keys only, never values.
import { HUB_PREFIX, RETIRED_PREFIX, isHubEnvironmentName } from './names.ts';

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
    .filter((key) => key.startsWith(RETIRED_PREFIX) && environment[key] !== undefined)
    .sort();
}

export function assertNoRetiredEnvironment(environment: Readonly<Record<string, string | undefined>> = process.env): void {
  const keys = retiredEnvironmentKeys(environment);
  if (keys.length === 0) return;
  const renames = keys
    .map((key) => {
      const replacement = `${HUB_PREFIX}${key.slice(RETIRED_PREFIX.length)}`;
      return isHubEnvironmentName(replacement) ? `${key} -> ${replacement}` : `${key}（没有同名的新变量，见配置说明）`;
    })
    .join('，');
  throw new HubEnvironmentError(
    `circle-hub 不再读取 ${RETIRED_PREFIX}* 配置，只要设置了就拒绝启动。请删除这些变量，改用 ${HUB_PREFIX}* 名字：${renames}`,
    keys,
  );
}
