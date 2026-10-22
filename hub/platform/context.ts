// Everything a platform command needs from its surroundings, in one object so tests can replace each part.
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { libpqDirectory } from './backup.ts';
import { PlatformError } from './errors.ts';
import { keychainStore, settingsKeychainNames, type DeploymentKeychainNames, type KeychainStore } from './keychain.ts';
import { defaultLaunchAgentsDirectory, launchAgent, type LaunchAgent, type ServiceIdentity } from './launchd.ts';
import { resolveLayout, type Layout } from './layout.ts';
import { createPostgres, type PostgresControl } from './postgres.ts';
import { runCommand, type CommandRunner } from './process.ts';
import { deploymentDatabase, readSettings, sameDatabase, SERVICE_LABEL, settingsPath, type DatabaseNames, type PlatformSettings } from './settings.ts';

export interface PlatformContext {
  env: NodeJS.ProcessEnv;
  layout: Layout;
  /**
   * Operating-system account that owns the deployment; also the cluster's superuser role, which owns the Hub database and
   * every object in it and runs initdb, the migrations, pg_dump and pg_restore.
   */
  user: string;
  uid: number;
  home: string;
  runner: CommandRunner;
  launchAgentsDir: string;
  /** A keychain file instead of the user's default keychain. */
  keychain?: string;
  /** Node binary for the service and for migrations; default: the settings, then a stable path to this Node. */
  nodePath?: string;
  libpqBin: string;
  /** Root of the code running this command; its node_modules holds the PostgreSQL binaries. */
  codeRoot: string;
  /** The deployment settings' names when the data root has settings, else the names init will write. */
  database: DatabaseNames;
  healthTimeoutMs: number;
  now: () => Date;
  npm: string;
  git: string;
  tar: string;
  /** Progress lines for the operator. */
  log: (line: string) => void;
}

export const CODE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function createContext(env: NodeJS.ProcessEnv = process.env, overrides: Partial<PlatformContext> = {}): PlatformContext {
  const home = overrides.home ?? homedir();
  const layout = overrides.layout ?? resolveLayout(env, home);
  return {
    env,
    layout,
    user: overrides.user ?? userInfo().username,
    uid: overrides.uid ?? process.getuid?.() ?? userInfo().uid,
    home,
    runner: overrides.runner ?? runCommand,
    launchAgentsDir: overrides.launchAgentsDir ?? defaultLaunchAgentsDirectory(home),
    ...(overrides.keychain ? { keychain: overrides.keychain } : {}),
    ...(overrides.nodePath ? { nodePath: overrides.nodePath } : {}),
    libpqBin: overrides.libpqBin ?? libpqDirectory(undefined, env),
    codeRoot: overrides.codeRoot ?? CODE_ROOT,
    database: overrides.database ?? deploymentDatabase(layout, env),
    healthTimeoutMs: overrides.healthTimeoutMs ?? 90_000,
    now: overrides.now ?? (() => new Date()),
    npm: overrides.npm ?? 'npm',
    git: overrides.git ?? 'git',
    tar: overrides.tar ?? 'tar',
    log: overrides.log ?? (() => {}),
  };
}

/** The deployment settings of the data root. A context whose database names differ from them is refused. */
export async function settingsOf(context: PlatformContext): Promise<PlatformSettings> {
  const settings = await readSettings(context.layout, context.env);
  if (!sameDatabase(settings.database, context.database)) {
    const text = (names: DatabaseNames) => `${names.name}/${names.role}/${names.port}`;
    throw new PlatformError(`数据库名与部署设置不一致：${text(context.database)}，部署设置里是 ${text(settings.database)}`, '部署设置是唯一的来源');
  }
  return settings;
}

/** The data root's cluster, run on the binaries under `binariesRoot` (a release directory) or this checkout's. */
export function postgresFor(context: PlatformContext, binariesRoot?: string): PostgresControl {
  return createPostgres({
    layout: context.layout,
    admin: context.user,
    role: context.database.role,
    port: context.database.port,
    database: context.database.name,
    runner: context.runner,
    binariesRoot: binariesRoot ?? context.codeRoot,
  });
}

export function identityOf(context: PlatformContext): ServiceIdentity {
  return { home: context.home, user: context.user, database: context.database };
}

/** One lock for every command that changes the data root: deploy, rollback, backup, restore. */
export function platformLockPath(context: PlatformContext): string {
  return join(context.layout.run, 'platform.lock');
}

export function agentFor(context: PlatformContext, settings: Pick<PlatformSettings, 'label'> = { label: SERVICE_LABEL }): LaunchAgent {
  return launchAgent({ label: settings.label, directory: context.launchAgentsDir, uid: context.uid, runner: context.runner });
}

/**
 * The deployment's keychain items, from its settings. A vault master key account that is the operator token's is refused:
 * `serve` would refuse it too, so deploy, rollback and service install|start check it before anything changes.
 */
export function keychainNamesFor(context: PlatformContext, settings: PlatformSettings): DeploymentKeychainNames {
  return settingsKeychainNames(settings, settingsPath(context.layout));
}

/** The vault master key's item of the deployment; a reserved account (the operator token's) is refused. */
export function keychainFor(context: PlatformContext, settings: PlatformSettings): KeychainStore {
  return keychainStore({
    ...keychainNamesFor(context, settings).vaultKey,
    runner: context.runner,
    ...(context.keychain ? { keychain: context.keychain } : {}),
  });
}
