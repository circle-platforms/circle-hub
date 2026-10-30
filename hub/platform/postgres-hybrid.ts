// Windows ARM64 runs PostgreSQL's x64 build under Windows' x64 emulation (owner decision of 2026-10-30, "hybrid"):
// embedded-postgres publishes no windows-arm64 build, and npm ci leaves @embedded-postgres/windows-x64 out on an ARM64 host
// because its cpu field says x64. This installs exactly the build the root lockfile pins, after npm ci: `npm pack` fetches
// that version, the tarball must have the lockfile's SHA-512 integrity, it is extracted into node_modules without running
// its install script (which only re-creates the symbolic links listed in native/pg-symlinks.json, an empty list in this
// build), and every executable must be an x64 PE image. A record beside the executables names each component's
// architecture and the emulation. It refuses on every other host and never runs when the Hub starts: a missing build is
// an error that names this step (resolveBinaries), never a download, a PostgreSQL on PATH or a system cluster.
// Usage: node hub/platform/postgres-hybrid.ts [<root that holds package-lock.json and node_modules>]
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlatformError } from './errors.ts';
import { postgresBuild, type PostgresBuild } from './postgres.ts';
import { hostToolEnvironment, inheritedEnvironment, runCommand, tailLines, windowsToolEnvironment, type CommandRunner } from './process.ts';

/** IMAGE_FILE_MACHINE_AMD64: the x64 PE machine type. */
export const PE_MACHINE_X64 = 0x8664;
/** The record of an installed hybrid build, beside its native/ directory. */
export const HYBRID_RECORD = '.circle-hub-build.json';
const RECORD_FORMAT = 'circle-hub-postgres-build@1';

export interface LockedPackage {
  name: string;
  version: string;
  integrity: string;
}

/** The lockfile entry of a package: its exact version and SHA-512 integrity. */
export function lockedPackage(lock: unknown, name: string): LockedPackage {
  const entry = (lock as { packages?: Record<string, unknown> } | null)?.packages?.[`node_modules/${name}`] as Record<string, unknown> | undefined;
  const version = entry?.version;
  const integrity = entry?.integrity;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new PlatformError(`package-lock.json 没有 ${name} 的确切版本`, '在发布目录运行 npm ci 所用的同一锁文件');
  if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) throw new PlatformError(`package-lock.json 没有 ${name} 的 SHA-512 完整性值`);
  return { name, version, integrity };
}

/** Whether bytes have exactly the lockfile's `sha512-<base64>` integrity. */
export function integrityMatches(bytes: Uint8Array, integrity: string): boolean {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}` === integrity;
}

/** The machine field of a PE image (MZ header, e_lfanew, "PE\0\0"), or undefined for anything else. */
export function peMachine(bytes: Uint8Array): number | undefined {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.length < 0x40 || view.readUInt16LE(0) !== 0x5a4d) return undefined;
  const header = view.readUInt32LE(0x3c);
  if (header + 6 > view.length || view.readUInt32LE(header) !== 0x00004550) return undefined;
  return view.readUInt16LE(header + 4);
}

/** The system tar: bsdtar in System32 on Windows (10 1803 and later), /usr/bin/tar elsewhere. Never one found on PATH. */
export function systemTar(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform !== 'win32') return '/usr/bin/tar';
  return `${windowsToolEnvironment(env).SystemRoot}\\System32\\tar.exe`;
}

/**
 * How to run npm without a shell. On Windows npm is a .cmd script, which Node refuses to spawn without one, so its CLI
 * runs under this Node from the npm that ships beside node.exe. Elsewhere `npm` from PATH, as deploy runs npm ci.
 */
export function npmCommand(platform: NodeJS.Platform = process.platform, node: string = process.execPath): { command: string; args: string[] } {
  if (platform !== 'win32') return { command: 'npm', args: [] };
  return { command: node, args: [join(dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js')] };
}

export interface HybridOptions {
  /** Directory holding package-lock.json and node_modules (a release, or this checkout). */
  root: string;
  platform?: NodeJS.Platform;
  arch?: string;
  runner?: CommandRunner;
  /** How npm runs; default npmCommand(platform) (npm ci ran with the same npm). */
  npm?: { command: string; args: string[] };
  tar?: string;
  /** The caller's environment for npm (its registry and proxy settings); PG* names are dropped. */
  env?: NodeJS.ProcessEnv;
}

export interface HybridResult {
  installed: boolean;
  package: LockedPackage;
  build: PostgresBuild;
  directory: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Every executable of the build is present and is an x64 PE image. */
async function assertX64Executables(directory: string, build: PostgresBuild): Promise<void> {
  for (const name of Object.values(build.executables)) {
    const path = join(directory, 'native', 'bin', name);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch {
      throw new PlatformError(`x64 PostgreSQL 构建缺少 ${name}`);
    }
    const machine = peMachine(bytes);
    if (machine !== PE_MACHINE_X64) throw new PlatformError(`${name} 不是 x64 Windows 程序（机器类型 ${machine === undefined ? '无法识别' : `0x${machine.toString(16)}`}）`);
  }
}

function record(locked: LockedPackage, build: PostgresBuild, arch: string): string {
  return `${JSON.stringify({ format: RECORD_FORMAT, package: locked.name, version: locked.version, integrity: locked.integrity, architecture: build.architecture, host: `win32-${arch}`, emulated: build.emulated }, null, 2)}\n`;
}

/**
 * Installs the lockfile's x64 build into `<root>/node_modules` on a Windows ARM64 host. An installed build whose record
 * names the lockfile's integrity is kept (installed: false); any other content there is refused, never replaced.
 */
export async function installHybridPostgres(options: HybridOptions): Promise<HybridResult> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const build = postgresBuild(platform, arch);
  if (!build.emulated) throw new PlatformError(`${platform}-${arch} 用原生的 PostgreSQL 构建，不需要 x64 模拟`, '只在 Windows ARM64 上运行这一步');
  const root = resolve(options.root);
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')) as unknown;
  const locked = lockedPackage(lock, build.package);
  const directory = join(root, 'node_modules', ...build.package.split('/'));
  if (await exists(directory)) {
    const existing = await readFile(join(directory, HYBRID_RECORD), 'utf8').then((text) => JSON.parse(text) as Record<string, unknown>).catch(() => undefined);
    if (existing?.format !== RECORD_FORMAT || existing.integrity !== locked.integrity) {
      throw new PlatformError(`${directory} 已经存在，但不是锁文件固定的 x64 构建；不覆盖`, '删掉 node_modules 后重新运行 npm ci 和这一步');
    }
    await assertX64Executables(directory, build);
    return { installed: false, package: locked, build, directory };
  }
  const runner = options.runner ?? runCommand;
  const stage = await mkdtemp(join(root, 'node_modules', '.circle-hub-postgres-'));
  try {
    const spec = `${locked.name}@${locked.version}`;
    const npm = options.npm ?? npmCommand();
    const packed = await runner(npm.command, [...npm.args, 'pack', spec, '--pack-destination', stage, '--json', '--ignore-scripts'], {
      cwd: root,
      env: inheritedEnvironment(options.env ?? process.env),
      timeoutMs: 600_000,
    });
    if (packed.code !== 0) throw new PlatformError(`npm pack ${spec} 失败（退出码 ${packed.code}）：${tailLines(packed.stderr || packed.stdout)}`);
    const tarballs = (await readdir(stage)).filter((name) => name.endsWith('.tgz'));
    if (tarballs.length !== 1) throw new PlatformError(`npm pack ${spec} 没有留下唯一的压缩包`);
    const tarball = join(stage, tarballs[0]!);
    if (!integrityMatches(await readFile(tarball), locked.integrity)) {
      throw new PlatformError(`${spec} 的压缩包与 package-lock.json 的 SHA-512 不一致，不安装`, '检查 npm 的 registry 设置；锁文件固定的构建才可以用');
    }
    const unpacked = join(stage, 'unpacked');
    await mkdir(unpacked);
    // The tools run on this host: `platform` and `arch` only choose the build (tests choose one this host is not).
    const tar = options.tar ?? systemTar();
    const extracted = await runner(tar, ['-xzf', tarball, '-C', unpacked], { env: hostToolEnvironment(), timeoutMs: 600_000 });
    if (extracted.code !== 0) throw new PlatformError(`解压 ${spec} 失败（退出码 ${extracted.code}）：${tailLines(extracted.stderr || extracted.stdout)}`);
    const content = join(unpacked, 'package');
    const manifest = JSON.parse(await readFile(join(content, 'package.json'), 'utf8')) as Record<string, unknown>;
    if (manifest.name !== locked.name || manifest.version !== locked.version) throw new PlatformError(`${spec} 的压缩包内容与名称或版本不符`);
    await assertX64Executables(content, build);
    await writeFile(join(content, HYBRID_RECORD), record(locked, build, arch), { flag: 'wx' });
    await mkdir(join(root, 'node_modules', build.package.split('/')[0]!), { recursive: true });
    await rename(content, directory);
    return { installed: true, package: locked, build, directory };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const root = process.argv[2] ?? fileURLToPath(new URL('../../', import.meta.url));
  try {
    const result = await installHybridPostgres({ root });
    const what = `${result.package.name}@${result.package.version}（${result.build.architecture}，在 ${process.platform}-${process.arch} 上经 x64 模拟运行）`;
    process.stdout.write(`${result.installed ? '已安装' : '已存在'}：${what}；SHA-512 与锁文件一致\n`);
  } catch (error) {
    const hint = (error as { hint?: unknown }).hint;
    process.stderr.write(`错误：${error instanceof Error ? error.message : String(error)}\n${typeof hint === 'string' ? `处理：${hint}\n` : ''}`);
    process.exitCode = 1;
  }
}
