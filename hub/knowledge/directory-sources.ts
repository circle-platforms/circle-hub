// The directory binding knowledge sync's plan and knowledge seed both use: each book is its own directory,
// one revision, the whole subtree, no batch cut. The walk is the adoc-format skill's generic module, reached only
// through that pack's api.ts; the version-line directory spelling is the layout the product pack declares.
import type { Producer } from '../../contracts/src/product.ts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Hex } from '../records/api.ts';
import { DIRECTORY_LIMITS, DirectorySourceError, PACK_DIR, booksOf, directoryOf, listedSources, mainsOf, rootId } from '../../packs/skill/adoc-format/api.ts';
import { readSource } from './page.ts';
import type { SourceLoader } from './sources.ts';

export interface DirectorySlot {
  slot: string;
  role: string;
  /** The parser the producer declared for the directory's file group (text@1 for adoc), applied to every file read. */
  parser: string | null;
}

/** A manual producer's directory inputs. `several` when it declares more than one list. Null when it declares neither. */
export function declaredDirectory(producer: Producer): { meta: DirectorySlot | null; many: DirectorySlot | null } | 'several' | null {
  const sources = Object.entries(producer.inputs).flatMap(([slot, input]) => ('source' in input ? [[slot, input] as const] : []));
  const many = sources.filter(([, input]) => input.many === true);
  const meta = sources.filter(([slot, input]) => slot === 'meta' && input.many !== true);
  if (many.length === 0 && meta.length === 0) return null;
  if (many.length > 1) return 'several';
  return {
    meta: meta.length === 1 ? { slot: meta[0][0], role: meta[0][1].source, parser: meta[0][1].parser ?? null } : null,
    many: many.length === 1 ? { slot: many[0][0], role: many[0][1].source, parser: many[0][1].parser ?? null } : null,
  };
}

/**
 * The skill whose walk bound a production's sources (issue 34, decision 157): the pack's id and version as its manifest
 * states them, the walk module, and the SHA-256 of that module's bytes as this process loaded them. The manifest of that
 * version lists the same file with its digest, so the record can be checked against the published skill. A production
 * whose walk ran inside the product pack's sandbox carries the product pack's digest instead, which covers its copy.
 */
export interface DirectorySkill { id: string; version: string; module: string; sha256: string }
const WALK_MODULE = 'functions/directory.ts';
let walkSkill: Promise<DirectorySkill> | undefined;
export function directorySkill(): Promise<DirectorySkill> {
  return (walkSkill ??= (async () => {
    const manifest = JSON.parse(await readFile(join(PACK_DIR, 'pack.json'), 'utf8')) as { id?: unknown; version?: unknown };
    if (typeof manifest.id !== 'string' || typeof manifest.version !== 'string') throw new Error('目录遍历技能包的清单缺少包名或版本');
    return { id: manifest.id, version: manifest.version, module: WALK_MODULE, sha256: sha256Hex(await readFile(join(PACK_DIR, WALK_MODULE))) };
  })());
}

export type DirectoryBind =
  | { ok: true; sources: Record<string, string | string[]> | null; skill?: DirectorySkill }
  | { ok: false; slot: string; detail: string; next: string };

/**
 * When `root` is a directory template, bind the meta role to that listing and the list role to each main file's
 * directory. A null root binds nothing. A missing page fails closed and names that page. `layout` is the producer's
 * declared directory layout (its `layout` parameter), which spells `{line_dir}`; without it only `{line}` expands.
 */
export async function bindDirectorySources(input: {
  producer: Producer;
  line: string;
  root: unknown;
  layout?: unknown;
  mains?: { cli: unknown; app: unknown };
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
    path = directoryOf(input.root === undefined ? null : input.root, input.line, input.layout);
  } catch (error) {
    if (error instanceof DirectorySourceError) return { ok: false, slot, detail: error.message, next: error.next_action };
    throw error;
  }
  if (path === null) return { ok: true, sources: null };

  const models = new Map<string, unknown>();
  const revisions = new Map<string, string | null>();
  // Each file of the group parses with the producer's declared parser for that group (the same single entry the sync
  // loader uses): a server labelling an adoc `application/octet-stream` still reads, and a changed declaration re-parses
  // because the document cache keys on the parser, never reusing an older recognizer pick for the same bytes. The
  // directory listings themselves keep the media recognizer: they are the connector's own XML/JSON documents.
  const fileParser = declared.many?.parser ?? null;
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

  let mains: { cli: string; app: string } | null;
  try {
    mains = mainsOf(input.mains?.cli, input.mains?.app);
  } catch (error) {
    if (error instanceof DirectorySourceError) return { ok: false, slot, detail: error.message, next: error.next_action };
    throw error;
  }
  const readWalk = (): ReturnType<typeof booksOf> => booksOf(path, mains, (id) => models.get(id));
  let walk = readWalk();
  try {
    for (let step = 0; step < DIRECTORY_LIMITS.directories * 2 + 1 && walk.pending.length > 0; step++) {
      const pending = walk.pending.find((id) => !models.has(id));
      if (pending === undefined) break;
      const read = await load(pending);
      if (!read.ok) return fail(pending, read.reason);
      if (revisions.get(pending) === null) return fail(pending, 'SVN 读取没有给出修订号');
      walk = readWalk();
    }
  } catch (error) {
    if (error instanceof DirectorySourceError) return { ok: false, slot, detail: error.message, next: error.next_action };
    throw error;
  }
  if (walk.pending.length > 0 || walk.revision === '') return fail(walk.pending[0] ?? rootId(path), '目录清单仍未读全');
  const directoryRevision = revisions.get(rootId(path));
  if (directoryRevision === undefined || directoryRevision === null || directoryRevision !== walk.revision) {
    return fail(rootId(path), `修订号是 ${directoryRevision ?? '（无）'}，目录清单修订号是 ${walk.revision}`);
  }
  const files: string[] = [];
  const seen = new Set<string>();
  for (const group of walk.groups) {
    if (group.tree.revision !== walk.revision) return fail(rootId(group.directory), `修订号是 ${group.tree.revision}，目录修订号是 ${walk.revision}`);
    for (const id of listedSources(group.directory, group.tree)) if (!seen.has(id)) { seen.add(id); files.push(id); }
  }
  for (const id of files) {
    const read = await readSource(input.loader, id, input.maxBytes, fileParser ?? undefined);
    if (!read.page.ok) return fail(id, read.page.reason ?? '读不出');
    if (read.revision !== walk.revision) return fail(id, `修订号是 ${read.revision ?? '（无）'}，目录修订号是 ${walk.revision}`);
  }
  const sources: Record<string, string | string[]> = {};
  if (declared.meta) sources[declared.meta.role] = rootId(path);
  if (declared.many) sources[declared.many.role] = files;
  return { ok: true, sources, skill: await directorySkill() };
}
