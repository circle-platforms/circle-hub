// What the acceptance tests take from the repository: the packs under packs/ (found by their pack.json and product.json,
// never by a product name written here) and the synthetic fixtures. Product knowledge stays in the packs and in their
// testing fixtures: these tests read product names, build names and sites from there at run time.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPOSITORY_PACKS, findPackDirectories } from '../../../hub/server/testing-real.ts';

export interface RepositoryPack {
  id: string;
  version: string;
  kind: string;
  dir: string;
}

export interface ProductPack extends RepositoryPack {
  /** Product line id (product.json `id`). */
  line: string;
  /** Every name of the line, as product.json lists them. */
  names: string[];
}

let cached: Promise<RepositoryPack[]> | null = null;

/** Every pack of the repository with its manifest identity. */
export function repositoryPacks(): Promise<RepositoryPack[]> {
  cached ??= (async () => {
    const out: RepositoryPack[] = [];
    for (const dir of await findPackDirectories(REPOSITORY_PACKS)) {
      const manifest = JSON.parse(await readFile(join(dir, 'pack.json'), 'utf8')) as { id: string; version: string; kind: string };
      out.push({ id: manifest.id, version: manifest.version, kind: manifest.kind, dir });
    }
    return out;
  })();
  return cached;
}

export async function productPacks(): Promise<ProductPack[]> {
  const out: ProductPack[] = [];
  for (const pack of await repositoryPacks()) {
    if (pack.kind !== 'product') continue;
    const product = JSON.parse(await readFile(join(pack.dir, 'product.json'), 'utf8')) as { id: string; names: string[] };
    out.push({ ...pack, line: product.id, names: product.names });
  }
  return out;
}

/** The product line known by two names (brief section 8): its build site walks both name families. */
export async function twoNameProduct(): Promise<ProductPack> {
  const found = (await productPacks()).filter((p) => p.names.length >= 2);
  if (found.length !== 1) throw new Error(`expected exactly one product pack with two names, found ${found.length}`);
  return found[0];
}

/** The second, single-name product (scenario 8: the same workflow pack reviews it, the core unchanged). */
export async function oneNameProduct(): Promise<ProductPack> {
  const found = (await productPacks()).filter((p) => p.names.length === 1);
  if (found.length !== 1) throw new Error(`expected exactly one product pack with one name, found ${found.length}`);
  return found[0];
}

/** The synthetic build site of the two-name product (its pack's testing/site.ts). */
export interface ProductSite {
  SITE_BASE: string;
  /** The released build that has its own command tree (first name family). */
  RELEASED: string;
  /** A newer build of the same line, not released. */
  UNRELEASED: string;
  /** A build of the second name family that is "based on" RELEASED (no tree of its own). */
  ALIAS: string;
  /** The version line of those builds. */
  LINE: string;
  /** Path -> file of the site. */
  site(): Record<string, { body: Uint8Array; type: string }>;
  /** The command tree XML of RELEASED. */
  tree(): string;
}

export async function productSite(): Promise<ProductSite> {
  const product = await twoNameProduct();
  const module = (await import(pathToFileURL(join(product.dir, 'testing', 'site.ts')).href)) as Record<string, unknown>;
  const pick = <T>(name: string): T => {
    if (!(name in module)) throw new Error(`${product.id}/testing/site.ts has no ${name}`);
    return module[name] as T;
  };
  // The module exports one `...Site()` (path -> file) and one `...Tree()` (the command tree XML); found by those suffixes.
  const byName = (suffix: RegExp) => Object.entries(module).filter(([name, v]) => typeof v === 'function' && suffix.test(name)).map(([, v]) => v);
  const [siteFn] = byName(/Site$/) as (() => Record<string, { body: Uint8Array; type: string }>)[];
  const [treeFn] = byName(/Tree$/) as (() => string)[];
  if (siteFn === undefined || treeFn === undefined) throw new Error(`${product.id}/testing/site.ts has no site or tree function`);
  return {
    SITE_BASE: pick<string>('SITE_BASE'),
    RELEASED: pick<string>('RELEASED'),
    UNRELEASED: pick<string>('UNRELEASED'),
    ALIAS: pick<string>('ALIAS'),
    LINE: pick<string>('LINE'),
    site: siteFn,
    tree: treeFn,
  };
}

/** The document store of the single-name product (its pack's testing/store.ts): release list and references, a review map. */
export interface ProductStore {
  RELEASED: string;
  OLDER: string;
  files(): Record<string, string>;
  reviewMindmap(): Uint8Array;
}

export async function productStore(): Promise<ProductStore> {
  const product = await oneNameProduct();
  const module = (await import(pathToFileURL(join(product.dir, 'testing', 'store.ts')).href)) as Record<string, unknown>;
  const files = Object.entries(module).find(([name, v]) => typeof v === 'function' && name.endsWith('Files'))?.[1] as (() => Record<string, string>) | undefined;
  const review = module.reviewMindmap as (() => Uint8Array) | undefined;
  if (files === undefined || review === undefined) throw new Error(`${product.id}/testing/store.ts has no files() or reviewMindmap()`);
  return { RELEASED: module.RELEASED as string, OLDER: module.OLDER as string, files, reviewMindmap: review };
}

/** A manual fixture of the two-name product's tests (generic synthetic Markdown with unplaced sections). */
export async function productManual(): Promise<string> {
  const product = await twoNameProduct();
  return readFile(join(product.dir, 'testing', 'fixtures', 'manual.md'), 'utf8');
}

export const WORKFLOW = { review: 'case-review', verify: 'case-review-verify', report: 'case-review-report', gap: 'template-gap', locate: 'case-location' } as const;
export const SYSTEM = { agile: 'agile-platform', plm: 'plm', site: 'build-site', store: 'manual-store' } as const;
