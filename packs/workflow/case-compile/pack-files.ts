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
  version: '3.20.5',
  kind: 'workflow',
  dependencies: [{pack:'mindmap-format'},{pack:'workbook-format'}],
  embeds: [{pack:'mindmap-format',version:'1.0.26',module:'case-structure'},{pack:'run-tools',version:'1.0.2',module:'hub-client'},{pack:'runner-workbook',version:'1.0.0',module:'workbook-writer'},{pack:'command-tools',version:'1.1.0',module:'command-check'}],
  title: '用例编译',
  description: '把一整份测试脑图编译成自动化用例 Excel 工作簿，再交给自动化测试环境执行；需要这份脑图在敏捷平台上的文档号。每个用例的第一行写着它在脑图里的层级（AAA>BBB>CCC），方便人工对照原文。工作簿由客户端生成，Hub 只逐行核对并重算，不生成内容、不调用模型；核对通过不证明在真实设备上跑得通',
} as const;

/** Top-level declaration files and the folders whose files belong to the pack. */
const TOP = ['workflow.json', 'requirements.json', 'checks.json', 'slots.schema.json', 'SKILL.md'];
const FOLDERS = ['functions', 'tables', 'policies', 'samples', 'examples', 'tools', 'agents'];
/** Tests and their helpers and the harness live beside the functions but are never loaded by a pack function. */
const NOT_PUBLISHED = (path: string): boolean => path.endsWith('.test.ts') || path === 'functions/test-support.ts' || path.startsWith('testing/');

export type ManifestEntry = { path: string; sha256: string; size: number };
export type Manifest = typeof IDENTITY & { files: ManifestEntry[] };

async function walk(relative: string, dir = PACK_DIR): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(dir, relative), { withFileTypes: true })) {
    const path = `${relative}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await walk(path, dir)));
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

const INTERNAL_TOOL_HELPERS = new Set([
  'tools/authoring-brief.ts',
  'tools/rework-inputs.ts',
  'tools/workspace-path.ts',
  'tools/case-writers/extension.ts',
]);

/** Validates pure-data `<tool>.cli.json` stdin declarations against all published tools/ files. */
export async function cliDeclarationProblems(dir = PACK_DIR): Promise<string[]> {
  const paths = (await walk('tools', dir)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const pathSet = new Set(paths);
  const problems: string[] = [];

  for (const rel of paths) {
    if (!rel.startsWith('tools/')) continue;
    if (rel.endsWith('.ts')) {
      if (INTERNAL_TOOL_HELPERS.has(rel)) {
        const unexpectedCli = `${rel.slice(0, -3)}.cli.json`;
        if (pathSet.has(unexpectedCli)) problems.push(`${unexpectedCli}: internal helper must not ship .cli.json`);
        continue;
      }
      const cliRel = `${rel.slice(0, -3)}.cli.json`;
      if (!pathSet.has(cliRel)) problems.push(`${rel}: missing pure-data declaration ${cliRel}`);
    } else if (rel.endsWith('.cli.json')) {
      const toolRel = `${rel.slice(0, -'.cli.json'.length)}.ts`;
      if (!pathSet.has(toolRel)) problems.push(`${rel}: orphaned declaration without ${toolRel}`);
      try {
        const raw = JSON.parse(await readFile(join(dir, rel), 'utf8')) as unknown;
        const ok =
          typeof raw === 'object' &&
          raw !== null &&
          !Array.isArray(raw) &&
          (raw as Record<string, unknown>).schema === 'tool-cli@1' &&
          Object.keys(raw).every((k) => k === 'schema' || k === 'stdin') &&
          Array.isArray((raw as Record<string, unknown>).stdin) &&
          ((raw as Record<string, unknown>).stdin as unknown[]).every((v) => typeof v === 'string' && /^%[A-Z][A-Z0-9_]*%$/.test(v));
        if (!ok) problems.push(`${rel}: invalid tool-cli@1 stdin declaration`);
      } catch {
        problems.push(`${rel}: unreadable UTF-8 JSON`);
      }
    }
  }
  return problems;
}

/** Copies the pack files and a fresh pack.json into `target` (created when missing); returns `target`. */
export async function stage(target: string): Promise<string> {
  const declProblems = await cliDeclarationProblems();
  if (declProblems.length > 0) throw new Error(`tool CLI declarations invalid: ${declProblems.join('; ')}`);
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
    const declProblems = await cliDeclarationProblems();
    if (declProblems.length > 0) {
      console.error(`tool CLI declarations invalid: ${declProblems.join('; ')}`);
      process.exit(1);
    }
    await write(join(PACK_DIR, 'pack.json'), manifestText(await computeManifest()));
    console.log('pack.json rewritten');
    return;
  }
  if (arg === '--check') {
    const declProblems = await cliDeclarationProblems();
    if (declProblems.length > 0) {
      console.error(`tool CLI declarations invalid: ${declProblems.join('; ')}`);
      process.exit(1);
    }
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
