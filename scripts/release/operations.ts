// File installation follows Circle's stage/verify/rename/current.ref layout. It does not manage services.
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { verifyExecutableTarget } from './executable.ts';
import { runtimeFor, targetFor, verifyDistribution, type Manifest, type Target } from './integrity.ts';

export interface Result { code: number; stdout: string; stderr: string }
export type Runner = (command: string, args: readonly string[], options: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<Result>;
export const run: Runner = (command, args, options) => new Promise((resolveResult, reject) => {
  const child = spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  let stdout = '', stderr = '', overflow = false, timedOut = false;
  const stop = (): void => {
    if (process.platform !== 'win32' && child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL'); }
    } else child.kill('SIGKILL');
  };
  const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
  const collect = (chunk: Buffer, output: 'stdout' | 'stderr'): void => {
    if (stdout.length + stderr.length + chunk.length > 4 * 1024 * 1024) { overflow = true; stop(); return; }
    if (output === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
  };
  child.stdout.on('data', (chunk: Buffer) => collect(chunk, 'stdout'));
  child.stderr.on('data', (chunk: Buffer) => collect(chunk, 'stderr'));
  child.once('error', (error) => { clearTimeout(timer); reject(error); });
  child.once('close', (code) => { clearTimeout(timer); resolveResult({ code: timedOut || overflow ? 124 : code ?? 1, stdout, stderr }); });
});

/** Fail before downloads or filesystem writes on a target without the required platform backend. */
export function requireTarget(target: Target): void {
  if (target.startsWith('windows-')) throw new Error('Windows 服务、等价隔离与 PostgreSQL 尚未完成验证，拒绝构建或安装');
  if (target !== targetFor()) throw new Error('目标平台及 Node 架构必须匹配');
}

export function scratchEnvironment(home: string, path = process.env.PATH ?? ''): NodeJS.ProcessEnv {
  return { PATH: path, HOME: home, USERPROFILE: home, TMPDIR: home, TMP: home, TEMP: home, LANG: 'C.UTF-8', NO_COLOR: '1', NODE_NO_WARNINGS: '1' };
}

export async function command(runner: Runner, executable: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<string> {
  const result = await runner(executable, args, { cwd, env, timeoutMs: 300_000 });
  // Never propagate arbitrary command output into a distribution error.
  if (result.code !== 0) throw new Error('发行命令执行失败');
  return result.stdout;
}

export function packageVersion(app: string): string {
  const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(app, 'package-lock.json'), 'utf8'));
  if (pkg.name !== 'circle-hub' || !/^\d+\.\d+\.\d+$/.test(pkg.version) || lock.name !== pkg.name || lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version || lock.packages?.['']?.name !== pkg.name) throw new Error('package.json 与锁文件版本不一致');
  if (!pkg.devDependencies?.['embedded-postgres']) throw new Error('发行必须保留 PostgreSQL 开发依赖');
  return pkg.version;
}

export async function smokeExecutable(root: string, manifest: Manifest, runner: Runner, env: NodeJS.ProcessEnv): Promise<void> {
  const node = join(root, 'runtime', 'node');
  verifyExecutableTarget(node, manifest.target);
  if ((await command(runner, node, ['--version'], env)).trim() !== `v${manifest.nodeVersion}`) throw new Error('Node 运行时版本冒烟失败');
  const identity = await command(runner, node, ['-p', 'process.platform+"-"+process.arch'], env);
  if (identity.trim() !== manifest.target) throw new Error('Node 目标架构冒烟失败');
  if ((await command(runner, node, [join(root, 'app/bin/circle-hub'), '--version'], env)).trim() !== manifest.version) throw new Error('Hub 版本冒烟失败');
}

export async function smokePlatform(root: string, runner: Runner, env: NodeJS.ProcessEnv): Promise<void> {
  const node = join(root, 'runtime/node');
  // Use URL conversion for spaces and non-ASCII installation paths.
  const { pathToFileURL } = await import('node:url');
  const probe = `const m=await import(${JSON.stringify(pathToFileURL(join(root, 'app/hub/rules/api.ts')).href)});if(!await m.osIsolationAvailable())process.exit(1);`;
  await command(runner, node, ['--input-type=module', '-e', probe], env);
  const target = targetFor();
  const app = join(root, 'app'), desired = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')).devDependencies?.['embedded-postgres'];
  const major = typeof desired === 'string' ? /^(\d+)\./.exec(desired) : null;
  const embedded = JSON.parse(readFileSync(join(app, 'node_modules/embedded-postgres/package.json'), 'utf8'));
  const platform = JSON.parse(readFileSync(join(app, 'node_modules', `@embedded-postgres/${target}`, 'package.json'), 'utf8'));
  if (!major || embedded.version !== desired || platform.version !== desired || platform.name !== `@embedded-postgres/${target}`) throw new Error('PostgreSQL 平台包与固定依赖不一致');
  const postgres = join(app, 'node_modules', `@embedded-postgres/${target}`, 'native/bin/postgres');
  verifyExecutableTarget(postgres, target);
  if (!new RegExp(`^postgres \\(PostgreSQL\\) ${major[1]}\\.`).test((await command(runner, postgres, ['--version'], env)).trim())) throw new Error('PostgreSQL 二进制版本不一致');
}

function atomicText(path: string, text: string, mode = 0o600): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, text, { flag: 'wx', mode }); renameSync(temporary, path); chmodSync(path, mode); }
  finally { rmSync(temporary, { force: true }); }
}

function safeDirectory(path: string): string {
  path = resolve(path);
  // Reject a symlink in any existing ancestor, not only the final directory.
  let current = path;
  while (!existsSync(current)) { const parent = dirname(current); if (parent === current) break; current = parent; }
  while (true) {
    if (lstatSync(current).isSymbolicLink() || !lstatSync(current).isDirectory()) throw new Error('安装目录祖先必须是普通目录');
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  return path;
}

function overlaps(left: string, right: string): boolean {
  const within = (a: string, b: string): boolean => { const rel = relative(a, b); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
  return within(left, right) || within(right, left);
}

export function activeVersion(prefix: string): string | undefined {
  const pointer = join(prefix, 'current.ref');
  if (!existsSync(pointer)) return undefined;
  if (!lstatSync(pointer).isFile() || lstatSync(pointer).isSymbolicLink()) throw new Error('安装版本指针必须是普通文件');
  const version = readFileSync(pointer, 'utf8').trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('安装版本指针不合法');
  return version;
}

export interface InstallOptions {
  prefix: string;
  /** Explicit data root prevents accidental overlap; this function never opens its contents. */
  dataRoot: string;
  expected: { version: string; target: Target; commit: string };
  runner?: Runner;
  /** Called after pointer activation; rejection restores the old pointer. No service is started implicitly. */
  checkActivation?: (installedRoot: string) => Promise<void>;
}

/** Installs application files only. Database migration, service wiring and production deployment are separate. */
export async function installRelease(root: string, options: InstallOptions): Promise<Manifest> {
  requireTarget(options.expected.target);
  const prefix = safeDirectory(options.prefix), dataRoot = safeDirectory(options.dataRoot);
  if (overlaps(prefix, dataRoot) || overlaps(prefix, realpathSync(root))) throw new Error('应用安装目录必须独立于数据及来源目录');
  const expected = { ...options.expected, runtime: runtimeFor(options.expected.target) };
  const manifest = verifyDistribution(root, expected);
  if (packageVersion(join(root, 'app')) !== manifest.version) throw new Error('发行版本不一致');
  const runner = options.runner ?? run;
  const scratch = mkdtempSync(join(tmpdir(), 'circle-hub-install-'));
  let stage: string | undefined;
  try {
    const env = scratchEnvironment(scratch);
    await smokeExecutable(root, manifest, runner, env);
    await smokePlatform(root, runner, env);
    mkdirSync(prefix, { recursive: true, mode: 0o700 });
    const lock = join(prefix, '.install-lock');
    mkdirSync(lock, { mode: 0o700 });
    try {
      const versions = safeDirectory(join(prefix, 'versions'));
      mkdirSync(versions, { recursive: true, mode: 0o700 });
      const destination = join(versions, manifest.version);
      if (existsSync(destination)) {
        const existing = verifyDistribution(destination, expected);
        if (JSON.stringify(existing) !== JSON.stringify(manifest)) throw new Error('同版本的已安装发行内容冲突');
      } else {
        stage = join(versions, `.staging-${randomUUID()}`);
        cpSync(root, stage, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
        verifyDistribution(stage, expected);
        await smokeExecutable(stage, manifest, runner, env);
        await smokePlatform(stage, runner, env);
        verifyDistribution(stage, expected);
        renameSync(stage, destination); stage = undefined;
      }
      const previous = activeVersion(prefix);
      const launcher = join(prefix, 'circle-hub');
      const quote = (text: string): string => "'" + text.replaceAll("'", "'\\''") + "'";
      if (/[\r\n]/.test(prefix)) throw new Error('安装目录含不支持的换行');
      // A stable launcher changes only its current.ref input between versions.
      const body = `#!/bin/sh\nprefix=${quote(prefix)}\nIFS= read -r version < "$prefix/current.ref" || exit 1\ncase "$version" in ''|*[!0-9.]*) exit 1;; esac\nexec "$prefix/versions/$version/runtime/node" "$prefix/versions/$version/app/bin/circle-hub" "$@"\n`;
      if (existsSync(launcher) && (!lstatSync(launcher).isFile() || lstatSync(launcher).isSymbolicLink() || readFileSync(launcher, 'utf8') !== body)) throw new Error('安装启动器已存在且不属于此布局');
      if (!existsSync(launcher)) atomicText(launcher, body, 0o755);
      try {
        atomicText(join(prefix, 'current.ref'), `${manifest.version}\n`);
        await smokeExecutable(destination, manifest, runner, env);
        await smokePlatform(destination, runner, env);
        await options.checkActivation?.(destination);
        verifyDistribution(destination, expected);
      } catch (error) {
        if (previous === undefined) rmSync(join(prefix, 'current.ref'), { force: true });
        else atomicText(join(prefix, 'current.ref'), `${previous}\n`);
        throw error;
      }
      return manifest;
    } finally { rmSync(lock, { recursive: true, force: true }); }
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
