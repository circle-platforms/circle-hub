// Distribution integrity is separate from hub/platform's installed deployment records.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

export const Target = z.enum(['darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64', 'windows-x64', 'windows-arm64']);
export type Target = z.infer<typeof Target>;
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Version = z.string().regex(/^\d+\.\d+\.\d+$/);
const Entry = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), sha256: Digest, size: z.number().int().nonnegative(), executable: z.boolean() }).strict(),
  z.object({ kind: z.literal('link'), target: z.string().min(1) }).strict(),
]);
// z.record strips __proto__ keys; filesystem inventories must retain every own name.
const Files = z.unknown().transform((value, context): Record<string, z.infer<typeof Entry>> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    context.addIssue({ code: 'custom', message: '发行文件清单必须是对象' });
    return z.NEVER;
  }
  const result: Record<string, z.infer<typeof Entry>> = Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    const parsed = Entry.safeParse(entry);
    if (!parsed.success) context.addIssue({ code: 'custom', path: [key], message: '发行文件条目不合法' });
    else result[key] = parsed.data;
  }
  return result;
});

export const Manifest = z.object({
  schema: z.literal('circle-hub-release/v1'), version: Version, target: Target, nodeVersion: z.string().regex(/^24\.\d+\.\d+$/),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  runtime: z.object({ version: z.string().regex(/^24\.\d+\.\d+$/), archive: z.string().regex(/^[A-Za-z0-9.-]+$/), sha256: Digest }).strict(),
  files: Files,
}).strict();
export type Manifest = z.infer<typeof Manifest>;

export function inventory(root: string): Manifest['files'] {
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error('发行目录必须是普通目录');
  // macOS temporary directories may have a system path alias; compare canonical roots.
  root = realpathSync(root);
  const result: Manifest['files'] = Object.create(null);
  const inside = (path: string): boolean => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), key = relative(root, path).split(sep).join('/');
      if (key === 'release.json') continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(path);
        if (isAbsolute(target) || !inside(resolve(dirname(path), target)) || !inside(realpathSync(path))) throw new Error('发行链接越界');
        result[key] = { kind: 'link', target };
      } else if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) result[key] = { kind: 'file', sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), size: stat.size, executable: (stat.mode & 0o111) !== 0 };
      else throw new Error('发行包含特殊文件');
    }
  };
  visit(root);
  return result;
}

export function verifyDistribution(root: string, expected: { version: string; target: Target; commit: string; runtime: Manifest['runtime'] }): Manifest {
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory() || !lstatSync(join(root, 'release.json')).isFile() || lstatSync(join(root, 'release.json')).isSymbolicLink()) throw new Error('发行清单必须是普通文件');
  const manifest = Manifest.parse(JSON.parse(readFileSync(join(root, 'release.json'), 'utf8')));
  for (const key of ['version', 'target', 'commit'] as const) if (manifest[key] !== expected[key]) throw new Error('发行身份不一致');
  if (manifest.nodeVersion !== manifest.runtime.version || (['version', 'archive', 'sha256'] as const).some((key) => manifest.runtime[key] !== expected.runtime[key])) throw new Error('Node 运行时固定信息不一致');
  const actual = inventory(root);
  if (JSON.stringify(Object.entries(actual).sort()) !== JSON.stringify(Object.entries(manifest.files).sort())) throw new Error('发行逐文件清单不一致');
  const pkg = JSON.parse(readFileSync(join(root, 'app/package.json'), 'utf8'));
  if (pkg.name !== 'circle-hub' || pkg.version !== manifest.version) throw new Error('发行版本不一致');
  for (const required of ['app/scripts/release/install-release.ts', 'app/scripts/release/operations.ts', 'app/scripts/release/executable.ts', 'app/scripts/release/integrity.ts', 'app/scripts/release/node-runtime.json', 'app/bin/circle-hub', 'app/node_modules/embedded-postgres/package.json', `runtime/${manifest.target.startsWith('windows-') ? 'node.exe' : 'node'}`]) {
    if (manifest.files[required]?.kind !== 'file') throw new Error('发行缺少必要文件');
  }
  return manifest;
}

// This is deliberately a blocker, not a synthetic readiness claim. Remove blockers only with
// native implementation and reviewed execution evidence on both Windows architectures.
export function releaseBlockers(): string[] {
  return ['Windows 后台服务尚未实现或验证', 'Windows 等价包函数隔离尚未实现或验证', 'Windows ARM64 PostgreSQL 尚未提供并验证', '六目标构建、安装、升级和篡改冒烟尚未全部执行'];
}

export function assertReleaseReady(): never {
  throw new Error(`禁止发布：${releaseBlockers().join('；')}`);
}

export function targetFor(platform: NodeJS.Platform = process.platform, arch: string = process.arch): Target {
  return Target.parse(`${platform === 'win32' ? 'windows' : platform}-${arch}`);
}

export function assetName(version: string, target = targetFor()): string {
  Version.parse(version);
  return `circle-hub-${version}-${target}.${target.startsWith('windows-') ? 'zip' : 'tar.gz'}`;
}

/** The pin table is adapted from Circle; never derive a digest from a downloaded binary. */
export function runtimeFor(target: Target): Manifest['runtime'] {
  const pins = z.object({
    version: z.string().regex(/^24\.\d+\.\d+$/), source: z.string().url(),
    archives: z.record(Target, z.object({ name: z.string(), sha256: Digest }).strict()),
  }).strict().parse(JSON.parse(readFileSync(new URL('./node-runtime.json', import.meta.url), 'utf8')));
  const archive = pins.archives[target];
  const os = target.startsWith('windows-') ? target.replace('windows-', 'win-') : target;
  const expected = `node-v${pins.version}-${os}.${target.startsWith('windows-') ? 'zip' : 'tar.gz'}`;
  if (archive.name !== expected || pins.source !== `https://nodejs.org/dist/v${pins.version}/SHASUMS256.txt`) throw new Error('Node 运行时固定表不一致');
  return { version: pins.version, archive: archive.name, sha256: archive.sha256 };
}
