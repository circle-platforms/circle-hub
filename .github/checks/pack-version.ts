import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { digestOf } from '../../hub/records/digest.ts';

interface ListedFile {
  path: string;
  sha256: string;
  size: number;
}

interface ManifestText {
  version: string;
  files: ListedFile[];
  value: unknown;
}

function git(root: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
}

function manifestFrom(text: string, path: string): ManifestText {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (typeof value !== 'object' || value === null) throw new Error(`${path}: pack.json is not an object`);
  const version = (value as { version?: unknown }).version;
  const files = (value as { files?: unknown }).files;
  if (typeof version !== 'string' || !Array.isArray(files)) throw new Error(`${path}: pack.json has no version or file list`);
  const listed = files.map((file, index) => {
    if (typeof file !== 'object' || file === null || typeof (file as { path?: unknown }).path !== 'string') {
      throw new Error(`${path}: files[${index}] has no path`);
    }
    const sha256 = (file as { sha256?: unknown }).sha256;
    const size = (file as { size?: unknown }).size;
    if (typeof sha256 !== 'string' || typeof size !== 'number') {
      throw new Error(`${path}: files[${index}] has invalid sha256 or size`);
    }
    return { path: (file as { path: string }).path, sha256, size };
  });
  return { version, files: listed, value };
}

function show(root: string, rev: string, path: string): string | null {
  return git(root, ['show', `${rev}:${path}`]);
}

function shallowBoundaries(root: string): Set<string> | null {
  const isShallow = git(root, ['rev-parse', '--is-shallow-repository'])?.trim();
  if (isShallow === undefined) throw new Error('git rev-parse --is-shallow-repository failed');
  if (isShallow !== 'true') return null;
  const shallowGitPath = git(root, ['rev-parse', '--git-path', 'shallow'])?.trim();
  if (!shallowGitPath) throw new Error('git rev-parse --git-path shallow failed');
  const shallowFile = resolve(root, shallowGitPath);
  if (!existsSync(shallowFile)) throw new Error('shallow repository has no shallow boundary file');
  const hashes = readFileSync(shallowFile, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (hashes.length === 0) throw new Error('shallow repository boundary file is empty');
  return new Set(hashes);
}

function defaultBranchRef(root: string, headRev: string): string {
  const originHead = git(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])?.trim();
  const remoteDefault = originHead?.startsWith('refs/remotes/origin/')
    ? originHead.slice('refs/remotes/origin/'.length)
    : null;
  const names = [...new Set([...(remoteDefault ? [remoteDefault] : []), 'main', 'master'])];
  for (const name of names) {
    const remoteRef = `refs/remotes/origin/${name}`;
    const localRef = `refs/heads/${name}`;
    const remoteCommit = git(root, ['rev-parse', '--verify', '--quiet', `${remoteRef}^{commit}`])?.trim() ?? null;
    const localCommit = git(root, ['rev-parse', '--verify', '--quiet', `${localRef}^{commit}`])?.trim() ?? null;
    if (!remoteCommit && !localCommit) continue;
    if (remoteCommit && !localCommit) return remoteRef;
    if (localCommit && !remoteCommit) return localRef;
    if (localCommit === headRev) return remoteRef;
    const remoteBase = git(root, ['merge-base', headRev, remoteCommit!])?.trim();
    const localBase = git(root, ['merge-base', headRev, localCommit!])?.trim();
    if (remoteBase && localBase) {
      if (git(root, ['merge-base', '--is-ancestor', localBase, remoteBase]) !== null) return remoteRef;
      return localRef;
    }
    return remoteBase ? remoteRef : localRef;
  }
  const branches = git(root, ['for-each-ref', '--format=%(refname)', 'refs/heads/'])?.trim().split('\n').filter(Boolean) ?? [];
  if (branches.length === 1) return branches[0];
  throw new Error('cannot determine published baseline: no release/* tag or default branch found');
}

export interface PublishedBaseline {
  readonly commit: string;
  readonly release: boolean;
}

export function resolvePublishedBaseline(root: string, head = 'HEAD'): PublishedBaseline {
  const headRev = git(root, ['rev-parse', '--verify', `${head}^{commit}`])?.trim();
  if (!headRev) throw new Error(`cannot resolve commit ${head}`);
  const shallow = shallowBoundaries(root);
  const tag = git(root, ['describe', '--tags', '--match', 'release/*', '--abbrev=0', headRev])?.trim();
  if (tag) {
    const taggedCommit = git(root, ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`])?.trim();
    if (!taggedCommit) throw new Error(`cannot resolve tag refs/tags/${tag}`);
    if (git(root, ['cat-file', '-e', `${taggedCommit}^{tree}`]) === null) {
      throw new Error(`shallow boundary: missing tree object for baseline commit ${taggedCommit.slice(0, 12)}`);
    }
    if (shallow !== null) {
      const aboveBaseline = git(root, ['rev-list', headRev, `^${taggedCommit}`])?.trim().split('\n').filter(Boolean) ?? [];
      for (const rev of aboveBaseline) {
        if (shallow.has(rev)) {
          throw new Error(`shallow boundary ${rev.slice(0, 12)} prevents verifying nearest release/* tag from ${headRev.slice(0, 12)}`);
        }
      }
    }
    return { commit: taggedCommit, release: true };
  }
  if (shallow !== null) {
    const reachable = git(root, ['rev-list', headRev])?.trim().split('\n').filter(Boolean) ?? [];
    for (const rev of reachable) {
      if (shallow.has(rev)) {
        throw new Error(`shallow boundary ${rev.slice(0, 12)} ends history before any release/* tag`);
      }
    }
  }
  const defaultRef = defaultBranchRef(root, headRev);
  const mergeBase = git(root, ['merge-base', headRev, defaultRef])?.trim();
  if (!mergeBase) {
    throw new Error(`cannot determine published baseline: ${headRev.slice(0, 12)} shares no common ancestor with ${defaultRef}`);
  }
  return { commit: mergeBase, release: false };
}

export function publishedBaseline(root: string, head = 'HEAD'): string {
  return resolvePublishedBaseline(root, head).commit;
}

function blob(root: string, spec: string): string | null {
  return git(root, ['rev-parse', '--verify', spec])?.trim() ?? null;
}

function formatManifestError(path: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith(`${path}:`) ? message : `${path}: ${message}`;
}

function onDiskMismatches(root: string, directory: string, files: readonly ListedFile[]): string[] {
  const mismatched: string[] = [];
  for (const file of files) {
    const fullPath = join(root, directory, file.path);
    let bytes: Buffer;
    try {
      bytes = readFileSync(fullPath);
    } catch {
      mismatched.push(file.path);
      continue;
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== file.sha256 || bytes.byteLength !== file.size) {
      mismatched.push(file.path);
    }
  }
  return mismatched;
}

export function versionReuseProblems(root: string): string[] {
  const listed = git(root, ['ls-files', '-z', '--', 'packs/**/pack.json']);
  if (listed === null) return ['git file list failed'];
  const paths = listed.split('\0').filter(Boolean);
  if (paths.length === 0) return [];
  let baseline: string;
  try {
    baseline = publishedBaseline(root);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  const problems: string[] = [];
  for (const path of paths) {
    let onDisk: ManifestText;
    try {
      onDisk = manifestFrom(readFileSync(join(root, path), 'utf8'), path);
    } catch (error) {
      problems.push(formatManifestError(path, error));
      continue;
    }
    const directory = dirname(path);
    const baseText = show(root, baseline, path);
    if (baseText !== null) {
      let base: ManifestText;
      try {
        base = manifestFrom(baseText, path);
      } catch (error) {
        problems.push(formatManifestError(path, error));
        continue;
      }
      if (onDisk.version === base.version) {
        const changed: string[] = [];
        if (digestOf(onDisk.value) !== digestOf(base.value)) changed.push('manifest digest');
        for (const file of onDisk.files) {
          const relative = `${directory}/${file.path}`;
          const now = git(root, ['hash-object', join(root, relative)])?.trim() ?? null;
          const then = blob(root, `${baseline}:${relative}`);
          if (now === null || then === null || now !== then) changed.push(file.path);
        }
        if (changed.length > 0) {
          problems.push(`${path}: version ${onDisk.version} is unchanged since ${baseline.slice(0, 12)} but ${changed.join(', ')} changed`);
          continue;
        }
      }
    }
    const stale = onDiskMismatches(root, directory, onDisk.files);
    if (stale.length > 0) {
      problems.push(`${path}: manifest checksums do not match disk for ${stale.join(', ')}`);
    }
  }
  return problems;
}
