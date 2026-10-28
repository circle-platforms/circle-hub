// Structural artifact/evidence validation. Authenticated CI provenance and implementation readiness are separate gates.
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { assertReleaseReady, assetName, Manifest, runtimeFor, Target } from './integrity.ts';
import { sha256 } from './operations.ts';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Commit = z.string().regex(/^[a-f0-9]{40}$/);
const CheckName = z.enum(['build', 'archive', 'install', 'relocate', 'upgrade', 'tamper', 'data', 'database', 'service', 'isolation']);
const RUNNERS: Record<z.infer<typeof Target>, { label: string; os: string; arch: string }> = {
  'darwin-x64': { label: 'macos-15-intel', os: 'darwin', arch: 'x64' },
  'darwin-arm64': { label: 'macos-15', os: 'darwin', arch: 'arm64' },
  'linux-x64': { label: 'ubuntu-24.04', os: 'linux', arch: 'x64' },
  'linux-arm64': { label: 'ubuntu-24.04-arm', os: 'linux', arch: 'arm64' },
  'windows-x64': { label: 'windows-2025', os: 'win32', arch: 'x64' },
  'windows-arm64': { label: 'windows-11-arm', os: 'win32', arch: 'arm64' },
};
const NativeReceipt = z.object({
  schema: z.literal('circle-hub-native-release-evidence/v1'), mode: z.literal('native'),
  target: Target, version: Manifest.shape.version, commit: Commit,
  repository: z.string().min(1), workflow_commit: Commit, run_id: z.string().min(1),
  archive_sha256: Digest, manifest_sha256: Digest, node_version: Manifest.shape.nodeVersion,
  runner: z.object({ label: z.string(), os: z.string(), arch: z.string(), hardware_arch: z.string(), emulated: z.literal(false) }).strict(),
  postgres: z.object({ version: z.string().regex(/^[0-9]+\.[0-9]+(?:\.[0-9]+)?$/), executable_arch: z.enum(['x64', 'arm64']), emulated: z.literal(false) }).strict(),
  checks: z.array(z.object({
    name: CheckName, executed: z.number().int().positive(), passed: z.number().int().positive(), failed: z.literal(0), skipped: z.literal(0), todo: z.literal(0),
    command: z.array(z.string().min(1)).min(1), output_sha256: Digest,
  }).strict()).length(CheckName.options.length),
}).strict();

export const ReleaseSet = z.object({
  schema: z.literal('circle-hub-release-set/v1'), repository: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/),
  version: Manifest.shape.version, commit: Commit, workflow_commit: Commit, run_id: z.string().min(1),
  targets: z.array(z.object({ target: Target, archive_sha256: Digest, manifest_sha256: Digest, receipt_sha256: Digest }).strict()).length(Target.options.length),
}).strict();
export type ReleaseSet = z.infer<typeof ReleaseSet>;
export type ReleaseIdentity = Pick<ReleaseSet, 'repository' | 'version' | 'commit' | 'workflow_commit' | 'run_id'>;

function ordinary(path: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('发行资产和证据必须是普通文件');
  return readFileSync(path);
}

/** Inputs must come from an authenticated CI selection. Passing this function does not authorize publication. */
export function verifyReleaseSet(directory: string, expected: ReleaseIdentity): ReleaseSet {
  const root = lstatSync(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('发行资产集合必须是普通目录');
  const set = ReleaseSet.parse(JSON.parse(ordinary(join(directory, 'release-set.json')).toString('utf8')));
  const dependency = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).devDependencies?.['embedded-postgres'];
  const postgresMajor = typeof dependency === 'string' ? /^(\d+)\./.exec(dependency)?.[1] : undefined;
  if (!postgresMajor) throw new Error('发行工具缺少 PostgreSQL 固定依赖');
  for (const key of ['repository', 'version', 'commit', 'workflow_commit', 'run_id'] as const) if (set[key] !== expected[key]) throw new Error('发行资产集合身份不一致');
  if (new Set(set.targets.map((item) => item.target)).size !== Target.options.length) throw new Error('发行必须恰好包含六个不同目标');
  const closed = new Set(['release-set.json']);
  for (const item of set.targets) {
    const asset = assetName(set.version, item.target);
    for (const suffix of ['', '.sha256', '.manifest.json', '.receipt.json']) closed.add(`${asset}${suffix}`);
    const archive = ordinary(join(directory, asset));
    if (sha256(archive) !== item.archive_sha256 || ordinary(join(directory, `${asset}.sha256`)).toString('utf8') !== `${item.archive_sha256}  ${asset}\n`) throw new Error('发行资产归档摘要不一致');
    const manifestBytes = ordinary(join(directory, `${asset}.manifest.json`));
    if (sha256(manifestBytes) !== item.manifest_sha256) throw new Error('发行资产清单摘要不一致');
    const manifest = Manifest.parse(JSON.parse(manifestBytes.toString('utf8'))), pin = runtimeFor(item.target);
    if (manifest.version !== set.version || manifest.commit !== set.commit || manifest.target !== item.target || manifest.nodeVersion !== pin.version || (['version', 'archive', 'sha256'] as const).some((key) => manifest.runtime[key] !== pin[key])) throw new Error('发行资产清单身份不一致');
    const receiptBytes = ordinary(join(directory, `${asset}.receipt.json`));
    if (sha256(receiptBytes) !== item.receipt_sha256) throw new Error('发行原生证据摘要不一致');
    const receipt = NativeReceipt.parse(JSON.parse(receiptBytes.toString('utf8'))), runner = RUNNERS[item.target];
    for (const key of ['repository', 'version', 'commit', 'workflow_commit', 'run_id'] as const) if (receipt[key] !== set[key]) throw new Error('发行原生证据身份不一致');
    if (receipt.target !== item.target || receipt.archive_sha256 !== item.archive_sha256 || receipt.manifest_sha256 !== item.manifest_sha256 || receipt.node_version !== pin.version || receipt.runner.label !== runner.label || receipt.runner.os !== runner.os || receipt.runner.arch !== runner.arch || receipt.runner.hardware_arch !== runner.arch || receipt.postgres.executable_arch !== runner.arch || !receipt.postgres.version.startsWith(`${postgresMajor}.`)) throw new Error('发行证据目标或资产绑定不一致');
    const names = receipt.checks.map((check) => check.name);
    if (new Set(names).size !== CheckName.options.length || CheckName.options.some((name) => !names.includes(name)) || receipt.checks.some((check) => check.executed !== check.passed)) throw new Error('发行必需检查未全部执行通过');
  }
  const actual = readdirSync(directory);
  if (actual.length !== closed.size || actual.some((name) => !closed.has(name))) throw new Error('发行资产集合存在缺失或多余文件');
  return set;
}

/** This is the publication entry's gate. Current missing backends cannot be overridden by receipt JSON. */
export function checkPublication(directory: string, expected: ReleaseIdentity): never {
  verifyReleaseSet(directory, expected);
  return assertReleaseReady();
}
