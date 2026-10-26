// A published pack version is the digest of its manifest. Once that version is in git, a later change to the manifest
// or to a file it lists has to carry a new version in the same commit. The baseline is the newest commit whose pack.json
// version differs from its parent. This reads only git; it does not ask Hub whether the version was published.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

/** Newest commit that introduced the version recorded at `head` for this manifest. */
export function versionCommit(root: string, path: string, head = 'HEAD'): string {
  const current = manifestFrom(show(root, head, path) ?? '', path).version;
  const touched = git(root, ['log', '--format=%H', '-G', '"version":', head, '--', path])?.trim().split('\n').filter(Boolean) ?? [];
  for (const rev of touched) {
    const text = show(root, rev, path);
    if (text === null) continue;
    let version: string;
    try {
      version = manifestFrom(text, path).version;
    } catch {
      return rev;
    }
    if (version !== current) continue;
    const parent = show(root, `${rev}^`, path);
    if (parent === null) return rev;
    try {
      if (manifestFrom(parent, path).version !== version) return rev;
    } catch {
      return rev;
    }
  }
  const added = git(root, ['log', '-1', '--format=%H', head, '--', path])?.trim();
  if (added === undefined || added === '') throw new Error(`${path}: no commit records pack.json`);
  return added;
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
    const baseline = versionCommit(root, path);
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
