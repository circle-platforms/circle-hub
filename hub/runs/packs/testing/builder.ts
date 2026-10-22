// Pack builder for tests: writes a pack directory with a correct manifest (pack.json with every file's SHA-256 and size)
// from an in-memory description, plus small synthetic workflow, product and system packs and helpers to corrupt one byte
// with or without signing the manifest again. Every name and text here is invented.
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PackKind } from '../../../../contracts/generated/vocabulary.ts';
import { manifestDigest } from '../directory.ts';
import { removeTree } from '../tree.ts';

/** File content: text (UTF-8), raw bytes, or a value written as JSON. */
export type FileContent = string | Uint8Array | Record<string, unknown> | unknown[];

export interface PackDescription {
  id: string;
  version: string;
  kind: PackKind;
  title: string;
  description: string;
  files: Record<string, FileContent>;
}

export interface ManifestEntry {
  path: string;
  sha256: string;
  size: number;
}

export interface WrittenManifest {
  schema: 'pack@1';
  id: string;
  version: string;
  kind: PackKind;
  title: string;
  description: string;
  files: ManifestEntry[];
}

export interface WrittenPack {
  dir: string;
  manifest: WrittenManifest;
  /** SHA-256 of the canonical JSON of the manifest. */
  digest: string;
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export function bytesOf(content: FileContent): Uint8Array {
  if (content instanceof Uint8Array) return content;
  if (typeof content === 'string') return new TextEncoder().encode(content);
  return new TextEncoder().encode(`${JSON.stringify(content, null, 2)}\n`);
}

/** A copy of a description with files replaced; `null` removes a file. */
export function withFiles(pack: PackDescription, changes: Record<string, FileContent | null>): PackDescription {
  const files = { ...pack.files };
  for (const [path, content] of Object.entries(changes)) {
    if (content === null) delete files[path];
    else files[path] = content;
  }
  return { ...pack, files };
}

/** A copy with one JSON file changed by `edit` (which receives a deep copy). */
export function editJson<T = Record<string, unknown>>(pack: PackDescription, path: string, edit: (value: T) => T | void): PackDescription {
  const current = pack.files[path];
  const value = structuredClone(typeof current === 'string' ? JSON.parse(current) : current instanceof Uint8Array ? JSON.parse(new TextDecoder().decode(current)) : current) as T;
  const changed = edit(value);
  return withFiles(pack, { [path]: (changed === undefined ? value : changed) as FileContent });
}

function manifestOf(pack: Omit<PackDescription, 'files'>, files: ManifestEntry[]): WrittenManifest {
  return {
    schema: 'pack@1',
    id: pack.id,
    version: pack.version,
    kind: pack.kind,
    title: pack.title,
    description: pack.description,
    files: [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}

/** Writes the pack into `dir` (created when missing) with a manifest that matches every file. */
export async function writePack(dir: string, pack: PackDescription): Promise<WrittenPack> {
  await mkdir(dir, { recursive: true });
  const entries: ManifestEntry[] = [];
  for (const [path, content] of Object.entries(pack.files)) {
    const bytes = bytesOf(content);
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), bytes);
    entries.push({ path, sha256: sha256(bytes), size: bytes.byteLength });
  }
  const manifest = manifestOf(pack, entries);
  await writeFile(join(dir, 'pack.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir, manifest, digest: manifestDigest(manifest) };
}

/** Lists every regular file under `dir` (links and special files are left out) with its digest. */
async function regularFiles(dir: string, relative = ''): Promise<ManifestEntry[]> {
  const out: ManifestEntry[] = [];
  for (const name of await readdir(join(dir, relative))) {
    const path = relative === '' ? name : `${relative}/${name}`;
    const info = await lstat(join(dir, path));
    if (info.isDirectory()) out.push(...(await regularFiles(dir, path)));
    else if (info.isFile() && path !== 'pack.json') {
      const bytes = await readFile(join(dir, path));
      out.push({ path, sha256: sha256(bytes), size: bytes.byteLength });
    }
  }
  return out;
}

/** Signs the directory again: pack.json lists every regular file as it is now; identity fields can be changed. */
export async function signPack(dir: string, identity: Partial<Omit<PackDescription, 'files'>> = {}): Promise<WrittenPack> {
  const previous = JSON.parse(await readFile(join(dir, 'pack.json'), 'utf8')) as WrittenManifest;
  const manifest = manifestOf({ ...previous, ...identity }, await regularFiles(dir));
  await writeFile(join(dir, 'pack.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir, manifest, digest: manifestDigest(manifest) };
}

/** Overwrites pack.json with any value (to test manifests that do not match). */
export async function writeManifest(dir: string, manifest: unknown): Promise<void> {
  await writeFile(join(dir, 'pack.json'), typeof manifest === 'string' ? manifest : `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Flips one byte of a file (also inside a read-only tree: modes are restored afterwards). With `resign` the manifest is
 * signed again, so only the digest changes; without it the manifest no longer matches.
 */
export async function corruptByte(dir: string, path: string, options: { offset?: number; resign?: boolean } = {}): Promise<WrittenPack | null> {
  const file = join(dir, path);
  const parent = dirname(file);
  const parentMode = (await lstat(parent)).mode & 0o777;
  const fileMode = (await lstat(file)).mode & 0o777;
  await chmod(parent, parentMode | 0o200);
  await chmod(file, fileMode | 0o200);
  try {
    const bytes = await readFile(file);
    const at = Math.min(options.offset ?? 0, Math.max(0, bytes.length - 1));
    if (bytes.length === 0) await writeFile(file, Uint8Array.of(0x20));
    else {
      bytes[at] = bytes[at] ^ 0x01;
      await writeFile(file, bytes);
    }
  } finally {
    await chmod(file, fileMode);
    await chmod(parent, parentMode);
  }
  return options.resign ? signPack(dir) : null;
}

/** A temporary directory and its removal (read-only trees inside included). */
export async function temporaryDirectory(prefix = 'circle-hub-packs-'): Promise<{ path: string; remove: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return { path, remove: () => removeTree(path) };
}

// ---------------------------------------------------------------- synthetic packs

/** structure@1 table: every item has a non-empty title (blocking, with its contract clause). */
export const TITLES_TABLE = {
  schema: 'structure@1',
  origin: '决定：合成的测试包，每个条目都要有标题',
  tier: 'blocking',
  basis: '要求项 titles：每个条目有不为空的标题',
  nodes: '$.items[*]',
  item: '/id',
  rules: [{ fields: [{ path: '/fields/title', required: true, type: 'string' }] }],
};

/** membership@1 table: finding codes come from the closed set the slots declare (advisory). */
export const CODES_TABLE = {
  schema: 'membership@1',
  origin: '决定：合成的测试包，发现码来自声明的集合',
  item: '/item',
  values: ['$.slots.findings[*].code'],
  set: { name: 'findings.codes' },
};

export const PROJECTION_MODULE = `import { itemsOf } from './util.ts';

export default function project(input: unknown): unknown {
  return { items: itemsOf(input), warnings: [] };
}
`;

export const UTIL_MODULE = `export function itemsOf(_input: unknown): unknown[] {
  return [];
}
`;

export interface WorkflowOptions {
  id?: string;
  version?: string;
  title?: string;
  /** workflow.json product binding. */
  product?: { id?: string; catalogs: string[] };
}

/**
 * A complete, publishable workflow pack: two fact and judgment requirements on items, one judgment over the run, a blocking
 * structure check with a positive and a negative sample (one of them a returned counterexample) and an advisory membership
 * check with author samples only.
 */
export function workflowPack(options: WorkflowOptions = {}): PackDescription {
  const product = options.product ?? { catalogs: ['commands@1'] };
  return {
    id: options.id ?? 'demo-review',
    version: options.version ?? '1.0.0',
    kind: 'workflow',
    title: options.title ?? '合成评审',
    description: '测试用的合成工作流包',
    files: {
      'workflow.json': {
        schema: 'workflow@1',
        inputs: [{ slot: 'target', role: 'subject', description: '被判的文档', accepts: ['application/json'], required: true, many: false }],
        parameters: [{ name: 'strict', description: '严格模式', required: false, schema: { type: 'boolean' } }],
        product,
        subject: 'target',
        projection: { module: 'functions/project.ts' },
      },
      'requirements.json': {
        schema: 'requirements@1',
        requirements: [
          {
            key: 'titles',
            name: '标题',
            description: '每个条目都有标题',
            target: 'item',
            required: true,
            done_rule: 'gating',
            layers: ['static'],
            accepted_producer: 'fact',
            checks: ['titles'],
            error_handling: [
              { code: 'core.structure.required_empty', action: 'repair', max_rounds: 2 },
              { code: '*', action: 'unknown' },
            ],
          },
          { key: 'findings', name: '发现', description: '对每个条目的判断', target: 'item', required: false, done_rule: 'bookkeeping', layers: ['static'], accepted_producer: 'judgment', checks: ['codes'], error_handling: [] },
          { key: 'level', name: '等级', description: '对整体的判断', target: 'run', required: false, done_rule: 'bookkeeping', layers: ['static'], accepted_producer: 'judgment', checks: [], error_handling: [] },
        ],
      },
      'checks.json': {
        schema: 'checks@1',
        checks: [
          { id: 'titles', interpreter: 'structure@1', table: 'tables/titles.json', applies: 'run', judges: 'subject', tier: 'blocking' },
          { id: 'codes', interpreter: 'membership@1', table: 'tables/codes.json', applies: 'item', judges: 'artifact_under_verification', tier: 'advisory' },
        ],
      },
      'slots.schema.json': {
        schema: 'slots@1',
        item: {
          findings: {
            codes: [
              { code: 'gap', label: '缺口' },
              { code: 'typo', label: '错字' },
            ],
            ranks: [
              { code: 'high', label: '高' },
              { code: 'low', label: '低' },
            ],
            min: 0,
          },
        },
        run: {
          level: {
            codes: [{ code: 'level', label: '等级' }],
            ranks: [
              { code: 'a', label: '甲' },
              { code: 'b', label: '乙' },
            ],
            min: 1,
            max: 1,
          },
        },
      },
      'knowledge.json': { schema: 'knowledge@1', requires: [{ catalog: 'commands@1', complete: true }] },
      'SKILL.md': '# 合成规程\n\n逐个条目判断，按槽位填写。\n',
      'functions/project.ts': PROJECTION_MODULE,
      'functions/util.ts': UTIL_MODULE,
      'tables/titles.json': TITLES_TABLE,
      'tables/codes.json': CODES_TABLE,
      'samples/positive/titles-good.json': {
        id: 'titles_good',
        source: 'author',
        check: 'titles',
        subject: { items: [{ id: 'a', fields: { title: '标题' } }] },
        expect: [{ verdict: 'support', item: 'a' }],
      },
      'samples/negative/titles-bad.json': {
        id: 'titles_bad',
        source: 'returned_counterexample',
        check: 'titles',
        subject: { items: [{ id: 'a', fields: { title: '' } }, { id: 'b', fields: { title: '有' } }] },
        expect: [
          { verdict: 'refute', code: 'core.structure.required_empty', item: 'a' },
          { verdict: 'support', item: 'b' },
        ],
      },
      'samples/positive/codes-good.json': {
        id: 'codes_good',
        source: 'author',
        check: 'codes',
        subject: { item: 'x', slots: { findings: [{ code: 'gap' }] } },
        expect: [{ verdict: 'support', item: 'x' }],
      },
      'samples/negative/codes-bad.json': {
        id: 'codes_bad',
        source: 'author',
        check: 'codes',
        subject: { item: 'x', slots: { findings: [{ code: 'other' }] } },
        expect: [{ verdict: 'refute', code: 'core.membership.not_in_set', item: 'x' }],
      },
    },
  };
}

export interface ProductOptions {
  id?: string;
  /** Pack id; default the product id. */
  pack?: string;
  version?: string;
  names?: string[];
  catalogs?: string[];
}

/** A product pack: names, one catalog per id given, a producer and a build choice function. */
export function productPack(options: ProductOptions = {}): PackDescription {
  const id = options.id ?? 'widget';
  const names = options.names ?? ['Widget', 'Gadget'];
  return {
    id: options.pack ?? id,
    version: options.version ?? '1.0.0',
    kind: 'product',
    title: `${names[0]} 产品线`,
    description: '测试用的合成产品包',
    files: {
      'product.json': {
        schema: 'product@1',
        id,
        title: `${names[0]} 产品线`,
        names,
        select_build: { module: 'functions/select.ts' },
        catalogs: (options.catalogs ?? ['commands@1']).map((catalog) => ({ id: catalog, entry_kind: 'definition', complete: true, case_sensitive: false })),
        producers: [{ id: 'commands', title: '命令', function: { module: 'functions/produce.ts' }, inputs: { tree: { source: 'tree' } } }],
      },
      'functions/produce.ts': 'export default function produce(_input: unknown): unknown {\n  return { entries: [], warnings: [] };\n}\n',
      'functions/select.ts': "export default function select(_input: unknown): unknown {\n  return { build: 'none', basis: '合成' };\n}\n",
    },
  };
}

/** A system pack (system@1): one role without authentication, one read-only route, one read with a projection function. */
export function systemPack(options: { id?: string; version?: string } = {}): PackDescription {
  return {
    id: options.id ?? 'tracker-system',
    version: options.version ?? '1.0.0',
    kind: 'system',
    title: '合成的系统',
    description: '测试用的合成系统包',
    files: {
      'system.json': {
        schema: 'system@1',
        title: '合成的跟踪系统',
        roles: [{ name: 'api' }],
        auth: { kind: 'none' },
        routes: [{ id: 'item', role: 'api', method: 'GET', path: '/items/{id}', response: 'json', max_bytes: 1048576, read: true }],
        reads: [{ name: 'item', external: 'tracker:item', request: { route: 'item', params: { id: '{id}' } }, project: { module: 'functions/project-item.ts' } }],
      },
      'functions/project-item.ts': 'export default function projectItem(_input: unknown): unknown {\n  return { artifacts: [], warnings: [] };\n}\n',
    },
  };
}
