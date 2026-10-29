// Builds, aliases and current roots (K01 R[6], R[10]; D01 R[8]; B05 R[4]). A build record is what the product pack's sync
// listed; the newest record of a name wins. A build whose base differs from its name is an alias and uses the tree of its
// base (followed to the final base, whatever line that is on); roots are keyed by product and base build. The current-root
// pointer of a product line@version names the root of the newest build of that line that has a root (newest release date,
// then build time) and moves only by compare-and-set, by an enabled admin, with the completed production that made the
// root as its cause; every move also writes a root_pointer record in the same transaction. Old roots are never deleted.
import type { RootPointerBody } from '../../contracts/src/knowledge.ts';
import type { BuildInfo, KnownBuild } from '../../contracts/src/product.ts';
import type { RootInfo } from '../ports.ts';
import type { ActionBody, PointerState, Principal, StoredRecord } from '../records/api.ts';
import { requireAdmin, type KnowledgeContext } from './context.ts';
import { canonicalize } from '../records/api.ts';
import { mapLimited } from './concurrency.ts';
import { compareText } from './digest.ts';
import { KnowledgeError } from './errors.ts';
import { infoOf } from './produce.ts';
import { COMPONENTS, INDEX, KnowledgeStore, buildKey, indexValueFits, listRoles, pointerName, withoutLists, type ProduceAction, type StoredBuild } from './store.ts';

export { pointerName };

/** Longest alias chain followed (an alias of an alias ...); a cycle or a longer chain stops there. */
const MAX_ALIAS_HOPS = 8;
const SHA256 = /^[0-9a-f]{64}$/;

/** Newest first: release date (unreleased last), then build time (unknown last), then name. */
export function compareNewestFirst(a: BuildInfo, b: BuildInfo): number {
  const byTime = (x: string | null, y: string | null): number => (x === y ? 0 : x === null ? 1 : y === null ? -1 : x < y ? 1 : -1);
  return byTime(a.released_at, b.released_at) || byTime(a.built_at, b.built_at) || compareText(a.name, b.name);
}

export interface MoveRootOptions {
  /** The enabled admin who moves the pointer; default the service's admin. */
  by?: Principal | null;
  /** The build whose root the pointer will name: on the pointer's line, using the tree the cause produced. Default the cause's build. */
  build?: string;
  /** The composition the pointer will name; when given it must be the cause's. */
  composition?: string;
  /** The observation that a reconciliation made before choosing its target. */
  expected_action?: string | null;
}

export type MoveRootResult =
  | { moved: true; pointer: PointerState; move: string; record: string }
  | { moved: false; current: PointerState | null; reason: string };

/** What reconciling the current root of one line did. */
export interface LineReconciliation {
  line: string | null;
  from: string | null;
  to: string | null;
  build: string | null;
  moved: boolean;
  reason: string;
}

/** A known build with the base whose tree it uses (aliases followed) and that base's newest completed production. */
interface Resolved {
  build: KnownBuild;
  base: string;
  production: ProduceAction | null;
}

export class Builds {
  readonly #context: KnowledgeContext;

  constructor(context: KnowledgeContext) {
    this.#context = context;
  }

  get #store(): KnowledgeStore {
    return this.#context.store;
  }

  /**
   * The newest record of every build name of a product. A record changes only when the build's identity does (a list that
   * changes writes none), and every produced build has one, so this is read without the history of productions.
   */
  async latestRecords(product: string): Promise<Map<string, StoredBuild>> {
    const out = new Map<string, StoredBuild>();
    for (const build of await this.#store.buildsOf(product)) out.set(build.body.build.name, build);
    return out;
  }

  /** The newest completed production of each of these base builds, looked up per base (a few records each). */
  async roots(product: string, bases: Iterable<string>): Promise<Map<string, ProduceAction>> {
    const unique = [...new Set(bases)];
    // Most known bases can have no production at all. Probe exact index keys in small batches, then use the
    // existing newest-valid reader for every key that exists. A failed probe is only an optimization failure:
    // fall back to the original reads, including their original integrity and error behavior.
    const batches: string[][] = [];
    for (let i = 0; i < unique.length; i += 16) batches.push(unique.slice(i, i + 16));
    const present = await mapLimited(batches, 2, async batch => {
      try {
        const found = await this.#store.records.findFirstMany({ key: INDEX.produce, values: batch.map(base => buildKey(product, base)), kind: 'action' });
        return batch.filter(base => found.has(buildKey(product, base)));
      } catch {
        return batch;
      }
    });
    const candidates = present.flat();
    const found = await mapLimited(candidates, 8, (base) => this.#store.latestProduction(product, base));
    const out = new Map<string, ProduceAction>();
    candidates.forEach((base, i) => {
      const production = found[i];
      if (production !== null) out.set(base, production);
    });
    return out;
  }

  /** Every known build with its final base and that base's production, newest first. */
  async #resolvedAll(product: string): Promise<Resolved[]> {
    const records = await this.latestRecords(product);
    const infos = new Map<string, BuildInfo>();
    for (const [name, record] of records) infos.set(name, withoutLists(record.body.build));
    const bases = new Map<string, string>();
    for (const info of infos.values()) bases.set(info.name, finalBase(info, infos));
    const roots = await this.roots(product, bases.values());
    const out: Resolved[] = [];
    for (const info of infos.values()) {
      const base = bases.get(info.name) as string;
      const production = roots.get(base) ?? null;
      out.push({ build: { ...info, root: production?.detail.root ?? null }, base, production });
    }
    return out.sort((a, b) => compareNewestFirst(a.build, b.build));
  }

  /** Every build the knowledge base knows for a product, any family, with the root of the tree it uses; newest first. */
  async known(product: string): Promise<KnownBuild[]> {
    return (await this.#resolvedAll(product)).map((r) => r.build);
  }

  /** The record a build name (any family, any case when unambiguous) names, without its list roles, or null. */
  async #named(product: string, name: string): Promise<BuildInfo | null> {
    const records = await this.#store.buildsNamed(product, name);
    const exact = records.filter((r) => r.body.build.name === name);
    if (exact.length > 0) return withoutLists(exact[exact.length - 1].body.build);
    const names = new Set(records.map((r) => r.body.build.name));
    if (names.size === 1) return withoutLists(records[records.length - 1].body.build);
    if (names.size > 1) return null;
    const produced = await this.#store.latestProduction(product, name);
    return produced?.detail.build == null ? null : withoutLists(produced.detail.build);
  }

  /** The record of a name and the last build its alias chain reaches (itself when it is not an alias); null when unknown. */
  async #chain(product: string, name: string): Promise<{ named: BuildInfo; last: BuildInfo } | null> {
    if (typeof name !== 'string' || name.trim() === '' || !indexValueFits(buildKey(product, name.trim()))) return null;
    const named = await this.#named(product, name.trim());
    if (named === null) return null;
    let current = named;
    const seen = new Set<string>([current.name]);
    for (let hop = 0; hop < MAX_ALIAS_HOPS && current.base !== current.name; hop++) {
      if (seen.has(current.base)) break;
      const base: BuildInfo | null = await this.#named(product, current.base);
      if (base === null || base.name !== current.base) break;
      seen.add(base.name);
      current = base;
    }
    return { named, last: current };
  }

  /** Original spellings matching a folded name, never an arbitrary winner of an ambiguous spelling. */
  async candidates(product: string, name: string): Promise<BuildInfo[]> {
    const records = await this.#store.buildsNamed(product, name.trim());
    const latest = new Map<string, BuildInfo>();
    for (const record of records) latest.set(record.body.build.name, withoutLists(record.body.build));
    const exact = latest.get(name.trim());
    return exact ? [exact] : [...latest.values()].sort((a,b) => compareText(a.name,b.name));
  }

  /** The record a build name names (exact, else the one spelling that folds to it), aliases not followed; null when unknown. */
  async named(product: string, name: string): Promise<BuildInfo | null> {
    return (await this.#chain(product, name))?.named ?? null;
  }

  /** Any build name to the build whose tree it uses, aliases followed; null when unknown. */
  async resolve(product: string, name: string): Promise<KnownBuild | null> {
    const chain = await this.#chain(product, name);
    if (chain === null) return null;
    const production = await this.#store.latestProduction(product, baseOf(chain.last));
    return { ...chain.last, root: production?.detail.root ?? null };
  }

  /** RootInfo of a production; its build without list roles (they are in the composition, by reference). */
  rootInfoOf(production: ProduceAction, product: string): RootInfo<KnownBuild | null> {
    return {
      root: production.detail.root as string,
      composition: production.detail.composition as string,
      product,
      build: production.detail.build === null ? null : { ...withoutLists(production.detail.build), root: production.detail.root },
      produced_at: production.record.body.ended_at,
    };
  }

  /** The sync root of a build name: one name lookup and the latest completed production of its base. */
  async syncRoot(product: string, name: string): Promise<(RootInfo & { build: KnownBuild }) | null> {
    const chain = await this.#chain(product, name);
    if (chain === null) return null;
    const production = await this.#store.latestProduction(product, baseOf(chain.last));
    const info = production === null ? null : this.rootInfoOf(production, product);
    return info?.build ? { ...info, build: info.build } : null;
  }

  /** The root a build name of any family resolves to. */
  async rootOfBuild(product: string, name: string): Promise<(RootInfo & { build: KnownBuild }) | null> {
    const build = await this.resolve(product, name);
    if (build === null) return null;
    const production = await this.#store.latestProduction(product, baseOf(build));
    const info = production === null ? null : this.rootInfoOf(production, product);
    return info?.build ? { ...info, build: info.build } : null;
  }

  /** Every composition of a root digest (equal content from different builds or products shares one root). */
  async rootInfo(root: string): Promise<RootInfo<KnownBuild | null>[]> {
    if (!SHA256.test(root)) return [];
    const productions = await this.#store.productionsOfRoot(root);
    return productions.map((production) => this.rootInfoOf(production, production.detail.product));
  }

  /** The newest build of a line that has a root, with the production of its final base, or null. */
  async #newestOfLine(product: string, line: string): Promise<Resolved | null> {
    return (await this.#resolvedAll(product)).find((r) => r.build.line === line && r.production !== null) ?? null;
  }

  /** The newest build of a line that has a root, or null. */
  async newestOfLine(product: string, line: string): Promise<KnownBuild | null> {
    return (await this.#newestOfLine(product, line))?.build ?? null;
  }

  /** The root the current-root pointer of a product line names. */
  async currentRoot(product: string, line: string): Promise<(RootInfo & { build: KnownBuild }) | null>;
  async currentRoot(product: string, line: null): Promise<RootInfo<null> | null>;
  async currentRoot(product: string, line: string | null): Promise<RootInfo<KnownBuild | null> | null>;
  async currentRoot(product: string, line: string | null): Promise<RootInfo<KnownBuild | null> | null> {
    let name: string;
    try {
      name = pointerName(product, line);
    } catch {
      return null;
    }
    const pointer = await this.#context.records.pointers.get(name);
    if (pointer === null) return null;
    const move = await this.#store.pointerMove(pointer.action);
    if (move !== null && move.root === pointer.target && move.product === product) {
      const productions = await this.#store.productionsOfRoot(pointer.target);
      const production = productions.find((p) => p.detail.composition === move.composition) ?? productions[productions.length - 1];
      if (production !== undefined) return this.rootInfoOf(production, product);
    }
    const productions = (await this.#store.productionsOfRoot(pointer.target)).filter((p) => p.detail.product === product && (p.detail.build?.line ?? null) === line);
    const latest = productions[productions.length - 1];
    return latest === undefined ? null : this.rootInfoOf(latest, product);
  }

  /**
   * Stores a build record when the build differs from the newest record of its name, list roles named but not kept (a list
   * that changes is not a new record: the ids a production reads are kept with it); true when one was written.
   */
  async record(product: string, pack: { id: string; version: string; digest: string }, build: BuildInfo, plan: string | null, sync: string | null): Promise<boolean> {
    const info = infoOf(build);
    const claim = withoutLists(info);
    const lists = listRoles(info);
    const existing = (await this.#store.buildsNamed(product, info.name)).filter((r) => r.body.build.name === info.name);
    const newest = existing[existing.length - 1];
    if (newest !== undefined && canonicalize({ build: newest.body.build, lists: newest.body.lists ?? [] }) === canonicalize({ build: claim, lists })) return false;
    await this.#store.putBuild({ product, build: claim, ...(lists.length > 0 ? { lists } : {}), pack, plan, sync });
    return true;
  }

  /**
   * Moves the current root of a product line@version from `expected` to `root` by compare-and-set, writing the move_root
   * action (records Pointers) and a root_pointer record in one transaction. Only an enabled admin moves it, and only with
   * the completed generate action that produced `root` for this product as `cause` (B05 R[4]); the build the pointer will
   * name is on this line and uses that production's tree. A refused compare-and-set writes nothing.
   */
  async moveRoot(product: string, line: string | null, expected: string | null, root: string, cause: string | null, options: MoveRootOptions = {}): Promise<MoveRootResult> {
    const by = await requireAdmin(this.#context, options.by, '移动当前根');
    if (!SHA256.test(root) || (expected !== null && !SHA256.test(expected))) throw new KnowledgeError('根摘要必须是 64 位小写十六进制');
    const name = pointerName(product, line);
    if (cause === null || !SHA256.test(cause)) throw new KnowledgeError('移动当前根要写明产出这个根的生产动作（generate 动作记录的摘要）');
    const record = await this.#store.records.get<ActionBody>(cause);
    const production = record === null ? null : KnowledgeStore.produceOf(record as StoredRecord<ActionBody>);
    if (production === null || !production.completed || production.detail.product !== product || production.detail.root !== root) {
      throw new KnowledgeError(`动作 ${cause} 不是产品线 ${product} 产出根 ${root} 的已完成生产动作，当前根不能指向它`);
    }
    if (options.composition !== undefined && options.composition !== production.detail.composition) {
      throw new KnowledgeError(`组成记录 ${options.composition} 不是这个生产动作的结果`);
    }
    // The build the pointer names: its own record is on this line, and its alias chain ends at the produced build.
    if ((line === null) !== (production.detail.build === null)) throw new KnowledgeError('生产动作的构建范围和指针范围不符');
    const producedBuild = production.detail.build;
    const buildName = options.build ?? producedBuild?.name ?? null;
    const chain = buildName === null ? null : await this.#chain(product, buildName);
    const named = chain?.named ?? (producedBuild !== null && buildName === producedBuild.name ? withoutLists(producedBuild) : null);
    if (named === null && line !== null) throw new KnowledgeError(`不认识构建 ${buildName}`);
    if (named !== null && named.line !== line) throw new KnowledgeError(`构建 ${named.name} 属于版本线 ${named.line}，不是 ${line}`);
    const base = chain === null ? named?.name ?? null : baseOf(chain.last);
    if (base !== (producedBuild?.name ?? null)) throw new KnowledgeError(`构建 ${named?.name} 用的是 ${base} 的树，不用这个生产动作的树（${producedBuild?.name}）`);
    const current = await this.#context.records.pointers.get(name);
    if(expected===root&&current?.target===root){const previous=await this.#store.pointerMove(current.action);if(previous?.composition===production.detail.composition)return {moved:false,current,reason:'当前根和组成已经相同'};}
    const records = this.#context.records;
    return records.store.withTransaction(async (tx) => {
      const moved = await records.pointers.move(
        { name, expected, next: root, refresh:expected===root, expected_action:options.expected_action!==undefined?options.expected_action:current?.action??null, by: { id: by.id, name: by.name, role: by.role }, run: null, component: COMPONENTS.sync, note: `生产动作 rec:${cause}` },
        tx,
      );
      if (!moved.moved) return { moved: false, current: moved.current, reason: '当前根已被移动过，比较并交换没有成功' };
      const body: RootPointerBody = {
        product,
        line,
        pointer: name,
        expected,
        root,
        build: named?.name ?? null,
        composition: production.detail.composition as string,
        move: moved.action.digest,
        version: moved.pointer.version,
        cause: `rec:${cause}`,
      };
      const pointerRecord = await this.#store.putPointerMove(body, tx);
      return { moved: true, pointer: moved.pointer, move: moved.action.digest, record: pointerRecord.digest };
    });
  }

  /**
   * Level-triggered reconciliation of one line (W09 R[2]): the pointer should name the root of the newest build of the line
   * that has one. The pointer is read before the newest build is decided, so the compare-and-set fails whenever anything
   * moved it in between (a reconciliation never moves a line back over a newer root); it then reads again.
   */
  async reconcileLine(product: string, line: string, by: Principal | null): Promise<LineReconciliation> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const pointer = await this.#context.records.pointers.get(pointerName(product, line));
      const from = pointer?.target ?? null;
      const newest = await this.#newestOfLine(product, line);
      if (newest === null || newest.production === null) return { line, from, to: null, build: null, moved: false, reason: '这条版本线还没有根' };
      const to = newest.production.detail.root as string;
      if(from===to&&pointer){const previous=await this.#store.pointerMove(pointer.action);if(previous?.composition===newest.production.detail.composition)return {line,from,to,build:newest.build.name,moved:false,reason:'当前根和组成已是最新'};}
      // The cause is the generate action that produced the root of the final base (B05 R[4]).
      const result = await this.moveRoot(product, line, from, to, newest.production.record.digest, {
        by,
        build: newest.build.name,
        composition: newest.production.detail.composition as string,
        expected_action: pointer?.action ?? null,
      });
      if (result.moved) return { line, from, to, build: newest.build.name, moved: true, reason: `移到 ${newest.build.name} 的根` };
    }
    const pointer = await this.#context.records.pointers.get(pointerName(product, line));
    return { line, from: pointer?.target ?? null, to: null, build: null, moved: false, reason: '当前根反复被别人移动，这次没有移动' };
  }
}

/** The base build a build's tree comes from: itself, or the base an alias names. */
function baseOf(build: BuildInfo): string {
  return build.base === build.name ? build.name : build.base;
}

/** The final base of a build within a set of known builds (aliases followed, cycle-safe). */
function finalBase(info: BuildInfo, infos: ReadonlyMap<string, BuildInfo>): string {
  let current = info;
  const seen = new Set([current.name]);
  for (let hop = 0; hop < MAX_ALIAS_HOPS && current.base !== current.name; hop++) {
    const base = infos.get(current.base);
    if (base === undefined || seen.has(base.name)) return current.base;
    seen.add(base.name);
    current = base;
  }
  return baseOf(current);
}
