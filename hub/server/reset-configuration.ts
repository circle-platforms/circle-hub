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

/** Owner transport for offline apply; identity remains the original standard Session administrator token. */
export function resetOwnerEnvironment(config: HubConfig, context: PlatformContext, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const target = postgresFor(context).target;
  assertResetTarget(config.database,target);
  const result = { ...env };
  delete result.CIRCLE_HUB_DATABASE_HOST;
  result.CIRCLE_HUB_DATABASE_SOCKET_DIR = target.socketDir;
  result.CIRCLE_HUB_DATABASE_PORT = String(target.port);
  result.CIRCLE_HUB_DATABASE_NAME = target.database;
  result.CIRCLE_HUB_DATABASE_USER = target.user;
  return result;
}
