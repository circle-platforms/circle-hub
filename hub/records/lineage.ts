// Verified source links for derived credential acceptance. No text, matched values or text fingerprints leave records.
import { z } from 'zod';
import { TreeRootBody, TreeRootSourcesPart } from '../../contracts/src/knowledge.ts';
import type { ArtifactOrigin, RecordStore, SourceArtifact, SourceArtifactBody } from './api.ts';
import { isSha256 } from './digest.ts';

const ROOT_READER = z.compile(TreeRootBody), SOURCES_READER = z.compile(TreeRootSourcesPart);

export type SourceLinks = Map<string, Set<string | null>>;

/** Actual inputs only: source references, pinned source records, or pinned compositions of the named roots. */
export async function sourceLinks(store: Pick<RecordStore,'get'>, origin: ArtifactOrigin): Promise<SourceLinks | null> {
  if (!('generated' in origin)) return null;
  const links: SourceLinks = new Map();
  const add = (sha: string, record: string | null) => {
    const records = links.get(sha) ?? new Set<string | null>(); records.add(record); links.set(sha,records);
  };
  const roots = new Set(origin.generated.inputs.flatMap(input => /^tree:([a-f0-9]{64})\/$/.exec(input)?.slice(1) ?? []));
  const pinnedRoots = new Set<string>();
  for (const input of origin.generated.inputs) {
    const source = /^src:([a-f0-9]{64})(?:$|[/#])/.exec(input);
    if (source) { add(source[1],null); continue; }
    if (/^tree:([a-f0-9]{64})\/$/.test(input)) continue;
    const reference = /^rec:([a-f0-9]{64})$/.exec(input);
    if (!reference) return null;
    const record = await store.get<unknown>(reference[1]);
    if (!record) return null;
    if (record.kind === 'source_artifact' && record.schema === 'source_artifact@1') {
      const body = record.body as SourceArtifactBody;
      if (!isSha256(body.sha256)) return null;
      add(body.sha256,record.digest); continue;
    }
    if (record.kind !== 'tree_root' || record.schema !== 'tree_root@1') return null;
    const parsed = ROOT_READER.safeParse(record.body);
    if (!parsed.success || !roots.has(parsed.data.root)) return null;
    pinnedRoots.add(parsed.data.root);
    for (const source of parsed.data.sources) add(source.sha256,source.artifact);
    for (const part of parsed.data.parts?.sources ?? []) {
      const stored = await store.get<unknown>(part.record);
      if (!stored || stored.kind !== 'tree_root' || stored.schema !== 'tree_root-sources@1') return null;
      const rows = SOURCES_READER.safeParse(stored.body);
      if (!rows.success) return null;
      for (const source of rows.data.rows) add(source.sha256,source.artifact);
    }
  }
  if ([...roots].some(root => !pinnedRoots.has(root))) return null;
  return links;
}

/** A recorded Hub read/generated artifact, never an upload or a person's authored bytes. */
export function hubArtifact(artifact: Pick<SourceArtifact,'body'>): boolean {
  return !('upload' in artifact.body.origin) && artifact.body.author?.user === null;
}
