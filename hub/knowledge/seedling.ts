// Production of the initial knowledge seedlings (the kb-seedling task, docs/hub-r4-tasks/kb-seedling.md): one tree per
// product × version line, merged from exactly three fixed sources — the command-tree XML of the line's current released
// build and the CLI and APP adoc manuals — by structure alone (no keywords, dictionaries, synonyms, prefix tables or
// free-text regular expressions decide anything here; the mounting rules live in the pack's producers). The production
// itself is the ordinary produceTree over the released build with only the three named producers, so it reuses
// kb-sections mounting, the kb-adoc models, the content-addressed nodes and the tree_root composition; on top it writes
// the seedling@1 record (the three sources with their original digests and the fixed adoc revisions, and the parent
// seedling) and moves the line's seedling pointer by compare-and-set. The old per-build roots are not touched.
import type { ProductHandle } from '../ports.ts';
import { KnowledgeError, describeError } from './errors.ts';
import type { Knowledge } from './service.ts';
import { requireAdmin, type KnowledgeContext } from './context.ts';
import type { Principal, Transaction } from '../records/api.ts';
import { pointerName, INDEX } from './store.ts';
import type { ProduceResult } from './produce.ts';
import { SeedlingBody, type SeedlingSource } from '../../contracts/src/knowledge.ts';
import type { BuildInfo } from '../../contracts/src/product.ts';

/** A producer input the seedling reads one fixed source through. */
export interface SeedlingRoleRef {
  producer: string;
  slot: string;
}

/** Which producer input fills which fixed role of the seedling. */
export interface SeedlingRoles {
  'command-tree': SeedlingRoleRef;
  'cli-manual': SeedlingRoleRef;
  'app-manual': SeedlingRoleRef;
}

export interface ProduceSeedlingInput {
  /** The version line of the seedling (the product pack names its syntax). */
  line: string;
  /** The released build whose command tree the seedling uses; null or undefined picks the line's newest released build. */
  build?: string | null;
  /** The admin whose context reads the sources; default the service's admin. */
  by?: Principal | null;
  /** One line of text: why this seedling was produced. */
  basis: string;
  /** The three fixed sources, as producer inputs of the pack. */
  roles: SeedlingRoles;
  /** The fixed SVN revisions the two manuals were read at (null when the source carries none). */
  revisions?: { cli: string | null; app: string | null };
  /** Directory roles for this production only. The stored build keeps list names, not the ids, so the seedling supplies them. */
  sources?: BuildInfo['sources'];
}

export interface SeedlingResult {
  ok: boolean;
  product: string;
  line: string;
  build: string | null;
  /** Digest of the root node. */
  root: string | null;
  /** Digest of the seedling@1 record. */
  seedling: string | null;
  /** Digest of the tree_root@1 composition the production wrote. */
  composition: string | null;
  origin: SeedlingSource[];
  /** The seedling record this one descends from, when the line already had one. */
  parent: string | null;
  pointer: { moved: boolean; reason: string } | null;
  reason: string | null;
  /** The underlying production's report (sources, warnings, counts), when one ran. */
  production: ProduceResult | null;
}

const ROLES = ['app-manual', 'cli-manual', 'command-tree'] as const;

/** The pointer name of a line's current seedling. */
export function seedlingName(product: string, line: string): string {
  return `seedling/${pointerName(product, line).split('/').slice(1).join('/')}`;
}

/** The seedling@1 record behind a digest, or null when no seedling record holds it. */
export async function seedlingRecord(context: Pick<KnowledgeContext, 'store'>, digest: string): Promise<SeedlingBody | null> {
  const record = await context.store.records.get<unknown>(digest);
  if (record === null || record.schema !== 'seedling@1') return null;
  return SeedlingBody.safeParse(record.body).data ?? null;
}

/** The newest seedling@1 record whose tree root is this root digest, or null (the current-seedling pointer names roots). */
export async function seedlingOfRoot(context: Pick<KnowledgeContext, 'store'>, product: string, root: string): Promise<string | null> {
  const found = await context.store.all<SeedlingBody>({ key: INDEX.seedlingRoot, value: `${product}/${root}`, kind: 'claim' });
  const seedling = found.filter((record) => record.schema === 'seedling@1').sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1);
  return seedling === undefined ? null : seedling.digest;
}

/** The digest of the seedling@1 record a line's seedling pointer names, or null. */
export async function currentSeedling(context: Pick<KnowledgeContext, 'records' | 'store'>, product: string, line: string): Promise<string | null> {
  const pointer = await context.records.pointers.get(seedlingName(product, line));
  return pointer?.target ?? null;
}

/**
 * Produces the initial seedling of one product × version line. The command tree comes from the line's current released
 * build (the named one, else the newest released of the line); the manuals are read through the two manual inputs of
 * the pack at the fixed revisions the caller names. Same inputs give the same tree bytes: the root digest covers
 * content only, and every rule that places an entry is structural.
 */
export async function produceSeedling(context: KnowledgeContext, knowledge: Knowledge, product: ProductHandle, input: ProduceSeedlingInput): Promise<SeedlingResult> {
  const productId = product.product.id;
  const fail = (reason: string, build: string | null = null, production: ProduceResult | null = null, parent: string | null = null): SeedlingResult =>
    ({ ok: false, product: productId, line: input.line, build, root: null, seedling: null, composition: null, origin: [], parent, pointer: null, reason, production });

  // The three roles must name producer inputs of this pack's versioned scope.
  const declared = new Map(product.product.producers.filter((p) => p.unversioned !== true).map((p) => [p.id, p]));
  for (const role of ROLES) {
    const ref = input.roles[role];
    const producer = declared.get(ref.producer);
    if (producer === undefined) return fail(`生产器 ${ref.producer} 不在产品包的构建生产器里，不能当树苗来源 ${role}`);
    if (!(ref.slot in producer.inputs)) return fail(`生产器 ${ref.producer} 没有 ${ref.slot} 输入，不能当树苗来源 ${role}`);
  }

  // Which released build of the line supplies the command tree: the named one, else the newest released of the line.
  let build;
  if (input.build === undefined || input.build === null || input.build === '') {
    const released = (await knowledge.builds(productId, { line: input.line, released: true })).slice().sort((a: { released_at: string | null; name: string }, b: { released_at: string | null; name: string }) => (a.released_at ?? '').localeCompare(b.released_at ?? '') || a.name.localeCompare(b.name));
    build = released.at(-1) ?? null;
    if (build === null) return fail(`版本线 ${input.line} 没有已发布的构建，没有命令树`);
  } else {
    build = await knowledge.resolveBuild(productId, input.build);
    if (build === null) return fail(`不认识构建 ${input.build}`, input.build);
  }
  if (build.line !== input.line) return fail(`构建 ${build.name} 属于版本线 ${build.line}，不是 ${input.line}`, build.name);
  if (build.base !== build.name) return fail(`构建 ${build.name} 是 ${build.base} 的别名，树苗用基础构建的树`, build.name);
  if (typeof build.sources.tree !== 'string') return fail(`构建 ${build.name} 没有命令树来源`, build.name);

  // The parent: the line's current seedling, when there is one (its root must be a seedling tree).
  const pointer = await context.records.pointers.get(seedlingName(productId, input.line));
  const parentRoot = pointer?.target ?? null;
  const parent = parentRoot === null ? null : await seedlingOfRoot(context, productId, parentRoot);
  if (parentRoot !== null && parent === null) {
    return fail(`当前树苗指针指着 ${parentRoot}，不是 seedling@1 的树；先由管理员核对`, build.name, null, null);
  }

  // The production: the ordinary per-build pipeline over the released build, with only the three named producers.
  const only = [...new Set(ROLES.map((role) => input.roles[role].producer))];
  const production = await knowledge.produceTree({ product, build, by: input.by, producers: only, ...(input.sources ? { sources: input.sources } : {}) });
  if (!production.ok || production.root === null || production.composition === null || production.action === null) {
    return fail(production.reason ?? '生产没有产出根', build.name, production, parent);
  }

  // The three fixed sources, exactly as the production used them. A manual revision the caller did not name is the
  // revision the composition recorded for that slot (an SVN read); the command tree stays null.
  const origin: SeedlingSource[] = [];
  const composed = await context.store.composition(production.composition);
  for (const role of ROLES) {
    const ref = input.roles[role];
    const row = production.sources.find((source: ProduceResult['sources'][number]) => source.producer === ref.producer && source.slot === ref.slot);
    // A manual role the caller resolved through the declared adoc directory is covered by that overlay even when the
    // production did not read the (optional) markdown input: the directory group is the manual of record.
    const producerOfRole = declared.get(ref.producer);
    const coveredByDirectory = row === undefined
      && (role === 'cli-manual' || role === 'app-manual')
      && producerOfRole !== undefined
      && (producerOfRole.inputs[ref.slot]?.optional === true)
      && Object.values(input.sources ?? {}).some((value) => typeof value === 'string' || Array.isArray(value));
    if (row === undefined && !coveredByDirectory) return fail(`生产没有用 ${ref.producer}.${ref.slot}，不能当树苗来源 ${role}`, build.name, production, parent);
    if (row === undefined) continue;
    const given = role === 'cli-manual' ? (input.revisions?.cli ?? null) : role === 'app-manual' ? (input.revisions?.app ?? null) : null;
    const recorded = composed?.sources.find((source) => source.producer === ref.producer && source.slot === ref.slot)?.revision ?? null;
    const revision = role === 'command-tree' ? null : (given ?? recorded);
    origin.push({ role, producer: row.producer, slot: row.slot, external: row.external, sha256: row.sha256, revision });
  }
  origin.sort((a, b) => a.role.localeCompare(b.role));

  // The seedling record: one per production, on the lineage of the line.
  const body: SeedlingBody = {
    product: productId,
    line: input.line,
    root: production.root,
    composition: production.composition,
    build: build.name,
    origin,
    parent,
    basis: input.basis.slice(0, 500),
  };
  const seedling = await context.store.putClaim('seedling@1', 'projected', body, [
    { key: INDEX.seedling, value: `${productId}/${input.line}` },
    { key: INDEX.seedlingRoot, value: `${productId}/${production.root}` },
  ]);

  // The current-seedling pointer moves by compare-and-set; the cause is the production's generate action.
  let pointerResult: { moved: boolean; reason: string } | null = null;
  const admin = await requireAdmin(context, input.by, '生产知识树');
  try {
    if (pointer?.target === production.root) {
      // The pointer already names this tree: not a move (same-target refresh needs its own guard).
      pointerResult = { moved: false, reason: '当前树苗指针已经指着这棵树，不重复移动' };
    } else {
      const moved = await context.records.store.withTransaction(async (tx: Transaction) => {
      const move = await context.records.pointers.move(
        {
          name: seedlingName(productId, input.line),
          expected: pointer?.target ?? null,
          next: production.root as string,
          by: { id: admin.id, name: admin.name, role: admin.role },
          run: null,
          component: 'knowledge.seedling@1',
          note: `树苗 rec:${seedling.digest}；生产动作 rec:${production.action}`,
        },
        tx,
      );
      if (!move.moved) return { moved: false, move: null };
      await context.store.putPointerMove(
        { product: productId, line: input.line, pointer: seedlingName(productId, input.line), expected: pointer?.target ?? null, root: production.root as string, build: build.name, composition: seedling.digest, move: move.action.digest, version: move.pointer.version, cause: `rec:${production.action}` },
        tx,
      );
      return { moved: true, move };
      });
      pointerResult = moved.moved
        ? { moved: true, reason: '已移动当前树苗指针' }
        : { moved: false, reason: '当前树苗已被移动过，比较并交换没有成功；这个树苗仍在血线上' };
    }
  } catch (error) {
    if (!(error instanceof KnowledgeError)) throw error;
    pointerResult = { moved: false, reason: `树苗已产出，移动当前树苗指针时被拒：${describeError(error)}` };
  }

  return { ok: true, product: productId, line: input.line, build: build.name, root: production.root, seedling: seedling.digest, composition: production.composition, origin, parent, pointer: pointerResult, reason: null, production };
}
