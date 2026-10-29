// The files of the case-compile pack and its manifest. The source directory also holds this tool, the README, the
// tests and the testing harness, which are not part of the pack, so a publication goes through a staged copy of the
// listed files (stage). pack.json in the source directory is the manifest of exactly those files:
//   node packs/workflow/case-compile/pack-files.ts --write   rewrites pack.json after a change
//   node packs/workflow/case-compile/pack-files.ts --check   exits 1 when pack.json is stale
//   node packs/workflow/case-compile/pack-files.ts --stage <empty directory>   copies the pack there, ready to publish
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACK_DIR = fileURLToPath(new URL('./', import.meta.url));

export const IDENTITY = {
  schema: 'pack@1',
  id: 'case-compile',
  version: '3.8.6',
  kind: 'workflow',
  dependencies: [{pack:'mindmap-format'},{pack:'workbook-format'}],
  title: '用例编译',
  description: '按运行器原始函数合约与 runtime-profile 核验单用例计划：重算身份，启用组合与本轮允许集合、签名、单行值、命令目录、类型化参数与效果授权、台架与血缘地址、地址替换及逐字期望（期望也可逐字取自本次运行冻结的已受理判据声明，其引文在本次边界上重核）。Hub 不生成内容、不调用模型；不证明在真实设备上跑得通',
} as const;

/** Top-level declaration files and the folders whose files belong to the pack. */
const TOP = ['workflow.json', 'requirements.json', 'checks.json', 'slots.schema.json', 'SKILL.md'];
const FOLDERS = ['functions', 'tables', 'policies', 'samples', 'examples', 'tools'];
/** Tests and their helpers and the harness live beside the functions but are never loaded by a pack function. */
const NOT_PUBLISHED = (path: string): boolean => path.endsWith('.test.ts') || path === 'functions/test-support.ts' || path.startsWith('testing/');

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
  for (const path of await packFiles()) {
    const to = join(target, path);
    await mkdir(dirname(to), { recursive: true });
    await copyFile(join(PACK_DIR, path), to);
  }
  await writeFile(join(target, 'pack.json'), manifestText(manifest));
  return target;
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (arg === '--write') {
    const { writeFile: write } = await import('node:fs/promises');
    await write(join(PACK_DIR, 'pack.json'), manifestText(await computeManifest()));
    console.log('pack.json rewritten');
    return;
  }
  if (arg === '--check') {
    const current = await readFile(join(PACK_DIR, 'pack.json'), 'utf8').catch(() => null);
    const expected = manifestText(await computeManifest());
    if (current !== expected) {
      console.error('pack.json is stale: run node packs/workflow/case-compile/pack-files.ts --write');
      process.exit(1);
    }
    console.log('pack.json is fresh');
    return;
  }
  if (arg === '--stage') {
    const target = process.argv[3];
    if (target === undefined) throw new Error('--stage needs an empty directory');
    console.log(await stage(target));
    return;
  }
  throw new Error('usage: pack-files.ts --write | --check | --stage <directory>');
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('pack-files.ts')) await main();
