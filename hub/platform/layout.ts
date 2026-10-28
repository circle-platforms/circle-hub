// The data root of one Hub deployment and its fixed directories.
import { chmod, mkdir } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { PLATFORM_VARIABLES } from './environment.ts';
import { PlatformError } from './errors.ts';

export interface Layout {
  root: string;
  /** PostgreSQL data directory, mode 0700. */
  db: string;
  /** Unix socket directory and pid and lock files, mode 0700. */
  run: string;
  objects: string;
  vault: string;
  logs: string;
  backups: string;
  /** One deployed copy per commit, each with its own node_modules. */
  releases: string;
  /** Symlink to releases/<id>. */
  current: string;
  config: string;
  /** Data moved out of the way by a failed deploy, a rollback or a failed restore; never deleted automatically. */
  setAside: string;
  /**
   * Read-only pack trees the server's pack registry extracts from the objects (directories 0500, files 0400) and checks
   * at every use: derived data, never backed up, restored, set aside or counted as data. The registry creates it.
   */
  packs: string;
}

/** The one variable that names the data root, shared with hub/config. */
export const DATA_ROOT_VARIABLE = PLATFORM_VARIABLES.dataDir;

/** Directories created by ensureLayout, all private to the owner. The db directory is created empty and filled by initdb. */
const PRIVATE_DIRECTORIES = ['db', 'run', 'objects', 'vault', 'logs', 'backups', 'releases', 'config'] as const;

// pg_ctl runs its command line through /bin/sh with double-quoted paths, and the socket directory list is comma separated.
const UNSAFE_PATH = /["$`\\,'\n\r\0]/;

/** macOS sun_path holds 104 bytes including the terminating NUL. */
export const SOCKET_PATH_LIMIT = 103;

export interface DataRootHost {
  /** Injectable only to exercise both operating systems in synthetic tests. */
  platform?: NodeJS.Platform;
  /** Effective operating-system account; never inferred from environment variables. */
  username?: string;
}

export function defaultDataRoot(home: string = process.platform === 'linux' ? userInfo().homedir : homedir(), env: NodeJS.ProcessEnv = process.env, host: DataRootHost = {}): string {
  if ((host.platform ?? process.platform) === 'linux') {
    if ((host.username ?? userInfo().username) === 'circle-hub') return join('/var', 'lib', 'circle-hub');
    const dataHome = env.XDG_DATA_HOME;
    if (dataHome !== undefined && dataHome !== '') {
      if (!isAbsolute(dataHome)) throw new PlatformError('XDG_DATA_HOME 必须是绝对路径', '改为绝对路径或删掉它');
      return join(dataHome, 'circle-hub');
    }
    return join(home, '.local', 'share', 'circle-hub');
  }
  return join(home, 'Library', 'Application Support', 'circle-hub');
}

export function layoutAt(root: string): Layout {
  if (!isAbsolute(root)) throw new PlatformError(`数据根必须是绝对路径：${root}`);
  if (UNSAFE_PATH.test(root)) {
    throw new PlatformError(`数据根路径含有不支持的字符（双引号、$、反引号、反斜杠、逗号、单引号或换行）：${root}`, '换一个只含字母、数字、空格和常见标点的路径');
  }
  const base = resolve(root);
  return {
    root: base,
    db: join(base, 'db'),
    run: join(base, 'run'),
    objects: join(base, 'objects'),
    vault: join(base, 'vault'),
    logs: join(base, 'logs'),
    backups: join(base, 'backups'),
    releases: join(base, 'releases'),
    current: join(base, 'current'),
    config: join(base, 'config'),
    setAside: join(base, 'set-aside'),
    packs: join(base, 'packs'),
  };
}

/** CIRCLE_HUB_DATA_DIR takes precedence; otherwise choose the host-specific default. */
export function resolveLayout(env: NodeJS.ProcessEnv = process.env, home: string = process.platform === 'linux' ? userInfo().homedir : homedir(), host: DataRootHost = {}): Layout {
  const value = env[DATA_ROOT_VARIABLE];
  if (value === undefined) return layoutAt(defaultDataRoot(home, env, host));
  if (value.trim() === '') throw new PlatformError(`${DATA_ROOT_VARIABLE} 设成了空值`, '删掉它或设成绝对路径');
  if (!isAbsolute(value)) throw new PlatformError(`${DATA_ROOT_VARIABLE} 必须是绝对路径：${value}`);
  return layoutAt(resolve(value));
}

export async function ensureLayout(layout: Layout): Promise<void> {
  await mkdir(layout.root, { recursive: true, mode: 0o700 });
  await chmod(layout.root, 0o700);
  for (const name of PRIVATE_DIRECTORIES) {
    const path = layout[name];
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  }
}

export function socketFile(layout: Layout, port: number): string {
  return join(layout.run, `.s.PGSQL.${port}`);
}

export function assertSocketPath(layout: Layout, port: number): void {
  const path = socketFile(layout, port);
  const bytes = Buffer.byteLength(path);
  if (bytes > SOCKET_PATH_LIMIT) {
    throw new PlatformError(`数据库套接字路径太长（${bytes} 字节，上限 ${SOCKET_PATH_LIMIT}）：${path}`, `把 ${DATA_ROOT_VARIABLE} 设到更短的路径`);
  }
}
