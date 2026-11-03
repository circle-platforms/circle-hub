// What `circle-hub serve` needs from the platform before it opens the database and the vault, read from the same
// CIRCLE_HUB_* environment the LaunchAgent gives it and checked against the data root's deployment settings.
import { createContext, postgresFor } from './context.ts';
import { PLATFORM_VARIABLES, variable } from './environment.ts';
import { PlatformError } from './errors.ts';
import { DEFAULT_KEY_ACCOUNT, DEFAULT_KEY_SERVICE, fileKeyProvider, keyNamesOf, settingsKeyNames, type DeploymentKeyNames, type KeyProvider } from './file-key.ts';
import { ensureDatabaseRunning } from './postgres.ts';
import { assertApplicationRole, roleFixHint } from './roles.ts';
import { resolveLayout } from './layout.ts';
import { readSettingsFile, resolveSettings, settingsPath } from './settings.ts';

/**
 * Starts the cluster of the data root CIRCLE_HUB_DATA_DIR names, on the binaries of the running release, when it is
 * not running. Never initialises a cluster and never creates the Hub database: a missing one is an error (init or
 * restore create it). The database names are the deployment settings'; a variable that disagrees is refused. An
 * application role that owns anything or holds more than its grants is refused too (roles.ts): the Hub would run with
 * the power to drop its own history. Only large objects and default privileges, which any role may create without a
 * privilege and which give it no such power, are let through with a warning (`warn`, default stderr): backups refuse
 * them until they are removed. The cluster keeps running when the server exits, so KeepAlive restarts are quick.
 */
export async function ensureHubDatabase(
  env: NodeJS.ProcessEnv = process.env,
  options: { warn?: (line: string) => void } = {},
): Promise<{ started: boolean; created: boolean }> {
  if (variable(env, PLATFORM_VARIABLES.dataDir) === undefined) throw new PlatformError(`没有设置 ${PLATFORM_VARIABLES.dataDir}`, '服务的环境由 circle-hub service install 写好');
  const control = postgresFor(createContext(env));
  const result = await ensureDatabaseRunning(control);
  const report = await assertApplicationRole(control, '启动之前，', { allowWithoutPrivilege: true });
  if (report.problems.length > 0) {
    const warn = options.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
    warn(`注意：应用角色 ${control.application.user} ${report.problems.join('、')}，都是不需授权就能建的对象，Hub 照常启动，但备份和部署会拒绝；处理：${roleFixHint(control, report)}`);
  }
  return result;
}

/**
 * The keys of the deployment CIRCLE_HUB_DATA_DIR names, as hubKeyProvider resolves the vault master key's: the deployment
 * settings of that data root when it has them, with the same rule as the platform's own commands (settingsKeyNames); a
 * data root without settings (a development root) takes the defaults. Without CIRCLE_HUB_DATA_DIR it refuses: platform
 * commands would act on the default data root, whose settings may name other keys, so nothing is guessed
 * (ensureHubDatabase refuses the same). The operator token sits beside the vault master key (the same service, account
 * OPERATOR_TOKEN_ACCOUNT, which the vault master key may not use). Only the settings file is read here.
 */
export async function deploymentKeyNames(env: NodeJS.ProcessEnv = process.env): Promise<DeploymentKeyNames> {
  if (variable(env, PLATFORM_VARIABLES.dataDir) === undefined) {
    throw new PlatformError(
      `没有设置 ${PLATFORM_VARIABLES.dataDir}：密钥文件由部署的数据根里的部署设置决定，不猜默认数据根`,
      `服务的环境由 circle-hub service install 写好；在 shell 里运行时把 ${PLATFORM_VARIABLES.dataDir} 设成部署的数据根`,
    );
  }
  const layout = resolveLayout(env);
  const file = await readSettingsFile(layout);
  if (file) return settingsKeyNames(resolveSettings(file, env, layout), settingsPath(layout));
  return keyNamesOf(DEFAULT_KEY_SERVICE, DEFAULT_KEY_ACCOUNT);
}

/**
 * The vault master key from its file under <data root>/keys, on every platform (decision 137), named as
 * deploymentKeyNames resolves it; without CIRCLE_HUB_DATA_DIR the first use is refused, as ensureHubDatabase refuses.
 * The file is looked up at the first use.
 */
export function hubKeyProvider(env: NodeJS.ProcessEnv = process.env): Required<KeyProvider> {
  let resolved: Promise<Required<KeyProvider>> | undefined;
  const provider = () =>
    (resolved ??= deploymentKeyNames(env)
      .then(({ vaultKey }) => fileKeyProvider({ root: resolveLayout(env).root, ...vaultKey }))
      .catch((error: unknown) => {
        resolved = undefined;
        throw error;
      }));
  return {
    getKey: async () => (await provider()).getKey(),
    initKey: async () => (await provider()).initKey(),
  };
}
