// The environment of an operator command run on the machine that hosts a deployment: the CIRCLE_HUB_* values the service
// gets (serviceEnvironment), taken from the deployment settings, for every name the caller has not set itself. So
// `circle-hub pack list` works in a shell that exports nothing, and an explicit variable still wins. Nothing is returned
// when there is no deployment (a development checkout) or its settings cannot be read: the command then reports the
// missing configuration itself, as hub/config does.
import { homedir, userInfo } from 'node:os';
import { PLATFORM_VARIABLES } from './environment.ts';
import { resolveLayout, type DataRootHost } from './layout.ts';
import { serviceEnvironment } from './launchd.ts';
import { deploymentDatabase, readSettings, readSettingsFileSync } from './settings.ts';

/** Optional host values are supplied by synthetic cross-platform tests; production uses the effective OS account. */
export interface OperatorHost extends DataRootHost { effectiveHome?: string }

export async function operatorEnvironment(env: NodeJS.ProcessEnv = process.env, home?: string, host: OperatorHost = {}): Promise<Record<string, string>> {
  try {
    const platform = host.platform ?? process.platform;
    const effectiveHome = home ?? (platform === 'linux' ? host.effectiveHome ?? userInfo().homedir : homedir());
    const user = host.username ?? userInfo().username;
    const layout = resolveLayout(env, effectiveHome, {platform, username:user});
    if (readSettingsFileSync(layout) === undefined) return {};
    const settings = await readSettings(layout, env);
    const database = deploymentDatabase(layout, env);
    const full = serviceEnvironment(layout, settings, { home:effectiveHome, user, database });
    const names = new Set<string>(Object.values(PLATFORM_VARIABLES));
    return Object.fromEntries(Object.entries(full).filter(([name]) => names.has(name) && (env[name] === undefined || env[name] === '')));
  } catch {
    return {};
  }
}
