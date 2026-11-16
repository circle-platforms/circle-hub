// The packs of a code tree, as the Hub would publish them: the digest of a pack is the Hub's own (readPackDirectory over the
// staged directory, the files pack.json lists), so a recorded run's pack digest can be matched against any commit's tree.
// This is the proof that a replay uses the pack a run was started with, and the way a candidate commit's packs are found.
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readPackDirectory } from '../../../hub/runs/api.ts';

export interface PackDirectory {
  /** Path of the directory inside the tree, with `/`. */
  dir: string;
  id: string;
  version: string;
  kind: string;
}

export interface PackIdentity extends PackDirectory {
  /** The digest the Hub gives the published version; null when the staged directory is refused. */
  digest: string | null;
  problem?: string;
}

/** Every directory of the tree under `packs/` that holds a pack.json, found without descending into a pack's own subfolders more than one pack deep. */
export async function findPackDirectories(root: string): Promise<PackDirectory[]> {
  const found: PackDirectory[] = [];
  const visit = async (relative: string, depth: number): Promise<void> => {
    if (depth > 5) return;
    let names;
    try {
      names = await readdir(join(root, relative), { withFileTypes: true });
    } catch {
      return;
    }
    if (names.some((entry) => entry.isFile() && entry.name === 'pack.json')) {
      try {
        const manifest = JSON.parse(await readFile(join(root, relative, 'pack.json'), 'utf8')) as { id?: unknown; version?: unknown; kind?: unknown };
        if (typeof manifest.id === 'string' && typeof manifest.version === 'string') found.push({ dir: relative, id: manifest.id, version: manifest.version, kind: String(manifest.kind ?? '') });
      } catch {
        /* not a pack manifest */
      }
    }
    // A pack may hold packs (a workflow pack's own sub-packs sit in its folder), so the walk goes on below a pack too.
    for (const entry of names.filter((e) => e.isDirectory() && e.name !== 'node_modules' && e.name !== 'functions' && e.name !== 'tables' && e.name !== 'policies' && e.name !== 'samples' && e.name !== 'examples' && e.name !== 'tools' && e.name !== 'agents' && e.name !== 'testing')) await visit(`${relative}/${entry.name}`, depth + 1);
  };
  await visit('packs', 0);
  return found.sort((a, b) => a.dir.localeCompare(b.dir));
}

/** Copies exactly the files pack.json lists, and pack.json, to a fresh directory: what `pack publish --stage` publishes. Returns the directory; the caller removes its parent. */
export async function stagePack(source: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(source, 'pack.json'), 'utf8')) as { files?: Array<{ path?: unknown }> };
  if (!Array.isArray(manifest.files)) throw new Error(`${source}/pack.json 没有 files 清单`);
  const parent = await mkdtemp(join(tmpdir(), 'circle-hub-replay-stage-'));
  const target = join(parent, 'pack');
  try {
    for (const path of ['pack.json', ...manifest.files.map((f) => f.path)]) {
      if (typeof path !== 'string' || path.startsWith('/') || path.split('/').some((part) => part === '' || part === '.' || part === '..')) throw new Error(`pack.json 里有不合法的文件路径：${String(path).slice(0, 120)}`);
      await mkdir(dirname(join(target, path)), { recursive: true });
      await copyFile(join(source, path), join(target, path));
    }
    return target;
  } catch (error) {
    await rm(parent, { recursive: true, force: true });
    throw error;
  }
}

/** The Hub's digest of a pack directory of the tree. */
export async function packIdentity(root: string, pack: PackDirectory): Promise<PackIdentity> {
  let staged: string | null = null;
  try {
    staged = await stagePack(join(root, pack.dir));
    const read = await readPackDirectory(staged);
    if (!read.ok) return { ...pack, digest: null, problem: read.problems.slice(0, 2).map((p) => p.message).join('；') };
    return { ...pack, digest: read.pack.digest };
  } catch (error) {
    return { ...pack, digest: null, problem: error instanceof Error ? error.message : String(error) };
  } finally {
    if (staged !== null) await rm(dirname(staged), { recursive: true, force: true });
  }
}

export interface RecordedPack {
  /** `id@version` as the run recorded it. */
  pack: string;
  digest: string;
}

export interface PackMatch extends RecordedPack {
  /** `same`: the tree has this version and its digest is the recorded one; `different`: the tree has the version with another digest; `absent`: the tree has no such version. */
  status: 'same' | 'different' | 'absent';
  /** The digest the tree gives that version, when it has it. */
  found?: string | null;
  dir?: string;
}

/** Matches recorded (pack@version, digest) pairs against a tree. */
export async function matchPacks(root: string, recorded: readonly RecordedPack[]): Promise<PackMatch[]> {
  const directories = await findPackDirectories(root);
  const identities = new Map<string, PackIdentity>();
  const out: PackMatch[] = [];
  for (const wanted of recorded) {
    const [id, version] = wanted.pack.split('@');
    const directory = directories.find((d) => d.id === id && d.version === version);
    if (directory === undefined) {
      out.push({ ...wanted, status: 'absent' });
      continue;
    }
    let identity = identities.get(directory.dir);
    if (identity === undefined) identities.set(directory.dir, (identity = await packIdentity(root, directory)));
    out.push({ ...wanted, status: identity.digest === wanted.digest ? 'same' : 'different', found: identity.digest, dir: directory.dir });
  }
  return out;
}
