// The files of the bed-install pack and its manifest. The source directory also holds this tool, the README and the tests,
// which are not part of the pack, so a publication goes through a staged copy of the listed files (stage). pack.json in
// the source directory is the manifest of exactly those files:
//   node packs/workflow/bed-install/pack-files.ts --write   rewrites pack.json after a change
//   node packs/workflow/bed-install/pack-files.ts --check   exits 1 when pack.json is stale
//   node packs/workflow/bed-install/pack-files.ts --stage <empty directory>   copies the pack there, ready to publish
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACK_DIR = fileURLToPath(new URL('./', import.meta.url));

export const IDENTITY = {
  schema: 'pack@1',
  id: 'bed-install',
  version: '1.0.1',
  kind: 'workflow',
  title: '自动化测试环境装构建',
  description: '复现缺陷要在发现它的构建上跑：自动化测试环境装的不是这个构建时，先用本包照 InfoTest 的升级用例给整台预订的环境装上（设备会重启），不用问用户。装构建请求写要装的构建和它在构建站上的镜像文件名（source-read 从入口页 buildsite:listing:index 读起，经版本线导航页到列有它的列表页，取它的镜像链接文件名）；Hub 核对镜像名按升级用例的读法正是这个构建、前驱运行持有整台环境、运行锁定设备现在装的构建，受理后由 Hub 派发，每台负载均衡设备一个框架升级用例，已是目标构建的设备跳过',
} as const;

/** Top-level declaration files and the folders whose files belong to the pack. */
const TOP = ['workflow.json', 'requirements.json', 'checks.json', 'slots.schema.json', 'SKILL.md'];
const FOLDERS = ['functions', 'samples', 'examples', 'policies'];
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
    process.stderr.write('pack.json does not list the current files; run node packs/workflow/bed-install/pack-files.ts --write\n');
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
