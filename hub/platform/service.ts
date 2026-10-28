// What `circle-hub serve` needs from the platform before it opens the database and the vault, read from the same
// CIRCLE_HUB_* environment the LaunchAgent gives it and checked against the data root's deployment settings.
import { createContext, postgresFor } from './context.ts';
import { PLATFORM_VARIABLES, variable } from './environment.ts';
import { PlatformError } from './errors.ts';
import { deploymentKeychainNames, keychainKeyProvider, type KeychainOptions, type KeyProvider } from './keychain.ts';
import { ensureDatabaseRunning } from './postgres.ts';
import { assertApplicationRole, roleFixHint } from './roles.ts';
import { fileKeyProvider } from './file-key.ts';
import { resolveLayout } from './layout.ts';

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
 * The vault master key from its keychain item as deploymentKeychainNames resolves it: the deployment settings of
 * CIRCLE_HUB_DATA_DIR (CIRCLE_HUB_KEYCHAIN_SERVICE and _ACCOUNT may only repeat them); a data root without settings (a
 * development root) takes the variables, else the defaults; without CIRCLE_HUB_DATA_DIR the first use is refused, as
 * ensureHubDatabase refuses. The item is looked up at the first use.
 */
export function hubKeyProvider(env: NodeJS.ProcessEnv = process.env, options: Pick<KeychainOptions, 'runner' | 'keychain'> & {platform?: NodeJS.Platform} = {}): Required<KeyProvider> {
  let resolved: Promise<Required<KeyProvider>> | undefined;
  const provider = () =>
    (resolved ??= deploymentKeychainNames(env)
      .then(({ vaultKey }) => (options.platform ?? process.platform) === 'linux'
        ? fileKeyProvider({ root: resolveLayout(env).root, ...vaultKey })
        : keychainKeyProvider({ ...options, ...vaultKey }))
      .catch((error: unknown) => {
        resolved = undefined;
        throw error;
      }));
  return {
    getKey: async () => (await provider()).getKey(),
    initKey: async () => (await provider()).initKey(),
  };
}
