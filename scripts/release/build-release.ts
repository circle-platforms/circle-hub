// Native distribution builder adapted from Circle; PostgreSQL needs devDependencies and install scripts.
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Manifest as ManifestSchema, assetName, inventory, runtimeFor, targetFor, verifyDistribution, type Manifest, type Target } from './integrity.ts';
import { verifyExecutableTarget } from './executable.ts';
import { command, packageVersion, requireTarget, run, scratchEnvironment, sha256, smokeExecutable, smokePlatform, type Runner } from './operations.ts';

export type Downloader = (url: string) => Promise<Uint8Array>;
export const download: Downloader = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: 'error' });
  if (!response.ok || !response.body) throw new Error('下载固定 Node 归档失败');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.length;
      if (size > 256 * 1024 * 1024) throw new Error('Node 归档超过大小上限');
      chunks.push(item.value);
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); }
};

export interface BuildOptions {
  source: string;
  output: string;
  target?: Target;
  commit?: string;
  runner?: Runner;
  download?: Downloader;
  /** Synthetic dependency injection only; production callers use the reviewed fixed table. */
  runtimeFor?: (target: Target) => Manifest['runtime'];
}

const SOURCE_PATHS = ['bin', 'hub', 'contracts', 'packs', 'scripts/release', 'package.json', 'package-lock.json', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md'];

export async function buildRelease(options: BuildOptions): Promise<{ archive: string; sha256: string; manifest: Manifest }> {
  const target = options.target ?? targetFor();
  requireTarget(target);
  const runner = options.runner ?? run;
  const temporary = mkdtempSync(join(tmpdir(), 'circle-hub-build-'));
  let partial: string | undefined;
  try {
    const env = scratchEnvironment(temporary);
    // Do not read the owner's npm/git configuration or credential helpers.
    writeFileSync(join(temporary, 'npm-user.conf'), '');
    writeFileSync(join(temporary, 'npm-global.conf'), '');
    writeFileSync(join(temporary, 'git.conf'), '');
    env.NPM_CONFIG_USERCONFIG = join(temporary, 'npm-user.conf');
    env.NPM_CONFIG_GLOBALCONFIG = join(temporary, 'npm-global.conf');
    env.NPM_CONFIG_CACHE = join(temporary, 'npm-cache');
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_CONFIG_GLOBAL = join(temporary, 'git.conf');
    env.GIT_TERMINAL_PROMPT = '0';
    const source = resolve(options.source);
    const commit = (await command(runner, 'git', ['-C', source, 'rev-parse', '--verify', `${options.commit ?? 'HEAD'}^{commit}`], env)).trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('源码提交标识不合法');
    const entries = (await command(runner, 'git', ['-C', source, 'ls-tree', '-rz', '--format=%(objectmode) %(path)', commit, '--', ...SOURCE_PATHS], env)).split('\0').filter(Boolean);
    if (entries.some((entry) => !entry.startsWith('100644 ') && !entry.startsWith('100755 '))) throw new Error('源码发行不允许链接或子模块');
    const paths = entries.map((entry) => entry.slice(7));
    if (paths.some((path) => path.split('/').some((name) => name === '.env' || name.startsWith('.env.') || name === '.npmrc' || name.endsWith('.log')))) throw new Error('源码发行路径含私有配置或日志');
    const sourceTar = join(temporary, 'source.tar');
    await command(runner, 'git', ['-C', source, 'archive', '--format=tar', `--output=${sourceTar}`, commit, '--', ...SOURCE_PATHS], env);
    const root = join(temporary, 'circle-hub'), app = join(root, 'app');
    mkdirSync(app, { recursive: true });
    await command(runner, 'tar', ['-xf', sourceTar, '-C', app], env);
    const version = packageVersion(app);
    const runtime = ManifestSchema.shape.runtime.parse((options.runtimeFor ?? runtimeFor)(target));
    if (runtime.archive !== `node-v${runtime.version}-${target}.tar.gz`) throw new Error('Node 归档名称与目标不一致');
    const bytes = await (options.download ?? download)(`https://nodejs.org/dist/v${runtime.version}/${runtime.archive}`);
    if (sha256(bytes) !== runtime.sha256) throw new Error('Node 归档摘要不一致');
    const runtimeTar = join(temporary, runtime.archive);
    writeFileSync(runtimeTar, bytes);
    const extracted = join(temporary, 'node'); mkdirSync(extracted);
    await command(runner, 'tar', ['-xzf', runtimeTar, '-C', extracted], env);
    const nodeRoot = join(extracted, runtime.archive.replace(/\.tar\.gz$/, ''));
    mkdirSync(join(root, 'runtime'));
    cpSync(join(nodeRoot, 'bin/node'), join(root, 'runtime/node'));
    chmodSync(join(root, 'runtime/node'), 0o755);
    verifyExecutableTarget(join(root, 'runtime/node'), target);
    cpSync(join(nodeRoot, 'LICENSE'), join(root, 'runtime/LICENSE'));
    await command(runner, 'npm', ['ci', '--include=dev', '--no-audit', '--no-fund'], env, app);
    const platformPackage = `@embedded-postgres/${target}`;
    const postgresPackage = JSON.parse(readFileSync(join(app, 'node_modules', platformPackage, 'package.json'), 'utf8'));
    if (postgresPackage.name !== platformPackage) throw new Error('PostgreSQL 平台包不一致');
    await smokePlatform(root, runner, env);
    const manifest: Manifest = { schema: 'circle-hub-release/v1', version, target, nodeVersion: runtime.version, commit, runtime, files: inventory(root) };
    writeFileSync(join(root, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    verifyDistribution(root, manifest);
    await smokeExecutable(root, manifest, runner, env);
    verifyDistribution(root, manifest);
    const output = resolve(options.output); mkdirSync(output, { recursive: true });
    const name = assetName(version, target), archive = join(output, name);
    partial = join(output, `.${name}.${randomUUID()}.partial`);
    await command(runner, 'tar', ['-czf', partial, '-C', temporary, 'circle-hub'], env);
    const digest = sha256(readFileSync(partial));
    // Exclusive publication: never silently replace an already built version/target.
    const { linkSync } = await import('node:fs');
    linkSync(partial, archive);
    try { writeFileSync(`${archive}.sha256`, `${digest}  ${name}\n`, { flag: 'wx' }); }
    catch (error) { rmSync(archive, { force: true }); throw error; }
    rmSync(partial); partial = undefined;
    return { archive, sha256: digest, manifest };
  } finally {
    if (partial) rmSync(partial, { force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length > 3) throw new Error('用法：node scripts/release/build-release.ts [输出目录]');
    const built = await buildRelease({ source: process.cwd(), output: process.argv[2] ?? '.tmp/release' });
    process.stdout.write(`${JSON.stringify({ asset: assetName(built.manifest.version, built.manifest.target), target: built.manifest.target, version: built.manifest.version, sha256: built.sha256 })}\n`);
  } catch {
    process.stderr.write('错误：发行构建失败；没有发布任何版本\n');
    process.exitCode = 1;
  }
}
