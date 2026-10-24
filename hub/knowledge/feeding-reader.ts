// A FeedingReader over the knowledge records: feeding records are stored by the Hub-side write path (kb-feeding-hub)
// with the layer's index keys and, in the record's index, a monotonically increasing sequence position per product
// (the write path stamps `knowledge.feeding.position/<n>`); reads page by key and cut at the frozen offset. The
// position is read from the record's index entries, never invented here.
import type { VersionBinding, FeedingUsage, FeedingRetraction, KnowledgeStructure } from '../../contracts/src/feeding.ts';
import type { KnowledgeStore } from './store.ts';
import type { StoredRecord } from '../records/api.ts';
import type { FeedingCut, FeedingReader, KnowledgeStructureObject } from './feeding-types.ts';
import { FEEDING_INDEX } from './feeding-types.ts';

const OBJECT_SCHEMAS = new Set(['fed-case@1', 'fed-defect@1', 'fed-spec@1', 'fed-build@1', 'fed-note@1']);
/** The sequence position of a feeding record: the write path stamps it into the body (`position`); records without one
 *  are older than every position (0), so a cut never hides them. */
function positionOf(body: { position?: unknown }): number {
  return typeof body.position === 'number' && Number.isSafeInteger(body.position) && body.position >= 0 ? body.position : 0;
}

export class RecordFeedingReader implements FeedingReader {
  readonly #store: KnowledgeStore;

  constructor(store: KnowledgeStore) {
    this.#store = store;
  }

  async cut(product: string, offset: number | null): Promise<FeedingCut | null> {
    const objects = new Map<string, KnowledgeStructureObject>();
    const bindings = new Map<string, VersionBinding[]>();
    const usages: FeedingUsage[] = [];
    const retracted = new Set<string>();
    const contradicted = new Set<string>();
    const before = (position: number): boolean => offset === null || position <= offset;

    for (const row of await this.#store.all<KnowledgeStructure>({ key: FEEDING_INDEX.object, value: product })) {
      const body = row.body;
      if (typeof body !== 'object' || body === null || !('schema' in body) || typeof (body as { schema: unknown }).schema !== 'string') continue;
      if (!OBJECT_SCHEMAS.has((body as { schema: string }).schema)) continue;
      if (!before(positionOf(row.body as { position?: unknown }))) continue;
      const object = body as KnowledgeStructureObject;
      objects.set(object.object, object);
    }
    for (const row of await this.#store.all<VersionBinding>({ key: FEEDING_INDEX.binding, value: product })) {
      if (row.body.schema !== 'version-binding@1') continue;
      if (!before(positionOf(row.body as { position?: unknown }))) continue;
      const list = bindings.get(row.body.object) ?? [];
      list.push(row.body);
      bindings.set(row.body.object, list);
    }
    for (const row of await this.#store.all<FeedingUsage>({ key: FEEDING_INDEX.usage, value: product })) {
      if (row.body.schema !== 'usage@1') continue;
      if (!before(positionOf(row.body as { position?: unknown }))) continue;
      usages.push(row.body);
    }
    for (const row of await this.#store.all<FeedingRetraction>({ key: FEEDING_INDEX.retraction, value: product })) {
      if (row.body.schema !== 'retraction@1') continue;
      if (!before(positionOf(row.body as { position?: unknown }))) continue;
      if ('entries' in row.body) for (const digest of row.body.entries) retracted.add(digest);
      if ('objects' in row.body) for (const digest of row.body.objects) retracted.add(digest);
    }
    if (objects.size === 0 && bindings.size === 0 && usages.length === 0) return null;
    for (const object of objects.values()) {
      if (object.relations?.some((relation) => relation.kind === 'contradicts') === true) contradicted.add(object.object);
    }
    for (const digest of retracted) objects.delete(digest);
    return { offset, objects, bindings, retracted, contradicted, usages };
  }

  async frozenOffset(run: string): Promise<number | null> {
    for (const row of await this.#store.all<{ schema: 'feeding-offset@1'; run: string; root: string | null; offset: number }>({ key: FEEDING_INDEX.offset, value: run })) {
      if (row.body.schema === 'feeding-offset@1' && row.body.run === run) return row.body.offset;
    }
    return null;
  }
}

/** The bound lines of an object: every binding that says bound; conflict candidates are returned beside, never resolved. */
export function boundLines(bindings: readonly VersionBinding[]): { bound: string[]; conflicts: string[][]; undeclared: boolean } {
  const bound = new Set<string>();
  const conflicts: string[][] = [];
  let undeclared = false;
  for (const binding of bindings) {
    if (binding.state === 'bound' && binding.line !== null) bound.add(binding.line);
    if (binding.state === 'conflict') conflicts.push(binding.candidates);
    if (binding.state === 'undeclared') undeclared = true;
  }
  return { bound: [...bound].sort(), conflicts, undeclared };
}
