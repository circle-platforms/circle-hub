// The files of the test-bed pack and its manifest. The source directory also holds this tool, the README and the tests,
// which are not part of the pack, so a publication goes through a staged copy of the listed files (stage). pack.json in
// the source directory is the manifest of exactly those files:
//   node packs/workflow/test-bed/pack-files.ts --write   rewrites pack.json after a change
//   node packs/workflow/test-bed/pack-files.ts --check   exits 1 when pack.json is stale
//   node packs/workflow/test-bed/pack-files.ts --stage <empty directory>   copies the pack there, ready to publish
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACK_DIR = fileURLToPath(new URL('./', import.meta.url));

export const IDENTITY = {
  schema: 'pack@1',
  id: 'test-bed',
  version: '1.2.10',
  kind: 'workflow',
  title: '设备台架',
  description: '读管理员发布的台架清单（命名文档），按需求搜索台架（空闲状态、构建一致性、缺什么）、算环境事实（监听候选、盲地址、后端候选、空闲地址数）、预订台架（租约键 bed/<台架>/<设备>，可带地址分配，没有时长限额，由运行持有到释放）；只含事实要求项，开始运行时由 Hub 直接算出结果',
} as const;

/** Top-level declaration files and the folders whose files belong to the pack. */
const TOP = ['workflow.json', 'requirements.json', 'checks.json', 'slots.schema.json', 'SKILL.md'];
const FOLDERS = ['functions', 'samples', 'examples', 'tables'];
/** Tests and their helpers live beside the functions but are never loaded by a pack function, so they stay out. */
const NOT_PUBLISHED = (path: string): boolean => path.endsWith('.test.ts') || path === 'functions/test-support.ts';

export type ManifestEntry = { path: string; sha256: string; size: number };
export type Manifest = typeof IDENTITY & { files: ManifestEntry[] };

async function walk(relative: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(PACK_DIR, relative), { withFileTypes: true })) {
    const path = `${relative}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else if (entry.isFile() && !NOT_PUBLISHED(path)) out.push(path);
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
    process.stderr.write('pack.json does not list the current files; run node packs/workflow/test-bed/pack-files.ts --write\n');
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
