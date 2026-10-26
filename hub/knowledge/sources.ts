// Reading and parsing the sources of a sync or a production: through the ExternalReaderPort in an admin context, then the
// stored bytes through the tier-aware Artifacts.source (never trustedBytes), then the explicitly declared core parser (or media recognition when undeclared; the
// Hub parses, not the pack). Only model-readable text read with a shared credential enters the tree: a credential hit
// (retain_only), function-only bytes, bytes the scanner could not inspect and personal-credential reads are refused with a
// Chinese reason naming the digest (B02 R[3], R[4]; records README, Needs).
import {ReadManifest,SourceAbsent} from '../../contracts/src/resources.ts';
import type {RecordStore} from '../records/api.ts';
import { labelOf, type ReadTier } from '../../contracts/generated/vocabulary.ts';
import { EXTERNAL_ARTIFACT, type ExternalReaderPort } from '../ports.ts';
import type { Artifacts, Principal, SourceArtifact, VariableSnapshot } from '../records/api.ts';
import { ParseError, parserKey, recognize, type ParsedDocument, type ParserRegistry } from '../refs/api.ts';
import { describeError } from './errors.ts';
import { Lru } from './store.ts';

const MODEL_READABLE: ReadTier = 'model_readable';
const documentKey=(source:ReadableSource,parser:string)=>JSON.stringify([source.sha256,parser,source.mediaType]);
const RETAIN_ONLY: ReadTier = 'retain_only';

/** One external read: the artifact a consumer parses (`content` when the system pack derived one, else the original). */
export interface SourceObservation {external:string;code:string;status:number|null;at:string;manifest:string;system_pack:string;resource:string}

export type ExternalLoad =
  | { ok: true; id: string; revision: string | null; artifact: SourceArtifact; manifest?:string|null }
  | { ok: false; id: string; reason: string; observation?:SourceObservation;retained?:string[] };

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
  /** Only an explicit source declaration can override media recognition; keep the discrepancy in the report. */
  parseNote?: string;
}

export type Loaded<T> = { ok: true; value: T } | { ok: false; reason: string; sha256: string | null };

export interface SourceDeps {
  external: ExternalReaderPort;
  artifacts: Artifacts;
  parsers: ParserRegistry;
  records?:Pick<RecordStore,'get'>;
  onCredential?:(load:Extract<ExternalLoad,{ok:true}>,slot?:string)=>Promise<void>;
  onReadable?:(load:Extract<ExternalLoad,{ok:true}>)=>Promise<void>;
  variables?: VariableSnapshot;
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
  readonly #readWrites=new Map<string,Promise<void>>();
  readonly #credentialReads=new Map<string,Promise<ExternalLoad>>();
  /** Parsed documents by digest, parser and media/charset options; source bytes never change. A few large documents at most. */
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

  /** Several builds/loaders may consume one port observation; record it once, retrying a failed persistence. */
  recordReadOnce(id:string,artifact:string,persist:()=>Promise<void>):Promise<void>{
    const key=`${id}\0${artifact}`;let pending=this.#readWrites.get(key);
    if(!pending){pending=Promise.resolve().then(persist);this.#readWrites.set(key,pending);const written=pending;void pending.catch(()=>{if(this.#readWrites.get(key)===written)this.#readWrites.delete(key);});}
    return pending;
  }

  read(id: string,slot?:string): Promise<ExternalLoad> {
    let pending = this.#reads.get(id);
    if (pending === undefined) {
      pending = this.#read(id);
      this.#reads.set(id, pending);
    }
    return pending.then(load=>{
      if(load.ok||!load.retained?.length||!this.#deps.onCredential)return load;
      const key=`${id}\0${slot??''}`;let recovery=this.#credentialReads.get(key);
      if(!recovery){recovery=this.#recover(load,slot);this.#credentialReads.set(key,recovery);}
      return recovery;
    });
  }

  async #recover(load:Extract<ExternalLoad,{ok:false}>,slot?:string):Promise<ExternalLoad>{
    let readable=true;
    for(const digest of load.retained??[]){
      const record=await this.#deps.records?.get(digest);if(record?.kind!=='source_artifact'){readable=false;continue;}
      const artifact=record as SourceArtifact;
      const stored={ok:true as const,id:load.id,artifact,revision:null,manifest:load.observation?.manifest};
      const current=await this.#deps.artifacts.source(this.#by,artifact.body.sha256,{consumer:'model',record:artifact.digest});
      if(current?.bytes===null)await this.#deps.onCredential?.(stored,slot);
      const checked=await this.#deps.artifacts.source(this.#by,artifact.body.sha256,{consumer:'model',record:artifact.digest});
      if(!checked?.bytes)readable=false;
    }
    if(!readable)return load;
    const retried=this.#read(load.id);this.#reads.set(load.id,retried);return retried;
  }

  /** Resuming a saved plan pins a stored observation, never reinterprets it as a fresh connector read. */
  restore(id:string,artifact:SourceArtifact,revision:string|null,manifest?:string|null):void {
    if(!this.#reads.has(id))this.#reads.set(id,Promise.resolve({ok:true,id,artifact,revision,manifest}));
  }
  async captured():Promise<Array<{id:string;artifact:string;sha256:string;revision:string|null;manifest:string|null}>>{
    const loads=await Promise.all(this.#reads.values());return loads.flatMap(load=>load.ok?[{id:load.id,artifact:load.artifact.digest,sha256:load.artifact.body.sha256,revision:load.revision,manifest:load.manifest??null}]:[]);
  }
  async manifest(id:string|null|undefined):Promise<ReadManifest|null>{
    if(!id||!this.#deps.records)return null;
    const row=await this.#deps.records.get(id);if(row?.kind!=='action'||row.schema!=='read-manifest@1')return null;
    const parsed=ReadManifest.safeParse(row.body);return parsed.success&&parsed.data.principal===this.#by.id?parsed.data:null;
  }
  async #read(id: string): Promise<ExternalLoad> {
    this.readCount++;
    let result;
    try {
      result = await this.#deps.external.read(id, { principal: this.#by, run: null, purpose: this.#purpose, variables:this.#deps.variables });
    } catch (error) {
      // The port promises never to throw; a broken adapter is reported like a failed read.
      return { ok: false, id, reason: `读取失败（连接器出错：${describeError(error)}）` };
    }
    if (result.ok && result.absent) {
      const manifest=await this.manifest(result.manifest),absence=SourceAbsent.safeParse(result.absent);
      const responses=absence.success?(absence.data.responses??[]).map(key=>manifest?.requests.findLast(request=>request.key===key)):[];
      const supported=responses.length>0&&responses.every(request=>request&&request.artifact!==null&&request.sha256!==null&&request.status!==null&&(
        request.ok&&request.status>=200&&request.status<300 || request.error==='SOURCE_ABSENT'&&(request.status===404||request.status===410)
      ));
      if(!absence.success||!manifest||manifest.external!==result.id||manifest.result!=='completed'||manifest.error_code!==null||!manifest.coverage.complete||absence.data.object!==result.id||absence.data.system!==result.id.split(':')[0]||!supported)
        return {ok:false,id,reason:'缺少相符的缺席读取清单或原始应答；请管理员恢复清单后按原对象重读'};
      const observation:SourceObservation={external:result.id,code:absence.data.code,status:responses.findLast(request=>request?.status===404||request?.status===410)?.status??responses.at(-1)?.status??null,at:absence.data.observed_at,manifest:result.manifest,system_pack:manifest.system_pack.id,resource:manifest.resource};
      return {ok:false,id,reason:`来源已确定缺席：${observation.code}（HTTP ${observation.status}，${observation.at}）`,observation};
    }
    if (!result.ok) {
      const manifest=await this.manifest(result.manifest);
      const observation=manifest?.external===result.id&&manifest.result==='error'&&manifest.error_code!==null?{
        external:result.id,code:manifest.error_code,status:manifest.requests.findLast(request=>!request.ok&&request.status!==null)?.status??null,
        at:manifest.ended_at,manifest:result.manifest!,system_pack:manifest.system_pack.id,resource:manifest.resource,
      }:undefined;
      return {ok:false,id,reason:observation?`读取确定失败：${observation.code}（${observation.status===null?'无 HTTP 状态':`HTTP ${observation.status}`}，${observation.at}）`:`读取失败：${result.reason}`,...(observation?{observation}:{}),...(observation?.code==='SOURCE_CREDENTIAL'?{retained:[...new Set(manifest!.requests.flatMap(request=>request.artifact===null?[]:[request.artifact]))]}:{})};
    }
    const chosen =
      result.artifacts.find((a) => a.name === EXTERNAL_ARTIFACT.content) ?? result.artifacts.find((a) => a.name === EXTERNAL_ARTIFACT.original);
    if (chosen === undefined) return { ok: false, id, reason: '读取结果里没有原件' };
    return { ok: true, id, revision: result.revision, artifact: chosen.artifact, manifest:result.manifest };
  }

  /**
   * The bytes of a read artifact when they may enter the knowledge tree, else the reason they may not. Every check runs on
   * the one record the connector read returned: the read is pinned to it, so another record of the same bytes (a newer
   * personal-credential read, say) never decides it.
   */
  async readable(load: Extract<ExternalLoad, { ok: true }>, maxBytes: number,context:{slot?:string}={}): Promise<Loaded<ReadableSource>> {
    const body = load.artifact.body;
    const sha256 = body.sha256;
    const id = load.id;
    if (!body.visibility.admins) {
      return { ok: false, sha256, reason: `源文件 ${sha256}（${id}）是用个人凭据读到的，个人凭据读到的源文件不进知识树` };
    }
    if (body.size > maxBytes) return { ok: false, sha256, reason: `源文件 ${sha256}（${id}）有 ${body.size} 字节，超过还能读的 ${maxBytes} 字节` };
    let source = await this.#deps.artifacts.source(this.#by, sha256, { consumer: 'model', record: load.artifact.digest });
    if(source?.bytes===null&&source.readTier==='retain_only'&&this.#deps.onCredential){
      await this.#deps.onCredential(load,context.slot);
      source=await this.#deps.artifacts.source(this.#by,sha256,{consumer:'model',record:load.artifact.digest});
    }
    if (source === null) return { ok: false, sha256, reason: `源文件 ${sha256}（${id}）对执行同步的管理员不可读` };
    if (source.bytes === null || source.readTier !== MODEL_READABLE) {
      if (source.readTier === RETAIN_ONLY) return { ok: false, sha256, reason: credentialReason(sha256, id) };
      return { ok: false, sha256, reason: `源文件 ${sha256}（${id}）的读取档位是“${labelOf('read_tier', source.readTier)}”；知识树的内容对模型可读，不能收这份文件` };
    }
    if (!source.artifact.body.scan.inspected) {
      return { ok: false, sha256, reason: `源文件 ${sha256}（${id}）不是凭据扫描能检查的文本，不进知识树` };
    }
    await this.#deps.onReadable?.(load);
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

  /** Uses the explicit source parser without fallback, otherwise the existing media recognizer. */
  parse(source: ReadableSource, declaredParser?: string): Loaded<ParsedSource> {
    if (declaredParser !== undefined) {
      const parser=this.#deps.parsers.get(declaredParser);
      if (!parser) return {ok:false,sha256:source.sha256,reason:`源文件 ${source.sha256}（${source.external}）来源声明的解析器 ${declaredParser} 未登记；请包作者修正声明或管理员登记解析器后重产`};
      const key=documentKey(source,declaredParser);
      try {
        let document=this.#documents.get(key);
        if (!document) {document=parser.parse(source.bytes,{mediaType:source.mediaType});this.#documents.set(key,document);}
        const inferred=this.#deps.parsers.forMediaType(source.mediaType)[0];
        const origin=source.artifact?.body?.origin;
        const mediaLabel=origin&&'generated' in origin?'派生件媒体类型':'服务器媒体类型';
        const parseNote=!inferred || parserKey(inferred)!==declaredParser ? `源文件 ${source.sha256}（${source.external}）：${mediaLabel} ${source.mediaType}，按来源声明以 ${declaredParser} 解析` : undefined;
        return {ok:true,value:{...source,parser:declaredParser,document,...(parseNote?{parseNote}:{})}};
      } catch(error) {
        const reason=error instanceof ParseError ? `${error.message}${error.offset===null?'':`（字节 ${error.offset}）`}；${error.fix}` : describeError(error);
        return {ok:false,sha256:source.sha256,reason:`源文件 ${source.sha256}（${source.external}）被来源声明的 ${declaredParser} 拒绝：${reason}；请修正来源或显式声明后重产`};
      }
    }
    const known = this.#recognized.get(`${source.sha256}\u0000${source.mediaType}`);
    const cached = known === undefined ? undefined : this.#documents.get(documentKey(source,known!));
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
    this.#documents.set(documentKey(source,parser), found.document);
    this.#recognized.set(`${source.sha256}\u0000${source.mediaType}`, parser);
    return { ok: true, value: { ...source, parser, document: found.document } };
  }

  /**
   * The document of a source parsed with a named parser (a fragment may name another parser than the one that parsed
   * the slot); null when the parser is not registered or does not accept the bytes.
   */
  documentWith(source: ReadableSource, parser: string): ParsedDocument | null {
    const key = documentKey(source,parser);
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
