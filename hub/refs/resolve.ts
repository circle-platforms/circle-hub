// Resolution rechecks bytes and permission. Null permission answers remain neutral; reader and integrity faults
// have distinct recovery codes. Internal reasons let the boundary record unfinished work instead of refusing it.
import { IntegrityError } from '../records/api.ts';
import { SandboxError } from '../rules/api.ts';
import { PROTOCOL_CODES, type ProtocolCode, type RecordKind } from '../../contracts/generated/protocol.ts';
import { labelOf, type PermissionRole, type ProducerKind, type ReadTier, type Reason, type ReferenceScheme } from '../../contracts/generated/vocabulary.ts';
import type { RecordEnvelope } from '../../contracts/src/records.ts';
import { canonicalJson, recordDigest, sha256Hex } from './canonical-json.ts';
import { ParseError, mediaTypeEssence, parserKey, parserCacheKey,parseDocument, type Fragment, type JsonObject, type JsonValue, type ParsedDocument, type ParserRegistry } from './parser.ts';
import { quoteMatches } from './quote.ts';
import { ReferenceSyntaxError, formatReference, parseReference, pointerTokens, type Reference } from './reference.ts';
import { decodeDeclared, decodeHtmlText, decodeXmlText, removeNul } from './text-decoding.ts';

/** Who reads. Readers implement visibility (R02) with it; refs never interprets it. */
export interface ReaderIdentity {
  user: string;
  role: PermissionRole;
  run?: string;
}

export interface SourceRead {
  /**
   * The stored bytes. Null only for a retain_only source when the store withholds them (B02 R[4]): refs never needs
   * them then, since it answers without content. For any other tier null bytes count as a failed read.
   */
  bytes: Uint8Array | null;
  mediaType: string;
  size: number;
  readTier: ReadTier;
}

/** Permission-aware access to stored source bytes; null means unavailable to this reader (absent or forbidden alike). */
export interface SourceReader {
  read(sha256: string, reader: ReaderIdentity): Promise<SourceRead | null> | SourceRead | null;
}

export interface TreeRead {
  /** Normalized content of the node or entry. */
  text: string;
  mediaType: string | null;
  readTier: ReadTier;
  data?: JsonValue;
  /** The source fragments (src references) that warrant the content, from the version composition record (B01 R[5]). */
  grounds?: string[];
  validity?: JsonValue;
}

/**
 * Reads knowledge tree nodes and entries (implemented by hub/knowledge). Returns only content whose digests it has
 * verified, or null when the node or entry is unavailable to the reader.
 */
export interface TreeReader {
  read(root: string, path: string, entry: string | null, reader: ReaderIdentity): Promise<TreeRead | null> | TreeRead | null;
  readEntry(entry: string, reader: ReaderIdentity): Promise<TreeRead | null> | TreeRead | null;
  /**
   * Optional: whether the root is visible to the reader. When it is, a path (or pinned entry) that `read` does not find
   * is a mistake in the reference, REFERENCE_UNRESOLVED like a src selector that locates nothing, not an unavailable source.
   */
  hasRoot?(root: string, reader: ReaderIdentity): Promise<boolean> | boolean;
}

export type RecordRead = Pick<RecordEnvelope, 'kind' | 'schema' | 'provenance' | 'created_at' | 'body'>;

/** Permission-aware access to stored records by digest (implemented by hub/records); null means unavailable. */
export interface RecordReader {
  read(digest: string, reader: ReaderIdentity): Promise<RecordRead | null> | RecordRead | null;
}

/** Parsed documents keyed by digest, parser and media type. The owning read/evaluation must dispose them when done. */
export interface DocumentCache {
  /** Coalesce concurrent parses within the owning operation; never shared across calls. */
  load?(key:string,parse:()=>Promise<ParsedDocument>):Promise<ParsedDocument>;
  /** Bound an operation-owned read by the same deadline as its document parses and lookups. */
  within?<T>(work:Promise<T>):Promise<T>;
  /** Do not start further reads after the operation deadline. */
  assertActive?():void;
  get(key: string): ParsedDocument | undefined;
  set(key: string, document: ParsedDocument): void;
  /** Terminal release by the owner of one read/evaluation; late callbacks cannot repopulate the cache. */
  dispose?():void;
}

export interface ResolveDiagnostic {
  reference: string;
  scheme: ReferenceScheme;
  /** Admin-only reason in English. */
  message: string;
}

export interface ResolveContext {
  /** Enable bounded retries for service callers without their own read retry boundary. */
  retryReads?: boolean;
  reader: ReaderIdentity;
  /** The clock validity re-reads judge against (B01 R[3]); absent, the wall clock. */
  now?: () => Date;
  parsers: ParserRegistry;
  sources?: SourceReader;
  trees?: TreeReader;
  records?: RecordReader;
  /** Who consumes the text: function_bytes_only content is given to functions only. Default model. */
  consumer?: ProducerKind;
  documents?: DocumentCache;
  /** Receives the real reason behind an unavailable result; never shown to the reader. */
  onDiagnostic?: (diagnostic: ResolveDiagnostic) => void;
  /** Active reference resolution set to detect and halt circular references. */
  visited?: Set<string>;
}

export type Resolved = {
  resolved: true;
  /** Canonical reference; for src fragments the selector is the parser's canonical one (retain_only: as given). */
  reference: string;
  scheme: ReferenceScheme;
  readTier: ReadTier;
  /** Whether `text` is given to this consumer. */
  readable: boolean;
  text: string | null;
  fragment: Fragment | null;
  mediaType: string | null;
  /** Structure-only summary when the content is not readable at this tier. */
  summary: JsonObject | null;
  note: string | null;
  grounds: string[];
  validity: JsonValue | null;
  recordKind: RecordKind | null;
  /** Whether the reference may stand alone as a claim's grounds (B01 R[4], R[5]). */
  groundable: boolean;
};

/** Why the Hub could not check a reference at all: its reader failed, or what it read does not match the digest. */
export type UncheckedReason = Extract<Reason, 'check_error' | 'integrity_unproven'>;

export type Unresolved = {
  parser_missing?:string;
  resolved: false;
  reference: string;
  code: Extract<ProtocolCode, 'SOURCE_UNAVAILABLE' | 'REFERENCE_UNRESOLVED' | 'SOURCE_RETRYABLE' | 'SOURCE_INTEGRITY_UNPROVEN'>;
  message: string;
  fix: string;
  /**
   * Internal: set when the answer says nothing about the reference because the Hub could not check it (a reader that
   * failed or is missing: check_error; stored bytes or a record that do not hash to the digest: integrity_unproven).
   * The caller records unfinished work with this reason instead of refusing the submission (T03 R[3]). Not enumerable,
   * so JSON and object spread leave it out; the public code and recovery instructions distinguish the fault.
   */
  readonly reason?: UncheckedReason;
};

export type ResolveResult = Resolved | Unresolved;

/** Text of the neutral answer for absent and forbidden alike (D05 R[3]). */
export const UNAVAILABLE_MESSAGE = '对你不可用';

// Record kinds that may serve as grounds (B01 R[4]): results and the Hub's own action and effect records.
const GROUNDABLE_KINDS: readonly RecordKind[] = ['claim', 'validation_result', 'action', 'effect'];

/** Whether a reference of this scheme (and record kind) may stand alone as grounds. Entries never may (B01 R[5]). */
export function isGroundable(scheme: ReferenceScheme, recordKind: RecordKind | null = null): boolean {
  if (scheme === 'entry') return false;
  if (scheme === 'rec') return recordKind !== null && GROUNDABLE_KINDS.includes(recordKind);
  return true;
}

/** Cache budget is a conservative accounting estimate, not a process RSS measurement. */
const DOCUMENT_CACHE_BYTES = 192 * 1024 * 1024;
const LEGACY_DOCUMENT_OVERHEAD = 16 * 1024 * 1024;
const DOCUMENT_OPERATION_MS = 120_000;

/** Count a legacy model without serializing it into another potentially enormous string. */
function legacyDocumentBytes(document: ParsedDocument, limit: number): number {
  let bytes = LEGACY_DOCUMENT_OVERHEAD;
  const pending: unknown[] = [document.model];
  const seen = new Set<object>();
  while (pending.length && bytes <= limit) {
    const value = pending.pop();
    if (typeof value === 'string') { bytes += value.length * 2 + 32; continue; }
    if (value === null || typeof value !== 'object') { bytes += 8; continue; }
    if (seen.has(value)) continue;
    seen.add(value);
    bytes += 64;
    for (const [key, child] of Object.entries(value)) {
      bytes += key.length * 2 + 24;
      pending.push(child);
      if (bytes > limit) break;
    }
  }
  return bytes;
}

export function createDocumentCache(maxEntries = 16, maxBytes = DOCUMENT_CACHE_BYTES, operationMs = DOCUMENT_OPERATION_MS): DocumentCache {
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new RangeError('文档缓存数量必须是正整数');
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError('文档缓存字节预算必须是正整数');
  if (!Number.isSafeInteger(operationMs) || operationMs <= 0) throw new RangeError('文档操作时限必须是正整数');
  const deadline=performance.now()+operationMs;
  const expired=()=>new SandboxError('SANDBOX_TIMEOUT',{limit:'operation'});
  const checkDeadline=():void=>{if(performance.now()>=deadline)throw expired();};
  const within=async<T>(promise:Promise<T>):Promise<T>=>{
    const remaining=deadline-performance.now();if(remaining<=0){void promise.catch(()=>{});throw expired();}
    let timer:ReturnType<typeof setTimeout>|undefined;
    const timely=promise.then(value=>{checkDeadline();return value;});
    try{return await Promise.race([timely,new Promise<never>((_,reject)=>{const tick=()=>{const left=deadline-performance.now();if(left<=0)reject(expired());else timer=setTimeout(tick,Math.ceil(left));};timer=setTimeout(tick,Math.ceil(remaining));})]);}finally{if(timer)clearTimeout(timer);}
  };
  const entries = new Map<string, { document: ParsedDocument; unsubscribe?: () => void }>();
  const pending=new Map<string,Promise<ParsedDocument>>();
  let disposed=false;
  let budgetExceeded=false;
  const budgetError=()=>new SandboxError('SANDBOX_OUTPUT_TOO_LARGE',{limit:'document_cache_bytes'});
  const checkBudget=():void=>{if(budgetExceeded)throw budgetError();};
  const weight = (document: ParsedDocument): number => {
    const measured = document.retainedBytes?.();
    return typeof measured === 'number' && Number.isSafeInteger(measured) && measured >= 0
      ? measured : legacyDocumentBytes(document, maxBytes);
  };
  const remove = (key: string): void => { const row=entries.get(key); entries.delete(key); row?.unsubscribe?.(); };
  const trim = (): void => {
    let total=0;
    for (const row of entries.values()) {
      const bytes=weight(row.document);
      if(bytes>maxBytes){budgetExceeded=true;for(const old of entries.keys())remove(old);throw budgetError();}
      total+=bytes;
    }
    while (entries.size > maxEntries || total > maxBytes) {
      const key=entries.keys().next().value!;
      total-=weight(entries.get(key)!.document);
      remove(key);
    }
  };
  const cache:DocumentCache={
    within,
    assertActive(){checkDeadline();checkBudget();},
    async load(key,parse){
      checkDeadline();
      checkBudget();
      const found=cache.get(key);if(found)return found;
      const active=pending.get(key);if(active)return within(active);
      if(disposed)return parse();
      if(pending.size>=Math.min(2,maxEntries)){await within(Promise.race(pending.values()).catch(()=>{}));return cache.load!(key,parse);}
      const value=Promise.resolve().then(parse).then(document=>{checkDeadline();cache.set(key,document);return document;}).finally(()=>pending.delete(key));
      pending.set(key,value);return within(value);
    },
    dispose(){disposed=true;for(const key of entries.keys())remove(key);pending.clear();},
    get(key) {
      if(disposed)return undefined;
      checkDeadline();
      checkBudget();
      trim();
      const row = entries.get(key);
      if (row) {
        entries.delete(key);
        entries.set(key, row);
      }
      return row?.document;
    },
    set(key, document) {
      if(disposed)return;
      checkDeadline();
      checkBudget();
      document.setOperationDeadline?.(deadline);
      remove(key);
      if(weight(document)>maxBytes){budgetExceeded=true;for(const old of entries.keys())remove(old);throw budgetError();}
      const row: { document: ParsedDocument; unsubscribe?: () => void } = {document};
      entries.set(key, row);
      row.unsubscribe=document.onRetainedBytesChange?.(()=>{
        if(weight(document)>maxBytes){budgetExceeded=true;for(const old of entries.keys())remove(old);throw budgetError();}
        trim();
      });
      trim();
    },
  };
  return cache;
}

/** SHA-256 of a fragment's text: the cited-fragment digest that detects a changed citation. */
export function fragmentDigest(fragment: Pick<Fragment, 'text'>): string {
  return sha256Hex(fragment.text);
}

function unavailable(reference: string, ctx:ResolveContext, reason?: UncheckedReason): Unresolved {
  const code = reason === 'integrity_unproven' ? 'SOURCE_INTEGRITY_UNPROVEN' : reason === 'check_error' ? 'SOURCE_RETRYABLE' : 'SOURCE_UNAVAILABLE';
  const message = reason === 'integrity_unproven' ? '缺少经摘要核验的原件；请管理员从备份恢复后重读' : reason === 'check_error' ? `缺少本次来源读取结果；下一次重读时间 ${new Date((ctx.now?.()??new Date()).getTime()+1000).toISOString()}，按原引用重读` : UNAVAILABLE_MESSAGE;
  const result: Unresolved = { resolved: false, reference, code, message, fix: PROTOCOL_CODES[code].fix };
  if (reason !== undefined) Object.defineProperty(result, 'reason', { value: reason, enumerable: false });
  return result;
}

function unresolved(reference: string, message: string): Unresolved {
  return { resolved: false, reference, code: 'REFERENCE_UNRESOLVED', message, fix: PROTOCOL_CODES.REFERENCE_UNRESOLVED.fix };
}

const TEXT_TYPES = new Set(['application/json', 'application/xml', 'application/javascript', 'application/yaml', 'application/x-yaml', 'application/toml']);
const XML_TYPES = new Set(['application/xml', 'text/xml']);
const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml']);

function isTextual(mediaType: string): boolean {
  const essence = mediaTypeEssence(mediaType);
  return essence.startsWith('text/') || TEXT_TYPES.has(essence) || essence.endsWith('+json') || essence.endsWith('+xml');
}

/** Whole-file text: XML and HTML by their own charset rules (as xml@1 and html@1 decode them), other text by the media type. */
function wholeText(bytes: Uint8Array, mediaType: string): string {
  const essence = mediaTypeEssence(mediaType);
  if (HTML_TYPES.has(essence)) return decodeHtmlText(bytes, mediaType);
  if (XML_TYPES.has(essence) || essence.endsWith('+xml')) return decodeXmlText(bytes, mediaType);
  return decodeDeclared('text@1', bytes, mediaType).text;
}

/** UTF-8 slice [from, to) of a text; null when out of bounds or not on character boundaries. */
export function sliceUtf8(text: string, from: number, to: number): string | null {
  const bytes = Buffer.from(text, 'utf8');
  if (from < 0 || to > bytes.length || from >= to) return null;
  const continuation = (index: number): boolean => index < bytes.length && (bytes[index] & 0xc0) === 0x80;
  if (continuation(from) || continuation(to)) return null;
  return bytes.subarray(from, to).toString('utf8');
}

type Visible = { readable: boolean; text: string | null; summary: JsonObject | null; note: string | null };

/** What a consumer may see at a read tier (B02 F[5], R[4]). */
function visibility(tier: ReadTier, consumer: ProducerKind, text: string | null, summary: () => JsonObject | null): Visible {
  if (tier === 'model_readable' || (tier === 'function_bytes_only' && consumer === 'function')) return { readable: text !== null, text, summary: null, note: null };
  if (tier === 'function_bytes_only') return { readable: false, text: null, summary: summary(), note: labelOf('read_tier', 'function_bytes_only') };
  return { readable: false, text: null, summary: null, note: labelOf('validity_status', 'credential_unreadable') };
}

async function settle<T>(read: () => Promise<T | null> | T | null, retry = false): Promise<{ value: T | null; error: unknown }> {
  for (let attempt = 0; ; attempt++) {
    try { return { value: await read(), error: null }; }
    catch (error) {
      if (error instanceof IntegrityError || attempt === (retry ? 2 : 0)) return { value: null, error };
      await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}

/**
 * Resolves a reference for a reader. Syntax problems, unknown parsers, unparseable sources, selectors that locate
 * nothing and bad ranges are REFERENCE_UNRESOLVED; null permission answers are SOURCE_UNAVAILABLE. Reader and digest
 * faults have actionable recovery codes and preserve the internal `reason`. Never
 * rejects for anything a reference or a stored source can contain.
 */
export async function resolveReference(input: string | Reference, ctx: ResolveContext): Promise<ResolveResult> {
  let ref: Reference;
  let canonical: string;
  try {
    canonical = typeof input === 'string' ? formatReference(parseReference(input)) : formatReference(input);
    ref = parseReference(canonical);
  } catch (error) {
    if (!(error instanceof ReferenceSyntaxError)) throw error;
    const shown = (typeof input === 'string' ? input : (JSON.stringify(input) ?? '')).slice(0, 512);
    return unresolved(shown, `引用格式不对：${error.message}`);
  }
  if(ref.scheme==='src'&&ref.parser){
    try{
      if(ctx.reader.run&&ctx.parsers.forRun)ctx={...ctx,parsers:await ctx.parsers.forRun(ctx.reader.run)};
      else if(ctx.parsers.forReference)ctx={...ctx,parsers:await ctx.parsers.forReference(ref.parser)};
      else await ctx.parsers.refresh?.();
    }catch(error){
      ctx.onDiagnostic?.({reference:canonical,scheme:ref.scheme,message:'locked parser package could not be loaded'});
      const failed=unavailable(canonical,ctx,error instanceof IntegrityError?'integrity_unproven':'check_error');
      return Object.assign(failed,{parser_missing:ref.parser,message:'缺少解析器 '+ref.parser+' 的已核验技能包摘要，当前不能复核这条引用',fix:'管理员恢复运行锁定的已发布包；历史运行缺锁时用 circle-hub skill bind-legacy <解析器 id@版本> <技能包 id@版本> 追加迁移声明，再按原引用重读'});
    }
  }
  if (ctx.visited?.has(canonical)) {
    return unresolved(canonical, `成环的引用：${canonical}`);
  }
  ctx.visited?.add(canonical);
  const consumer = ctx.consumer ?? 'model';
  const diagnose = (message: string): void => ctx.onDiagnostic?.({ reference: canonical, scheme: ref.scheme, message });
  switch (ref.scheme) {
    case 'src': {
      const result=await resolveSource(ref, canonical, ctx, consumer, diagnose);
      return result.resolved&&ctx.parsers.bindingDisclosure?{...result,note:[result.note,ctx.parsers.bindingDisclosure].filter(Boolean).join('；')}:result;
    }
    case 'tree':
    case 'entry': {
      if (!ctx.trees) {
        diagnose('no tree reader configured');
        return unavailable(canonical, ctx, 'check_error');
      }
      const trees = ctx.trees;
      const { value: read, error } = await settle(() =>
        ref.scheme === 'tree' ? trees.read(ref.root, ref.path, ref.entry ?? null, ctx.reader) : trees.readEntry(ref.entry, ctx.reader), ctx.retryReads
      );
      if (error !== null) {
        diagnose(`tree reader failed: ${String(error)}`);
        return unavailable(canonical, ctx, error instanceof IntegrityError ? 'integrity_unproven' : 'check_error');
      }
      if (read === null) {
        if (ref.scheme === 'tree' && trees.hasRoot) {
          const hasRoot = trees.hasRoot.bind(trees);
          const visible = await settle(() => hasRoot(ref.root, ctx.reader), ctx.retryReads);
          if (visible.error !== null) {
            diagnose(`tree reader failed: ${String(visible.error)}`);
            return unavailable(canonical, ctx, 'check_error');
          }
          if (visible.value === true) return unresolved(canonical, ref.entry ? '知识树里没有这个路径，或这个路径上没有所指的条目' : '知识树里没有这个路径');
        }
        return unavailable(canonical, ctx);
      }
      const seen = visibility(read.readTier, consumer, read.text, () => null);
      const grounds = (read.grounds ?? []).filter((ground) => {
        try {
          if (formatReference(parseReference(ground)) === ground) return true;
        } catch (cause) {
          if (!(cause instanceof ReferenceSyntaxError)) throw cause;
        }
        diagnose(`tree reader returned a ground that is not a canonical reference: ${String(ground).slice(0, 200)}`);
        return false;
      });
      return {
        resolved: true,
        reference: canonical,
        scheme: ref.scheme,
        readTier: read.readTier,
        ...seen,
        fragment: null,
        mediaType: read.mediaType,
        grounds,
        validity: read.validity ?? null,
        recordKind: null,
        groundable: isGroundable(ref.scheme),
      };
    }
    case 'rec': {
      if (!ctx.records) {
        diagnose('no record reader configured');
        return unavailable(canonical, ctx, 'check_error');
      }
      const records = ctx.records;
      const { value: record, error } = await settle(() => records.read(ref.record, ctx.reader), ctx.retryReads);
      if (error !== null) {
        diagnose(`record reader failed: ${String(error)}`);
        return unavailable(canonical, ctx, error instanceof IntegrityError ? 'integrity_unproven' : 'check_error');
      }
      if (record === null) return unavailable(canonical, ctx);
      let digest: string;
      try {
        digest = recordDigest(record);
      } catch (cause) {
        diagnose(`record cannot be canonicalized: ${String(cause)}`);
        return unavailable(canonical, ctx, 'integrity_unproven');
      }
      if (digest !== ref.record) {
        diagnose(`stored record hashes to ${digest}, not to the referenced digest`);
        return unavailable(canonical, ctx, 'integrity_unproven');
      }
      let value: unknown = record.body;
      let validity: unknown = validityOf(value);
      // B01 R[3] (re-read before relying): an expires_at in the record's own validity is checked at read time — a
      // past expiry surfaces as expired instead of the stale status stored with the claim. The context's injected
      // clock decides "now" when there is one (deterministic tests); Date.now() only as the default.
      if (validity !== undefined && typeof validity === 'object' && validity !== null) {
        const at = (validity as { expires_at?: unknown }).expires_at;
        const now = typeof ctx.now === 'function' ? ctx.now() : new Date();
        if (typeof at === 'string' && Date.parse(at) <= now.getTime() && (validity as { status?: unknown }).status !== 'expired') {
          validity = { ...(validity as Record<string, unknown>), status: 'expired' };
        }
      }
      if (ref.pointer !== undefined) {
        for (const token of pointerTokens(ref.pointer)) {
          const next = step(value, token);
          if (next === undefined) return unresolved(canonical, '记录里没有这个 JSON Pointer 指向的值');
          value = next;
          validity = validityOf(value) ?? validity;
        }
      }
      const text = typeof value === 'string' ? value : canonicalJson(value);
      return {
        resolved: true,
        reference: canonical,
        scheme: 'rec',
        readTier: 'model_readable',
        readable: true,
        text,
        fragment: null,
        mediaType: 'application/json',
        summary: null,
        note: null,
        grounds: [],
        validity: (validity ?? null) as JsonValue | null,
        recordKind: record.kind,
        groundable: isGroundable('rec', record.kind),
      };
    }
  }
}

function step(value: unknown, token: string): unknown {
  if (Array.isArray(value)) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(token)) return undefined;
    const index = Number(token);
    return index < value.length ? value[index] : undefined;
  }
  if (value !== null && typeof value === 'object' && Object.hasOwn(value, token)) return (value as { [key: string]: unknown })[token];
  return undefined;
}

function validityOf(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const validity = (value as { validity?: unknown }).validity;
  return validity !== null && typeof validity === 'object' ? validity : undefined;
}

/** Parses each cited source once and loads every selector on it before the per-reference checks. Failures stay with resolveReference. */
export async function prefetchReferences(inputs: readonly string[], ctx: ResolveContext): Promise<void> {
  const groups = new Map<string, { sha: string; parser: string; selectors: string[] }>();
  for (const input of inputs) {
    let ref: Reference;
    try { ref = parseReference(input); } catch { continue; }
    if (ref.scheme !== 'src' || ref.parser === undefined || ref.selector === undefined) continue;
    const key = `${ref.sha256}\u0000${ref.parser}`;
    const group = groups.get(key) ?? { sha: ref.sha256, parser: ref.parser, selectors: [] };
    group.selectors.push(ref.selector);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    let document: ParsedDocument | undefined;
    try {
      const parser = ctx.parsers.get(group.parser);
      if (!parser || !ctx.sources) continue;
      ctx.documents?.assertActive?.();
      const reading=Promise.resolve(ctx.sources.read(group.sha, ctx.reader));
      const read = await (ctx.documents?.within?.(reading) ?? reading);
      if (!read?.bytes || read.readTier === 'retain_only' || read.bytes.length !== read.size || sha256Hex(read.bytes) !== group.sha) continue;
      const cacheKey = `${group.sha}\u0000${parserCacheKey(parser)}\u0000${read.mediaType}`;
      document = ctx.documents?.get(cacheKey);
      if (!document) {
        const parse = () => parseDocument(parser, read.bytes!, { mediaType: read.mediaType });
        document = ctx.documents?.load ? await ctx.documents.load(cacheKey, parse) : await parse();
        ctx.documents?.set(cacheKey, document);
      }
    } catch (error) {
      // A definite format refusal belongs to the individual reference. Operational failures must not disappear.
      if (error instanceof ParseError) continue;
      throw error;
    }
    // Once parsing produced a document, a failed locate batch is not evidence of an absent selector.
    // Propagate it so the owning operation returns a retryable unknown rather than silently restarting N calls.
    await document.prefetch?.(group.selectors);
  }
}

async function resolveSource(
  ref: Extract<Reference, { scheme: 'src' }>,
  canonical: string,
  ctx: ResolveContext,
  consumer: ProducerKind,
  diagnose: (message: string) => void,
): Promise<ResolveResult> {
  // The parser is checked before any read, so this answer never depends on whether the source exists.
  const parser = ref.parser === undefined ? null : ctx.parsers.get(ref.parser);
  if (ref.parser !== undefined && !parser) {
    const why=ctx.parsers.unavailable?.(ref.parser);
    if(why)return {resolved:false,reference:canonical,code:'SOURCE_UNAVAILABLE',message:why,fix:why,parser_missing:ref.parser};
    return unresolved(canonical, `解析器 ${ref.parser} 没有登记`);
  }
  if (!ctx.sources) {
    diagnose('no source reader configured');
    return unavailable(canonical, ctx, 'check_error');
  }
  const sources = ctx.sources;
  const { value: read, error } = await settle(() => {
    ctx.documents?.assertActive?.();
    const reading=Promise.resolve(sources.read(ref.sha256, ctx.reader));
    return ctx.documents?.within?.(reading) ?? reading;
  }, ctx.retryReads);
  if (error !== null) {
    if(error instanceof SandboxError)throw error;
    // Source readers can throw untrusted response text and paths. Log only the established failure class.
    diagnose(error instanceof IntegrityError ? 'source reader failed: integrity_unproven' : 'source reader failed: check_error');
    return unavailable(canonical, ctx, error instanceof IntegrityError ? 'integrity_unproven' : 'check_error');
  }
  if (read === null) return unavailable(canonical, ctx);
  const groundable = isGroundable('src');
  const retained = (source: SourceRead): Resolved => ({
    resolved: true, reference: canonical, scheme: 'src', readTier: source.readTier,
    ...visibility(source.readTier, consumer, null, () => null), fragment: null,
    mediaType: source.mediaType, grounds: [], validity: null, recordKind: null, groundable,
  });
  if (read.bytes === null || read.bytes === undefined) {
    if (read.readTier !== 'retain_only') {
      diagnose(`source reader withheld the bytes of a ${String(read.readTier)} source`);
      return unavailable(canonical, ctx, 'integrity_unproven');
    }
  } else if (read.bytes.length !== read.size || sha256Hex(read.bytes) !== ref.sha256) {
    diagnose(`stored bytes (size ${read.bytes.length}, recorded ${read.size}) do not hash to the referenced digest`);
    return unavailable(canonical, ctx, 'integrity_unproven');
  }
  if (read.readTier === 'retain_only') {
    // B02 R[4]: no text, no fragment, no structure. Nor is the selector or range evaluated: whether one resolves would
    // tell the reader line lengths, names and headings of a source it may not read. Every reference gets this answer.
    return retained(read);
  }
  const bytes = read.bytes!;
  if (!parser) {
    let text: string | null = null;
    let note: string | null = null;
    if (isTextual(read.mediaType)) {
      try {
        text = removeNul(wholeText(bytes, read.mediaType));
      } catch (cause) {
        if (!(cause instanceof ParseError)) throw cause;
        note = '内容不能按文本解码';
      }
    } else note = '二进制内容，没有文本';
    const seen = visibility(read.readTier, consumer, text, () => ({ size: read.size, mediaType: read.mediaType }));
    return {
      resolved: true,
      reference: canonical,
      scheme: 'src',
      readTier: read.readTier,
      ...seen,
      note: seen.note ?? note,
      fragment: null,
      mediaType: read.mediaType,
      grounds: [],
      validity: null,
      recordKind: null,
      groundable,
    };
  }
  // Parsing and locate may wait on a sandbox. Recheck the same source binding after that wait,
  // before disclosing even whether the selector exists. The parsed document is not an authorization token.
  const recheck = async (): Promise<{ current: SourceRead } | { failure: ResolveResult }> => {
    const again = await settle(() => {
      ctx.documents?.assertActive?.();
      const reading=Promise.resolve(sources.read(ref.sha256,ctx.reader));
      return ctx.documents?.within?.(reading) ?? reading;
    },ctx.retryReads);
    if (again.error !== null) {
      if (again.error instanceof SandboxError) throw again.error;
      diagnose('source access recheck failed');
      return {failure:unavailable(canonical,ctx,again.error instanceof IntegrityError ? 'integrity_unproven' : 'check_error')};
    }
    const current=again.value;
    if (current === null) return {failure:unavailable(canonical,ctx)};
    if (current.size!==read.size || current.mediaType!==read.mediaType || current.bytes !== null && (current.bytes.length!==current.size || sha256Hex(current.bytes)!==ref.sha256) || current.bytes===null && current.readTier!=='retain_only') {
      diagnose('source identity or bytes failed the access recheck');
      return {failure:unavailable(canonical,ctx,'integrity_unproven')};
    }
    if (current.readTier==='retain_only') return {failure:retained(current)};
    return {current};
  };
  const cacheKey = `${ref.sha256}\u0000${parserCacheKey(parser)}\u0000${read.mediaType}`;
  let document = ctx.documents?.get(cacheKey);
  if (!document) {
    try {
      const parse=()=>parseDocument(parser,bytes,{mediaType:read.mediaType});
      document = ctx.documents?.load?await ctx.documents.load(cacheKey,parse):await parse();
    } catch (cause) {
      if (!(cause instanceof ParseError)) throw cause;
      const checked=await recheck(); if ('failure' in checked) return checked.failure;
      return unresolved(canonical, `源文件不能按 ${ref.parser} 解析：${cause.message}`);
    }
    ctx.documents?.set(cacheKey, document);
  }
  const fragment = await document.locate(ref.selector!);
  const checked=await recheck(); if ('failure' in checked) return checked.failure;
  const current=checked.current;
  if (current.readTier === 'function_bytes_only' && consumer === 'model') {
    // A package's summary, canonical selector and locate outcome are untrusted and can encode the withheld bytes.
    // Disclose only identity already in the caller's reference and source metadata verified by the Hub.
    return {resolved:true,reference:canonical,scheme:'src',readTier:current.readTier,
      ...visibility(current.readTier,consumer,null,()=>({size:current.size,mediaType:current.mediaType})),
      fragment:null,mediaType:current.mediaType,grounds:[],validity:null,recordKind:null,groundable};
  }
  if (!fragment) return unresolved(canonical, `片段定位 ${ref.selector} 在源文件里找不到`);
  let text = fragment.text;
  if (ref.range) {
    const part = sliceUtf8(fragment.text, ref.range[0], ref.range[1]);
    if (part === null) return unresolved(canonical, '字节范围超出片段，或没有落在字符边界上');
    text = part;
  }
  let resolvedReference: string;
  try {
    resolvedReference = formatReference({ ...ref, selector: fragment.selector });
  } catch (cause) {
    if (!(cause instanceof ReferenceSyntaxError)) throw cause;
    // A parser answered with a canonical selector that cannot be written into a reference (the core parsers never do).
    diagnose(`parser ${ref.parser} answered with a selector that is not writable`);
    return unresolved(canonical, '技能包返回的片段定位不符合引用语法；请包作者修正后重读');
  }
  const doc = document;
  const seen = visibility(current.readTier, consumer, text, () => ({
    document: doc.summary(),
    fragment: { selector: fragment.selector, bytes: Buffer.byteLength(fragment.text, 'utf8'), byteRange: fragment.byteRange },
  }));
  return {
    resolved: true,
    reference: resolvedReference,
    scheme: 'src',
    readTier: current.readTier,
    ...seen,
    fragment: seen.readable ? fragment : null,
    mediaType: read.mediaType,
    grounds: [],
    validity: null,
    recordKind: null,
    groundable,
  };
}

/** Checks a quotation against a resolution: true or false when the text is readable, null when it cannot be checked. */
export function verifyQuote(result: ResolveResult, quote: string): boolean | null {
  if (!result.resolved || !result.readable || result.text === null) return null;
  return quoteMatches(result.text, quote);
}
