// The directory binding knowledge sync's plan and knowledge seed both use: one revision, the whole tree, no batch cut.
import type { Producer } from '../../contracts/src/product.ts';
import { ADOC_LIMITS, ManualSourceError, directoryOf, listedSources, rootId, treeOf } from '../../packs/product/apv/functions/adoc/tree.ts';
import { readSource } from './page.ts';
import type { SourceLoader } from './sources.ts';

export interface DirectorySlot {
  slot: string;
  role: string;
}

/** A manual producer's directory inputs. `several` when it declares more than one list. Null when it declares neither. */
export function declaredDirectory(producer: Producer): { meta: DirectorySlot | null; many: DirectorySlot | null } | 'several' | null {
  const sources = Object.entries(producer.inputs).flatMap(([slot, input]) => ('source' in input ? [[slot, input] as const] : []));
  const many = sources.filter(([, input]) => input.many === true);
  const meta = sources.filter(([slot, input]) => slot === 'meta' && input.many !== true);
  if (many.length === 0 && meta.length === 0) return null;
  if (many.length > 1) return 'several';
  return {
    meta: meta.length === 1 ? { slot: meta[0][0], role: meta[0][1].source } : null,
    many: many.length === 1 ? { slot: many[0][0], role: many[0][1].source } : null,
  };
}

export type DirectoryBind =
  | { ok: true; sources: Record<string, string | string[]> | null }
  | { ok: false; slot: string; detail: string; next: string };

/**
 * When `root` is a directory template, read that SVN directory at one revision and bind the producer's meta role and
 * list role to the complete tree. A null root binds nothing. A missing page fails closed and names that page.
 */
export async function bindDirectorySources(input: {
  producer: Producer;
  line: string;
  root: unknown;
  loader: SourceLoader;
  maxBytes: number;
  next: string;
}): Promise<DirectoryBind> {
  const declared = declaredDirectory(input.producer);
  if (declared === null || declared === 'several') return { ok: true, sources: null };
  const slot = declared.many?.slot ?? declared.meta?.slot ?? 'meta';
  const role = declared.many?.role ?? declared.meta?.role ?? 'meta';
  let path: string | null;
  try {
    path = directoryOf(input.root === undefined ? null : input.root, input.line);
  } catch (error) {
    if (error instanceof ManualSourceError) return { ok: false, slot, detail: error.message, next: error.next_action };
    throw error;
  }
  if (path === null) return { ok: true, sources: null };

  const models = new Map<string, unknown>();
  const revisions = new Map<string, string | null>();
  const load = async (id: string): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const read = await readSource(input.loader, id, input.maxBytes);
    revisions.set(id, read.revision);
    if (!read.page.ok) return { ok: false, reason: read.page.reason ?? '读不出' };
    models.set(id, read.page.model);
    return { ok: true };
  };
  const fail = (id: string, reason: string, next = input.next): DirectoryBind => ({
    ok: false, slot, detail: `${input.producer.id}.${slot}（${role}）缺少来源 ${id}：${reason}`, next,
  });

  let tree = treeOf(path, (id) => models.get(id));
  try {
    for (let step = 0; step <= ADOC_LIMITS.directories && tree.pending.length > 0; step++) {
      const pending = tree.pending.find((id) => !models.has(id));
      if (pending === undefined) break;
      const read = await load(pending);
      if (!read.ok) return fail(pending, read.reason);
      if (read.ok && revisions.get(pending) === null) return fail(pending, 'SVN 读取没有给出修订号');
      tree = treeOf(path, (id) => models.get(id));
    }
  } catch (error) {
    if (error instanceof ManualSourceError) return { ok: false, slot, detail: error.message, next: error.next_action };
    throw error;
  }
  if (tree.pending.length > 0) return fail(tree.pending[0], '目录清单仍未读全');
  const directoryRevision = revisions.get(rootId(path));
  if (directoryRevision === undefined || directoryRevision === null || directoryRevision !== tree.revision) {
    return fail(rootId(path), `修订号是 ${directoryRevision ?? '（无）'}，目录清单修订号是 ${tree.revision}`);
  }
  const files = listedSources(path, tree);
  for (const id of files) {
    const read = await readSource(input.loader, id, input.maxBytes);
    if (!read.page.ok) return fail(id, read.page.reason ?? '读不出');
    if (read.revision !== tree.revision) return fail(id, `修订号是 ${read.revision ?? '（无）'}，目录修订号是 ${tree.revision}`);
  }
  const sources: Record<string, string | string[]> = {};
  if (declared.meta) sources[declared.meta.role] = rootId(path);
  if (declared.many) sources[declared.many.role] = files;
  return { ok: true, sources };
}
