// Pack packaging and file staging tool for defect-to-case.
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PackManifest, packPathProblem } from '../../../contracts/src/pack.ts';

export const PACK_DIR = fileURLToPath(new URL('./', import.meta.url));

export const IDENTITY = {
  schema: 'pack@1',
  id: 'defect-to-case',
  version: '1.6.22',
  kind: 'workflow',
  title: '缺陷转用例',
  description: '从缺陷（现象、修复说明）起草回归测试用例，Hub 核对命令和参数合法性、期望结果引文依据、用例结构及重复用例',
} as const;

export type ManifestEntry = { path: string; sha256: string; size: number };
export type Manifest = typeof IDENTITY & { files: ManifestEntry[] };

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function isPackFile(path: string): boolean {
  if (path === 'pack.json' || path.endsWith('.test.ts') || path.startsWith('testing/') || path === 'pack-files.ts' || path === 'api.ts' || path === 'README.md') {
    return false;
  }
  return packPathProblem(path) === null;
}

async function walk(dir: string, relative = ''): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await readdir(join(dir, relative))).sort()) {
    const path = relative === '' ? name : `${relative}/${name}`;
    const info = await lstat(join(dir, path));
    if (info.isDirectory()) out.push(...(await walk(dir, path)));
    else if (info.isFile() && isPackFile(path)) out.push(path);
  }
  return out;
}

export async function packFiles(): Promise<ManifestEntry[]> {
  const out: ManifestEntry[] = [];
  const files = (await walk(PACK_DIR)).sort(byCodeUnits);
  for (const path of files) {
    const bytes = await readFile(join(PACK_DIR, path));
    out.push({
      path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.byteLength,
    });
  }
  return out;
}

export async function readManifest(): Promise<PackManifest> {
  return PackManifest.parse(JSON.parse(await readFile(join(PACK_DIR, 'pack.json'), 'utf8')));
}

export async function manifestProblems(): Promise<string[]> {
  const listed = (await readManifest()).files;
  const actual = await packFiles();
  const problems: string[] = [];
  const byPath = new Map(listed.map((f) => [f.path, f]));
  for (const file of actual) {
    const entry = byPath.get(file.path);
    if (entry === undefined) problems.push(`${file.path} is not listed in pack.json`);
    else if (entry.sha256 !== file.sha256 || entry.size !== file.size) {
      problems.push(`${file.path} changed since pack.json was signed`);
    }
  }
  const present = new Set(actual.map((f) => f.path));
  for (const entry of listed) {
    if (!present.has(entry.path)) problems.push(`${entry.path} is listed in pack.json but is not a pack file on disk`);
  }
  return problems;
}

export async function signManifest(): Promise<PackManifest> {
  const manifest = PackManifest.parse({
    ...IDENTITY,
    files: await packFiles(),
  });
  await writeFile(join(PACK_DIR, 'pack.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function stage(target: string): Promise<string> {
  const problems = await manifestProblems();
  if (problems.length > 0) {
    throw new Error(`pack.json is not current (run sign): ${problems.join('; ')}`);
  }
  const manifest = await readManifest();
  await mkdir(target, { recursive: true });
  for (const file of manifest.files) {
    await mkdir(dirname(join(target, file.path)), { recursive: true });
    await copyFile(join(PACK_DIR, file.path), join(target, file.path));
  }
  await copyFile(join(PACK_DIR, 'pack.json'), join(target, 'pack.json'));
  return target;
}

async function main(args: string[]): Promise<number> {
  if (args[0] === '--write') {
    await signManifest();
    return 0;
  }
  if (args[0] === '--check') {
    const problems = await manifestProblems();
    if (problems.length === 0) return 0;
    process.stderr.write(`pack.json does not list the current files; run node packs/workflow/defect-to-case/pack-files.ts --write\n${problems.join('\n')}\n`);
    return 1;
  }
  if (args[0] === '--stage' && args[1] !== undefined) {
    await stage(args[1]);
    return 0;
  }
  process.stderr.write('usage: pack-files.ts --write | --check | --stage <directory>\n');
  return 2;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main(process.argv.slice(2));
