import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface SourceFile {
  source: string;
  sourcePath: string;
  destination: string;
  gitBlob: string;
  sha256: string;
  mode: string;
  owner: string;
  related: string[];
  status: string;
}
export interface SourceManifest {
  schemaVersion: string;
  sources: Record<
    string,
    {
      repository: string;
      commit: string;
      tree: string;
      completeSnapshot: boolean;
    }
  >;
  files: SourceFile[];
}
const owners = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
const hex = /^[a-f0-9]{40}$/;
const digest = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
const gitObject = (kind: string, bytes: Buffer) =>
  createHash('sha1')
    .update(Buffer.from(`${kind} ${bytes.length}\0`))
    .update(bytes)
    .digest('hex');
function safePath(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.startsWith('/') ||
    /[\\\0]/.test(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw Error('invalid archive path');
  }
}
interface TreeNode {
  files: Map<string, SourceFile>;
  directories: Map<string, TreeNode>;
}
const node = (): TreeNode => ({ files: new Map(), directories: new Map() });
function sourceTree(files: SourceFile[]): string {
  const root = node();
  for (const file of files) {
    const parts = file.sourcePath.split('/');
    let current = root;
    for (const part of parts.slice(0, -1)) {
      if (current.files.has(part))
        throw Error('source file/directory collision');
      if (!current.directories.has(part)) current.directories.set(part, node());
      current = current.directories.get(part)!;
    }
    const name = parts.at(-1)!;
    if (current.files.has(name) || current.directories.has(name))
      throw Error('duplicate source path');
    current.files.set(name, file);
  }
  function hash(current: TreeNode): string {
    const entries = [
      ...[...current.files].map(([name, file]) => ({
        name,
        order: name,
        mode: file.mode,
        hash: file.gitBlob,
      })),
      ...[...current.directories].map(([name, child]) => ({
        name,
        order: name + '/',
        mode: '40000',
        hash: hash(child),
      })),
    ].sort((a, b) =>
      Buffer.compare(Buffer.from(a.order), Buffer.from(b.order)),
    );
    return gitObject(
      'tree',
      Buffer.concat(
        entries.flatMap((entry) => [
          Buffer.from(`${entry.mode} ${entry.name}\0`),
          Buffer.from(entry.hash, 'hex'),
        ]),
      ),
    );
  }
  return hash(root);
}

/** Read source bytes only. Never load a business module or contact a source repository. */
export function verifyReferenceArchive(
  root: string,
  manifest?: SourceManifest,
) {
  const data =
    manifest ??
    JSON.parse(
      readFileSync(resolve(root, 'references/source-manifest.json'), 'utf8'),
    );
  if (
    data.schemaVersion !== '1.0.0' ||
    !Array.isArray(data.files) ||
    !data.files.length ||
    !data.sources ||
    Object.keys(data.sources).length !== 1 ||
    !Object.hasOwn(data.sources, 'circle')
  ) {
    throw Error('invalid source manifest');
  }
  // The shared Circle baseline is the only archive; its placement and byte/tree verification stay fixed.
  const locations: Record<string, string> = { circle: 'foundation/circle' };
  const destinations = new Set<string>();
  for (const file of data.files as SourceFile[]) {
    safePath(file.sourcePath);
    safePath(file.destination);
    const prefix = locations[file.source];
    if (
      !prefix ||
      file.destination !== `${prefix}/${file.sourcePath}` ||
      destinations.has(file.destination)
    ) {
      throw Error('invalid or duplicate source placement');
    }
    if (
      !owners.has(file.owner) ||
      !Array.isArray(file.related) ||
      file.related.some((owner) => !owners.has(owner)) ||
      !['100644', '100755'].includes(file.mode) ||
      !hex.test(file.gitBlob) ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw Error('invalid source declaration');
    if (file.status !== 'unmodified-source-baseline')
      throw Error('archive status cannot declare production availability');
    const path = resolve(root, file.destination);
    if (!lstatSync(path).isFile())
      throw Error('archive entries must be ordinary files');
    const bytes = readFileSync(path);
    if (
      digest(bytes) !== file.sha256 ||
      gitObject('blob', bytes) !== file.gitBlob
    ) {
      throw Error(`source bytes changed: ${file.destination}`);
    }
    destinations.add(file.destination);
  }
  const sources: Record<
    string,
    { files: number; commit: string; tree: string }
  > = {};
  for (const [name, prefix] of Object.entries(locations)) {
    const source = data.sources[name];
    const files = (data.files as SourceFile[]).filter(
      (file) => file.source === name,
    );
    if (
      !files.length ||
      source.completeSnapshot !== true ||
      !hex.test(source.commit) ||
      !hex.test(source.tree)
    ) {
      throw Error('incomplete source snapshot');
    }
    const tree = sourceTree(files);
    if (tree !== source.tree) throw Error(`source tree mismatch: ${name}`);
    const observed = new Set<string>();
    function walk(folder: string) {
      for (const entry of readdirSync(resolve(root, folder), {
        withFileTypes: true,
      })) {
        const path = `${folder}/${entry.name}`;
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile()) {
          if (!destinations.has(path))
            throw Error(`unregistered archive file: ${path}`);
          observed.add(path);
        } else throw Error('archive cannot contain symlinks or special files');
      }
    }
    if (!lstatSync(resolve(root, prefix)).isDirectory())
      throw Error('archive root must be an ordinary directory');
    walk(prefix);
    if (observed.size !== files.length)
      throw Error(`archive closure mismatch: ${name}`);
    sources[name] = { files: files.length, commit: source.commit, tree };
  }
  return {
    verified: true,
    files: destinations.size,
    sources,
    evidence:
      'Source bytes, Git blobs, complete source trees and declared archive placement only; no runtime verification',
  };
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    console.log(
      JSON.stringify(
        verifyReferenceArchive(fileURLToPath(new URL('../', import.meta.url))),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
