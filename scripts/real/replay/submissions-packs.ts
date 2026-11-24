import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readPackDirectory } from '../../../hub/runs/api.ts';

export interface PackDirectory {
  dir: string;
  id: string;
  version: string;
  kind: string;
}

export interface PackIdentity extends PackDirectory {
  digest: string | null;
  problem?: string;
}

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
      }
    }
    for (const entry of names.filter((e) => e.isDirectory() && e.name !== 'node_modules' && e.name !== 'functions' && e.name !== 'tables' && e.name !== 'policies' && e.name !== 'samples' && e.name !== 'examples' && e.name !== 'tools' && e.name !== 'agents' && e.name !== 'testing')) await visit(`${relative}/${entry.name}`, depth + 1);
  };
  await visit('packs', 0);
  return found.sort((a, b) => a.dir.localeCompare(b.dir));
}

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
  pack: string;
  digest: string;
}

export interface PackMatch extends RecordedPack {
  status: 'same' | 'different' | 'absent';
  found?: string | null;
  dir?: string;
}

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
