// A published pack version is the digest of its manifest. Once that version is in git, a later change to the manifest
// or to a file it lists has to carry a new version in the same commit. The baseline is the newest commit whose pack.json
// version differs from its parent. This reads only git; it does not ask Hub whether the version was published.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { digestOf } from '../../hub/records/digest.ts';

interface ListedFile {
  path: string;
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
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null) throw new Error(`${path}: pack.json is not an object`);
  const version = (value as { version?: unknown }).version;
  const files = (value as { files?: unknown }).files;
  if (typeof version !== 'string' || !Array.isArray(files)) throw new Error(`${path}: pack.json has no version or file list`);
  const listed = files.map((file, index) => {
    if (typeof file !== 'object' || file === null || typeof (file as { path?: unknown }).path !== 'string') {
      throw new Error(`${path}: files[${index}] has no path`);
    }
    return { path: (file as { path: string }).path };
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
  // Resolve relative to `root` so both main checkouts and git worktrees locate the shared shallow file.
  const shallowFile = resolve(root, shallowGitPath);
  if (!existsSync(shallowFile)) throw new Error('shallow repository has no shallow boundary file');
  const hashes = readFileSync(shallowFile, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (hashes.length === 0) throw new Error('shallow repository boundary file is empty');
  return new Set(hashes);
}

function commitParents(root: string, rev: string, path: string): string[] {
  const line = git(root, ['rev-list', '--parents', '-n', '1', rev])?.trim();
  if (!line) throw new Error(`${path}: failed to read parents of ${rev.slice(0, 12)}`);
  const parts = line.split(/\s+/);
  if (parts[0] !== rev) throw new Error(`${path}: unexpected parent output for ${rev.slice(0, 12)}`);
  return parts.slice(1);
}

function parentHasVersion(root: string, parent: string, path: string, version: string): boolean {
  if (git(root, ['cat-file', '-e', `${parent}^{tree}`]) === null) {
    throw new Error(`${path}: missing tree object for parent commit ${parent.slice(0, 12)}`);
  }
  const text = show(root, parent, path);
  if (text === null) return false;
  try {
    return manifestFrom(text, path).version === version;
  } catch {
    return false;
  }
}

/** Newest commit that introduced the version recorded at `head` for this manifest. */
export function versionCommit(root: string, path: string, head = 'HEAD'): string {
  const headText = show(root, head, path);
  if (headText === null) throw new Error(`${path}: no manifest at ${head}`);
  const current = manifestFrom(headText, path).version;
  const shallow = shallowBoundaries(root);
  const log = git(root, ['log', '--no-follow', '--format=%H', head, '--', path]);
  if (log === null) throw new Error(`${path}: git log failed at ${head}`);
  const commits = log.trim().split('\n').filter(Boolean);
  if (commits.length === 0) throw new Error(`${path}: no commit records pack.json`);
  for (const rev of commits) {
    const text = show(root, rev, path);
    if (text === null) continue;
    let version: string;
    try {
      version = manifestFrom(text, path).version;
    } catch {
      continue;
    }
    if (version !== current) continue;
    const parents = commitParents(root, rev, path);
    if (parents.length === 0) {
      if (shallow?.has(rev)) {
        throw new Error(`${path}: cannot verify when version ${current} was introduced because commit ${rev.slice(0, 12)} is at a shallow boundary`);
      }
      return rev;
    }
    if (!parents.some((parent) => parentHasVersion(root, parent, path, current))) return rev;
  }
  throw new Error(`${path}: could not find commit introducing version ${current} in reachable git history`);
}

function blob(root: string, spec: string): string | null {
  return git(root, ['rev-parse', '--verify', spec])?.trim() ?? null;
}

/** Packs whose listed bytes or manifest digest moved since the commit that set the current version. */
export function versionReuseProblems(root: string): string[] {
  const listed = git(root, ['ls-files', '-z', '--', 'packs/**/pack.json']);
  if (listed === null) return ['git file list failed'];
  const problems: string[] = [];
  for (const path of listed.split('\0').filter(Boolean)) {
    const onDisk = manifestFrom(readFileSync(join(root, path), 'utf8'), path);
    const head = show(root, 'HEAD', path);
    if (head === null) continue;
    const committed = manifestFrom(head, path);
    if (onDisk.version !== committed.version) continue;
    let baseline: string;
    try {
      baseline = versionCommit(root, path);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    const baseText = show(root, baseline, path);
    if (baseText === null) {
      problems.push(`${path}: version ${onDisk.version} has no manifest at ${baseline.slice(0, 12)}`);
      continue;
    }
    const base = manifestFrom(baseText, path);
    const changed: string[] = [];
    if (digestOf(onDisk.value) !== digestOf(base.value)) changed.push('manifest digest');
    const directory = dirname(path);
    for (const file of onDisk.files) {
      const relative = `${directory}/${file.path}`;
      const now = git(root, ['hash-object', join(root, relative)])?.trim() ?? null;
      const then = blob(root, `${baseline}:${relative}`);
      if (now === null || then === null || now !== then) changed.push(file.path);
    }
    if (changed.length > 0) problems.push(`${path}: version ${onDisk.version} is unchanged since ${baseline.slice(0, 12)} but ${changed.join(', ')} changed`);
  }
  return problems;
}
