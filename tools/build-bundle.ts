// Builds the release bundle of one platform (owner decision 76): `node tools/build-bundle.ts --platform <platform>
// --out <dir> [--version <x.y.z>] [--node <vX.Y.Z>] [--commit <rev>]`. The bundle is a tar.gz holding one directory
// `circle-hub-<version>-<platform>/` with
//   app/         git archive of the commit (without foundation/ and references/) and `npm ci --include=dev` for the
//                target platform (`--os` and `--cpu`: the PostgreSQL binaries are a dev dependency per platform);
//   node/        bin/node and LICENSE of the official Node.js build, checked against the release's SHASUMS256.txt;
//   bundle.json  version, commit, platform, Node version and the tree digest of app/ (hub/platform bundleTreeDigest).
// It prints the bundle's path and SHA-256 and writes `<bundle>.sha256`. Nothing here is signed; the installer trusts the
// SHA-256 list published with the GitHub release.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BUNDLE_FILE, BUNDLE_PLATFORMS, BUNDLE_SCHEMA, RELEASE_EXCLUDES, bundleTreeDigest, type BundlePlatform } from '../hub/platform/release.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
/** The Node.js the bundles carry: 24.20 or later is needed for process.permission.drop (the Linux pack sandbox). */
export const BUNDLED_NODE = 'v24.21.0';

/** npm's names for a bundle platform. */
export function npmTarget(platform: BundlePlatform): { os: string; cpu: string } {
  const [os, cpu] = platform.split('-');
  return { os, cpu };
}

/** The file name of the official Node.js tarball for a platform. */
export function nodeTarball(version: string, platform: BundlePlatform): string {
  return `node-${version}-${platform}.tar.gz`;
}

/** The SHA-256 SHASUMS256.txt lists for `file`, or null. */
export function shasumOf(list: string, file: string): string | null {
  for (const line of list.split('\n')) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line.trim());
    if (match && match[2] === file) return match[1];
  }
  return null;
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * The library symlinks the PostgreSQL package's postinstall makes (native/pg-symlinks.json): made here when npm did not run
 * that script (npm may require approving install scripts), and checked either way, so a bundle never lacks them.
 */
export async function hydratePostgresLinks(app: string, platform: BundlePlatform): Promise<number> {
  const root = join(app, 'node_modules', '@embedded-postgres', platform);
  const list = JSON.parse(await readFile(join(root, 'native', 'pg-symlinks.json'), 'utf8')) as { source: string; target: string }[];
  let made = 0;
  for (const { source, target } of list) {
    // Paths in the list are relative to the package; links are relative to their own directory, as the postinstall makes them.
    const link = join(root, target);
    const relativeSource = relative(dirname(link), join(root, source));
    try {
      const current = await readlink(link);
      if (current !== relativeSource) throw new Error(`${target} 指向 ${current}，应为 ${relativeSource}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await symlink(relativeSource, link);
      made += 1;
    }
  }
  return made;
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`下载 ${url} 失败：HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  execFileSync(command, args, { cwd, env, stdio: ['ignore', 'inherit', 'inherit'] });
}

export async function buildBundle(options: { platform: BundlePlatform; out: string; version: string; node: string; commit: string }): Promise<{ path: string; sha256: string }> {
  const name = `circle-hub-${options.version}-${options.platform}`;
  const staging = await mkdtemp(join(tmpdir(), 'circle-hub-bundle-'));
  try {
    const dir = join(staging, name);
    const app = join(dir, 'app');
    await mkdir(app, { recursive: true });
    const archive = join(staging, 'source.tar');
    const pathspec = ['.', ...RELEASE_EXCLUDES.map((entry) => `:(exclude)${entry}`)];
    run('git', ['-C', ROOT, 'archive', '--format=tar', `--output=${archive}`, options.commit, '--', ...pathspec], ROOT);
    run('tar', ['-x', '-f', archive, '-C', app], ROOT);
    await rm(archive);
    const { os, cpu } = npmTarget(options.platform);
    run('npm', ['ci', '--include=dev', '--no-audit', '--no-fund', `--os=${os}`, `--cpu=${cpu}`], app, { ...process.env, npm_config_update_notifier: 'false' });
    await hydratePostgresLinks(app, options.platform);

    const tarball = nodeTarball(options.node, options.platform);
    const sums = (await download(`https://nodejs.org/dist/${options.node}/SHASUMS256.txt`)).toString('utf8');
    const expected = shasumOf(sums, tarball);
    if (expected === null) throw new Error(`SHASUMS256.txt 里没有 ${tarball}`);
    const bytes = await download(`https://nodejs.org/dist/${options.node}/${tarball}`);
    if (sha256(bytes) !== expected) throw new Error(`${tarball} 的 SHA-256 与 SHASUMS256.txt 不符`);
    const nodeStaging = join(staging, 'node');
    await mkdir(nodeStaging);
    await writeFile(join(staging, tarball), bytes);
    run('tar', ['-x', '-z', '-f', join(staging, tarball), '-C', nodeStaging, '--strip-components=1'], staging);
    await mkdir(join(dir, 'node', 'bin'), { recursive: true });
    await cp(join(nodeStaging, 'bin', 'node'), join(dir, 'node', 'bin', 'node'));
    await cp(join(nodeStaging, 'LICENSE'), join(dir, 'node', 'LICENSE'));

    const bundle = {
      schema: BUNDLE_SCHEMA,
      version: options.version,
      commit: options.commit,
      platform: options.platform,
      node: options.node,
      tree_sha256: await bundleTreeDigest(app),
      created_at: new Date().toISOString(),
    };
    await writeFile(join(dir, BUNDLE_FILE), `${JSON.stringify(bundle, null, 2)}\n`);
    await mkdir(options.out, { recursive: true });
    const path = join(resolve(options.out), `${name}.tar.gz`);
    run('tar', ['-c', '-z', '-f', path, '-C', staging, name], staging);
    const digest = sha256(await readFile(path));
    await writeFile(`${path}.sha256`, `${digest}  ${name}.tar.gz\n`);
    return { path, sha256: digest };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { platform: { type: 'string' }, out: { type: 'string' }, version: { type: 'string' }, node: { type: 'string' }, commit: { type: 'string' } }, strict: true });
  const platform = values.platform as BundlePlatform | undefined;
  if (platform === undefined || !(BUNDLE_PLATFORMS as readonly string[]).includes(platform) || values.out === undefined) {
    process.stderr.write(`用法：node tools/build-bundle.ts --platform <${BUNDLE_PLATFORMS.join('|')}> --out <目录> [--version <x.y.z>] [--node <vX.Y.Z>] [--commit <提交>]\n`);
    process.exit(2);
  }
  const version = values.version ?? JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).version;
  const commit = execFileSync('git', ['-C', ROOT, 'rev-parse', '--verify', `${values.commit ?? 'HEAD'}^{commit}`], { encoding: 'utf8' }).trim();
  const result = await buildBundle({ platform, out: values.out, version, node: values.node ?? BUNDLED_NODE, commit });
  process.stdout.write(`${result.path}\n${result.sha256}\n`);
}
