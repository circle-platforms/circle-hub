// Reading and parsing the sources of a sync or a production: through the ExternalReaderPort in an admin context, then the
// stored bytes through the tier-aware Artifacts.source (never trustedBytes), then the core parser for the media type (the
// Hub parses, not the pack). Only model-readable text read with a shared credential enters the tree: a credential hit
// (retain_only), function-only bytes, bytes the scanner could not inspect and personal-credential reads are refused with a
// Chinese reason naming the digest (B02 R[3], R[4]; records README, Needs).
import { labelOf, type ReadTier } from '../../contracts/generated/vocabulary.ts';
import { EXTERNAL_ARTIFACT, type ExternalReaderPort } from '../ports.ts';
import type { Artifacts, Principal, SourceArtifact } from '../records/api.ts';
import { ParseError, parserKey, recognize, type ParsedDocument, type ParserRegistry } from '../refs/api.ts';
import { describeError } from './errors.ts';
import { Lru } from './store.ts';

const MODEL_READABLE: ReadTier = 'model_readable';
const RETAIN_ONLY: ReadTier = 'retain_only';

/** One external read: the artifact a consumer parses (`content` when the system pack derived one, else the original). */
export type ExternalLoad =
  | { ok: true; id: string; revision: string | null; artifact: SourceArtifact }
  | { ok: false; id: string; reason: string };

/** Stored bytes a parser may read, with the record that decided the read. */
export interface ReadableSource {
  external: string;
  revision: string | null;
  sha256: string;
  size: number;
  mediaType: string;
  artifact: SourceArtifact;
  readTier: ReadTier;
  bytes: Uint8Array;
}

export interface ParsedSource extends ReadableSource {
  /** parser@version that parsed it. */
  parser: string;
  document: ParsedDocument;
}

export type Loaded<T> = { ok: true; value: T } | { ok: false; reason: string; sha256: string | null };

export interface SourceDeps {
  external: ExternalReaderPort;
  artifacts: Artifacts;
  parsers: ParserRegistry;
}

/** The message for a source whose credential scan found something: names the digest and how an administrator unblocks it. */
export function credentialReason(sha256: string, external: string): string {
  return (
    `源文件 ${sha256}（${external}）的凭据扫描有命中，读取档位为“${labelOf('read_tier', RETAIN_ONLY)}”（${labelOf('validity_status', 'credential_unreadable')}），` +
    `不进知识树。管理员核对后可以接受这份文件（摘要 ${sha256}）的扫描命中项，然后重新运行同步。`
  );
}

/**
 * Reads, checks and parses sources for one sync. External reads are kept by id for the sync (a source shared by several
 * builds is read once); parsed documents are kept in a small cache by digest and parser.
 */
export class SourceLoader {
  readonly #deps: SourceDeps;
  readonly #by: Principal;
  readonly #purpose: string;
  readonly #reads = new Map<string, Promise<ExternalLoad>>();
  /** Parsed documents by digest and parser; bytes behind a digest never change. A few large documents at most. */
  readonly #documents = new Lru<string, ParsedDocument>(4);
  /** Which parser recognised the bytes of a digest and media type. */
  readonly #recognized = new Lru<string, string>(64);
  /** Pages and sources read through the port by this loader. */
  readCount = 0;

  constructor(deps: SourceDeps, by: Principal, purpose: string) {
    this.#deps = deps;
    this.#by = by;
    this.#purpose = purpose;
  }

  /** True when this external id was already read by this loader. */
  hasRead(id: string): boolean {
    return this.#reads.has(id);
  }

  read(id: string): Promise<ExternalLoad> {
    let pending = this.#reads.get(id);
    if (pending === undefined) {
      this.readCount++;
      pending = this.#read(id);
      this.#reads.set(id, pending);
    }
    return pending;
  }

  async #read(id: string): Promise<ExternalLoad> {
    let result;
    try {
      result = await this.#deps.external.read(id, { principal: this.#by, run: null, purpose: this.#purpose });
    } catch (error) {
      // The port promises never to throw; a broken adapter is reported like a failed read.
      return { ok: false, id, reason: `读取失败（连接器出错：${describeError(error)}）` };
    }
    if (!result.ok) return { ok: false, id, reason: `读取失败：${result.reason}` };
    const chosen =
      result.artifacts.find((a) => a.name === EXTERNAL_ARTIFACT.content) ?? result.artifacts.find((a) => a.name === EXTERNAL_ARTIFACT.original);
    if (chosen === undefined) return { ok: false, id, reason: '读取结果里没有原件' };
    return { ok: true, id, revision: result.revision, artifact: chosen.artifact };
  }

  /**
   * The bytes of a read artifact when they may enter the knowledge tree, else the reason they may not. Every check runs on
   * the one record the connector read returned: the read is pinned to it, so another record of the same bytes (a newer
   * personal-credential read, say) never decides it.
   */
  async readable(load: Extract<ExternalLoad, { ok: true }>, maxBytes: number): Promise<Loaded<ReadableSource>> {
    const body = load.artifact.body;
    const sha256 = body.sha256;
    const id = load.id;
    if (!body.visibility.admins) {
      return { ok: false, sha256, reason: `源文件 ${sha256}（${id}）是用个人凭据读到的，个人凭据读到的源文件不进知识树` };
    }
    if (body.size > maxBytes) return { ok: false, sha256, reason: `源文件 ${sha256}（${id}）有 ${body.size} 字节，超过还能读的 ${maxBytes} 字节` };
    const source = await this.#deps.artifacts.source(this.#by, sha256, { consumer: 'model', record: load.artifact.digest });
    if (source === null) return { ok: false, sha256, reason: `源文件 ${sha256}（${id}）对执行同步的管理员不可读` };
    if (source.bytes === null || source.readTier !== MODEL_READABLE) {
      if (source.readTier === RETAIN_ONLY) return { ok: false, sha256, reason: credentialReason(sha256, id) };
      return { ok: false, sha256, reason: `源文件 ${sha256}（${id}）的读取档位是“${labelOf('read_tier', source.readTier)}”；知识树的内容对模型可读，不能收这份文件` };
    }
    if (!source.artifact.body.scan.inspected) {
      return { ok: false, sha256, reason: `源文件 ${sha256}（${id}）不是凭据扫描能检查的文本，不进知识树` };
    }
    return {
      ok: true,
      value: {
        external: id,
        revision: load.revision,
        sha256,
        size: source.size,
        mediaType: source.mediaType,
        artifact: source.artifact,
        readTier: source.readTier,
        bytes: source.bytes,
      },
    };
  }

  /** Parses with the first core parser for the media type that accepts the bytes (a source shared by builds is parsed once). */
  parse(source: ReadableSource): Loaded<ParsedSource> {
    const known = this.#recognized.get(`${source.sha256}\u0000${source.mediaType}`);
    const cached = known === undefined ? undefined : this.#documents.get(`${source.sha256}\u0000${known}`);
    if (known !== undefined && cached !== undefined) return { ok: true, value: { ...source, parser: known, document: cached } };
    let found: ReturnType<typeof recognize>;
    let rejected: ParseError | undefined;
    try {
      found = recognize(this.#deps.parsers, source.bytes, source.mediaType, {}, error => { rejected = error; });
    } catch (error) {
      return { ok: false, sha256: source.sha256, reason: `源文件 ${source.sha256}（${source.external}）解析时出错：${describeError(error)}` };
    }
    if (found === null) {
      return { ok: false, sha256: source.sha256, reason: rejected === undefined
        ? `源文件 ${source.sha256}（${source.external}，${source.mediaType}）没有支持此媒体类型的核心解析器；请管理员核对源文件媒体类型后重读`
        : `源文件 ${source.sha256}（${source.external}）被 ${rejected.parser} 拒绝：${rejected.message}${rejected.offset === null ? '' : `（字节 ${rejected.offset}）`}；${rejected.fix}` };
    }
    const parser = parserKey(found.parser);
    this.#documents.set(`${source.sha256}\u0000${parser}`, found.document);
    this.#recognized.set(`${source.sha256}\u0000${source.mediaType}`, parser);
    return { ok: true, value: { ...source, parser, document: found.document } };
  }

  /**
   * The document of a source parsed with a named parser (a fragment may name another parser than the one that parsed
   * the slot); null when the parser is not registered or does not accept the bytes.
   */
  documentWith(source: ReadableSource, parser: string): ParsedDocument | null {
    const key = `${source.sha256}\u0000${parser}`;
    const cached = this.#documents.get(key);
    if (cached !== undefined) return cached;
    const found = this.#deps.parsers.get(parser);
    if (found === undefined) return null;
    try {
      const document = found.parse(source.bytes, { mediaType: source.mediaType });
      this.#documents.set(key, document);
      return document;
    } catch (error) {
      if (error instanceof ParseError) return null;
      throw error;
    }
  }

  /** Read, check and parse in one step. */
  async load(id: string, maxBytes: number): Promise<Loaded<ParsedSource>> {
    const load = await this.read(id);
    if (!load.ok) return { ok: false, sha256: null, reason: `${id}：${load.reason}` };
    const readable = await this.readable(load, maxBytes);
    if (!readable.ok) return readable;
    return this.parse(readable.value);
  }
}
