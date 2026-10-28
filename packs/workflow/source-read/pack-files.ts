// The files of the source-read pack and its manifest. The source directory also holds this tool, the README and the tests,
// which are not part of the pack, so a publication goes through a staged copy of the listed files (stage). pack.json in
// the source directory is the manifest of exactly those files:
//   node packs/workflow/source-read/pack-files.ts --write   rewrites pack.json after a change
//   node packs/workflow/source-read/pack-files.ts --check   exits 1 when pack.json is stale
//   node packs/workflow/source-read/pack-files.ts --stage <empty directory>   copies the pack there, ready to publish
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACK_DIR = fileURLToPath(new URL('./', import.meta.url));

export const IDENTITY = {
  schema: 'pack@1',
  id: 'source-read',
  version: '0.1.1',
  kind: 'workflow',
  title: '来源原件读取',
  description: '通用技能包：按系统路由读取平台原件（缺陷、需求、构建、脑图、构建页、手册文件、SVN 文件），零要求项，返回原件引用与投影',
} as const;

/** Top-level declaration files and the folders whose files belong to the pack. */
const TOP = ['workflow.json', 'requirements.json', 'checks.json', 'slots.schema.json', 'SKILL.md'];
const FOLDERS = ['functions'];
/** Tests and their helpers live beside the functions but are never loaded by a pack function, so they stay out. */
const NOT_PUBLISHED = (path: string): boolean => path.endsWith('.test.ts') || path === 'functions/test-support.ts';

export type ManifestEntry = { path: string; sha256: string; size: number };
export type Manifest = typeof IDENTITY & { files: ManifestEntry[] };

async function walk(relative: string): Promise<string[]> {
  const out: string[] = [];
  const dir = join(PACK_DIR, relative);
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) out.push(...(await walk(path)));
      else if (entry.isFile() && !NOT_PUBLISHED(path)) out.push(path);
    }
  } catch {
    // folder missing is tolerated
  }
  return out;
}

/** Paths of the pack's files (pack.json excluded), sorted by UTF-16 code units as the manifest requires. */
export async function packFiles(): Promise<string[]> {
  const paths = [...TOP];
  for (const folder of FOLDERS) paths.push(...(await walk(folder)));
  return paths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export async function computeManifest(): Promise<Manifest> {
  const files: ManifestEntry[] = [];
  for (const path of await packFiles()) {
    const bytes = await readFile(join(PACK_DIR, path));
    files.push({ path, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength });
  }
  return { ...IDENTITY, files };
}

export const manifestText = (manifest: Manifest): string => `${JSON.stringify(manifest, null, 2)}\n`;

/** Copies the pack files and a fresh pack.json into `target` (created when missing); returns `target`. */
export async function stage(target: string): Promise<string> {
  const manifest = await computeManifest();
  for (const { path } of manifest.files) {
    await mkdir(dirname(join(target, path)), { recursive: true });
    await copyFile(join(PACK_DIR, path), join(target, path));
  }
  await writeFile(join(target, 'pack.json'), manifestText(manifest));
  return target;
}

async function main(args: string[]): Promise<number> {
  const manifest = manifestText(await computeManifest());
  const file = join(PACK_DIR, 'pack.json');
  if (args[0] === '--write') {
    await writeFile(file, manifest);
    return 0;
  }
  if (args[0] === '--check') {
    const current = await readFile(file, 'utf8').catch(() => '');
    if (current === manifest) return 0;
    process.stderr.write('pack.json does not list the current files; run node packs/workflow/source-read/pack-files.ts --write\n');
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
