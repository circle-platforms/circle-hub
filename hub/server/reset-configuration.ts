import { assertResetTarget } from './reset-target.ts';
import type { HubConfig } from '../config/index.ts';
import { postgresFor, type PlatformContext } from '../platform/api.ts';
import { createResetConfigurationPorts } from './cli-apply.ts';

/** Offline reset callbacks use the database owner, never the serving application's restricted role. */
export function boundResetConfigurationPorts(config: HubConfig, context: PlatformContext, applyDefinition: (path: string) => Promise<void>) {
  const target = postgresFor(context).target;
  assertResetTarget(config.database, target);
  const recordsConfig = { ...config, dataDir: context.layout.root, database: {
    host: target.socketDir, port: target.port, user: target.user, database: target.database,
  } };
  return createResetConfigurationPorts({
    config: recordsConfig,
    applyDefinition,
  });
}
