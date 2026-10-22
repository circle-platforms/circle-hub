// Named documents published by administrators (C4, docs/hub-r4-device-pack.md section 4). `circle-hub doc put` stores
// the file through the source-artifact pipeline (the credential scan as usual: a hit is held back until an admin
// accepts it) and moves a named pointer (hub/records/pointers.ts compare-and-set, `doc:<name>`) to its digest; a
// replacement keeps every older revision readable by digest. The external ids `doc:doc:<name>` (the current
// revision) and `doc:doc:<name>@<sha256>` (a pinned one) are answered by the Hub's own reader (never an external
// system): the revision is the content digest, so withRevision freezes `doc:doc:<name>@<sha256>` into the run at
// start (RunRecord.sources), and the provenance is `declared`. A read needs a run of a pack that declares the doc
// input type (`accepts: ["doc:doc"]` on an input slot) and answers only that run's user; everyone else, and every
// CLI user who is not an admin, gets the same answer as for a doc that does not exist.
import { labelOf } from '../../contracts/generated/vocabulary.ts';
import { ExternalObjectId } from '../../contracts/src/reference.ts';
import { RunId } from '../../contracts/src/common.ts';
import type { ExternalRead, ExternalReadContext, ExternalReaderPort, WorkflowStore } from '../ports.ts';
import {
  RECORD_SCHEMAS,
  sha256Hex,
  type ActionBody,
  type ArtifactOrigin,
  type Principal,
  type RecordsKit,
  type SourceArtifact,
} from '../records/api.ts';

/** Name of a named document (the CLI's `doc put <name>` and the last segment of its external id). */
export const DOC_NAME = /^[a-z][a-z0-9-]{0,63}$/;
/** The external object type a workflow's input slot declares to bind a named document (`accepts: ["doc:doc"]`). */
export const DOC_EXTERNAL_TYPE = 'doc:doc';
/** Largest file `doc put` stores. */
export const MAX_DOC_BYTES = 2 * 1024 * 1024;
/** component@version of this module's pointer moves and read manifests. */
const COMPONENT = 'server.docs@1';
/** Retries of the pointer move when a concurrent put wins the compare-and-set in between. */
const MOVE_ATTEMPTS = 3;

const DOC_ID = /^doc:doc:([a-z][a-z0-9-]{0,63})(?:@([0-9a-f]{64}))?$/;

/** The external id of a named document, pinned when a digest is given. */
export function docIdOf(name: string, sha256?: string): string {
  return `doc:doc:${name}${sha256 === undefined ? '' : `@${sha256}`}`;
}

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

/** A refusal of this module, in Chinese, mapped to a CliError by the CLI. */
export class DocsError extends Error {
  readonly hint: string | null;
  constructor(message: string, hint: string | null = null) {
    super(message);
    this.name = 'DocsError';
    this.hint = hint;
  }
}

export interface DocInfo {
  name: string;
  sha256: string;
  size: number;
}

export interface DocPutResult extends DocInfo {
  /** Pointer version after the move (1 for the first revision). Unchanged when the bytes were already current. */
  version: number;
  /** False when the same bytes were already the current revision (no move, no new revision). */
  created: boolean;
  /** Credential scan findings of the stored bytes: above 0 they are held back until an admin accepts them. */
  findings: number;
}

export interface Docs {
  put(admin: Principal, name: string, bytes: Uint8Array, options?: { fileName?: string; mediaType?: string }): Promise<DocPutResult>;
  list(): Promise<DocInfo[]>;
  show(name: string): Promise<DocInfo | null>;
  reader: ExternalReaderPort;
}

export interface DocsDeps {
  records: RecordsKit;
  workflows: WorkflowStore;
  now?: () => Date;
}

const MEDIA_BY_SUFFIX: ReadonlyArray<[string, string]> = [
  ['.json', 'application/json'],
  ['.md', 'text/markdown'],
  ['.markdown', 'text/markdown'],
  ['.xml', 'application/xml'],
  ['.html', 'text/html'],
  ['.htm', 'text/html'],
  ['.txt', 'text/plain'],
];

/** The media type a doc file is stored as, from its name (the core parser is looked up by it later). */
export function docMediaType(fileName: string | undefined): string {
  const lower = (fileName ?? '').toLowerCase();
  for (const [suffix, type] of MEDIA_BY_SUFFIX) if (lower.endsWith(suffix)) return type;
  return 'application/octet-stream';
}

/** The artifact this module ingested for one revision of one doc (its origin names the doc's pinned id). */
function docRecord(records: SourceArtifact[], name: string, sha256: string): SourceArtifact | undefined {
  return records.find((record) => {
    const origin = record.body.origin as ArtifactOrigin;
    return 'read' in origin && origin.read.object === docIdOf(name, sha256);
  });
}

export function createDocs(deps: DocsDeps): Docs {
  const { records } = deps;
  const now = deps.now ?? (() => new Date());

  async function put(admin: Principal, name: string, bytes: Uint8Array, options: { fileName?: string; mediaType?: string } = {}): Promise<DocPutResult> {
    if (admin.role !== 'admin') throw new DocsError(`没有叫 ${name.slice(0, 80)} 的命名文档`);
    if (!DOC_NAME.test(name)) throw new DocsError(`命名文档的名字要写成小写字母开头的字母、数字或连字符，1 到 64 个字符：${name.slice(0, 80)}`);
    if (!(bytes instanceof Uint8Array)) throw new TypeError('bytes must be a Uint8Array');
    if (bytes.byteLength > MAX_DOC_BYTES) throw new DocsError(`文件有 ${bytes.byteLength} 字节，超过命名文档的上限 ${MAX_DOC_BYTES} 字节（2 MiB），没有保存`);
    const sha256 = sha256Hex(bytes);
    const pointer = docPointerName(name);
    const current = await records.pointers.get(pointer);
    if (current !== null && current.target === sha256) {
      return { name, sha256, size: bytes.byteLength, version: current.version, created: false, findings: 0 };
    }
    const stored = await records.artifacts.ingest({
      bytes,
      mediaType: options.mediaType ?? docMediaType(options.fileName),
      // The Hub takes in the pinned revision of the doc, like a read of it: a scan hit is held back, never refused.
      origin: { read: { object: docIdOf(name, sha256) } },
      author: { user: null },
      provenanceType: 'declared',
      visibility: { readers: [], admins: true, packs: [], shareable: false },
      name: (options.fileName ?? `${name}.bin`).slice(0, 300),
    });
    for (let attempt = 0; ; attempt++) {
      const before = attempt === 0 ? current : await records.pointers.get(pointer);
      const moved = await records.pointers.move({ name: pointer, expected: before?.target ?? null, next: sha256, by: admin, component: COMPONENT });
      if (moved.moved) {
        return { name, sha256, size: bytes.byteLength, version: moved.pointer.version, created: true, findings: stored.body.scan.findings.length };
      }
      if (attempt + 1 >= MOVE_ATTEMPTS) throw new DocsError(`命名文档 ${name} 正在被另一个发布改动，这一份没有存上`, '重新运行这条命令');
    }
  }

  async function show(name: string): Promise<DocInfo | null> {
    if (!DOC_NAME.test(name)) return null;
    const pointer = await records.pointers.get(docPointerName(name));
    if (pointer === null) return null;
    const record = docRecord(await records.artifacts.records(pointer.target), name, pointer.target);
    return { name, sha256: pointer.target, size: record?.body.size ?? 0 };
  }

  /** The digests this doc ever pointed at (its current one included), for the pinned form. */
  async function revisions(name: string): Promise<Set<string>> {
    const out = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await records.pointers.history(docPointerName(name), { limit: 500, ...(cursor === null ? {} : { cursor }) });
      for (const record of page.items) for (const input of record.body.inputs) out.add(input);
      cursor = page.next;
    } while (cursor !== null);
    return out;
  }

  async function read(id: string, context: ExternalReadContext): Promise<ExternalRead> {
    const startedAt = now().toISOString();
    const bare = id.includes('@') ? id.slice(0, id.indexOf('@')) : id;
    const parsed = parseDocId(id);
    if (parsed === null) return { ok: false, id: bare, reason: '不是命名文档的标识' };
    // The caller always gets the engine's neutral SOURCE_UNAVAILABLE; the reason here is for the admin note.
    const neutral = `账号 ${context.principal.id} 不能读命名文档 ${parsed.name}（没有这个文档，或者不能经这次运行读它）`;
    const principal = context.principal;
    if (principal.role !== 'admin') {
      // Through a run only: the run must exist and be this user's, and its pack must declare the doc input type.
      // A run that is not stored yet is being started: bindInputs has already checked the assignment and the slot.
      if (context.run === undefined || context.run === null || !RunId.safeParse(context.run).success) {
        return { ok: false, id: bare, reason: `命名文档只经运行读取；${neutral}` };
      }
      const page = await records.store.find<{ runner?: string; pack_digest?: string }>({ key: 'runs.id', value: context.run, kind: 'run', limit: 1 });
      const record = page.items[0];
      if (record !== undefined) {
        if (record.body.runner !== principal.id) return { ok: false, id: bare, reason: `运行 ${context.run} 不是这个账号的；${neutral}` };
        const workflow = typeof record.body.pack_digest === 'string' ? await deps.workflows.byDigest(record.body.pack_digest) : null;
        const declares = workflow?.workflow.inputs.some((slot) => slot.accepts.includes(DOC_EXTERNAL_TYPE)) ?? false;
        if (!declares) return { ok: false, id: bare, reason: `运行 ${context.run} 的任务包没有声明命名文档输入；${neutral}` };
      }
    }
    const pointer = await records.pointers.get(docPointerName(parsed.name));
    if (parsed.sha256 === null && pointer === null) return { ok: false, id: bare, reason: `没有命名文档 ${parsed.name}；${neutral}` };
    if (parsed.sha256 !== null && pointer === null) return { ok: false, id: bare, reason: `没有命名文档 ${parsed.name}；${neutral}` };
    const target = parsed.sha256 ?? (pointer as { target: string }).target;
    if (parsed.sha256 !== null && target !== (pointer as { target: string }).target && !(await revisions(parsed.name)).has(target)) {
      return { ok: false, id: bare, reason: `命名文档 ${parsed.name} 没有过这份摘要的内容；${neutral}` };
    }
    const bytes = await records.artifacts.trustedBytes(target);
    if (bytes === null) return { ok: false, id: bare, reason: `命名文档 ${parsed.name} 的字节（${target.slice(0, 12)}）不在对象库里` };
    const storedRecord = docRecord(await records.artifacts.records(target), parsed.name, target);
    if (storedRecord === undefined) return { ok: false, id: bare, reason: `命名文档 ${parsed.name} 的源文件记录（${target.slice(0, 12)}）找不到` };
    const visibility = { readers: [principal.id], admins: true, packs: [], shareable: false };
    const run = context.run !== undefined && context.run !== null && RunId.safeParse(context.run).success ? context.run : null;
    const inputs = [`src:${target}`];
    const artifact = await records.artifacts.ingest({
      bytes,
      mediaType: storedRecord.body.media_type,
      origin: { generated: { generator: COMPONENT, inputs } },
      author: { user: null },
      provenanceType: 'declared',
      visibility,
      name: storedRecord.body.name,
      ...(run === null ? {} : { run }),
    });
    if (artifact.body.read_tier !== 'model_readable') {
      return { ok: false, id: bare, reason: `命名文档 ${parsed.name} 的凭据扫描有命中（读取档位“${labelOf('read_tier', artifact.body.read_tier)}”），不交给任务包` };
    }
    const meta = await records.artifacts.ingest({
      bytes: new TextEncoder().encode(JSON.stringify({ title: `命名文档 ${parsed.name}`, name: parsed.name, revision: target, size: bytes.byteLength })),
      mediaType: 'application/json',
      origin: { generated: { generator: COMPONENT, inputs } },
      author: { user: null },
      provenanceType: 'declared',
      visibility,
      name: 'doc-meta.json',
      ...(run === null ? {} : { run }),
    });
    const body: ActionBody = {
      action: 'read',
      run,
      item: null,
      inputs,
      component: COMPONENT,
      lease: null,
      started_at: startedAt,
      ended_at: now().toISOString(),
      result: 'completed',
      error_code: null,
      acceptance: null,
      codes: [],
      detail: {
        external: bare,
        name: parsed.name,
        sha256: target,
        size: bytes.byteLength,
        pinned: parsed.sha256 !== null,
        reader: principal.id,
        purpose: String(context.purpose ?? '').slice(0, 200),
      },
    };
    const manifest = await records.store.put<ActionBody>(
      { kind: 'action', schema: RECORD_SCHEMAS.action, provenance: 'observed', body, created_at: body.ended_at, index: [{ key: 'action.kind', value: 'read' }, ...(run === null ? [] : [{ key: 'action.run', value: run }])] },
    );
    return {
      ok: true,
      id: bare,
      revision: target,
      artifacts: [
        { name: 'original', artifact },
        { name: 'meta', artifact: meta },
      ],
      manifest: manifest.digest,
    };
  }

  return {
    put,
    list: async (): Promise<DocInfo[]> => {
      const pointers = await records.pointers.list('doc:');
      const out: DocInfo[] = [];
      for (const pointer of pointers) {
        const name = pointer.name.slice('doc:'.length);
        const record = docRecord(await records.artifacts.records(pointer.target), name, pointer.target);
        out.push({ name, sha256: pointer.target, size: record?.body.size ?? 0 });
      }
      return out;
    },
    show,
    reader: {
      accepts: async (id: string) => typeof id === 'string' && parseDocId(id) !== null && ExternalObjectId.safeParse(id).success,
      read,
    },
  };
}

/**
 * One ExternalReaderPort over two: ids of the system `doc` go to the named-documents reader, every other id to `other`.
 * For the run engine, beside the knowledge views.
 */
export function routeDocs(docs: ExternalReaderPort, other: ExternalReaderPort): ExternalReaderPort {
  const ours = (id: string): boolean => typeof id === 'string' && id.startsWith('doc:');
  return {
    accepts: (id) => (ours(id) ? docs.accepts(id) : other.accepts(id)),
    read: (id, context) => (ours(id) ? docs.read(id, context) : other.read(id, context)),
  };
}
