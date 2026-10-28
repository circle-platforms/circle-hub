// The user LaunchAgent that keeps `circle-hub serve` running, managed with launchctl bootstrap, bootout and kickstart in
// the gui/<uid> domain (the login session, where the login keychain is unlocked). Tests generate plists and use a fake
// runner; they never call launchctl.
import { realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PLATFORM_VARIABLES } from './environment.ts';
import { PlatformError } from './errors.ts';
import { exists, writeFileAtomic } from './files.ts';
import type { Layout } from './layout.ts';
import { runCommand, tailLines, toolEnvironment, type CommandRunner } from './process.ts';
import type { DatabaseNames, PlatformSettings } from './settings.ts';

export interface ServiceDefinition {
  label: string;
  programArguments: string[];
  workingDirectory: string;
  environment: Record<string, string>;
  standardOutPath: string;
  standardErrorPath: string;
}

export interface ServiceStatus {
  plist: string;
  installed: boolean;
  loaded: boolean;
  running: boolean;
  pid?: number;
  lastExit?: string;
}

export interface LaunchAgent {
  readonly plist: string;
  readonly service: string;
  /** Writes the plist and loads it; RunAtLoad starts the service. A loaded older definition is unloaded first. */
  install(definition: ServiceDefinition): Promise<void>;
  /** Unloads and removes the plist; true when there was something to remove. */
  uninstall(): Promise<boolean>;
  /** Loads the installed plist, or kickstarts a loaded service that is not running; true when it acted. */
  start(): Promise<boolean>;
  /** Unloads the service (it comes back at the next login or start); true when it was loaded. */
  stop(): Promise<boolean>;
  status(): Promise<ServiceStatus>;
}

export interface LaunchAgentOptions {
  label: string;
  /** Directory of the plist, ~/Library/LaunchAgents in production. */
  directory: string;
  uid: number;
  runner?: CommandRunner;
  launchctl?: string;
}

const LABEL = /^[A-Za-z0-9._-]{1,128}$/;
// XML 1.0 forbids these characters even when escaped.
const XML_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;
export const SERVICE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

export function defaultLaunchAgentsDirectory(home: string = homedir()): string {
  return join(home, 'Library', 'LaunchAgents');
}

export interface ServiceIdentity {
  home: string;
  /** Operating-system account; its own role is the cluster's superuser, which owns the Hub database. */
  user: string;
  /** `role` is the application role the service connects as. */
  database: DatabaseNames;
}

/**
 * The service's environment: the CIRCLE_HUB_* names hub/config reads (it refuses any other name under the prefix), all
 * given explicitly so the server never falls back to a default that differs from this data root, plus PATH, HOME, USER.
 * CIRCLE_HUB_DATABASE_USER is the application role: `serve` connects as it and does not migrate. The deploy's migrate
 * step runs `serve --migrate-only` with this same environment; that connects as the account's own role (the owner) and
 * grants CIRCLE_HUB_DATABASE_USER (MIGRATE_ARGUMENTS in deploy.ts). hub/config has no name for the owner role.
 */
export function serviceEnvironment(layout: Layout, settings: PlatformSettings, identity: ServiceIdentity): Record<string, string> {
  return {
    [PLATFORM_VARIABLES.dataDir]: layout.root,
    [PLATFORM_VARIABLES.port]: String(settings.port),
    ...(settings.listenHost ? { [PLATFORM_VARIABLES.host]: settings.listenHost } : {}),
    ...(settings.allowedHosts ? { [PLATFORM_VARIABLES.allowedHosts]: settings.allowedHosts.join(',') } : {}),
    ...(settings.proxyOrigin ? { [PLATFORM_VARIABLES.proxyOrigin]: settings.proxyOrigin } : {}),
    ...(settings.proxyPeer ? { [PLATFORM_VARIABLES.proxyPeer]: settings.proxyPeer } : {}),
    [PLATFORM_VARIABLES.databaseSocketDir]: layout.run,
    [PLATFORM_VARIABLES.databasePort]: String(identity.database.port),
    [PLATFORM_VARIABLES.databaseName]: identity.database.name,
    [PLATFORM_VARIABLES.databaseUser]: identity.database.role,
    [PLATFORM_VARIABLES.keychainService]: settings.keychainService,
    [PLATFORM_VARIABLES.keychainAccount]: settings.keychainAccount,
    HOME: identity.home,
    PATH: SERVICE_PATH,
    USER: identity.user,
  };
}

export function serviceDefinition(layout: Layout, settings: PlatformSettings, options: ServiceIdentity & { node: string }): ServiceDefinition {
  return {
    label: settings.label,
    programArguments: [options.node, join(layout.current, 'bin', 'circle-hub'), 'serve'],
    workingDirectory: layout.current,
    environment: serviceEnvironment(layout, settings, options),
    standardOutPath: join(layout.logs, 'hub.out.log'),
    standardErrorPath: join(layout.logs, 'hub.err.log'),
  };
}

function xml(text: string): string {
  if (XML_FORBIDDEN.test(text)) throw new PlatformError('服务定义里有 XML 不允许的控制字符');
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export function renderPlist(definition: ServiceDefinition): string {
  if (!LABEL.test(definition.label)) throw new PlatformError(`服务标签只能含字母、数字、点、下划线和连字符：${definition.label}`);
  if (definition.programArguments.length === 0) throw new PlatformError('服务没有要运行的程序');
  const string = (value: string, indent: string) => `${indent}<string>${xml(value)}</string>`;
  const env = Object.keys(definition.environment)
    .sort()
    .flatMap((key) => [`\t\t<key>${xml(key)}</key>`, string(definition.environment[key]!, '\t\t')]);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>Label</key>',
    string(definition.label, '\t'),
    '\t<key>ProgramArguments</key>',
    '\t<array>',
    ...definition.programArguments.map((arg) => string(arg, '\t\t')),
    '\t</array>',
    '\t<key>WorkingDirectory</key>',
    string(definition.workingDirectory, '\t'),
    '\t<key>EnvironmentVariables</key>',
    '\t<dict>',
    ...env,
    '\t</dict>',
    '\t<key>RunAtLoad</key>',
    '\t<true/>',
    '\t<key>KeepAlive</key>',
    '\t<true/>',
    '\t<key>ThrottleInterval</key>',
    '\t<integer>10</integer>',
    '\t<key>ExitTimeOut</key>',
    '\t<integer>30</integer>',
    '\t<key>Umask</key>',
    '\t<integer>63</integer>',
    '\t<key>StandardOutPath</key>',
    string(definition.standardOutPath, '\t'),
    '\t<key>StandardErrorPath</key>',
    string(definition.standardErrorPath, '\t'),
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** Fields of `launchctl print`. Only whether the job runs matters here. */
export function parsePrint(output: string): { running: boolean; pid?: number; lastExit?: string } {
  const state = /^\s*state = (.+)$/m.exec(output)?.[1]?.trim();
  const pid = /^\s*pid = (\d+)$/m.exec(output)?.[1];
  const lastExit = /^\s*last exit code = (.+)$/m.exec(output)?.[1]?.trim();
  return { running: state === 'running', ...(pid ? { pid: Number(pid) } : {}), ...(lastExit ? { lastExit } : {}) };
}

export function launchAgent(options: LaunchAgentOptions): LaunchAgent {
  if (!LABEL.test(options.label)) throw new PlatformError(`服务标签只能含字母、数字、点、下划线和连字符：${options.label}`);
  const runner = options.runner ?? runCommand;
  const launchctl = options.launchctl ?? '/bin/launchctl';
  const domain = `gui/${options.uid}`;
  const service = `${domain}/${options.label}`;
  const plist = join(options.directory, `${options.label}.plist`);
  const env = toolEnvironment();
  const run = async (args: string[], action: string) => {
    const result = await runner(launchctl, args, { env, timeoutMs: 120_000 });
    if (result.code !== 0) throw new PlatformError(`${action}失败（launchctl 退出码 ${result.code}）：${tailLines(result.stderr || result.stdout) || '没有输出'}`);
  };

  const status = async (): Promise<ServiceStatus> => {
    const installed = await exists(plist);
    const result = await runner(launchctl, ['print', service], { env, timeoutMs: 30_000 });
    if (result.code !== 0) return { plist, installed, loaded: false, running: false };
    return { plist, installed, loaded: true, ...parsePrint(result.stdout) };
  };

  return {
    plist,
    service,
    status,

    async install(definition) {
      if (definition.label !== options.label) throw new PlatformError(`服务标签不一致：${definition.label} 与 ${options.label}`);
      const text = renderPlist(definition);
      if ((await status()).loaded) await run(['bootout', service], '卸下旧的服务定义');
      await writeFileAtomic(plist, text, 0o644);
      await run(['bootstrap', domain, plist], '加载服务');
    },

    async uninstall() {
      const current = await status();
      if (current.loaded) await run(['bootout', service], '卸下服务');
      if (current.installed) await rm(plist, { force: true });
      return current.loaded || current.installed;
    },

    async start() {
      const current = await status();
      if (!current.installed) throw new PlatformError('服务还没安装', '先运行 circle-hub service install');
      if (!current.loaded) {
        await run(['bootstrap', domain, plist], '加载服务');
        return true;
      }
      if (current.running) return false;
      await run(['kickstart', service], '启动服务');
      return true;
    },

    async stop() {
      if (!(await status()).loaded) return false;
      await run(['bootout', service], '停止服务');
      return true;
    },
  };
}

/** A stable path for the service's Node: Homebrew's symlink survives `brew upgrade`, the Cellar path does not. */
export async function stableNodePath(execPath: string = process.execPath): Promise<string> {
  const actual = await realpath(execPath).catch(() => execPath);
  for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
    if ((await realpath(candidate).catch(() => undefined)) === actual) return candidate;
  }
  return execPath;
}

export async function checkNode(node: string, runner: CommandRunner = runCommand): Promise<string> {
  const result = await runner(node, ['--version'], { env: toolEnvironment(), timeoutMs: 30_000 });
  const match = /^v(\d+)\./.exec(result.stdout.trim());
  if (result.code !== 0 || !match) throw new PlatformError(`无法确认 ${node} 的版本`);
  if (Number(match[1]) < 24) throw new PlatformError(`${node} 是 ${result.stdout.trim()}，服务需要 Node 24 或更新`);
  return result.stdout.trim();
}
