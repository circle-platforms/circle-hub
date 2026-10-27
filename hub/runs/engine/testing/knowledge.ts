// Fakes of the product registry (PacksPort) and the knowledge base (KnowledgePort) for the engine's tests: two toy product
// lines, one known by two names whose second family's builds are aliases of the first's, builds with and without roots, and
// a closed command catalog per root.
import { createHash } from 'node:crypto';
import type { KnownBuild, ProductDeclaration } from '../../../../contracts/src/product.ts';
import type { RootSource } from '../../../../contracts/src/knowledge.ts';
import { digestOf, type Principal } from '../../../records/api.ts';
import type { EntryDiff, KnowledgePort, NodesPage, PackHandle, PacksPort, ProductHandle, RootDiff, RootInfo } from '../../../ports.ts';
import type { ReaderIdentity, TreeRead, TreeReader } from '../../../refs/api.ts';
import { buildCatalog, type CatalogView } from '../../../rules/api.ts';
import { productPack, writePack } from './packs.ts';
import { PackManifest } from '../../../../contracts/src/pack.ts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

export const ROOTS = {
  meadow327: sha('root meadow 3.2.7'),
  meadow329: sha('root meadow 3.2.9'),
  meadow331: sha('root meadow 3.3.1'),
  grove102: sha('root grove 1.0.2'),
  grove104: sha('root grove 1.0.4'),
  grove105: sha('root grove 1.0.5'),
} as const;

const build = (b: Partial<KnownBuild> & Pick<KnownBuild, 'name' | 'family' | 'line'>): KnownBuild => ({
  base: b.name,
  platform: null,
  built_at: null,
  released_at: null,
  sources: {},
  root: null,
  ...b,
});

/** Builds of each product line, newest first (the order KnowledgePort.builds promises). */
export const BUILDS: Record<string, KnownBuild[]> = {
  meadow: [
    build({ name: 'Rel_MEADOW_3_3_1', family: 'Meadow', line: '3.3', built_at: '2026-10-10T00:00:00.000Z', root: ROOTS.meadow331 }),
    build({ name: 'Rel_PASTURE_3_2_9', family: 'Pasture', line: '3.2', base: 'Rel_MEADOW_3_2_9', built_at: '2026-10-02T00:00:00.000Z', released_at: '2026-10-03T00:00:00.000Z', root: ROOTS.meadow329 }),
    build({ name: 'Rel_MEADOW_3_2_9', family: 'Meadow', line: '3.2', built_at: '2026-09-30T00:00:00.000Z', released_at: '2026-10-01T00:00:00.000Z', root: ROOTS.meadow329 }),
    build({ name: 'Rel_MEADOW_3_2_7', family: 'Meadow', line: '3.2', built_at: '2026-08-30T00:00:00.000Z', released_at: '2026-09-01T00:00:00.000Z', root: ROOTS.meadow327 }),
    build({ name: 'Rel_MEADOW_3_1_5', family: 'Meadow', line: '3.1', built_at: '2026-06-01T00:00:00.000Z', released_at: '2026-06-02T00:00:00.000Z' }),
  ],
  grove: [
    build({ name: 'Rel_GROVE_1_0_5', family: 'Grove', line: '1.0', built_at: '2026-10-01T00:00:00.000Z', root: ROOTS.grove105 }),
    build({ name: 'Rel_GROVE_1_0_4', family: 'Grove', line: '1.0', built_at: '2026-09-14T00:00:00.000Z', released_at: '2026-09-15T00:00:00.000Z', root: ROOTS.grove104 }),
    build({ name: 'Rel_GROVE_1_0_2', family: 'Grove', line: '1.0', built_at: '2026-07-31T00:00:00.000Z', released_at: '2026-08-01T00:00:00.000Z', root: ROOTS.grove102 }),
  ],
};

/** The toy command catalog of every root: zone, valve and schedule commands with typed parameters. */
export function catalogOf(root: string): CatalogView {
  return buildCatalog({
    root,
    complete: true,
    entries: [
      {
        head: 'zone set',
        signatures: [
          [
            { name: 'zone', type: 'int', minimum: 1, maximum: 8 },
            { name: 'minutes', type: 'int', minimum: 1, maximum: 120 },
          ],
        ],
      },
      { head: 'zone show', signatures: [[]] },
      { head: 'valve open', signatures: [[{ name: 'valve', type: 'int', minimum: 1, maximum: 16 }]] },
      { head: 'schedule list', signatures: [[]] },
      { head: 'schedule add', signatures: [[{ name: 'name', type: 'string', maxLength: 16 }]] },
    ],
  });
}

const PRODUCTS: ProductDeclaration[] = [
  {
    schema: 'product@1',
    id: 'meadow',
    title: '草场灌溉控制器',
    names: ['Meadow', 'Pasture'],
    select_build: { module: 'functions/select-build.ts' },
    catalogs: [{ id: 'commands@1', entry_kind: 'definition', complete: true, case_sensitive: false }],
    producers: [],
  },
  {
    schema: 'product@1',
    id: 'grove',
    title: '果园滴灌控制器',
    names: ['Grove'],
    catalogs: [{ id: 'commands@1', entry_kind: 'definition', complete: true, case_sensitive: false }],
    producers: [],
  },
];

export class FakePacks implements PacksPort {
  readonly handles: ProductHandle[] = [];
  /** Product lines users may read; admins read all. Default: every product. */
  readable: Set<string> | null = null;

  async install(root: string): Promise<void> {
    for (const product of PRODUCTS) {
      const dir = await writePack(root, productPack(product, product.select_build !== undefined));
      const manifest = PackManifest.parse(JSON.parse(await readFile(join(dir, 'pack.json'), 'utf8')));
      this.handles.push({ id: product.id, version: manifest.version, digest: digestOf(manifest), kind: 'product', directory: dir, product });
    }
  }

  async pack(ref: string): Promise<PackHandle | null> {
    return this.handles.find((h) => h.id === ref || `${h.id}@${h.version}` === ref) ?? null;
  }
  async productByName(name: string): Promise<ProductHandle | null> {
    const key = name.normalize('NFC').toLowerCase();
    return this.handles.find((h) => h.product.names.some((n) => n.normalize('NFC').toLowerCase() === key)) ?? null;
  }
  async productById(id: string): Promise<ProductHandle | null> {
    return this.handles.find((h) => h.product.id === id) ?? null;
  }
  async products(): Promise<ProductHandle[]> {
    return [...this.handles];
  }
  async readableProducts(user: Principal): Promise<ReadonlySet<string>> {
    if (user.role === 'admin' || this.readable === null) return new Set(this.handles.map((h) => h.product.id));
    return this.readable;
  }
}

export class FakeKnowledge implements KnowledgePort {
  /** Roots whose catalog is missing (to show a check without its catalog). */
  readonly withoutCatalog = new Set<string>();
  /** Answer builds in reverse order (a port's order must never change an outcome). */
  reversedBuilds = false;

  async builds(product: string, filter?: { line?: string; released?: boolean }): Promise<KnownBuild[]> {
    const list = (BUILDS[product] ?? []).filter((b) => (filter?.line === undefined || b.line === filter.line) && (filter?.released === undefined || (b.released_at !== null) === filter.released));
    return this.reversedBuilds ? [...list].reverse() : list;
  }
  async resolveBuild(product: string, name: string): Promise<KnownBuild | null> {
    const key = name.toLowerCase();
    const found = (BUILDS[product] ?? []).find((b) => b.name.toLowerCase() === key);
    if (found === undefined) return null;
    return found.base === found.name ? found : ((BUILDS[product] ?? []).find((b) => b.name === found.base) ?? null);
  }
  async currentRoot(product: string, line: string): Promise<RootInfo | null> {
    const newest = (BUILDS[product] ?? []).find((b) => b.line === line && b.root !== null);
    return newest === undefined ? null : this.rootOfBuild(product, newest.name);
  }
  async rootOfBuild(product: string, name: string): Promise<RootInfo | null> {
    const b = await this.resolveBuild(product, name);
    if (b === null || b.root === null) return null;
    return { root: b.root, composition: sha(`composition of ${b.name}`), product, build: b, produced_at: '2026-10-20T00:00:00.000Z' };
  }
  async rootInfo(root: string): Promise<RootInfo[]> {
    const out: RootInfo[] = [];
    for (const [product, builds] of Object.entries(BUILDS)) for (const b of builds) if (b.root === root && b.base === b.name) out.push((await this.rootOfBuild(product, b.name))!);
    return out;
  }
  readonly sources = new Map<string, RootSource[]>();
  async rootSources(root: string): Promise<RootSource[]> {
    return this.sources.get(root) ?? [];
  }
  async catalog(root: string, catalogId: string): Promise<CatalogView | null> {
    if (catalogId !== 'commands@1' || this.withoutCatalog.has(root)) return null;
    return Object.values(BUILDS).some((builds) => builds.some((b) => b.root === root)) ? catalogOf(root) : null;
  }
  treeReader(): TreeReader {
    return {
      hasRoot: (root: string) => Object.values(BUILDS).some((builds) => builds.some((b) => b.root === root)),
      read(root: string, path: string, _entry: string | null, _reader: ReaderIdentity): TreeRead | null {
        if (!Object.values(BUILDS).some((builds) => builds.some((b) => b.root === root))) return null;
        const words = path === '/' ? [] : path.slice(1).split('/').map((s) => decodeURIComponent(s));
        const entry = words.length > 0 ? catalogOf(root).get(words) : undefined;
        return { text: entry ? `命令 ${entry.words.join(' ')}` : `知识树 ${path}`, mediaType: 'text/plain', readTier: 'model_readable', grounds: [] };
      },
      readEntry(): TreeRead | null {
        return null;
      },
    };
  }
  async getNodes(): Promise<NodesPage | null> {
    return null;
  }
  async diffRoots(): Promise<RootDiff | null> {
    return null;
  }
  async diffEntries(): Promise<EntryDiff | null> {
    return null;
  }
}
