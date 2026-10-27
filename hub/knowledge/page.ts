// One external page as sync and seed both read it: the connector read, the same byte checks, the core parser.
import type { SyncPlanInput } from '../../contracts/src/product.ts';
import type { SourceLoader } from './sources.ts';

export type ParsedPage = SyncPlanInput['read'][string];

export interface ReadSource {
  page: ParsedPage;
  revision: string | null;
}

/** The parsed page and the connector revision. Sync keeps only the page; seed also checks the revision. A declared
 *  parser (the producer's declaration for the file group) goes straight to the loader's single parse entry, so the
 *  same bytes parse the same way in a sync and in a seed and a changed declaration never reuses the old pick. */
export async function readSource(loader: SourceLoader, id: string, maxBytes: number, declaredParser?: string): Promise<ReadSource> {
  const load = await loader.read(id);
  if (!load.ok) return { page: { ok: false, media_type: null, parser: null, model: null, reason: load.reason }, revision: null };
  const mediaType = load.artifact.body.media_type;
  const readable = await loader.readable(load, maxBytes);
  if (!readable.ok) return { page: { ok: false, media_type: mediaType, parser: null, model: null, reason: readable.reason }, revision: load.revision };
  const parsed = await loader.parse(readable.value, declaredParser);
  if (!parsed.ok) return { page: { ok: false, media_type: mediaType, parser: null, model: null, reason: parsed.reason }, revision: load.revision };
  return { page: { ok: true, media_type: mediaType, parser: parsed.value.parser, model: parsed.value.document.model, reason: null }, revision: load.revision };
}

/** One page of a plan: read, checked like any source, parsed with the core parser for its media type. */
export async function readPage(loader: SourceLoader, id: string, maxBytes: number): Promise<ParsedPage> {
  return (await readSource(loader, id, maxBytes)).page;
}
