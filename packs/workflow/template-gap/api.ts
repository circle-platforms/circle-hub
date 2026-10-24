// Public surface of the template-gap workflow pack for other packages (assembly, acceptance, tooling): where the pack lives,
// which files it publishes, its manifest, a publishable copy, and the pure functions with their types. This directory also
// holds the package README, the tests and their support (testing/), which are not part of the pack: the published pack is
// exactly the files pack.json lists, every file under the places packs keep files except tests.
//
//   node packs/workflow/template-gap/api.ts check         pack.json lists every pack file with its SHA-256 and size
//   node packs/workflow/template-gap/api.ts sign          rewrites the file list of pack.json (identity unchanged)
//   node packs/workflow/template-gap/api.ts stage <dir>   writes a publishable copy (pack.json and the listed files)
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PackManifest, packPathProblem } from '../../../contracts/src/pack.ts';

export const PACK_ID = 'template-gap';
/** Absolute path of the pack's source directory, with a trailing separator. */
export const PACK_DIR = fileURLToPath(new URL('./', import.meta.url));
export const MANIFEST = 'pack.json';

export interface ManifestFile {
  path: string;
  sha256: string;
  size: number;
}

/** A pack file: a legal pack path (contracts packPathProblem) that is not a test. Everything else here is the package's own. */
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

/** The pack files as they are on disk now, sorted by path, with their SHA-256 and size. */
export async function packFiles(dir: string = PACK_DIR): Promise<ManifestFile[]> {
  const out: ManifestFile[] = [];
  for (const path of (await walk(dir)).filter(isPackFile).sort(byCodeUnits)) {
    const bytes = await readFile(join(dir, path));
    out.push({ path, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength });
  }
  return out;
}

export async function readManifest(dir: string = PACK_DIR): Promise<PackManifest> {
  return PackManifest.parse(JSON.parse(await readFile(join(dir, MANIFEST), 'utf8')));
}

/** What differs between pack.json and the pack files on disk; empty when the manifest is current. */
export async function manifestProblems(dir: string = PACK_DIR): Promise<string[]> {
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
export async function signManifest(dir: string = PACK_DIR): Promise<PackManifest> {
  // The current file list may be stale or empty, so only the identity is read from it.
  const { schema, id, version, kind, title, description } = JSON.parse(await readFile(join(dir, MANIFEST), 'utf8')) as Record<string, unknown>;
  const manifest = PackManifest.parse({ schema, id, version, kind, title, description, files: await packFiles(dir) });
  await writeFile(join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Writes a publishable copy into `target` (created when missing): pack.json and exactly the files it lists. */
export async function stagePack(target: string, dir: string = PACK_DIR): Promise<string> {
  const problems = await manifestProblems(dir);
  if (problems.length > 0) throw new Error(`pack.json of ${PACK_ID} is not current (run: node packs/workflow/template-gap/api.ts sign): ${problems.join('; ')}`);
  const manifest = await readManifest(dir);
  await mkdir(target, { recursive: true });
  for (const file of manifest.files) {
    await mkdir(dirname(join(target, file.path)), { recursive: true });
    await copyFile(join(dir, file.path), join(target, file.path));
  }
  await copyFile(join(dir, MANIFEST), join(target, MANIFEST));
  return target;
}

export { projectDocuments, documentIdOf, LIMITS, SUBJECT_SLOT } from './functions/project.ts';
export type { ProjectOptions } from './functions/project.ts';
export { commandOutcomes } from './functions/command-check.ts';
export { commandSubject } from './functions/command-subject.ts';
export { commandCoverage, caseCategories } from './functions/commands.ts';
export { coverageSubject } from './functions/subject.ts';
export { categoryFacts, readTemplate, MAX_EVIDENCE, TEMPLATE_SCHEMA } from './functions/template.ts';
export { casePath, casesOf, CASE_LIMITS, PRIORITIES } from './functions/cases.ts';
export type { DocumentCases, NodeTable } from './functions/cases.ts';
export { CANONICAL_TAGS, canonicalTag, canonicalTags } from './functions/tags.ts';
export type { CaseRecord, CategoryFact, CoverageSubject, DocumentFields, DocumentItem, ProjectionOutcome, ProjectionResult, Skip } from './functions/types.ts';

if (import.meta.main) {
  const [command, target] = process.argv.slice(2);
  if (command === 'check') {
    const problems = await manifestProblems();
    for (const problem of problems) console.error(problem);
    process.exitCode = problems.length === 0 ? 0 : 1;
    if (problems.length === 0) console.log(`pack.json of ${PACK_ID} is current`);
  } else if (command === 'sign') {
    const manifest = await signManifest();
    console.log(`pack.json of ${PACK_ID}@${manifest.version} lists ${manifest.files.length} files`);
  } else if (command === 'stage' && target !== undefined) {
    console.log(await stagePack(target));
  } else {
    console.error('usage: node packs/workflow/template-gap/api.ts check | sign | stage <directory>');
    process.exitCode = 2;
  }
}
