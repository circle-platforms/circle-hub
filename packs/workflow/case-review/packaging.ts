// Packaging of the packs of this package (case-review, case-review-verify, the product packs famx and lumen-api, the system
// packs): a pack's source directory holds the pack files and package files (README.md, api.ts, tests, testing/), and
// pack.json lists exactly the pack files: every file under a place packs keep files (contracts packPathProblem) that is not a
// test. `stage` writes a publishable copy (pack.json and the listed files) for publishPack. The packs/ root is not this
// package's, so the shared tool lives here; every pack's api.ts calls it with its own directory.
//
//   node packs/workflow/case-review/packaging.ts check | sign | stage <directory>     every pack of this package
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PackManifest, packPathProblem } from '../../../contracts/src/pack.ts';

export const MANIFEST = 'pack.json';

export interface ManifestFile {
  path: string;
  sha256: string;
  size: number;
}

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

/** The source directory of every pack of this package, by pack id. */
export const PACK_DIRECTORIES: Readonly<Record<string, string>> = {
  'case-review': here('./'),
  'case-review-verify': here('../case-review-verify/'),
  'case-review-report': here('../case-review-report/'),
  'defect-to-case': here('../defect-to-case/'),
  'template-gap': here('../template-gap/'),
  famx: here('../../product/famx/'),
  'lumen-api': here('../../product/lumen-api/'),
  'agile-platform': here('../../system/agile-platform/'),
  plm: here('../../system/plm/'),
  'build-site': here('../../system/build-site/'),
  'manual-store': here('../../system/manual-store/'),
  openkm: here('../../system/openkm/'),
};

/** A pack file: a legal pack path that is not a test. README.md, api.ts and testing/ are not legal pack paths. */
export function isPackFile(path: string): boolean {
  return path !== MANIFEST && packPathProblem(path) === null && !path.endsWith('.test.ts');
}

async function walk(dir: string, relative = ''): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await readdir(join(dir, relative))).sort()) {
    const path = relative === '' ? name : `${relative}/${name}`;
    const info = await lstat(join(dir, path));
    if (info.isDirectory()) out.push(...(await walk(dir, path)));
    else if (info.isFile()) out.push(path);
  }
  return out;
}

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The pack files on disk, sorted by path, with SHA-256 and size. */
export async function packFiles(dir: string): Promise<ManifestFile[]> {
  const out: ManifestFile[] = [];
  for (const path of (await walk(dir)).filter(isPackFile).sort(byCodeUnits)) {
    const bytes = await readFile(join(dir, path));
    out.push({ path, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength });
  }
  return out;
}

export async function readManifest(dir: string): Promise<PackManifest> {
  return PackManifest.parse(JSON.parse(await readFile(join(dir, MANIFEST), 'utf8')));
}

/** What differs between pack.json and the pack files on disk; empty when the manifest is current. */
export async function manifestProblems(dir: string): Promise<string[]> {
  const listed = (await readManifest(dir)).files;
  const actual = await packFiles(dir);
  const problems: string[] = [];
  const byPath = new Map(listed.map((f) => [f.path, f]));
  for (const file of actual) {
    const entry = byPath.get(file.path);
    if (entry === undefined) problems.push(`${file.path} is not listed in pack.json`);
    else if (entry.sha256 !== file.sha256 || entry.size !== file.size) problems.push(`${file.path} changed since pack.json was signed`);
  }
  const present = new Set(actual.map((f) => f.path));
  for (const entry of listed) if (!present.has(entry.path)) problems.push(`${entry.path} is listed in pack.json but is not a pack file on disk`);
  return problems;
}

/** Rewrites the file list of pack.json from the files on disk; the identity (id, version, kind, title, description) stays. */
export async function signManifest(dir: string): Promise<PackManifest> {
  const { schema, id, version, kind, title, description } = JSON.parse(await readFile(join(dir, MANIFEST), 'utf8')) as Record<string, unknown>;
  const manifest = PackManifest.parse({ schema, id, version, kind, title, description, files: await packFiles(dir) });
  await writeFile(join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Writes a publishable copy into `target` (created when missing): pack.json and exactly the files it lists. */
export async function stagePack(dir: string, target: string): Promise<string> {
  const problems = await manifestProblems(dir);
  if (problems.length > 0) throw new Error(`pack.json in ${dir} is not current (run: node packs/workflow/case-review/packaging.ts sign): ${problems.join('; ')}`);
  const manifest = await readManifest(dir);
  await mkdir(target, { recursive: true });
  for (const file of manifest.files) {
    await mkdir(dirname(join(target, file.path)), { recursive: true });
    await copyFile(join(dir, file.path), join(target, file.path));
  }
  await copyFile(join(dir, MANIFEST), join(target, MANIFEST));
  return target;
}

/** The command line of one pack's api.ts (or of the packs here): check [ids] | sign [ids] | stage <directory> [ids]. */
export async function packagingCli(packs: Readonly<Record<string, string>>, argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const target = command === 'stage' ? rest[0] : undefined;
  const ids = command === 'stage' ? rest.slice(1) : rest;
  const unknown = ids.filter((id) => !Object.hasOwn(packs, id));
  if (unknown.length > 0) {
    console.error(`unknown pack: ${unknown.join(', ')} (known: ${Object.keys(packs).join(', ')})`);
    return 2;
  }
  const entries = Object.entries(packs).filter(([id]) => ids.length === 0 || ids.includes(id));
  if (command === 'check') {
    let failed = 0;
    for (const [id, dir] of entries) {
      const problems = await manifestProblems(dir);
      for (const problem of problems) console.error(`${id}: ${problem}`);
      if (problems.length > 0) failed += 1;
      else console.log(`${id}: pack.json is current`);
    }
    return failed === 0 ? 0 : 1;
  }
  if (command === 'sign') {
    for (const [id, dir] of entries) {
      const manifest = await signManifest(dir);
      console.log(`${id}@${manifest.version}: pack.json lists ${manifest.files.length} files`);
    }
    return 0;
  }
  if (command === 'stage' && target !== undefined) {
    for (const [id, dir] of entries) console.log(await stagePack(dir, entries.length === 1 ? target : join(target, id)));
    return 0;
  }
  console.error('usage: check | sign | stage <directory>');
  return 2;
}

if (import.meta.main) process.exitCode = await packagingCli(PACK_DIRECTORIES, process.argv.slice(2));
