// The read plugins (D01 R[1], R[2]; B02; B05). executeRead plans the requests of one read with the system pack's planner
// function (sandboxed, pure, called again with the responses so far, at most five rounds, until it answers done) or with the
// read's one declared request; sends them through the resource's HttpSource (allow-list, login once per expiry); stores
// EVERY response body as a source artifact the moment it is complete, before anything interprets it; runs the projection
// function (sandboxed) to derive artifacts such as `content` and `meta`; and stores a read manifest, the B05 action record
// of the read. Nested reads (another external object the planner needs, such as the folder tree above a document) are served
// from a cache per resource configuration, pack, reader and object until they expire or the planner asks for a refresh once;
// top-level reads only refresh an entry a nested read made, and the cache is bounded by bytes.
// Read tier (B02 R[4]): an answer stored at retain_only (a credential hit no acceptance covers, or the echo of a credential
// value the Hub sent, which this engine stores at retain_only itself) reaches no function: its view has no json, text or
// model and `ok: false` (SOURCE_CREDENTIAL); as the original it fails the read with its digest. A derived artifact stored
// at retain_only gives nested readers no content. A planned request that would carry a sent credential value is refused.
// Visibility of what a read stores (B02 R[3], D01 R[4]; milestone 1 has shared service credentials only): the reader and
// admins, never shareable.
import {readRetryDelay,READ_TRANSPORT_RETRIES,READ_RETRY_WAIT_MS,type ReadRetry} from './read-retry.ts';
import { SANDBOX_ERRORS, SandboxError } from '../rules/api.ts';
import type { ParserRegistry } from '../refs/api.ts';
import type { ExternalArtifact, ExternalReadContext, ExternalRedirect, PackHandle } from '../ports.ts';
import type { Artifacts, Principals, RecordStore, SourceArtifact, Visibility } from '../records/api.ts';
import { canonicalBytes, sha256Hex, scanForCredentials } from '../records/api.ts';
import type {Coverage} from '../../contracts/src/common.ts';
import { labelOf } from '../../contracts/generated/vocabulary.ts';
import { RunId } from '../../contracts/src/common.ts';
import { ExternalObjectId } from '../../contracts/src/reference.ts';
import {
  MAX_NESTED_READS,
  MAX_READ_ROUNDS,
  DEFAULT_READ_REQUESTS,
  ReadManifest,
  ReadPlanOutput,
  ReadProjectionOutput,
  SourceAbsent,
  type NestedRead,
  type PlannedRequest,
  type ReadDeclaration,
  type ReadRequestEntry,
  type ReadResponse,
  type ReadSubject,
  type ResourceRecord,
  type SystemProfile,
} from '../../contracts/src/resources.ts';
import { CONNECTOR_ERRORS, ConnectorError, FATAL_READ_ERRORS, asConnectorError, isConnectorErrorCode, type ConnectorErrorCode } from './errors.ts';
import { decodeText, type ConnectorLog, type HttpExchange, type HttpSource } from './http.ts';
import type { LoginManager, StaticCredential, StaticHeader } from './login.ts';
import type { Redactor } from './redact.ts';
import { MAX_PATH, buildPath, type CompiledRoute } from './routes.ts';

/** Runs one pack function in the sandbox and returns its JSON output (tests may wrap it). */
export type PackFunctionRunner = (target: { packDir: string; module: string; export?: string }, input: unknown, kind: 'plan' | 'project') => Promise<unknown>;

/** Everything the engine needs of one enabled resource. */
export interface ResourceRuntime {
  variables?: import('../../contracts/src/variables.ts').VariableUse[];
  dependencies?: string[];
  gate?: import('./credential-stop.ts').CredentialStop|null;
  resource: ResourceRecord;
  /** Digest of the authorization record that put the definition in force. */
  decision: string;
  pack: PackHandle;
  profile: SystemProfile;
  routes: CompiledRoute[];
  http: HttpSource;
  /** The login of a login_token profile, or null. */
  login: LoginManager | null;
  /** The header credential of a static_header profile, or null. */
  credential: StaticCredential | null;
}

export interface ReadArgs {
  /** The key of the external object: the part after `system:type:`. */
  id: string;
  /** A revision asked for; the read fails when it observes another. */
  revision?: string | null;
  /** Extra arguments handed to the read functions as input.args. */
  args?: Record<string, unknown>;
}

export type ReadOutcome =
  | {
      ok: true;
      external: string;
      revision: string | null;
      artifacts: ExternalArtifact[];
      /** Digest of the read manifest record. */
      manifest: string;
      /** The content artifact parsed (JSON) or as text; the original when there is none. */
      content: unknown;
      meta: unknown;
      coverage:Coverage;
      absent?:SourceAbsent;
    }
  | { ok: false; external: string; code: ConnectorErrorCode; reason: string; message?:string; disclosable?:boolean; manifest: string | null;retry?:ReadRetry;redirect?:ExternalRedirect };

export interface ReadEngineOptions {
  readRetrySleep?:(ms:number)=>Promise<void>;
  store: RecordStore;
  artifacts: Artifacts;
  principals: Principals;
  parsers: ParserRegistry;
  callFunction: PackFunctionRunner;
  /** The enabled resources whose profile declares an external type (resolution for nested reads). */
  resolve: (type: string, context?: ExternalReadContext) => Promise<{ runtime: ResourceRuntime; read: ReadDeclaration }[]>;
  redactor: Redactor;
  now: () => Date;
  log?: ConnectorLog;
  /** How long a nested read is served from the cache, default one hour. */
  nestedCacheMs?: number;
  /** Bytes of stored artifacts the nested-read cache keeps at most, default 64 MiB. */
  nestedCacheBytes?: number;
}

export const COMPONENT = 'connectors@1';
/** Depth of nested reads: a read may ask for reads that ask for none. */
const MAX_DEPTH = 1;
const DEFAULT_READ_BYTES = 256 * 1024 * 1024;
const MAX_GENERATED_INPUTS = 200;
const MAX_CACHED_READS = 500;
const DEFAULT_CACHE_BYTES = 64 * 1024 * 1024;
const JSON_MEDIA = /^application\/(?:[a-z0-9.+-]*\+)?json\s*(?:;|$)/i;
const RETAIN_ONLY = 'retain_only' as const;

interface ResponseState {
  failure?:ConnectorError;
  view: ReadResponse;
  url: string | null;
  artifact: SourceArtifact | null;
}

/** A stored answer and whether the engine itself kept it retain_only because it echoes a credential value the Hub sent. */
interface Stored {
  artifact: SourceArtifact;
  echoed: boolean;
}

/** A path as a manifest entry records it: as sent, or for a longer refused one its start and the digest of the whole. */
function entryPath(path: string): string {
  if (path.length <= MAX_PATH) return path;
  return `${path.slice(0, MAX_PATH - 80)}…sha256:${sha256Hex(path)}`;
}

/** Whether a failed request still shows that the source accepted the token for authentication (it answered otherwise than 401). */
function judged(error: ConnectorError): boolean {
  const status = error.detail.status;
  return typeof status === 'number' && ((status >= 200 && status < 300) || (status >= 400 && status < 500 && status !== 401));
}

interface NestedState {
  view: NestedRead;
  manifest: string | null;
  artifacts: SourceArtifact[];
}

interface CacheEntry {
  at: number;
  bytes: number;
  outcome: Extract<ReadOutcome, { ok: true }>;
}

/** `system:type:key[@revision]` split, or null when it is not an external object identity. */
export const MAX_EXTERNAL_ID_BYTES = 900;
export function externalSizeReason(id: string): string | null {
  const bytes = Buffer.byteLength(id, 'utf8');
  return bytes > MAX_EXTERNAL_ID_BYTES ? `外部对象标识是 ${bytes} 字节，超过 ${MAX_EXTERNAL_ID_BYTES} 字节上限；缩短读取键后重读` : null;
}

export function parseExternal(id: string): ReadSubject | null {
  const subject = externalShape(id);
  return subject === null || externalSizeReason(id) !== null ? null : subject;
}

/** Routing may admit a shape-valid oversized id so read() can report the actual byte failure. */
export function externalRoutingType(id: string): string | null {
  const parsed = externalShape(id);
  return parsed === null ? null : `${parsed.system}:${parsed.type}`;
}

function externalShape(id: string): ReadSubject | null {
  if (!ExternalObjectId.safeParse(id).success) return null;
  const first = id.indexOf(':');
  const second = id.indexOf(':', first + 1);
  const rest = id.slice(second + 1);
  const at = rest.indexOf('@');
  const key = at < 0 ? rest : rest.slice(0, at);
  const revision = at < 0 ? null : rest.slice(at + 1);
  const system = id.slice(0, first);
  const type = id.slice(first + 1, second);
  return { id: `${system}:${type}:${key}`, system, type, key, revision };
}

function indexValue(value: string): string {
  return Buffer.byteLength(value, 'utf8') <= MAX_EXTERNAL_ID_BYTES ? value : `sha256:${sha256Hex(value)}`;
}

function fillId(value: unknown, key: string, depth = 0): unknown {
  if (depth > 32) throw new ConnectorError('PROFILE_INVALID', '声明的请求体嵌套太深');
  if (typeof value === 'string') return value.replaceAll('{id}', key);
  if (Array.isArray(value)) return value.map((item) => fillId(item, key, depth + 1));
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillId(v, key, depth + 1)]));
  return value;
}

function stringMap(value: Record<string, string> | undefined, key: string): Record<string, string> | undefined {
  return value === undefined ? undefined : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, v.replaceAll('{id}', key)]));
}

function zodProblem(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `/${issue.path.map(String).join('/')}: ${issue.message}`)
    .join('; ');
}

function majorOf(version: string): string {
  return version.split('.')[0] ?? '0';
}

/** The value of a stored artifact for the read functions: JSON when its media type says so, else text. */
function valueOf(bytes: Uint8Array, mediaType: string): unknown {
  const text = decodeText(bytes, mediaType);
  if (JSON_MEDIA.test(mediaType)) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

export class ReadEngine {
  // Only the internal reason channel consumed by administrator notes carries pack diagnostics.
  // Never add them to read manifests, artifacts or the public tool answer.
  readonly #adminReasons = new WeakMap<ConnectorError, string>();
  readonly #o: ReadEngineOptions;
  readonly #cache = new Map<string, CacheEntry>();
  #cacheBytes = 0;

  constructor(options: ReadEngineOptions) {
    this.#o = options;
  }

  /** Forgets every cached nested read. */
  clearCache(): void {
    this.#cache.clear();
    this.#cacheBytes = 0;
  }

  /** One read of one external object through one resource. Never throws: a failure is an outcome with a reason. */
  async execute(runtime: ResourceRuntime, read: ReadDeclaration, args: ReadArgs, context: ExternalReadContext): Promise<ReadOutcome> {
    const external = `${read.external}:${String(args?.id)}${args?.revision ? `@${args.revision}` : ''}`;
    const sizeReason = externalSizeReason(external);
    if (sizeReason !== null) return { ok: false, external, code: 'PLAN_INVALID', reason: sizeReason, manifest: null };
    const subject = parseExternal(external);
    if (subject === null) return { ok: false, external, code: 'PLAN_INVALID', reason: `${this.#o.redactor.text(external)} 不是外部对象标识`, manifest: null };
    return this.top(runtime, read, subject, context, args.args ?? {});
  }

  async #reader(context: ExternalReadContext): Promise<string> {
    const id = context?.principal?.id;
    const user = typeof id === 'string' ? await this.#o.principals.get(id) : null;
    if (user === null || user.disabled) throw new ConnectorError('READER_INVALID', '读取者不是有效的 Hub 账号');
    return user.id;
  }

  async #execute(
    runtime: ResourceRuntime,
    read: ReadDeclaration,
    subject: ReadSubject,
    args: Record<string, unknown>,
    context: ExternalReadContext,
    reader: string,
    depth: number,
  ): Promise<ReadOutcome> {
    const startedAt = this.#o.now().toISOString();
    const visibility: Visibility = { readers: [reader], admins: true, packs: [], shareable: false };
    const responses = new Map<string, ResponseState>();
    const echoedArtifacts=new Set<string>();
    const entries: ReadRequestEntry[] = [];
    const nested = new Map<string, NestedState>();
    const refreshed = new Set<string>();
    const warnings: string[] = [];
    const maxRequests = read.max_requests ?? DEFAULT_READ_REQUESTS;
    const maxBytes = read.max_bytes ?? DEFAULT_READ_BYTES;
    let bytes = 0;
    let original: string | null = null;
    let revision: string | null = null;
    let artifacts: ExternalArtifact[] = [];
    let content: unknown = null;
    let meta: unknown = null;
    let complete = false;
    let absent:SourceAbsent|undefined;
    let note: string | undefined;
    let failure: ConnectorError | null = null;

    // Plan order, not completion order: the read functions get the same input whatever order the answers arrived in.
    const order: string[] = [];
    const nestedOrder: string[] = [];
    const views = (): Record<string, ReadResponse> => Object.fromEntries(order.flatMap((key) => (responses.has(key) ? [[key, responses.get(key)!.view]] : [])));
    const nestedViews = (): Record<string, NestedRead> => Object.fromEntries(nestedOrder.flatMap((key) => (nested.has(key) ? [[key, nested.get(key)!.view]] : [])));

    const store = async (exchange: HttpExchange, key: string): Promise<Stored> => {
      if (bytes + exchange.bytes.byteLength > maxBytes) {
        throw new ConnectorError('READ_LIMIT', `这次读取的应答合计超过 ${maxBytes} 字节；不截断保存`, { layer: 'transport', detail: { limit: maxBytes } });
      }
      bytes += exchange.bytes.byteLength;
      // An answer carrying a credential value the Hub sent (an echo of the request's own header, a debug page) is kept
      // retain_only whatever the credential scanner finds; an admin acceptance of scan findings does not lift it.
      const echoed = this.#o.redactor.echoedIn(exchange.bytes, exchange.mediaType);
      try {
        const artifact = await this.#o.artifacts.ingest({
          bytes: exchange.bytes,
          mediaType: exchange.mediaType,
          origin: { read: { object: subject.id, resource: runtime.resource.id, action: null } },
          author: { user: null },
          provenanceType: 'observed',
          visibility: echoed ? {admins:true,readers:[],packs:[],shareable:false} : visibility,
          name: `${read.name}/${key}`,
          capturedAt: new Date(exchange.endedAt).toISOString(),
          ...(echoed ? { readTier: RETAIN_ONLY } : {}),
        });
        if(echoed){echoedArtifacts.add(artifact.body.sha256);this.#event('secret_echoed',{resource:runtime.resource.id,route:exchange.route.id,status:exchange.status,record:artifact.digest});}
        return { artifact, echoed };
      } catch (error) {
        throw new ConnectorError('STORE_FAILED', `保存路由 ${exchange.route.id} 的应答失败`, { cause: error, detail: { route: exchange.route.id } });
      }
    };

    /** The view of an answer stored retain_only: what was received, never what it says. */
    const withheld = (route: string, path: string, query: Record<string, string>, exchange: HttpExchange, stored: Stored, failed: ConnectorError | null): ReadResponse | null => {
      if (stored.artifact.body.read_tier !== RETAIN_ONLY) return null;
      const why = stored.echoed ? '含有 Hub 发出的凭据或令牌' : '有凭据扫描命中';
      const code: ConnectorErrorCode = failed?.code ?? 'SOURCE_CREDENTIAL';
      const said = failed === null ? '' : `${CONNECTOR_ERRORS[failed.code]}；`;
      return {
        ok: false,
        route,
        path,
        query,
        status: exchange.status,
        media_type: exchange.mediaType,
        size: exchange.bytes.byteLength,
        sha256: stored.echoed?null:exchange.sha256,
        etag: stored.echoed?null:exchange.etag,
        error: { code, message: `${said}应答${stored.echoed?'':`（sha256 ${exchange.sha256}）`}${why}，按“${labelOf('read_tier', RETAIN_ONLY)}”保存，函数拿不到原文` },
      };
    };

    const routePages=new Map<string,number>();
    const redirectChains=new Map<string,{hops:number;limit:number}>();
    const followed=new Map<string,string>();
    const covered=(key:string,visited=new Set<string>()):boolean=>{
      if(visited.has(key))return false;
      visited.add(key);
      const state=responses.get(key);
      return state?.view.ok===true || (state?.view.error?.code==='SOURCE_REDIRECT_REFUSED' && followed.has(key) && covered(followed.get(key)!,visited));
    };
    const send = async (planned: PlannedRequest, round: number): Promise<void> => {
      const compiled = runtime.routes.find((route) => route.declaration.id === planned.route);
      if(compiled===undefined && planned.against && responses.get(planned.against)?.view.error?.code==='SOURCE_REDIRECT_REFUSED')throw new ConnectorError('SOURCE_REDIRECT_REFUSED','已观察的 Location 没有对应的已声明读取路由；由资源管理员核对路由',{layer:'transport'});
      if (compiled === undefined) throw new ConnectorError('ROUTE_REFUSED', `系统包没有路由 ${planned.route}；请求在发出前被拒绝`, { layer: 'transport', detail: { route: planned.route } });
      const route = compiled.declaration;
      let path: string;
      let query: Record<string, string> = {};
      if (planned.href !== undefined) {
        let against: string | null = null;
        if (planned.against !== undefined) {
          against = responses.get(planned.against)?.url ?? null;
          if (against === null) throw new ConnectorError('PLAN_INVALID', `请求 ${planned.key} 的 against 指向没有地址的应答 ${planned.against}`, { layer: 'plugin' });
        }
        let resolved;
        try {resolved=runtime.http.resolveHref(route.role,planned.href,against);}
        catch(error) {
          if(planned.against && responses.get(planned.against)?.view.error?.code==='SOURCE_REDIRECT_REFUSED')throw new ConnectorError('SOURCE_REDIRECT_REFUSED','已观察的 Location 不在允许的同源根路径内；由资源管理员核对来源与路由',{layer:'transport',cause:error});
          throw error;
        }
        path = resolved.path;
        query = resolved.query;
        if (planned.query !== undefined && Object.keys(resolved.query).length > 0) throw new ConnectorError('PLAN_INVALID', `请求 ${planned.key} 的链接已带查询参数`, { layer: 'plugin' });
      } else if (planned.path !== undefined) {
        path = planned.path;
      } else {
        path = buildPath(compiled, planned.params ?? {});
      }
      for (const [name, value] of Object.entries(planned.query ?? {})) query[name] = String(value);
      if(planned.against && responses.get(planned.against)?.view.error?.code==='SOURCE_REDIRECT_REFUSED') {
        const previous=responses.get(planned.against)!;
        const sourceRoute=runtime.routes.find(r=>r.declaration.id===previous.view.route)?.declaration;
        const inherited=redirectChains.get(planned.against);
        const limit=Math.min(inherited?.limit??Infinity,sourceRoute?.redirects?.max_hops??0);
        const hops=(inherited?.hops??0)+1;
        if(!sourceRoute?.redirects || hops>limit || !previous.view.location || planned.href!==previous.view.location || Object.keys(planned.query??{}).length>0 || new URL(previous.view.location,previous.url!).origin!==new URL(previous.url!).origin)throw new ConnectorError('SOURCE_REDIRECT_REFUSED','缺少允许此同源跳转的声明或已到跳转上限；由资源管理员核对 Location 与路由',{layer:'transport'});
        // resolveHref has already checked the same origin and the role base path; check() below checks the allow list.
        redirectChains.set(planned.key,{hops,limit});followed.set(planned.against,planned.key);
      } else {
        const pages=(routePages.get(route.id)??0)+1;routePages.set(route.id,pages);
        if(route.pagination && pages>route.pagination.max_pages)throw new ConnectorError('READ_LIMIT',`路由 ${route.id} 的分页超过声明的 ${route.pagination.max_pages} 页；缺少余下页面，请管理员核对分页上限后重新完整读取`,{layer:'plugin'});
      }

      const auth = runtime.profile.auth;
      const carries = auth.kind !== 'none' && auth.roles.includes(route.role);
      const refusedEntry = (code: string, masked: boolean): ReadRequestEntry => {
        const at = this.#o.now().toISOString();
        const recorded = masked ? (this.#o.redactor.maskSent({ path, query, body: planned.body }) as { path: string; query: Record<string, string>; body?: unknown }) : { path, query, body: planned.body };
        return {
          key: planned.key,
          round,
          route: route.id,
          method: route.method,
          path: entryPath(recorded.path),
          query: recorded.query,
          ...(recorded.body === undefined ? {} : { body: recorded.body }),
          started_at: at,
          ended_at: at,
          status: null,
          ok: false,
          error: code,
          sha256: null,
          size: null,
          media_type: null,
          etag: null,
          artifact: null,
          after_login: false,
        };
      };
      // A plan never carries a credential value the Hub sent (the functions never see one); such a request is refused and
      // recorded masked.
      if (this.#o.redactor.carriesSent([path, ...Object.keys(query), ...Object.values(query), planned.body === undefined ? '' : JSON.stringify(planned.body)])) {
        entries.push(refusedEntry('PLAN_INVALID', true));
        throw new ConnectorError('PLAN_INVALID', `请求 ${planned.key} 带有 Hub 发出过的凭据或令牌；请求在发出前被拒绝`, { layer: 'plugin' });
      }
      // Refusals come before any credential is fetched: a request that may not go out never causes a login.
      try {
        runtime.http.check({ route: route.id, method: route.method, path, query, body: planned.body }, carries);
      } catch (error) {
        const failed = asConnectorError(error, 'ROUTE_REFUSED', 'transport');
        entries.push(refusedEntry(failed.code, false));
        if(planned.against && responses.get(planned.against)?.view.error?.code==='SOURCE_REDIRECT_REFUSED')throw new ConnectorError('SOURCE_REDIRECT_REFUSED','已观察的 Location 不符合目标读取路由；由资源管理员核对路由声明',{layer:'transport',cause:failed});
        throw failed;
      }
      let attempts=0,retries=0,waited=0;
      const attempt = async (credential: { name: string; value: string } | null, afterLogin: boolean): Promise<void> => {
        attempts++;
        const started = this.#o.now().toISOString();
        let received: { exchange: HttpExchange; stored: Stored } | null = null;
        const entry = (ok: boolean, error: string | null): ReadRequestEntry => ({
          key: planned.key,
          attempt:attempts,
          round,
          route: route.id,
          method: route.method,
          path: entryPath(path),
          query,
          ...(planned.body === undefined ? {} : { body: planned.body }),
          started_at: started,
          ended_at: this.#o.now().toISOString(),
          status: received?.exchange.status ?? null,
          ok,
          error,
          sha256: received?.stored.echoed?null:received?.exchange.sha256 ?? null,
          size: received?.exchange.bytes.byteLength ?? null,
          media_type: received?.exchange.mediaType ?? null,
          etag: received?.stored.echoed?null:received?.exchange.etag ?? null,
          ...(received && received.stored.artifact.body.read_tier!==RETAIN_ONLY?this.#location(received.exchange):{}),
          artifact: received?.stored.echoed?null:received?.stored.artifact.digest ?? null,
          after_login: afterLogin,
        });
        try {
          const reply = await runtime.http.request(
            { route: route.id, method: route.method, path, query, body: planned.body, credential },
            {
              received: async (exchange) => {
                received = { exchange, stored: await store(exchange, planned.key) };
              },
            },
          );
          const got = received as { exchange: HttpExchange; stored: Stored } | null;
          if (got === null) throw new ConnectorError('STORE_FAILED', `路由 ${route.id} 的应答没有保存`);
          let view: ReadResponse = withheld(route.id, path, query, reply, got.stored, null) ?? this.#view(route.id, path, query, reply, null);
          if (view.ok && route.parse !== undefined) view = this.#parsed(view, route.parse, reply.bytes, reply.mediaType);
          responses.set(planned.key, { view, url: reply.url, artifact: got.stored.artifact });
          entries.push(entry(view.ok, view.ok ? null : (view.error?.code ?? 'SOURCE_MALFORMED')));
        } catch (error) {
          const failed = asConnectorError(error, 'SOURCE_UNREACHABLE', 'transport');
          entries.push(entry(false, failed.code));
          const got = received as { exchange: HttpExchange; stored: Stored } | null;
          if (got !== null) {
            const view = withheld(route.id, path, query, got.exchange, got.stored, failed) ?? this.#view(route.id, path, query, got.exchange, failed);
            responses.set(planned.key, { view, url: got.exchange.url, artifact: got.stored.artifact });
          } else {
            responses.set(planned.key, {
              view: { ok: false, route: route.id, path, query, status: null, media_type: null, size: null, sha256: null, etag: null, error: { code: failed.code, message: this.#o.redactor.text(failed.message) } },
              url: null,
              artifact: null,
            });
          }
          throw failed;
        }
      };
      const retryAttempt=async(credential:{name:string;value:string}|null,afterLogin:boolean):Promise<void>=>{
        for(;;) {
          try {return await attempt(credential,afterLogin);}
          catch(error) {
            const failed=asConnectorError(error,'SOURCE_UNREACHABLE','transport');
            const delay=readRetryDelay(failed,retries);
            if(delay===null)throw failed;
            const at=new Date(this.#o.now().getTime()+delay).toISOString();
            const final=new ConnectorError(failed.code,failed.message,{layer:failed.layer,detail:{...failed.detail,retry_at:at,attempts},cause:failed});
            const state=responses.get(planned.key);
            if(state){state.failure=final;if(state.view.error)Object.assign(state.view.error,{retry_at:at,attempts});}
            const entry=entries.findLast(value=>value.key===planned.key && value.attempt===attempts);
            if(entry)entry.retry_at=at;
            if(retries>=READ_TRANSPORT_RETRIES || delay+waited>READ_RETRY_WAIT_MS)throw final;
            retries++;waited+=delay;
            await (this.#o.readRetrySleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms))))(delay);
          }
        }
      };
      if (!carries) {
        try {
          await retryAttempt(null, false);
        } catch (error) {
          if (FATAL_READ_ERRORS.has((error as ConnectorError).code)) throw error;
        }
        return;
      }
      const guarded = <T>(fn:()=>Promise<T>)=>runtime.gate?runtime.gate.run(fn):fn();
      if (auth.kind === 'static_header') {
        return guarded(async()=>{
        const credential = runtime.credential;
        if (credential === null) throw new ConnectorError('PROFILE_INVALID', '资源没有静态凭据的处理');
        const header: StaticHeader = await credential.acquire();
        let accepted = false;
        try {
          await retryAttempt(header, false);
          accepted = true;
        } catch (error) {
          const failed = error as ConnectorError;
          // 401 or an envelope "expired" code to a static value: the source refused it; it is not sent again.
          if (failed.code === 'SOURCE_LOGIN_EXPIRED') await credential.refused(failed, header);
          accepted = judged(failed);
          if (FATAL_READ_ERRORS.has(failed.code)) throw failed;
        } finally {
          header.settle(accepted);
        }
        });
      }
      const login = runtime.login;
      if (login === null || auth.kind !== 'login_token') throw new ConnectorError('PROFILE_INVALID', '资源没有登录的处理');
      const header = (token: string) => ({ name: auth.header.name, value: auth.header.scheme === 'bearer' ? `Bearer ${token}` : token });
      /** Sends with `token`; true when the answer said "login expired". Any other answer confirms the token. */
      const sendWith = async (token: string, afterLogin: boolean): Promise<boolean> => {
        try {
          await retryAttempt(header(token), afterLogin);
        } catch (error) {
          const failed = error as ConnectorError;
          if (failed.code === 'SOURCE_LOGIN_EXPIRED') return true;
          if (judged(failed)) await login.confirmed(token);
          if (FATAL_READ_ERRORS.has(failed.code)) throw failed;
          return false;
        }
        await login.confirmed(token);
        return false;
      };
      const cached=await login.cachedToken();
      if(cached)await runtime.gate?.assertOpen();
      const first = cached??await guarded(()=>login.token());
      if (!(await sendWith(first.token, false))) return;
      // One login for an explicit "expired" answer to a confirmed token (none for a token nothing confirmed), then the
      // request once more; another "expired" ends the read and, for a token a login just produced, stops the logins.
      const next = await guarded(()=>login.expired(first.token));
      if (!(await sendWith(next, true))) return;
      await guarded(()=>login.refused(next));
    };

    const nestedRead = async (wanted: { external: string; refresh?: boolean }): Promise<void> => {
      const target = parseExternal(wanted.external);
      if (target === null) throw new ConnectorError('PLAN_INVALID', `嵌套读取 ${this.#o.redactor.text(wanted.external)} 不是外部对象标识`, { layer: 'plugin' });
      if (target.id === subject.id) throw new ConnectorError('PLAN_INVALID', '嵌套读取指向读取对象自己', { layer: 'plugin' });
      if (depth + 1 > MAX_DEPTH) throw new ConnectorError('READ_LIMIT', '嵌套读取只能有一层', { layer: 'plugin' });
      const refresh = wanted.refresh === true && !refreshed.has(target.id);
      if (refresh) refreshed.add(target.id);
      const outcome = await this.nested(target, context, reader, refresh, depth + 1);
      const cached = 'cached' in outcome && outcome.cached === true;
      nested.set(target.id, {
        view: outcome.ok
          ? { ok: true, coverage:outcome.coverage, revision: outcome.revision, cached, content: outcome.content, meta: outcome.meta, reason: null }
          : { ok: false, revision: null, cached: false, content: null, meta: null, reason: outcome.reason },
        manifest: outcome.manifest,
        artifacts: outcome.ok ? outcome.artifacts.map((a) => a.artifact) : [],
      });
    };

    try {
      // The credential values of the resource are known to the redactor before the first plan is checked (no login).
      await this.#prime(runtime);
      let done = false;
      let requestCount = 0;
      let nestedCount = 0;
      for (let round = 1; round <= MAX_READ_ROUNDS && !done; round++) {
        const plan = await this.#plan(runtime, read, subject, args, round, views(), nestedViews());
        // The original: what the planner names, else the first request of the first round that has one.
        if (plan.original !== undefined) original = plan.original;
        else if (original === null) original = plan.requests[0]?.key ?? null;
        const keys = new Set<string>();
        for (const request of plan.requests) {
          if (order.includes(request.key) || keys.has(request.key)) throw new ConnectorError('PLAN_INVALID', `请求键 ${request.key} 用了两次`, { layer: 'plugin' });
          keys.add(request.key);
        }
        order.push(...keys);
        for (const wanted of plan.reads ?? []) {
          const id = parseExternal(wanted.external)?.id;
          if (id !== undefined && !nestedOrder.includes(id)) nestedOrder.push(id);
        }
        requestCount += plan.requests.length;
        nestedCount += plan.reads?.length ?? 0;
        if (requestCount > maxRequests) throw new ConnectorError('READ_LIMIT', `这次读取的请求超过 ${maxRequests} 个`, { layer: 'plugin', detail: { limit: maxRequests } });
        if (nestedCount > MAX_NESTED_READS) throw new ConnectorError('READ_LIMIT', `这次读取的嵌套读取超过 ${MAX_NESTED_READS} 个`, { layer: 'plugin' });
        const jobs=[...(plan.reads??[]).map(wanted=>()=>nestedRead(wanted)),...plan.requests.map(request=>()=>send(request,round))];
        const width=plan.concurrency??Math.max(jobs.length,1);
        for(let from=0;from<jobs.length;from+=width){
          const settled=await Promise.allSettled(jobs.slice(from,from+width).map(job=>job()));
          const fatal=settled.find((result):result is PromiseRejectedResult=>result.status==='rejected');
          if(fatal!==undefined)throw fatal.reason;
        }
        done = plan.done;
      }
      if (!done) throw new ConnectorError('PLAN_INVALID', `规划函数 ${MAX_READ_ROUNDS} 轮后仍没有给出 done`, { layer: 'plugin' });
      if (original === null || !responses.has(original)) {
        const failed = new ConnectorError('PLAN_INVALID', '规划没有给出原件请求（第一轮的第一个请求，或 original）', { layer: 'plugin' });
        // A terminal plan that sent nothing can explain its refusal through the existing projection error shape.
        // No response is invented: this sentinel names no original, and no successful projection or artifact is accepted.
        if (order.length === 0 && nestedOrder.length === 0 && read.project !== undefined) {
          try {
            const projected = await this.#project(runtime, read, subject, args, 'unavailable', views(), nestedViews());
            if ('error' in projected) this.#adminReasons.set(failed, this.#o.redactor.text(`${projected.error.code}：${projected.error.message}`));
          } catch (error) {
            if (error instanceof ConnectorError) this.#adminReasons.set(failed, this.#adminReason(error));
          }
        }
        throw failed;
      }
      const first = responses.get(original)!;
      if (!first.view.ok || first.artifact === null) {
        const code: ConnectorErrorCode = isConnectorErrorCode(first.view.error?.code) ? first.view.error.code : 'SOURCE_MALFORMED';
        if(first.failure)throw first.failure;
        throw new ConnectorError(code, `原件请求 ${original} 没有成功：${first.view.error?.message ?? '无应答'}`, { layer: 'transport' });
      }
      artifacts = [{ name: 'original', artifact: first.artifact }];
      content = first.view.json !== undefined ? first.view.json : (first.view.text ?? null);
      complete = [...responses.keys()].every(key=>covered(key)) && [...nested.values()].every(state=>state.view.ok && state.view.coverage?.complete!==false);
      if (read.project !== undefined) {
        const projected = await this.#project(runtime, read, subject, args, original, views(), nestedViews());
        if ('error' in projected && read.absent_codes?.includes(projected.error.code) && [...responses.values()].every(state=>state.view.ok || state.view.error?.code==='SOURCE_ABSENT')) {
          throw new ConnectorError('SOURCE_ABSENT','投影按声明确认本对象缺席',{layer:'plugin',detail:{absence_responses:order}});
        }
        if ('error' in projected) throw new ConnectorError('PROJECTION_FAILED', `投影函数报错 ${this.#o.redactor.text(projected.error.code)}：${this.#o.redactor.text(projected.error.message)}`, { layer: 'plugin' });
        for (const warning of projected.warnings ?? []) if (warnings.length < 50) warnings.push(this.#o.redactor.text(warning).slice(0, 500));
        if (projected.complete === false) complete = false;
        if(projected.absent) {
          if(projected.absent.system!==subject.system || projected.absent.object!==subject.id)throw new ConnectorError('PROJECTION_FAILED','缺席观察的系统或对象与本次读取不一致',{layer:'plugin'});
          absent=projected.absent;
        }
        note = projected.note;
        revision = projected.revision ?? null;
        if (revision !== null && !ExternalObjectId.safeParse(`${subject.id}@${revision}`).success) {
          throw new ConnectorError('PROJECTION_FAILED', '投影给出的修订不能写进外部对象标识', { layer: 'plugin' });
        }
        const names = new Set<string>();
        const inputs = [
          ...order.flatMap((key) => {
            const artifact = responses.get(key)?.artifact;
            return artifact && !echoedArtifacts.has(artifact.body.sha256) ? [`src:${artifact.body.sha256}`] : [];
          }),
          ...nestedOrder.flatMap((key) => (nested.get(key)?.artifacts ?? []).map((artifact) => `src:${artifact.body.sha256}`)),
        ];
        const generatedInputs = [...new Set(inputs)].slice(0, MAX_GENERATED_INPUTS);
        for (const derived of projected.artifacts) {
          if (names.has(derived.name)) throw new ConnectorError('PROJECTION_FAILED', `投影给出了两个名为 ${derived.name} 的派生件`, { layer: 'plugin' });
          names.add(derived.name);
          if (derived.response !== undefined) {
            const state = responses.get(derived.response);
            if(state?.artifact && echoedArtifacts.has(state.artifact.body.sha256))throw new ConnectorError('SOURCE_CREDENTIAL','投影不得引用 Hub 凭据回显原件');
            if (state?.artifact == null) throw new ConnectorError('PROJECTION_FAILED', `派生件 ${derived.name} 指向没有保存的应答 ${derived.response}`, { layer: 'plugin' });
            artifacts.push({ name: derived.name, artifact: state.artifact });
            // A stored answer named as content or meta gives nested readers its value, unless no function may read it.
            const value = state.view.ok ? (state.view.json !== undefined ? state.view.json : (state.view.text ?? null)) : null;
            if (derived.name === 'content') content = value;
            if (derived.name === 'meta') meta = value;
            continue;
          }
          let artifact: SourceArtifact;
          let bytesOf: Uint8Array;
          try {
            bytesOf = derived.text !== undefined ? Buffer.from(derived.text, 'utf8') : canonicalBytes(derived.json);
            const echoed = this.#o.redactor.echoedIn(bytesOf, derived.media_type);
            artifact = await this.#o.artifacts.ingest({
              bytes: bytesOf,
              mediaType: derived.media_type,
              origin: { generated: { generator: `${runtime.pack.id}.${read.name}@${majorOf(runtime.pack.version)}`, inputs: generatedInputs, read_back: null } },
              derivedSources: generatedInputs.map(input => input.slice('src:'.length)),
              author: { user: null },
              provenanceType: 'projected',
              visibility: echoed ? {admins:true,readers:[],packs:[],shareable:false} : visibility,
              name: derived.name,
              capturedAt: this.#o.now().toISOString(),
              ...(echoed ? { readTier: RETAIN_ONLY } : {}),
            });
          } catch (error) {
            const why = error instanceof TypeError ? error.message : error instanceof Error && error.name === 'CanonicalizationError' ? '不是可规范化的 JSON' : '存储失败';
            throw new ConnectorError('PROJECTION_FAILED', `派生件 ${derived.name} 不能保存（${this.#o.redactor.text(why)}）`, { layer: 'plugin', cause: error });
          }
          if(this.#o.redactor.echoedIn(bytesOf,derived.media_type)){echoedArtifacts.add(artifact.body.sha256);this.#event('secret_echoed',{resource:runtime.resource.id,artifact:derived.name,record:artifact.digest});throw new ConnectorError('SOURCE_CREDENTIAL','派生件含有 Hub 凭据回显，原件身份仅供管理员私审');}
          artifacts.push({ name: derived.name, artifact });
          // A derived artifact stored retain_only (the scanner flagged what the projection made) gives no content.
          const kept = artifact.body.read_tier === RETAIN_ONLY;
          if (kept && warnings.length < 50) warnings.push(`派生件 ${derived.name} 按“${labelOf('read_tier', RETAIN_ONLY)}”保存（凭据），嵌套读取拿不到它的内容`);
          const value = kept ? null : derived.json !== undefined ? derived.json : valueOf(bytesOf, derived.media_type);
          if (derived.name === 'content') content = value;
          if (derived.name === 'meta') meta = value;
        }
      }
      if (subject.revision !== null && revision !== subject.revision) {
        throw new ConnectorError('SOURCE_ABSENT', `要求修订 ${this.#o.redactor.text(subject.revision)}，读到的是 ${revision === null ? '无修订' : this.#o.redactor.text(revision)}`, { layer: 'plugin' });
      }
    } catch (error) {
      failure = asConnectorError(error, 'STORE_FAILED');
      absent=undefined;
    }

    // Whole-object absence is a determined observation, backed only by originals this read actually stored.
    const firstState=original===null?undefined:responses.get(original);
    const httpAbsent=failure?.code==='SOURCE_ABSENT' && firstState?.view.error?.code==='SOURCE_ABSENT' && (firstState.view.status===404 || firstState.view.status===410);
    const declared=failure?.detail.absence_responses;
    if(absent || httpAbsent || Array.isArray(declared)) {
      const keys=absent?.responses ?? (Array.isArray(declared)?declared:[original!]);
      try {
        if(!keys.length || keys.some(key=>typeof key!=='string' || !responses.has(key)))throw new ConnectorError('PROJECTION_FAILED','缺席观察没有指向本次读取的应答',{layer:'plugin'});
        const states=keys.map(key=>responses.get(key as string)!);
        if(states.some(state=>!state.artifact || state.artifact.body.read_tier===RETAIN_ONLY || (!state.view.ok && !(state.view.error?.code==='SOURCE_ABSENT' && (state.view.status===404 || state.view.status===410)))))throw new ConnectorError('PROJECTION_FAILED','缺席根据未读到或不可读；恢复该来源后重读，不能把读不到算成没有',{layer:'plugin'});
        absent=SourceAbsent.parse({code:'SOURCE_ABSENT',system:subject.system,object:subject.id,observed_at:this.#o.now().toISOString(),responses:keys});
        content={...absent,message:`系统 ${subject.system} 里没有 ${subject.id}（读于 ${absent.observed_at}）`};
        const inputs=[...new Set(states.map(state=>`src:${state.artifact!.body.sha256}`))];
        const observation=await this.#o.artifacts.ingest({bytes:canonicalBytes(content),mediaType:'application/json',origin:{generated:{generator:'hub.source-absence@1',inputs,read_back:null}},derivedSources:inputs.map(ref=>ref.slice(4)),author:{user:null},provenanceType:'projected',visibility,name:'content',capturedAt:absent.observed_at});
        if(observation.body.read_tier===RETAIN_ONLY)throw new ConnectorError('SOURCE_CREDENTIAL','缺席观察被凭据扫描保留；请管理员处理后重读');
        artifacts=[{name:'original',artifact:states[0].artifact!},{name:'content',artifact:observation}];
        meta=null;complete=true;failure=null;revision=null;
      } catch(error) {absent=undefined;failure=asConnectorError(error,'PROJECTION_FAILED');}
    }

    const disclosable=echoedArtifacts.size===0 && ![...responses.values()].some(state=>state.artifact?.body.read_tier===RETAIN_ONLY) && !artifacts.some(entry=>entry.artifact.body.read_tier===RETAIN_ONLY);
    // Interpreting a held envelope can itself produce an error containing its text. That text belongs only in
    // the protected original, never in the manifest, diagnostic message or a public protocol error.
    if(failure && !disclosable && (failure.code!=='SOURCE_CREDENTIAL' || echoedArtifacts.size>0)) {
      failure=new ConnectorError(failure.code,`${CONNECTOR_ERRORS[failure.code]}；原件按保留档位处理，请管理员核对受理与读取档位后重读`,{layer:failure.layer,cause:failure,detail:{...(typeof failure.detail.retry_at==='string'?{retry_at:failure.detail.retry_at,attempts:failure.detail.attempts}:{})}});
    }

    entries.sort((a, b) => a.round - b.round || order.indexOf(a.key) - order.indexOf(b.key) || Number(a.after_login) - Number(b.after_login));
    const examined = [...responses.keys()].filter(key=>covered(key) || absent?.responses?.includes(key)).length + [...nested.values()].filter(state=>state.view.ok).length;
    const total = order.length + nestedOrder.length;
    const incompleteNested=[...nested].filter(([,state])=>!state.view.ok || state.view.coverage?.complete===false).map(([external])=>external);
    if(incompleteNested.length && !note)note=`嵌套来源尚未完整：${incompleteNested.slice(0,10).join('、')}；恢复失败来源后重读本对象，再确认完整范围`;
    const ok = failure === null;
    const manifest: ReadManifest = {
      action: 'read',
      run: RunId.safeParse(context.run).success ? (context.run as string) : null,
      item: null,
      variables:runtime.variables ?? [],
      inputs: [`rec:${runtime.decision}`, ...(runtime.dependencies??[]).map(d=>`rec:${d}`), ...nestedOrder.flatMap((key) => {
        const state = nested.get(key);
        return state === undefined || state.manifest === null ? [] : [`rec:${state.manifest}`];
      })],
      component: COMPONENT,
      lease: null,
      started_at: startedAt,
      ended_at: this.#o.now().toISOString(),
      result: ok ? 'completed' : 'error',
      error_code: failure?.code ?? null,
      external: subject.id,
      revision: ok ? revision : null,
      resource: runtime.resource.id,
      environment: runtime.resource.environment,
      system_pack: { id: runtime.pack.id, version: runtime.pack.version, digest: runtime.pack.digest },
      read: read.name,
      principal: reader,
      purpose: this.#o.redactor.text(typeof context.purpose === 'string' ? context.purpose : '').slice(0, 200),
      requests: entries,
      reads: nestedOrder.flatMap((external) => {
        const state = nested.get(external);
        return state === undefined ? [] : [{ external, ok: state.view.ok, cached: state.view.cached, revision: state.view.revision, manifest: state.manifest }];
      }),
      original,
      artifacts: ok ? artifacts.map(({ name, artifact }) => ({ name, record: artifact.digest, sha256: artifact.body.sha256, media_type: artifact.body.media_type, size: artifact.body.size })) : [],
      coverage: ok && complete && examined === total ? { complete: true, examined, total, ...(note ? { note: this.#o.redactor.text(note).slice(0, 500) } : {}) } : { complete: false, examined, total, ...(note ? { note: this.#o.redactor.text(note).slice(0, 500) } : {}) },
      reason: failure === null ? null : failure.code,
      warnings,
    };
    // A manifest that is not read-manifest@1 is a programming error: it is never stored under that schema.
    const checked = ReadManifest.safeParse(manifest);
    let digest: string | null = null;
    if (!checked.success) {
      const problem = zodProblem(checked.error);
      this.#event('manifest_shape', { resource: runtime.resource.id, problem });
      if (failure === null) failure = new ConnectorError('STORE_FAILED', `读清单不符合 read-manifest@1（程序错误），没有保存：${problem}`);
    } else {
      try {
        const record = await this.#o.store.put({
          kind: 'action',
          schema: 'read-manifest@1',
          provenance: 'observed',
          body: manifest,
          index: [
            { key: 'action.kind', value: 'read' },
            { key: 'action.user', value: reader },
            ...(manifest.run === null ? [] : [{ key: 'action.run', value: manifest.run }]),
            { key: 'connectors.external', value: indexValue(subject.id) },
            { key: 'connectors.resource', value: runtime.resource.id },
            ...manifest.artifacts.map(artifact=>({key:'connectors.artifact',value:artifact.record})),
          ],
        });
        digest = record.digest;
      } catch (error) {
        this.#event('manifest_store_failed', { resource: runtime.resource.id });
        if (failure === null) failure = new ConnectorError('STORE_FAILED', '读清单保存失败', { cause: error });
      }
    }
    this.#event(ok && failure === null ? 'read_ok' : 'read_failed', {
      resource: runtime.resource.id,
      read: read.name,
      requests: entries.length,
      ...(failure === null ? {} : { code: failure.code }),
      // A nested pack must not receive a diagnostic it could echo into public derived content.
      ...(failure !== null && depth > 0 && this.#adminReasons.has(failure) ? { reason: this.#adminReason(failure) } : {}),
    });
    if (failure !== null || digest === null) {
      const final = failure ?? new ConnectorError('STORE_FAILED', '读清单保存失败');
      const refusedRedirect=final.code==='SOURCE_REDIRECT_REFUSED'?[...responses].findLast(([key,state])=>state.view.error?.code==='SOURCE_REDIRECT_REFUSED' && !covered(key)):undefined;
      const redirect=refusedRedirect?{status:refusedRedirect[1].view.status!,location:refusedRedirect[1].view.location??null,observed_at:this.#o.now().toISOString(),...(refusedRedirect[1].view.location_redacted?{location_redacted:true as const}:{})}:undefined;
      return { ok: false, external: subject.id, code: final.code, disclosable, message:this.#o.redactor.text(final.message), reason: depth === 0 ? this.#adminReason(final) : this.#o.redactor.text(final.message), manifest: digest,...(redirect?{redirect}:{}),...(typeof final.detail.retry_at==='string'?{retry:{code:final.code,at:final.detail.retry_at,attempts:Number(final.detail.attempts)}}:{}) };
    }
    return { ok: true, external: subject.id, revision, artifacts, manifest: digest, content, meta,coverage:manifest.coverage,...(absent?{absent}:{}) };
  }

  /** A nested or top-level read of another object, from the cache unless refreshed or expired. */
  async nested(target: ReadSubject, context: ExternalReadContext, reader: string, refresh: boolean, depth: number): Promise<ReadOutcome & { cached?: boolean }> {
    const candidates = await this.#o.resolve(`${target.system}:${target.type}`,context);
    if (candidates.length !== 1) {
      return {
        ok: false,
        external: target.id,
        code: 'RESOURCE_UNAVAILABLE',
        reason: candidates.length === 0 ? `没有启用的资源声明外部类型 ${target.system}:${target.type}` : `${candidates.length} 个启用的资源都声明了外部类型 ${target.system}:${target.type}`,
        manifest: null,
      };
    }
    const [{ runtime, read }] = candidates;
    const key = this.#cacheKey(runtime, reader, target);
    const ttl = this.#o.nestedCacheMs ?? 3_600_000;
    const hit = this.#cache.get(key);
    if (!refresh && hit !== undefined && Date.now() - hit.at < ttl) return { ...hit.outcome, cached: true };
    const outcome = await this.#execute(runtime, read, target, {}, context, reader, depth);
    if (outcome.ok) this.#remember(key, outcome);
    return { ...outcome, cached: false };
  }

  /** Top level: a read the caller asked for (never from the cache); it refreshes an entry a nested read made, never adds one. */
  async top(runtime: ResourceRuntime, read: ReadDeclaration, subject: ReadSubject, context: ExternalReadContext, args: Record<string, unknown> = {}): Promise<ReadOutcome> {
    try {
      const reader = await this.#reader(context);
      const outcome = await this.#execute(runtime, read, subject, args, context, reader, 0);
      const key = this.#cacheKey(runtime, reader, subject);
      if (outcome.ok && this.#cache.has(key)) this.#remember(key, outcome);
      return outcome;
    } catch (error) {
      const failure = asConnectorError(error, 'STORE_FAILED');
      return { ok: false, external: subject.id, code: failure.code, reason: this.#o.redactor.text(failure.message), manifest: null };
    }
  }

  /** The configuration in force and the pack are part of the key: a moved or re-bound resource never sees old entries. */
  #cacheKey(runtime: ResourceRuntime, reader: string, target: ReadSubject): string {
    return `${runtime.resource.id}|${runtime.decision}|${runtime.pack.digest}|${runtime.dependencies?.join(",") ?? ""}|${reader}|${target.id}${target.revision === null ? '' : `@${target.revision}`}`;
  }

  #forget(key: string): void {
    const entry = this.#cache.get(key);
    if (entry === undefined) return;
    this.#cache.delete(key);
    this.#cacheBytes -= entry.bytes;
  }

  /** Keeps an outcome within the entry and byte bounds (sizes of its stored artifacts), oldest out first. */
  #remember(key: string, outcome: Extract<ReadOutcome, { ok: true }>): void {
    this.#forget(key);
    if(!outcome.coverage.complete || outcome.absent)return;
    const bytes = outcome.artifacts.reduce((sum, { artifact }) => sum + artifact.body.size, 0);
    const limit = this.#o.nestedCacheBytes ?? DEFAULT_CACHE_BYTES;
    if (bytes > limit) return;
    while (this.#cache.size > 0 && (this.#cache.size >= MAX_CACHED_READS || this.#cacheBytes + bytes > limit)) this.#forget(this.#cache.keys().next().value as string);
    this.#cache.set(key, { at: Date.now(), bytes, outcome });
    this.#cacheBytes += bytes;
  }

  /** Makes the resource's credential values known to the redactor (vault reads only, never a login). */
  async #prime(runtime: ResourceRuntime): Promise<void> {
    try {
      await runtime.login?.prime();
      await runtime.credential?.prime();
    } catch {
      // The credential is read again when a request needs it; that read reports the problem.
    }
  }

  async #plan(
    runtime: ResourceRuntime,
    read: ReadDeclaration,
    subject: ReadSubject,
    args: Record<string, unknown>,
    round: number,
    responses: Record<string, ReadResponse>,
    reads: Record<string, NestedRead>,
  ): Promise<ReadPlanOutput> {
    if (read.request !== undefined) {
      const request = read.request;
      const body = request.body === undefined ? undefined : fillId(request.body, subject.key);
      return {
        requests: [
          {
            key: 'response',
            route: request.route,
            ...(request.params === undefined ? {} : { params: stringMap(request.params, subject.key) }),
            ...(request.query === undefined ? {} : { query: stringMap(request.query, subject.key) }),
            ...(body === undefined ? {} : { body }),
          },
        ],
        done: true,
        original: 'response',
      };
    }
    const input = { round, external: subject, args, settings: runtime.resource.settings, responses, reads };
    const output = await this.#call(runtime, read.plan!, input, 'plan');
    const parsed = ReadPlanOutput.safeParse(output);
    if (!parsed.success) throw new ConnectorError('PLAN_INVALID', `规划函数第 ${round} 轮的输出不符合 read-plan-output@1：${zodProblem(parsed.error)}`, { layer: 'plugin' });
    return parsed.data;
  }

  async #project(
    runtime: ResourceRuntime,
    read: ReadDeclaration,
    subject: ReadSubject,
    args: Record<string, unknown>,
    original: string,
    responses: Record<string, ReadResponse>,
    reads: Record<string, NestedRead>,
  ): Promise<ReadProjectionOutput> {
    const input = { external: subject, args, settings: runtime.resource.settings, responses, reads, original };
    const output = await this.#call(runtime, read.project!, input, 'project');
    const parsed = ReadProjectionOutput.safeParse(output);
    if (!parsed.success) throw new ConnectorError('PROJECTION_FAILED', `投影函数的输出不符合 read-projection-output@1：${zodProblem(parsed.error)}`, { layer: 'plugin' });
    return parsed.data;
  }

  async #call(runtime: ResourceRuntime, ref: { module: string; export?: string }, input: unknown, kind: 'plan' | 'project'): Promise<unknown> {
    try {
      return await this.#o.callFunction({ packDir: runtime.pack.directory, module: ref.module, ...(ref.export === undefined ? {} : { export: ref.export }) }, input, kind);
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      const code = error instanceof SandboxError ? error.code : error instanceof RangeError ? 'INPUT_TOO_LARGE' : 'FUNCTION_ERROR';
      const reason = error instanceof SandboxError && typeof error.detail.reason === 'string' ? `，${error.detail.reason}` : '';
      const what = error instanceof SandboxError ? SANDBOX_ERRORS[error.code] : '函数调用无效';
      const failed: ConnectorErrorCode = kind === 'plan' ? 'FUNCTION_FAILED' : 'PROJECTION_FAILED';
      const failure = new ConnectorError(failed, `系统包函数 ${ref.module} 失败（${code}${reason}）：${what}`, { layer: 'plugin', detail: { module: ref.module, sandbox: code } });
      if (error instanceof SandboxError && typeof error.detail.message === 'string' && error.detail.message.trim() !== '') {
        this.#adminReasons.set(failure, this.#o.redactor.text(error.detail.message));
      }
      throw failure;
    }
  }

  #adminReason(error: ConnectorError): string {
    const detail = this.#adminReasons.get(error);
    return this.#o.redactor.text(`${error.message}${detail ? `；${detail}` : ''}`);
  }

  #location(exchange:HttpExchange):Pick<ReadResponse,'location'|'location_redacted'> {
    const location=exchange.location;
    if(location===undefined)return {};
    let credentials=false;
    try {const url=new URL(location,exchange.url);credentials=url.username!=='' || url.password!=='';} catch {credentials=true;}
    if(location.length>4096 || credentials || this.#o.redactor.text(location)!==location || scanForCredentials(Buffer.from(location)).findings.length)return {location_redacted:true};
    return {location};
  }

  #view(route: string, path: string, query: Record<string, string>, exchange: HttpExchange & { json?: unknown; text?: string }, error: ConnectorError | null): ReadResponse {
    const view: ReadResponse = {
      ok: error === null,
      route,
      path,
      query,
      status: exchange.status,
      media_type: exchange.mediaType,
      size: exchange.bytes.byteLength,
      sha256: exchange.sha256,
      etag: exchange.etag,
      ...this.#location(exchange),
      error: error === null ? null : { code: error.code, message: this.#o.redactor.text(error.message) },
    };
    const kind = exchange.route.response;
    if (kind === 'bytes') return view;
    if (exchange.json !== undefined) return { ...view, json: exchange.json };
    const text = exchange.text ?? decodeText(exchange.bytes, exchange.mediaType);
    if (kind === 'json') {
      try {
        return { ...view, json: JSON.parse(text) };
      } catch {
        return { ...view, text };
      }
    }
    return { ...view, text };
  }

  #parsed(view: ReadResponse, parser: string, bytes: Uint8Array, mediaType: string): ReadResponse {
    if (!view.ok) return view;
    const found = this.#o.parsers.get(parser);
    if (found === undefined) return { ...view, ok: false, error: { code: 'SOURCE_MALFORMED', message: `没有核心解析器 ${parser}` } };
    try {
      return { ...view, model: found.parse(bytes, { mediaType }).model };
    } catch (error) {
      return { ...view, ok: false, error: { code: 'SOURCE_MALFORMED', message: `${parser} 解析失败：${this.#o.redactor.text((error as Error).message).slice(0, 300)}` } };
    }
  }

  #event(event: string, detail: Record<string, unknown>): void {
    if (this.#o.log === undefined) return;
    try {
      this.#o.log({ at: this.#o.now().toISOString(), event, resource: typeof detail.resource === 'string' ? detail.resource : null, ...(this.#o.redactor.value(detail) as Record<string, unknown>) });
    } catch {
      // A failing log sink never fails a read.
    }
  }
}

