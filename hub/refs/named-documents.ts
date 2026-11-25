import type { Pointers } from '../records/api.ts';

const DOC_ID = /^doc:doc:([a-z][a-z0-9-]{0,63})(?:@([0-9a-f]{64}))?$/;

/** Name and optional pinned digest of a doc external id; null when it is not one. */
export function parseDocId(id: string): { name: string; sha256: string | null } | null {
  if (typeof id !== 'string') return null;
  const match = DOC_ID.exec(id);
  if (match === null) return null;
  return { name: match[1] as string, sha256: (match[2] as string | undefined) ?? null };
}

/** The pointer whose target is the current revision's digest. */
export function docPointerName(name: string): string {
  return `doc:${name}`;
}

/** The digests this doc ever pointed at (its current one included), for the pinned form. */
export async function documentRevisions(pointers: Pointers, name: string, throughVersion?: number): Promise<Set<string>> {
  const out = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await pointers.history(docPointerName(name), { limit: 500, ...(cursor === null ? {} : { cursor }) });
    for (const record of page.items) {
      const version = record.body.detail.version;
      if (throughVersion !== undefined && !(typeof version === 'number' && version <= throughVersion)) continue;
      for (const input of record.body.inputs) out.add(input);
    }
    cursor = page.next;
  } while (cursor !== null);
  return out;
}

export type DocumentsByRevision = Map<string, Array<{ name: string; current: string }>>;

export async function documentsByRevision(pointers: Pointers, wanted?: ReadonlySet<string>): Promise<DocumentsByRevision> {
  const byRevision: DocumentsByRevision = new Map();
  for (const pointer of await pointers.list('doc:')) {
    const name = pointer.name.slice('doc:'.length);
    const revisions = pointer.version === 1 ? [pointer.target] : await documentRevisions(pointers, name, pointer.version);
    for (const revision of revisions) {
      if (wanted && !wanted.has(revision)) continue;
      const documents = byRevision.get(revision) ?? [];
      documents.push({ name, current: pointer.target });
      byRevision.set(revision, documents);
    }
  }
  return byRevision;
}
