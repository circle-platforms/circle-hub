// Personal/team knowledge uses immutable versions and shared content-addressed objects. Every read rechecks current grants.
import { z } from 'zod';
import type {ProtocolError} from '../../contracts/src/common.ts';
import { KnowledgeShareInput, KnowledgeShareBody, type KnowledgeShareReceipt } from '../../contracts/src/sharing.ts';
import { SpaceId, SpaceEntryInput, SpaceEntryBody, SpaceVersionBody, SpaceGrantBody, SpaceQuotaBody, SpaceSourceBody, SpaceTreeNode, type SpaceRow, } from '../../contracts/src/spaces.ts';
import { KnowledgeEntryStatusSchema, ShareCheckSchema, labelOf, type ShareCheck, type StaticTerminal, type KnowledgeSearchScope, type KnowledgeGrantee } from '../../contracts/generated/vocabulary.ts';
import { PROTOCOL_CODES, type ProtocolCode, type RecordKind } from '../../contracts/generated/protocol.ts';
import { canonicalize, sha256Hex, scanForCredentials, RecordsError, type Principal, type Transaction, type StoredRecord, type ArtifactSource, type Page, type IngestInput } from '../records/api.ts';
import { pathOf, pathSegments, parseReference, resolveReference, verifyQuote, type TreeReader, type ReaderIdentity, type TreeRead } from '../refs/api.ts';
import type { NodesPage, NodesQuery } from '../ports.ts';
import { WriteQueue, type KnowledgeContext } from './context.ts';
import type { SpaceSearchRow } from '../records/api.ts';
import { normaliseStatement } from './digest.ts';
import { levelOfHeight, KnowledgeEntryBody } from '../../contracts/src/knowledge.ts';
import { KnowledgeError } from './errors.ts';
export const DEFAULT_PERSONAL_CAPACITY = 1024 ** 3;
export const PRODUCTS_PATH = pathOf(['产品']);
const VERSION_KEY = 'knowledge.space.version';
const GRANT_KEY = 'knowledge.space.grant';
const SOURCE_KEY = 'knowledge.space.source';
const QUOTA_KEY = 'knowledge.space.quota';
const active = (row: SpaceRow) => row.status === 'verified' || row.status === 'unverified';
export const withinSpacePath = (path: string, parent: string) => parent === '/' || path === parent || path.startsWith(parent + '/');
function fail(code: ProtocolCode, message: string = PROTOCOL_CODES[code].when): never { throw new KnowledgeError(message, { code }); }
const pathCheck = (path: string) => {
  try {
    const parts = pathSegments(path);
    if (parts.some(p => p === '.' || p === '..'))
      fail('SPACE_ENTRY_INVALID');
    return pathOf(parts);
  }
  catch {
    return fail('SPACE_ENTRY_INVALID', '目录路径格式不正确');
  }
};
const refOf = (root: string, path: string, entry?: string) => `tree:${root}${path}${entry ? '@' + entry : ''}`;
const emptyCoverage = { complete: true, examined: 0, total: 0 };
export interface SpaceVersion {
  root: string;
  body: SpaceVersionBody;
}
export interface VisibleSpace {
  space: string;
  version: SpaceVersion;
  paths: string[];
}
export interface SpaceEntryView {
  row: SpaceRow;
  body: SpaceEntryBody;
  root: string;
  reference: string;
  cited_count: number | null;
  grounds_withdrawn: string[];
  grounds_withdrawn_hidden_count:number;
}
type LegacySpaceIndex = (mount: SpaceVersionBody['products'][number]) => Promise<{
  version: string;
  rows: Array<Omit<SpaceSearchRow, 'version'> & {
    text: string;
  }>;
} | null>;
export interface SharingCheck {check:ShareCheck;state:StaticTerminal;code:ProtocolCode|null;message:string;fix:string}
const SHARING_CHECKS=ShareCheckSchema.extract(['grounds','quotations','sources','duplicates','credentials']).options;
export class KnowledgeSpaces {
  #ctx: KnowledgeContext;
  #writes=new Map<string,WriteQueue>();
  #legacy: TreeReader;
  #mounts: () => Promise<SpaceVersionBody['products']>;
  #legacyNodes: (query: NodesQuery, by: Principal) => Promise<NodesPage | null>;
  #legacyIndex: LegacySpaceIndex;
  #legacyPaths: (root: string) => Promise<Array<{
    path: string;
    entry: string;
  }>>;
  constructor(ctx: KnowledgeContext, legacy: TreeReader, mounts: () => Promise<SpaceVersionBody['products']> = async () => [], legacyNodes: (query: NodesQuery, by: Principal) => Promise<NodesPage | null> = async () => null, legacyIndex: LegacySpaceIndex = async () => null, legacyPaths: (root: string) => Promise<Array<{
    path: string;
    entry: string;
  }>> = async () => []) { this.#ctx = ctx; this.#legacy = legacy; this.#mounts = mounts; this.#legacyNodes = legacyNodes; this.#legacyIndex = legacyIndex; this.#legacyPaths = legacyPaths; }
  #write<T>(space:string,work:()=>Promise<T>):Promise<T>{
    let queue=this.#writes.get(space);if(!queue){queue=new WriteQueue();this.#writes.set(space,queue);}
    return queue.run(work);
  }
  async #user(by: Principal): Promise<Principal> {
    const user = await this.#ctx.records.principals.get(by.id);
    if (!user || user.disabled)
      return fail('SOURCE_UNAVAILABLE');
    return user;
  }
  async #records<B>(key: string, value: string, kind: RecordKind, tx?: Transaction): Promise<StoredRecord<B>[]> {
    const out: StoredRecord<B>[] = [];
    let cursor: string | null = null;
    do {
      const page: Page<StoredRecord<B>> = await this.#ctx.records.store.find<B>({ key, value, kind, cursor, limit: 500 }, tx);
      out.push(...page.items);
      cursor = page.next;
    } while (cursor);
    return out;
  }
  async current(space: string, tx?: Transaction): Promise<SpaceVersion | null> {
    SpaceId.parse(space);
    const record = (await this.#ctx.records.store.find({ key: VERSION_KEY, value: space, kind: 'knowledge_space_version', newestFirst: true, limit: 1 }, tx)).items[0];
    return record ? { root: record.digest, body: SpaceVersionBody.parse(record.body) } : null;
  }
  async version(root: string): Promise<SpaceVersion | null> {
    const record = await this.#ctx.records.store.get(root);
    return record?.kind === 'knowledge_space_version' ? { root, body: SpaceVersionBody.parse(record.body) } : null;
  }
  async #tree(directories: string[], entries: SpaceRow[], products: SpaceVersionBody['products'],tx?:Transaction): Promise<string> {
    const build = async (path: string): Promise<string> => {
      const mount = products.find(p => p.path === path);
      if (mount)
        return mount.root;
      const segments = pathSegments(path);
      const names = [...new Set(directories.filter(p => withinSpacePath(p, path) && pathSegments(p).length > segments.length).map(p => pathSegments(p)[segments.length]))].sort();
      const children = [];
      for (const name of names)
        children.push({ name, digest: await build(pathOf([...segments, name])) });
      const node = { name: segments.at(-1) ?? '', children, entries: entries.filter(r => r.path === path && active(r)).map(r => r.entry).sort() };
      return (await this.#ctx.records.objects.put(Buffer.from(canonicalize(node)), 'application/json',tx)).sha256;
    };
    return build('/');
  }
  #draft(space:string,previous:SpaceVersion|null,entries:SpaceRow[],directories:string[],by:Principal|null,reason:string,bytes:number,sources=previous?.body.sources??[],products=previous?.body.products??[]):SpaceVersionBody{
    directories=[...directories,...products.map(p=>p.path)];
    directories=[...new Set(['/',...directories,...entries.map(r=>r.path)].flatMap(p=>{const parts=pathSegments(p);return Array.from({length:parts.length+1},(_,n)=>pathOf(parts.slice(0,n)));}))].sort();
    const body=SpaceVersionBody.parse({space,sources,products,parent:previous?.root??null,entries,directories,tree:'0'.repeat(64),by:by?.id??null,at:this.#ctx.now().toISOString(),reason,used_bytes:previous?.body.used_bytes??0});
    const delta=previous===null&&entries.length===0&&directories.length===1?0:Buffer.byteLength(canonicalize(body))+bytes;
    body.used_bytes+=delta;return body;
  }
  async #save(space: string, previous: SpaceVersion | null, entries: SpaceRow[], directories: string[], by: Principal|null, reason: string, bytes: number, tx: Transaction, sources = previous?.body.sources ?? [], products = previous?.body.products ?? []): Promise<SpaceVersion> {
    const body=this.#draft(space,previous,entries,directories,by,reason,bytes,sources,products);
    if(space!=='team'&&body.used_bytes+((await this.#ctx.records.memoryIndex?.usage(space,tx))?.history??0)>await this.capacity(space,tx))fail('SPACE_CAPACITY_EXCEEDED');
    body.tree=await this.#tree(body.directories,entries,products,tx);
    const record=await this.#ctx.records.store.put({kind:'knowledge_space_version',schema:'knowledge-space-version@1',provenance:'projected',body,index:[{key:VERSION_KEY,value:space}]},tx);
    const version={root:record.digest,body};await this.#index(version,tx);return version;
  }
  async ensure(by: Principal, space: string = by.id): Promise<SpaceVersion> {
    by = await this.#user(by);
    SpaceId.parse(space);
    if (space !== 'team' && space !== by.id)
      fail('SOURCE_UNAVAILABLE');
    const current=await this.current(space);const products=space==='team'?await this.#mounts():[];
    if(current&&(space!=='team'||canonicalize(products)===canonicalize(current.body.products)))return current;
    return this.#ctx.records.store.withTransaction(async (tx) => {
      await this.#ctx.records.store.lock('knowledge-space:' + space, tx);
      const previous = await this.current(space, tx);
      if (space === 'team') {
        if (previous && canonicalize(products) === canonicalize(previous.body.products))
          return previous;
        return this.#save(space, previous, previous?.body.entries ?? [], previous?.body.directories.filter(p => !withinSpacePath(p, PRODUCTS_PATH)) ?? ['/'], null, previous ? '登记当前产品目录' : '建立团队知识空间', 0, tx, previous?.body.sources ?? [], products);
      }
      return previous ?? this.#save(space, null, [], ['/'], by, '建立个人知识空间', 0, tx);
    });
  }
  async locks(by: Principal) { return { owner: by.id, team: (await this.ensure(by, 'team')).root, personal: (await this.ensure(by)).root }; }
  async capacity(space: string, tx?: Transaction): Promise<number> {
    const row = (await this.#ctx.records.store.find({ key: QUOTA_KEY, value: space, kind: 'knowledge_space_quota', newestFirst: true, limit: 1 }, tx)).items[0];
    return row ? SpaceQuotaBody.parse(row.body).bytes : DEFAULT_PERSONAL_CAPACITY;
  }
  async setCapacity(by: Principal, space: string, bytes: number): Promise<void> {
    by = await this.#user(by);
    if (by.role !== 'admin' || !(await this.#ctx.records.principals.get(space)))
      fail('SOURCE_UNAVAILABLE');
    const body = SpaceQuotaBody.parse({ space, bytes, by: by.id, at: this.#ctx.now().toISOString() });
    await this.#write(space,() => this.#ctx.records.store.withTransaction(async (tx) => { await this.#ctx.records.store.lock('knowledge-space:' + space, tx); await this.#ctx.records.store.put({ kind: 'knowledge_space_quota', schema: 'knowledge-space-quota@1', provenance: 'declared', body, index: [{ key: QUOTA_KEY, value: space }] }, tx); }));
  }
  async grants(by: Principal): Promise<SpaceGrantBody[]> {
    by = await this.#user(by);
    const records = await this.#records<SpaceGrantBody>(GRANT_KEY, by.id, 'knowledge_space_grant');
    return this.#latestGrants(records);
  }
  #latestGrants(records: StoredRecord<SpaceGrantBody>[]): SpaceGrantBody[] {
    const map = new Map<string, SpaceGrantBody>();
    for (const record of records) {
      const body = SpaceGrantBody.parse(record.body);
      map.set(canonicalize([body.space, body.path, body.audience, body.member]), body);
    }
    return [...map.values()].filter(g => g.action === 'grant');
  }
  async paths(by: Principal, space: string): Promise<string[]> {
    by = await this.#user(by);
    if (space === 'team' || space === by.id)
      return ['/'];
    const owner = await this.#ctx.records.principals.get(space);
    if (!owner || owner.disabled)
      return [];
    const grants = this.#latestGrants(await this.#records<SpaceGrantBody>(GRANT_KEY, space, 'knowledge_space_grant'));
    return grants.filter(g => g.audience === 'member' ? g.member === by.id : by.role === 'admin').map(g => g.path);
  }
  async mayRead(by: Principal, space: string, path = '/'): Promise<boolean> { return (await this.paths(by, space)).some(parent => withinSpacePath(path, parent)); }
  async visible(by: Principal, scope: KnowledgeSearchScope = 'all',onUnavailable?:(space:string,error:unknown)=>void,options:{initialize?:boolean}={}): Promise<VisibleSpace[]> {
    by = await this.#user(by);
    const ids = new Set<string>();
    if (scope === 'personal' || scope === 'all')
      ids.add(by.id);
    if (scope === 'team' || scope === 'all')
      ids.add('team');
    if (scope === 'shared' || scope === 'all') {
      const keys = [by.id, ...(by.role === 'admin' ? ['administrators'] : [])];
      const rows = await this.#ctx.records.store.findMany<SpaceGrantBody>({ key: 'knowledge.space.grantee', values: keys, kind: 'knowledge_space_grant' });
      for (const row of rows)
        if (row.body.space !== by.id)
          ids.add(row.body.space);
    }
    const out: VisibleSpace[] = [];
    for (const space of ids) {
      try{
      const paths = await this.paths(by, space);
      if (!paths.length)
        continue;
      const version = (space === by.id || space === 'team')&&options.initialize!==false ? await this.ensure(by, space) : await this.current(space);
      if (version)
        out.push({ space, version, paths });
      }catch(error){if(!onUnavailable)throw error;onUnavailable(space,error);}
    }
    return out;
  }
  async precheckGrant(by:Principal,path:string){
    by=await this.#user(by);path=pathCheck(path);const version=await this.current(by.id);
    const checks:SharingCheck[]=ShareCheckSchema.extract(['credentials','personal_sources','local_only']).options.map(check=>({check,state:'unchecked',code:null,message:'',fix:''}));let phase=0;
    try{
      if(!version||!version.body.directories.includes(path))fail('SOURCE_UNAVAILABLE');
      for(const row of version.body.entries.filter(row=>withinSpacePath(row.path,path))){const entry=await this.#entry(row);if(!entry)fail('SPACE_ENTRY_INVALID');this.#scan(entry);}
      for(const source of await this.sources(by))if(withinSpacePath(source.path,path)){const original=await this.source(by,source.sha256);if(!original?.bytes)fail('SPACE_CONTENT_UNINSPECTABLE');this.#inspectSource(original.bytes);}
      checks[phase++].state='pass';
      for(const row of version.body.entries.filter(row=>withinSpacePath(row.path,path))){const entry=await this.#entry(row);if(!entry)fail('SPACE_ENTRY_INVALID');for(const ground of entry.grounds)await this.#grantableGround(by,ground.reference);}
      for(const source of await this.sources(by))if(withinSpacePath(source.path,path))await this.#grantableGround(by,'src:'+source.sha256);
      checks[phase++].state='pass';checks[phase].state='pass';
    }catch(error){const code=error instanceof KnowledgeError&&error.code?error.code:'SOURCE_UNAVAILABLE';checks[phase]={...checks[phase],state:error instanceof KnowledgeError&&code!=='SPACE_CONTENT_UNINSPECTABLE'&&code!=='SHARE_GROUND_UNRESOLVED'?'violation':'incomplete',code,message:error instanceof KnowledgeError?error.message:PROTOCOL_CODES[code].when,fix:PROTOCOL_CODES[code].fix};}
    return checks;
  }
  async grant(by: Principal, input: {
    path: string;
    audience: KnowledgeGrantee;
    member?: string | null;
    revoke?: boolean;
  }): Promise<void> {
    by = await this.#user(by);
    const path = pathCheck(input.path);
    const body = SpaceGrantBody.parse({ space: by.id, path, audience: input.audience, member: input.member ?? null, action: input.revoke ? 'revoke' : 'grant', by: by.id, at: this.#ctx.now().toISOString() });
    if (body.member && !(await this.#ctx.records.principals.get(body.member)))
      fail('SOURCE_UNAVAILABLE');
    await this.#write(by.id,() => this.#ctx.records.store.withTransaction(async (tx) => {
      await this.#ctx.records.store.lock('knowledge-space:' + by.id, tx);
      const version = await this.current(by.id, tx);
      if (!input.revoke) {
        if (!version || !version.body.directories.includes(path))
          fail('SOURCE_UNAVAILABLE');
        for (const row of version.body.entries.filter(r => withinSpacePath(r.path, path))) {
          const entry = await this.#entry(row);
          if (!entry)
            fail('SPACE_ENTRY_INVALID');
          this.#scan(entry);
          for (const ground of entry.grounds)
            await this.#grantableGround(by, ground.reference);
        }
        for (const source of await this.sources(by))
          if (withinSpacePath(source.path, path))
            await this.#grantableGround(by, 'src:' + source.sha256);
      }
      await this.#ctx.records.store.put({ kind: 'knowledge_space_grant', schema: 'knowledge-space-grant@1', provenance: 'declared', body, index: [{ key: GRANT_KEY, value: by.id }, { key: 'knowledge.space.grantee', value: body.member ?? 'administrators' }] }, tx);
    }));
  }
  #scan(value: unknown) {
    const inspect = (text: string) => {
      const scan = scanForCredentials(Buffer.from(text));
      if (scan.findings.length || !scan.inspected)
        fail('SPACE_CREDENTIALS_DETECTED');
    };
    inspect(canonicalize(value));
    const visit = (v: unknown, depth = 0): void => {
      if (depth > 64)
        fail('SPACE_ENTRY_INVALID');
      if (typeof v === 'string')
        inspect(v);
      else if (Array.isArray(v))
        for (const item of v)
          visit(item, depth + 1);
      else if (v && typeof v === 'object')
        for (const item of Object.values(v))
          visit(item, depth + 1);
    };
    visit(value);
  }
  #inspectSource(bytes:Uint8Array){const scan=scanForCredentials(bytes);if(scan.findings.length)fail('SPACE_CREDENTIALS_DETECTED');if(!scan.inspected||scan.truncated)fail('SPACE_CONTENT_UNINSPECTABLE');}
  async #grantableGround(by: Principal, reference: string, seen = new Set<string>()): Promise<void> {
    if (seen.has(reference))
      fail('SPACE_ENTRY_INVALID');
    seen.add(reference);
    const ref = parseReference(reference);
    if (ref.scheme === 'src') {
      const artifact = await this.#ctx.records.artifacts.readable(by, ref.sha256);
      if(artifact&&!artifact.body.scan.inspected)fail('SPACE_CONTENT_UNINSPECTABLE');
      if (!artifact || artifact.body.read_tier !== 'model_readable' || ('read' in artifact.body.origin && !artifact.body.visibility.admins))
        fail('SPACE_ENTRY_INVALID', '个人凭据读取的来源不可授权');
      const source = await this.#ctx.records.artifacts.source(by, ref.sha256);
      if (!source?.bytes)
        fail('SPACE_ENTRY_INVALID');
      this.#inspectSource(source.bytes);
    }
    else if (ref.scheme === 'tree') {
      const version = await this.version(ref.root);
      if (version) {
        const rows = version.body.entries.filter(r => r.path === ref.path && (!ref.entry || ref.entry === r.entry));
        for (const row of rows) {
          const entry = await this.#entry(row);
          if (!entry)
            fail('SPACE_ENTRY_INVALID');
          for (const ground of entry.grounds)
            await this.#grantableGround(by, ground.reference, new Set(seen));
        }
      }
    }
    else
      fail('SPACE_ENTRY_INVALID', '授权的依据须为来源或知识树引用');
  }
  async write(by: Principal, raw: unknown, session: string | null = null, space = by.id): Promise<{
    space: string;
    root: string;
    entry: string;
    reference: string;
    status: SpaceEntryBody['status'];
  }> {
    by = await this.#user(by);
    const input = SpaceEntryInput.parse(raw);
    input.path = pathCheck(input.path);
    if (space !== by.id && (space !== 'team' || by.role !== 'admin'))
      fail('SOURCE_UNAVAILABLE');
    if (space === 'team' && !input.grounds.length)
      fail('SPACE_ENTRY_INVALID', '团队知识导入须有可核验的依据');
    if (space === 'team' && withinSpacePath(input.path, PRODUCTS_PATH))
      fail('SPACE_ENTRY_INVALID', '产品目录由产品知识来源维护');
    const content = { kind: input.kind, statement: normaliseStatement(input.statement), data: input.data, applicability: input.applicability };
    if (!content.statement || Buffer.byteLength(canonicalize(content)) > this.#ctx.limits.maxDataBytes)
      fail('SPACE_ENTRY_INVALID');
    this.#scan(input);
    const teamSources: Array<{
      sha256: string;
      artifact: string;
      size: number;
    }> = [];
    for (const ground of input.grounds) {
      if (space === 'team') {
        const ref = parseReference(ground.reference);
        if (ref.scheme !== 'src')
          fail('SPACE_ENTRY_INVALID', '团队导入须引用业务系统的团队读取原文');
        const artifact = await this.#ctx.records.artifacts.readable(by, ref.sha256);
        if (!artifact || !(('read' in artifact.body.origin&&artifact.body.visibility.admins)||await this.#ctx.records.artifacts.mayDeclareUpload(by,artifact.digest)))
          fail('SPACE_ENTRY_INVALID', '团队导入须引用团队读取原文，或管理员本人声明的普通上传；个人空间原文须先共享或授权');
        teamSources.push({ sha256: ref.sha256, artifact: artifact.digest, size: artifact.body.size });
      }
      const result = await resolveReference(ground.reference, { reader: { user: by.id, role: by.role },teamParsersOnly:space==='team', parsers: this.#ctx.parsers, trees: this.treeReader(), sources: { read: hash => this.source(by, hash) } });
      if(!result.resolved&&result.code==='TEAM_PARSER_REQUIRED')fail(result.code);
      if (verifyQuote(result, ground.quotation) !== true)
        fail('SPACE_ENTRY_INVALID', '依据不可读或引文与来源不一致');
    }
    return this.#write(space,() => this.#ctx.records.store.withTransaction(async (tx) => {
      await this.#ctx.records.store.lock('knowledge-space:' + space, tx);
      const previous = await this.current(space, tx);
      const grants = space === 'team' ? [] : this.#latestGrants(await this.#records<SpaceGrantBody>(GRANT_KEY, by.id, 'knowledge_space_grant', tx));
      if (grants.some(g => withinSpacePath(input.path, g.path)))
        for (const ground of input.grounds)
          await this.#grantableGround(by, ground.reference);
      if (input.expected_version !== undefined && input.expected_version !== (previous?.root ?? null))
        fail('SPACE_VERSION_CONFLICT');
      const rows = previous?.body.entries.map(r => ({ ...r })) ?? [];
      if (input.replaces) {
        const row = rows.find(r => r.entry === input.replaces && active(r));
        if (!row)
          fail('SPACE_ENTRY_INVALID', '被取代的条目不在当前个人空间');
        row.status = 'superseded';
      }
      const entry = sha256Hex(canonicalize(content));
      if (rows.some(r => r.entry === entry))
        fail('SPACE_ENTRY_INVALID', '该空间已包含相同条目');
      const body = SpaceEntryBody.parse({ space, entry, content, grounds: input.grounds, status: input.grounds.length ? 'verified' : 'unverified', by: by.id, at: this.#ctx.now().toISOString(), session, replaces: input.replaces ?? null });
      const record = await this.#ctx.records.store.put({ kind: 'knowledge_space_entry', schema: 'knowledge-space-entry@1', provenance: 'declared', body, index: [{ key: 'knowledge.space.entry', value: entry }, { key: 'knowledge.space.entry_owner', value: space }] }, tx);
      rows.push({ path: input.path, entry, record: record.digest, status: body.status });
      const sources = [...previous?.body.sources ?? []];
      for (const source of teamSources) {
        const sourceBody = SpaceSourceBody.parse({ ...source, space: 'team', path: input.path, by: by.id, at: body.at });
        const stored = await this.#ctx.records.store.put({ kind: 'knowledge_space_source', schema: 'knowledge-space-source@1', provenance: 'declared', body: sourceBody, index: [{ key: SOURCE_KEY, value: 'team' }, { key: 'knowledge.space.source_hash', value: source.sha256 }] }, tx);
        sources.push(stored.digest);
      }
      const version = await this.#save(space, previous, rows, previous?.body.directories ?? ['/'], by, input.reason, Buffer.byteLength(canonicalize(body)), tx, sources);
      return { space, root: version.root, entry, reference: refOf(version.root, input.path, entry), status: body.status };
    }));
  }
  async directory(by: Principal, path: string, space = by.id): Promise<SpaceVersion> {
    by = await this.#user(by);
    path = pathCheck(path);
    this.#scan(path);
    if (space === 'team' && withinSpacePath(path, PRODUCTS_PATH))
      fail('SPACE_ENTRY_INVALID', '产品目录由产品知识来源维护');
    if (space !== by.id && (space !== 'team' || by.role !== 'admin'))
      fail('SOURCE_UNAVAILABLE');
    return this.#write(space,() => this.#ctx.records.store.withTransaction(async (tx) => {
      await this.#ctx.records.store.lock('knowledge-space:' + space, tx);
      const previous = await this.current(space, tx);
      if (previous?.body.directories.includes(path))
        return previous;
      return this.#save(space, previous, previous?.body.entries ?? [], [...previous?.body.directories ?? [], path], by, '建立知识目录', 0, tx);
    }));
  }
  async withdraw(by: Principal, entry: string, space = by.id): Promise<void> {
    by = await this.#user(by);
    if (space !== by.id && space !== 'team') fail('SOURCE_UNAVAILABLE');
    await this.#write(space,() => this.#ctx.records.store.withTransaction(async (tx) => {
      await this.#ctx.records.store.lock('knowledge-space:' + space, tx);
      const previous = await this.current(space, tx);
      if (!previous)
        fail('SOURCE_UNAVAILABLE');
      const rows = previous.body.entries.map(r => ({ ...r }));
      const row = rows.find(r => r.entry === entry && active(r));
      if (!row)
        fail('SOURCE_UNAVAILABLE');
      if(space==='team'&&by.role!=='admin'){const body=await this.#entry(row,tx);if(!body?.shared_from||body.by!==by.id)fail('SOURCE_UNAVAILABLE');}
      row.status = 'withdrawn';
      await this.#save(space, previous, rows, previous.body.directories, by, space === 'team' ? '撤回团队条目' : '撤回个人条目', 0, tx);
    }));
  }
  async #entry(row: SpaceRow, tx?: Transaction): Promise<SpaceEntryBody | null> {
    const record = await this.#ctx.records.store.get(row.record, tx);
    if (record?.kind !== 'knowledge_space_entry')
      return null;
    const body = SpaceEntryBody.parse(record.body);
    return body.entry === row.entry && sha256Hex(canonicalize(body.content)) === row.entry ? body : null;
  }
  async entry(by: Principal, root: string, path: string, digest: string): Promise<SpaceEntryView | null> {
    const version = await this.version(root);
    if (!version || !(await this.mayRead(by, version.body.space, path)))
      return null;
    const row = version.body.entries.find(r => r.path === path && r.entry === digest);
    if (!row)
      return null;
    const body = await this.#entry(row);
    if (!body || body.space !== version.body.space)
      return null;
    const current = await this.current(version.body.space);
    const state = current?.body.entries.find(r => r.entry === digest)?.status ?? row.status;
    return { row: { ...row, status: state }, body, root, reference: refOf(root, path, digest),...await this.withdrawalState(body.grounds.map(g=>g.reference),by), cited_count: version.body.space === 'team' || by.id === version.body.space ? await this.#citations(version.body.space, digest) : null };
  }
  /** Follow immutable grounds while checking the current withdrawal projection; no historic body is changed. */
  async #withdrawnGrounds(references: readonly string[], visiting=new Set<string>(),depth=0):Promise<string[]> {
    if(depth>64)fail('SPACE_ENTRY_INVALID','依据链超过可核对的深度上限');
    const withdrawn=new Set<string>();
    for(const reference of references){
      let ref;try{ref=parseReference(reference);}catch{continue;}
      if(ref.scheme!=='tree'||!ref.entry)continue;
      if(visiting.has(reference))fail('SPACE_ENTRY_INVALID','依据链存在循环，核对未完成');
      const version=await this.version(ref.root);if(!version)continue;
      const row=version.body.entries.find(row=>row.entry===ref.entry&&row.path===ref.path);if(!row)continue;
      const current=await this.current(version.body.space),state=current?.body.entries.find(row=>row.entry===ref.entry)?.status??row.status;
      if(state==='withdrawn')withdrawn.add(reference);
      const entry=await this.#entry(row);if(entry){const next=new Set(visiting);next.add(reference);for(const ground of await this.#withdrawnGrounds(entry.grounds.map(g=>g.reference),next,depth+1))withdrawn.add(ground);}
    }
    return [...withdrawn];
  }
  async hasWithdrawnGrounds(references:readonly string[]):Promise<boolean>{return (await this.#withdrawnGrounds(references)).length>0;}
  async withdrawnGrounds(references:readonly string[],by:Principal):Promise<string[]>{return (await this.withdrawalState(references,by)).grounds_withdrawn;}
  async withdrawalState(references:readonly string[],by:Principal):Promise<{grounds_withdrawn:string[];grounds_withdrawn_hidden_count:number}>{
    by=await this.#user(by);const all=await this.#withdrawnGrounds(references),visible:string[]=[];
    for(const reference of all){const ref=parseReference(reference);if(ref.scheme!=='tree')continue;const version=await this.version(ref.root);if(version&&await this.mayRead(by,version.body.space,ref.path))visible.push(reference);}
    return {grounds_withdrawn:visible,grounds_withdrawn_hidden_count:all.length-visible.length};
  }
  async shareHistory(by:Principal,cursor:string|null=null){
    by=await this.#user(by);
    const page=await this.#ctx.records.store.find({kind:'knowledge_share',key:'knowledge.share.by',value:by.id,newestFirst:true,limit:50,cursor});
    return {items:page.items.map(record=>({record:record.digest,...KnowledgeShareBody.parse(record.body)})),next:page.next};
  }
  async #shareSource(by:Principal,reference:string,sources:Map<string,{sha256:string;artifact:string;size:number}>,seen=new Set<string>(),depth=0,quotation?:string):Promise<void>{
    if(depth>64||seen.has(reference))fail('SHARE_GROUND_UNRESOLVED');
    seen=new Set(seen);seen.add(reference);const ref=parseReference(reference);
    if(quotation!==undefined){
      const resolved=await resolveReference(reference,{reader:{user:by.id,role:by.role},teamParsersOnly:true,parsers:this.#ctx.parsers,trees:this.treeReader(),sources:{read:hash=>this.source(by,hash)}});
      if(!resolved.resolved&&resolved.code==='TEAM_PARSER_REQUIRED')fail(resolved.code);
      if(verifyQuote(resolved,quotation)!==true)fail('SHARE_QUOTE_MISMATCH');
    }
    if(ref.scheme==='src'){
      const artifact=(await this.source(by,ref.sha256))?.artifact;
      if(!artifact)fail('SHARE_GROUND_UNRESOLVED');
      if('upload' in artifact.body.origin)fail('SHARE_UPLOAD_UNSIGNED');
      if('read' in artifact.body.origin&&!artifact.body.visibility.admins)fail('SHARE_PERSONAL_SOURCE');
      if(!('read' in artifact.body.origin)||artifact.provenance!=='observed')fail('SHARE_GROUND_UNRESOLVED');
      sources.set(ref.sha256,{sha256:ref.sha256,artifact:artifact.digest,size:artifact.body.size});
      return;
    }
    if(ref.scheme!=='tree'||!ref.entry)fail('SHARE_GROUND_UNRESOLVED');
    const version=await this.version(ref.root);
    if(version){const row=version.body.entries.find(row=>row.entry===ref.entry&&row.path===ref.path);const body=row?await this.#entry(row):null;if(!body||!body.grounds.length)fail('SHARE_GROUND_UNRESOLVED');for(const ground of body.grounds)await this.#shareSource(by,ground.reference,sources,seen,depth+1,ground.quotation);}
    else{const read=await this.#legacy.read(ref.root,ref.path,ref.entry,{user:by.id,role:by.role});if(!read?.grounds?.length)fail('SHARE_GROUND_UNRESOLVED');for(const ground of read.grounds)await this.#shareSource(by,ground,sources,seen,depth+1);}
  }
  async #inspectSharing(by:Principal,input:z.infer<typeof KnowledgeShareInput>,view:SpaceEntryView,personal:SpaceVersion|null,previous:SpaceVersion|null,teamPath:string,tx?:Transaction){
      const row=personal?.body.entries.find(row=>row.entry===input.entry&&row.path===input.path);
      const checks:SharingCheck[]=SHARING_CHECKS.map(check=>({check,state:'unchecked',code:null,message:'',fix:''}));let phase=0;
      const sources=new Map<string,{sha256:string;artifact:string;size:number}>(),grounds:SpaceEntryBody['grounds']=[];
      let replacement:SpaceRow|undefined;
      try{
        if(!row||row.status!=='verified'||!view.body.grounds.length)fail('SHARE_UNVERIFIED');
        if(await this.hasWithdrawnGrounds(view.body.grounds.map(g=>g.reference)))fail('GROUNDS_WITHDRAWN');
        const resolved=[];
        for(const ground of view.body.grounds){
          const result=await resolveReference(ground.reference,{reader:{user:by.id,role:by.role},teamParsersOnly:true,parsers:this.#ctx.parsers,trees:this.treeReader(),sources:{read:hash=>this.source(by,hash)}});
          if(!result.resolved&&result.code==='TEAM_PARSER_REQUIRED')fail(result.code);
          if(!result.resolved||!result.readable)fail('SHARE_GROUND_UNRESOLVED');resolved.push(result);
        }
        checks[phase++].state='pass';
        for(const [index,ground] of view.body.grounds.entries())if(verifyQuote(resolved[index],ground.quotation)!==true)fail('SHARE_QUOTE_MISMATCH');
        checks[phase++].state='pass';
        for(const ground of view.body.grounds){
          await this.#shareSource(by,ground.reference,sources);
          let reference=ground.reference;const ref=parseReference(reference);
          if(ref.scheme==='tree'){
            const version=await this.version(ref.root);
            if(version&&version.body.space!=='team'){
              const team=(previous?.body.entries??[]).find(row=>row.entry===ref.entry&&active(row));
              if(!team)fail('SHARE_GROUND_UNREADABLE');reference=refOf(previous!.root,team.path,team.entry);
            }else{
              for(const reader of (await this.#ctx.records.principals.list?.()??fail('SHARE_GROUND_UNREADABLE')).filter(user=>!user.disabled)){
                const read=await this.treeReader().read(ref.root,ref.path,ref.entry??null,{user:reader.id,role:reader.role});if(!read||read.readTier!=='model_readable')fail('SHARE_GROUND_UNREADABLE');
              }
            }
          }
          grounds.push({...ground,reference});
        }
        if(withinSpacePath(teamPath,PRODUCTS_PATH))fail('SHARE_GROUND_UNREADABLE','产品目录由产品知识来源维护；请选择普通团队目录');
        checks[phase++].state='pass';
        // Follow only the submitter's personal revision chain; another submitter's team content is never replaced.
        const personalEntries=new Map(personal?.body.entries.map(row=>[row.entry,row]));
        const ancestors=new Set<string>();let predecessor=view.body.replaces;
        while(predecessor){
          if(ancestors.has(predecessor)||ancestors.size>=64)fail('SHARE_UNVERIFIED');
          ancestors.add(predecessor);
          const earlier=personalEntries.get(predecessor),body=earlier?await this.#entry(earlier,tx):null;
          if(!body||body.space!==by.id||body.by!==by.id)fail('SHARE_UNVERIFIED');
          predecessor=body.replaces;
        }
        const teamEntries=new Map((previous?.body.entries??[]).map(row=>[row.entry,row]));
        for(const ancestor of ancestors){
          const candidate=teamEntries.get(ancestor),body=candidate?await this.#entry(candidate,tx):null;
          if(body?.by===by.id&&body.shared_from?.space===by.id&&body.shared_from.entry===ancestor){replacement=candidate;break;}
        }
        if((previous?.body.entries??[]).some(row=>row.entry===input.entry&&row.record!==replacement?.record))fail('SHARE_DUPLICATE');
        const readable=await this.#ctx.packs.readableProducts(by);
        for(const mount of (previous?.body.products??[]).filter(mount=>readable.has(mount.product)))if((await this.#legacyPaths(mount.root)).some(row=>row.entry===input.entry))fail('SHARE_DUPLICATE');
        checks[phase++].state='pass';
        try{this.#scan(teamPath);this.#scan(view.body);for(const source of sources.values()){const bytes=await this.#ctx.records.artifacts.source(by,source.sha256,{record:source.artifact,consumer:'model'});if(!bytes?.bytes)fail('SHARE_GROUND_UNRESOLVED');this.#inspectSource(bytes.bytes);}}catch(error){if(error instanceof KnowledgeError&&error.code==='SPACE_CREDENTIALS_DETECTED')fail('SHARE_CREDENTIALS');throw error;}
        checks[phase].state='pass';
      }catch(error){
        const code=error instanceof KnowledgeError&&error.code?error.code:'SOURCE_UNAVAILABLE';
        checks[phase]={...checks[phase],state:error instanceof KnowledgeError&&code!=='SPACE_CONTENT_UNINSPECTABLE'&&code!=='SHARE_GROUND_UNRESOLVED'?'violation':'incomplete',code,message:error instanceof KnowledgeError?error.message:PROTOCOL_CODES.SOURCE_UNAVAILABLE.when,fix:PROTOCOL_CODES[code].fix};
        return {sources,grounds,replacement,checks,error};
      }
      return {sources,grounds,replacement,checks,error:null};
  }
  async precheckShare(by:Principal,raw:unknown){
    by=await this.#user(by);const input=KnowledgeShareInput.parse(raw),teamPath=pathCheck(input.team_path??input.path);
    const origin=await this.version(input.root);if(!origin||origin.body.space!==by.id)fail('SOURCE_UNAVAILABLE');
    const view=await this.entry(by,input.root,input.path,input.entry);if(!view)fail('SOURCE_UNAVAILABLE');
    const previous=await this.current('team');
    const prepared=await this.#inspectSharing(by,input,view,await this.current(by.id),previous,teamPath);
    const duplicate=prepared.checks.find(c=>c.code==='SHARE_DUPLICATE')&&previous?.body.entries.find(row=>row.entry===input.entry);
    let safeTargetPath=true;
    try{this.#scan(teamPath);}catch(error){if(error instanceof KnowledgeError&&error.code==='SPACE_CREDENTIALS_DETECTED')safeTargetPath=false;else throw error;}
    return {ok:prepared.error===null,checks:prepared.checks,duplicate:duplicate&&previous?refOf(previous.root,duplicate.path,duplicate.entry):null,...(safeTargetPath?{target_path:teamPath}:{})};
  }
  async share(by:Principal,raw:unknown,session:string|null=null):Promise<KnowledgeShareReceipt>{
    by=await this.#user(by);const input=KnowledgeShareInput.parse(raw),teamPath=pathCheck(input.team_path??input.path);
    let safeTargetPath=true;
    try{this.#scan(teamPath);}catch(error){if(error instanceof KnowledgeError&&error.code==='SPACE_CREDENTIALS_DETECTED')safeTargetPath=false;else throw error;}
    const origin=await this.version(input.root);if(!origin||origin.body.space!==by.id)fail('SOURCE_UNAVAILABLE');
    const view=await this.entry(by,input.root,input.path,input.entry);if(!view)fail('SOURCE_UNAVAILABLE');
    await this.ensure(by,'team');
    return this.#write('team',()=>this.#ctx.records.store.withTransaction(async tx=>{
      await this.#ctx.records.store.lock('knowledge-space:'+by.id,tx);await this.#ctx.records.store.lock('knowledge-space:team',tx);
      const previous=await this.current('team',tx);if(!previous)fail('SHARE_GROUND_UNRESOLVED');
      const personal=await this.current(by.id,tx),row=personal?.body.entries.find(row=>row.entry===input.entry&&row.path===input.path);
      const source={space:by.id,root:input.root,path:input.path,entry:input.entry},at=this.#ctx.now().toISOString();
      const receipt=async(status:KnowledgeShareBody['status'],code:ProtocolCode|null,message:string,team:SpaceVersion|null):Promise<KnowledgeShareReceipt>=>{
        const body=KnowledgeShareBody.parse({source,by:by.id,at,session,status,code,message,...(safeTargetPath?{target_path:teamPath}:{}),team_root:team?.root??null,reference:team?refOf(team.root,teamPath,input.entry):null});
        const record=await this.#ctx.records.store.put({kind:'knowledge_share',schema:'knowledge-share@1',provenance:'declared',body,index:[{key:'knowledge.share.by',value:by.id},{key:'knowledge.share.entry',value:by.id+'/'+input.entry}]},tx);
        return {record:record.digest,...body};
      };
      const {sources,grounds,replacement,error}=await this.#inspectSharing(by,input,view,personal,previous,teamPath,tx);
      if(error){if(error instanceof KnowledgeError&&error.code&&(error.code.startsWith('SHARE_')||error.code==='GROUNDS_WITHDRAWN'||error.code==='SPACE_CONTENT_UNINSPECTABLE'||error.code==='TEAM_PARSER_REQUIRED'))return receipt('rejected',error.code,error.message,null);throw error;}
      if(withinSpacePath(teamPath,PRODUCTS_PATH))return receipt('rejected','SHARE_GROUND_UNREADABLE','产品目录由产品知识来源维护；请选择普通团队目录',null);
      const body=SpaceEntryBody.parse({...view.body,space:'team',grounds,by:by.id,at,session,replaces:replacement?.entry??null,shared_from:source});
      const record=await this.#ctx.records.store.put({kind:'knowledge_space_entry',schema:'knowledge-space-entry@1',provenance:'declared',body,index:[{key:'knowledge.space.entry',value:body.entry},{key:'knowledge.space.entry_owner',value:'team'}]},tx);
      const sourceRecords=[...previous.body.sources];
      for(const source of sources.values()){
        const stored=await this.#ctx.records.store.put({kind:'knowledge_space_source',schema:'knowledge-space-source@1',provenance:'declared',body:SpaceSourceBody.parse({...source,space:'team',path:teamPath,by:by.id,at}),index:[{key:SOURCE_KEY,value:'team'},{key:'knowledge.space.source_hash',value:source.sha256}]},tx);sourceRecords.push(stored.digest);
      }
      const rows=previous.body.entries.map(row=>row.record===replacement?.record&&active(row)?{...row,status:KnowledgeEntryStatusSchema.enum.superseded}:row);
      const team=await this.#save('team',previous,[...rows,{path:teamPath,entry:input.entry,record:record.digest,status:'verified'}],previous.body.directories,by,'提交共享',Buffer.byteLength(canonicalize(body)),tx,sourceRecords);
      return receipt('merged',null,'',team);
    }));
  }
  async #citations(space: string, entry: string): Promise<number | null> {
    if (!this.#ctx.records.store.countIndexed) return null;
    const personal = space !== 'team';
    const result = await this.#ctx.records.store.countIndexed({
      kind:'submission',since:'0001-01-01T00:00:00.000Z',cap:10000,
      index:[{key:personal?'runs.submission.cites.personal_entry':'runs.submission.cites.entry',value:personal?sha256Hex(space+'\0'+entry):entry}],
    });
    return result.capped ? null : result.count;
  }
  async runAllows(by: Principal, root: string, path: string, runId?: string): Promise<boolean> {
    if (!runId)
      return true;
    const version = await this.version(root);
    if (!version)
      return true;
    const record = (await this.#ctx.records.store.find<any>({ key: 'runs.id', value: runId, kind: 'run', limit: 1 })).items[0];
    const locked = record?.body.knowledge_spaces;
    const initiator = record?.body.runner ?? record?.body.configurer;
    if (!locked || typeof initiator !== 'string' || locked.owner !== initiator)
      return false;
    const owner = await this.#ctx.records.principals.get(initiator);
    if (!owner || owner.disabled)
      return false;
    const mount = version.body.products.find(p => withinSpacePath(path, p.path));
    if (mount && !(await this.#ctx.packs.readableProducts(owner)).has(mount.product))
      return false;
    if (version.body.space === 'team' && locked.team !== root || version.body.space === initiator && locked.personal !== root)
      return false;
    return await this.mayRead(owner, version.body.space, path) && await this.mayRead(by, version.body.space, path);
  }
  async history(by: Principal, space: string, cursor: string | null = null) {
    by=await this.#user(by);
    if (space!=='team'&&space!==by.id)
      return { items: [], next: null };
    const page = await this.#ctx.records.store.find({ key: VERSION_KEY, value: space, kind: 'knowledge_space_version', newestFirst: true, limit: 50, cursor });
    return { items: page.items.map(r => { const body = SpaceVersionBody.parse(r.body); return { root: r.digest, body: { space, parent: body.parent, by: body.by, at: body.at, reason: body.reason } }; }), next: page.next };
  }
  async diff(by: Principal, from: string, to: string) {
    const a = await this.version(from), b = await this.version(to);
    if (!a || !b || a.body.space !== b.body.space || !(await this.paths(by, a.body.space)).length)
      return null;
    const paths = await this.paths(by, a.body.space);
    const readable = await this.#ctx.packs.readableProducts(by);
    const map = async (v: SpaceVersion) => {
      const rows = v.body.entries.filter(row => active(row) && paths.some(prefix => withinSpacePath(row.path, prefix)));
      for (const mount of v.body.products.filter(m => readable.has(m.product))) {
        for (const row of await this.#legacyPaths(mount.root))
          rows.push({ ...row, path: mount.path + (row.path === '/' ? '' : row.path), status: 'verified', record: '' });
      }
      const grouped = new Map<string, string[]>();
      for (const row of rows)
        grouped.set(row.path, [...grouped.get(row.path) ?? [], row.entry]);
      return new Map([...grouped].map(([path, entries]) => [path, entries.sort().join(',')]));
    };
    const left = await map(a), right = await map(b);
    return { from, to, added: [...right.keys()].filter(p => !left.has(p)), removed: [...left.keys()].filter(p => !right.has(p)), modified: [...right.keys()].filter(p => left.has(p) && left.get(p) !== right.get(p)) };
  }
  async #index(version: SpaceVersion, tx?: Transaction) {
    const index=this.#ctx.records.spaceIndex;if(!index||await index.ready(version.root,'/',tx))return;
    const entries=version.body.entries.filter(active),missing=await index.missing(entries.map(row=>row.record),tx);
    const rows=[];
    for(const row of entries){const metadata={space:version.body.space,path:row.path,entry:row.entry,record:row.record};
      if(!missing.has(row.record)){rows.push(metadata);continue;}
      const body=await this.#entry(row,tx);if(body)rows.push({...metadata,text:canonicalize([body.content.statement,body.content.data,body.grounds.map(g=>g.quotation)])});
    }
    try{await index.add(version.root,rows,tx);await index.complete(version.root,'/',tx);}
    catch(error){if(error instanceof RecordsError&&error.code==='SPACE_INDEX_LIMIT')throw new KnowledgeError(error.message,{code:error.code,fix:error.fix??undefined,detail:error.detail});throw error;}
  }
  async search(by: Principal, text: string, scope: KnowledgeSearchScope = 'all', cursor: string | null = null, limit = 30) {
    if (!text.trim() || text.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 100)
      fail('SPACE_ENTRY_INVALID');
    const warnings:ProtocolError[]=[];
    const unavailable=(space:string|null,error:unknown,path='/')=>{
      const limited=(error instanceof RecordsError||error instanceof KnowledgeError)&&error.code==='SPACE_INDEX_LIMIT';
      const code=limited?'SPACE_INDEX_LIMIT':'SOURCE_UNAVAILABLE';
      const label=space===null?'当前可读':space==='team'?labelOf('knowledge_space_kind','team'):labelOf('knowledge_space_kind','personal')+(space===by.id?'':' '+space);
      warnings.push({code,path,message:`${label}知识索引：${limited?error.message:'当前索引未完成或暂不可用'}；未检索该范围`,fix:limited&&error.fix?error.fix:'稍后从第一页重试；仍不可用时请管理员核对索引'});
    };
    const visible=await this.visible(by,scope,(space,error)=>unavailable(space,error));
    const spaces:VisibleSpace[]=[];
    for(const space of visible)try{
      if(!this.#ctx.records.spaceIndex)throw new KnowledgeError('知识搜索索引暂不可用');
      await this.#index(space.version);
      if(!await this.#ctx.records.spaceIndex.ready(space.version.root,'/'))throw new KnowledgeError('知识搜索索引尚未完成');
      spaces.push(space);
    }catch(error){unavailable(space.space,error);}
    const products: Array<{
      version: string;
      path: string;
      team: string;
    }> = [];
    for (const space of visible.filter(s => s.space === 'team')) {
      const readable = await this.#ctx.packs.readableProducts(by);
      for (const mount of space.version.body.products.filter(m => readable.has(m.product))) {
        try{
        const indexed = await this.#legacyIndex(mount);
        if (!indexed)
          throw new KnowledgeError('产品知识索引暂不可用');
        if (!await this.#ctx.records.spaceIndex?.ready(indexed.version, mount.path)) {
          await this.#ctx.records.spaceIndex?.add(indexed.version, indexed.rows,undefined,'product:'+mount.path);
          await this.#ctx.records.spaceIndex?.complete(indexed.version, mount.path);
        }
        if(!await this.#ctx.records.spaceIndex?.ready(indexed.version,mount.path))throw new KnowledgeError('产品知识索引尚未完成');
        products.push({ version: indexed.version, path: mount.path, team: space.version.root });
        }catch(error){unavailable('team',error,mount.path);}
      }
    }
    const binding = sha256Hex(canonicalize([by.id, text, scope, spaces.map(s => [s.version.root, s.paths]), products, limit]));
    const offset = this.#cursor(cursor, binding);
    let rows:SpaceSearchRow[]=[];
    try{rows=await this.#ctx.records.spaceIndex?.search(text, [...spaces.map(s => ({ version: s.version.root, paths: s.paths })), ...products.map(p => ({ version: p.version, paths: [p.path] }))], offset, limit + 1)??[];}
    catch(error){unavailable(null,error);}
    const matches = [];
    let consumed = 0, size = 0;
    for (const row of rows.slice(0, limit)) {
      const entry = await this.entry(by, row.version, row.path, row.entry);
      let hit;
      if (entry)
        hit = { space: row.space, root: row.version, path: row.path, entry: row.entry, reference: entry.reference, status: entry.row.status, statement: entry.body.content.statement, kind: entry.body.content.kind };
      else {
        const product = products.find(p => p.version === row.version && withinSpacePath(row.path, p.path));
        if (product) {
          const record = await this.#ctx.records.store.get(row.record);
          if (record) {
            const content = KnowledgeEntryBody.parse(record.body);
            hit = { space: 'team', root: product.team, path: row.path, entry: row.entry, reference: refOf(product.team, row.path, row.entry), status: 'verified' as const, statement: content.statement, kind: content.kind };
          }
        }
      }
      if (hit) {
        const bytes = Buffer.byteLength(canonicalize(hit));
        if (size + bytes > this.#ctx.limits.pageBytes) {
          if (!matches.length)
            fail('SPACE_ENTRY_INVALID', '搜索条目超出单页大小上限，请按引用读取');
          break;
        }
        matches.push(hit);
        size += bytes;
      }
      consumed++;
    }
    return { matches, next: rows.length > consumed ? this.#next(binding, offset + consumed) : null,...(warnings.length?{warnings:warnings.slice(0,99).concat(warnings.length>99?[{code:'SOURCE_UNAVAILABLE',message:`另有 ${warnings.length-99} 个索引范围未检索`,fix:'稍后从第一页重试；仍不可用时请管理员核对索引'}]:[])}:{}) };
  }
  #cursor(cursor: string | null | undefined, binding: string): number {
    if (!cursor)
      return 0;
    try {
      if (cursor.length > 1024)
        throw new Error();
      const value = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      if (value.binding === binding && Number.isSafeInteger(value.offset) && value.offset >= 0)
        return value.offset;
    }
    catch { }
    return fail('SPACE_ENTRY_INVALID', '分页游标与当前空间、授权或查询不一致');
  }
  #next(binding: string, offset: number) { return Buffer.from(JSON.stringify({ binding, offset })).toString('base64url'); }
  async #node(version: SpaceVersion, path: string) {
    let digest = version.body.tree;
    let bytes = await this.#ctx.records.objects.get(digest);
    if (!bytes)
      throw new KnowledgeError('知识目录原件暂不可读');
    let node = SpaceTreeNode.parse(JSON.parse(new TextDecoder().decode(bytes)));
    for (const name of pathSegments(path)) {
      const child = node.children.find(c => c.name === name);
      if (!child)
        return null;
      digest = child.digest;
      bytes = await this.#ctx.records.objects.get(digest);
      if (!bytes)
        throw new KnowledgeError('知识目录原件暂不可读');
      node = SpaceTreeNode.parse(JSON.parse(new TextDecoder().decode(bytes)));
    }
    let height = Math.max(0, ...version.body.directories.filter(p => withinSpacePath(p, path)).map(p => pathSegments(p).length - pathSegments(path).length));
    for (const mount of version.body.products.filter(p => withinSpacePath(p.path, path))) {
      const legacy = await this.#ctx.store.node(mount.root);
      if (legacy)
        height = Math.max(height, pathSegments(mount.path).length - pathSegments(path).length + legacy.height);
    }
    return { digest, node, level: levelOfHeight(height) };
  }
  async getNodes(query: NodesQuery, by: Principal): Promise<NodesPage | null> {
    by = await this.#user(by);
    const version = await this.version(query.root);
    if (!version)
      return null;
    const allowed = await this.paths(by, version.body.space);
    if (!allowed.length)
      return null;
    const readableProducts = version.body.products.length ? await this.#ctx.packs.readableProducts(by) : new Set<string>();
    const visibleProducts = version.body.products.filter(p => readableProducts.has(p.product));
    const mount = query.paths.length === 1 ? visibleProducts.find(p => withinSpacePath(query.paths[0], p.path)) : undefined;
    if (mount) {
      if (!(await this.runAllows(by, query.root, query.paths[0], query.run)))
        return null;
      const binding = sha256Hex(canonicalize([by.id, query.root, query.paths, query.depth, allowed, visibleProducts, query.run ?? null]));
      let cursor: string | null = null;
      if (query.cursor) {
        try {
          const parsed = JSON.parse(Buffer.from(query.cursor, 'base64url').toString());
          if (parsed.mount !== binding || typeof parsed.cursor !== 'string')
            throw new Error();
          cursor = parsed.cursor;
        }
        catch {
          fail('SPACE_ENTRY_INVALID', '产品目录游标与当前知识版本不一致');
        }
      }
      const relative = query.paths[0].slice(mount.path.length) || '/';
      const page = await this.#legacyNodes({ ...query, root: mount.root, paths: [relative], cursor }, by);
      if (!page)
        return null;
      const alias = (path: string) => mount.path + (path === '/' ? '' : path);
      return { ...page, next: page.next ? Buffer.from(JSON.stringify({ mount: binding, cursor: page.next })).toString('base64url') : null, nodes: page.nodes.map(node => ({ ...node, path: alias(node.path), reference: refOf(query.root, alias(node.path)), children: node.children.map(child => ({ ...child, path: alias(child.path) })), entries: node.entries.map(entry => ({ ...entry, reference: refOf(query.root, alias(node.path), entry.entry) })) })) };
    }
    const paths = query.paths.map(pathCheck);
    if (!Number.isInteger(query.depth) || query.depth < 0 || query.depth > 6 || paths.length > 256)
      fail('SPACE_ENTRY_INVALID');
    let wanted = version.body.directories.filter(p => (!withinSpacePath(p, PRODUCTS_PATH) || p === PRODUCTS_PATH && visibleProducts.length > 0 || visibleProducts.some(m => withinSpacePath(m.path, p))) && allowed.some(a => withinSpacePath(p, a)) && paths.some(q => withinSpacePath(p, q) && pathSegments(p).length - pathSegments(q).length <= query.depth));
    if (query.run) {
      const permitted: string[] = [];
      for (const path of wanted)
        if (await this.runAllows(by, query.root, path, query.run))
          permitted.push(path);
      wanted = permitted;
    }
    const binding = sha256Hex(canonicalize([by.id, query.root, paths, query.depth, allowed, visibleProducts, query.run ?? null]));
    const offset = this.#cursor(query.cursor, binding);
    const nodes: NodesPage['nodes'] = [];
    let size = 0, at = offset;
    let mountedChildren = false;
    for (; at < wanted.length && nodes.length < this.#ctx.limits.pageNodes; at++) {
      const path = wanted[at], entries = [];
      const product = visibleProducts.find(p => p.path === path);
      if (product) {
        const productPage = await this.getNodes({ ...query, paths: [path], depth: 0, cursor: null }, by);
        const first = productPage?.nodes[0];
        if (first) {
          const bytes = Buffer.byteLength(canonicalize(first));
          if (size + bytes > this.#ctx.limits.pageBytes) {
            if (!nodes.length)
              fail('SPACE_ENTRY_INVALID', '该目录超出单页大小上限，请读取具体条目引用');
            break;
          }
          nodes.push(first);
          size += bytes;
          mountedChildren ||= first.children.length > 0 || productPage?.next !== null;
        }
        continue;
      }
      const stored = await this.#node(version, path);
      if (!stored)
        continue;
      for (const row of version.body.entries.filter(r => r.path === path && active(r)).sort((a, b) => a.entry < b.entry ? -1 : a.entry > b.entry ? 1 : 0)) {
        const view = await this.entry(by, query.root, path, row.entry);
        if (view)
          entries.push({ entry: row.entry, kind: view.body.content.kind, statement: view.body.content.statement, reference: view.reference, applicability: view.body.content.applicability ? canonicalize(view.body.content.applicability) : '未声明', data: view.body.content.data, status: view.row.status, grounds: view.body.grounds, grounds_withdrawn:view.grounds_withdrawn,...(view.grounds_withdrawn_hidden_count?{grounds_withdrawn_hidden_count:view.grounds_withdrawn_hidden_count}:{}), cited_count: view.cited_count });
      }
      const children = stored.node.children.map(child => ({ ...child, path: pathOf([...pathSegments(path), child.name]) })).filter(child => (!withinSpacePath(child.path, PRODUCTS_PATH) || child.path === PRODUCTS_PATH && visibleProducts.length > 0 || visibleProducts.some(m => withinSpacePath(m.path, child.path))) && allowed.some(a => withinSpacePath(child.path, a)));
      const node = { path, reference: refOf(query.root, path), name: stored.node.name, level: stored.level, digest: stored.digest, children, entries };
      const bytes = Buffer.byteLength(canonicalize(node));
      if (size + bytes > this.#ctx.limits.pageBytes) {
        if (!nodes.length)
          fail('SPACE_ENTRY_INVALID', '该目录超出单页大小上限，请读取具体条目引用');
        break;
      }
      nodes.push(node);
      size += bytes;
    }
    return { nodes, next: at < wanted.length ? this.#next(binding, at) : null, coverage: { ...emptyCoverage, complete: at === wanted.length && !mountedChildren, examined: at, total: wanted.length, ...(mountedChildren ? { note: '产品目录按子节点引用分别继续读取' } : {}) } };
  }
  /** Only sources in this immutable snapshot and currently readable paths become quotation candidates. */
  async basisSources(by: Principal, root: string): Promise<string[]> {
    const version = await this.version(root);
    if (!version)
      return [];
    const paths = await this.paths(by, version.body.space);
    if (!paths.length)
      return [];
    const hashes = new Set<string>();
    const records = await this.#ctx.records.store.getMany(version.body.sources);
    for (const record of records.values()) {
      if (record.kind !== 'knowledge_space_source')
        continue;
      const body = SpaceSourceBody.parse(record.body);
      if (body.space === version.body.space && paths.some(path => withinSpacePath(body.path, path)))
        hashes.add(body.sha256);
    }
    for (const row of version.body.entries.filter(r => paths.some(path => withinSpacePath(r.path, path)))) {
      const body = await this.#entry(row);
      if (!body)
        continue;
      for (const ground of body.grounds) {
        const ref = parseReference(ground.reference);
        if (ref.scheme === 'src')
          hashes.add(ref.sha256);
      }
    }
    return [...hashes];
  }
  async sources(by: Principal, space = by.id) {
    const paths = await this.paths(by, space);
    if (!paths.length)
      return [];
    const records = await this.#records<z.infer<typeof SpaceSourceBody>>(SOURCE_KEY, space, 'knowledge_space_source');
    return records.map(r => SpaceSourceBody.parse(r.body)).filter(s => paths.some(p => withinSpacePath(s.path, p)));
  }
  async importFile(by: Principal, bytes: Uint8Array, mediaType: string, name: string | null, path = '/', session: string | null = null) {
    bytes=Uint8Array.from(bytes);
    by = await this.#user(by);
    path = pathCheck(path);
    const upload:IngestInput={bytes,mediaType,name,origin:{upload:{session,message:null}},author:{user:by.id,declared:null},provenanceType:'declared',visibility:{readers:[by.id],admins:false,packs:[],shareable:false},readTier:'model_readable'};
    try{
    this.#scan({path,name});
    return await this.#write(by.id,() => this.#ctx.records.store.withTransaction(async (tx) => {
      await this.#ctx.records.store.lock('knowledge-space:' + by.id, tx);
      const previous = await this.current(by.id, tx);
      const planned=this.#draft(by.id,previous,previous?.body.entries??[],[...previous?.body.directories??[],path],by,'导入个人知识原文',bytes.byteLength,[...previous?.body.sources??[],'0'.repeat(64)]);
      if (planned.used_bytes > await this.capacity(by.id, tx))
        fail('SPACE_CAPACITY_EXCEEDED');
      if(previous)await this.#index(previous,tx);
      const grants=this.#latestGrants(await this.#records<SpaceGrantBody>(GRANT_KEY,by.id,'knowledge_space_grant',tx));
      if(grants.some(grant=>withinSpacePath(path,grant.path)))this.#inspectSource(bytes);
      const artifact = await this.#ctx.records.artifacts.ingest(upload,tx);
      const body = SpaceSourceBody.parse({ space: by.id, path, sha256: artifact.body.sha256, artifact: artifact.digest, size: artifact.body.size, by: by.id, at: this.#ctx.now().toISOString() });
      const source = await this.#ctx.records.store.put({ kind: 'knowledge_space_source', schema: 'knowledge-space-source@1', provenance: 'declared', body, index: [{ key: SOURCE_KEY, value: by.id }, { key: 'knowledge.space.source_hash', value: body.sha256 }] }, tx);
      await this.#save(by.id, previous, previous?.body.entries ?? [], [...previous?.body.directories ?? [], path], by, '导入个人知识原文', body.size, tx, [...previous?.body.sources ?? [], source.digest]);
      return artifact;
    }));
    }catch(error){
      if(error instanceof RecordsError&&error.code==='CREDENTIAL_IN_UPLOAD'||error instanceof KnowledgeError&&(error.code==='SPACE_CREDENTIALS_DETECTED'||error.code==='SPACE_CONTENT_UNINSPECTABLE')){
        const action=await this.#ctx.records.artifacts.recordUploadRefusal(upload,error.code!);
        const detail={...error.detail,action:action.digest};
        if(error instanceof KnowledgeError)throw new KnowledgeError(error.message,{code:error.code,fix:error.fix??undefined,detail});
        throw new RecordsError(error.message,{code:error.code,fix:error.fix,detail});
      }
      throw error;
    }
  }
  /** Preserve independently authorized captures; a space import never takes authority over equal bytes. */
  async source(by: Principal, sha256: string, runId?: string,consumer:import('../../contracts/generated/vocabulary.ts').ProducerKind='model',capture?:string): Promise<ArtifactSource | null> {
    const artifacts=this.#ctx.records.artifacts;
    const records=await this.#ctx.records.store.findMany<z.infer<typeof SpaceSourceBody>>({key:'knowledge.space.source_hash',values:[sha256],kind:'knowledge_space_source'});
    const captures=new Set(records.filter(row=>row.body.space!=='team').map(row=>row.body.artifact));
    const run=runId?(await this.#ctx.records.store.find<any>({key:'runs.id',value:runId,kind:'run',limit:1})).items[0]?.body:null;
    const pins=capture?[capture]:[...new Set<string>((run?.sources??[]).filter((binding:any)=>{const ref=parseReference(binding.reference);return ref.scheme==='src'&&ref.sha256===sha256&&binding.artifact;}).map((binding:any)=>String(binding.artifact)))];
    if(pins.length){
      let selected:ArtifactSource|null=null;
      for(const record of pins){
        const source=await artifacts.source(by,sha256,{consumer,record})??(runId?await artifacts.sourceForRun(by,sha256,runId,{consumer,record}):null)??await this.spaceSource(by,sha256,runId,consumer,record);
        if(!source)return null;
        selected??=source;
      }
      return selected;
    }
    else {
      const direct=await artifacts.source(by,sha256,{consumer});
      if(direct&&!captures.has(direct.artifact.digest))return direct;
      if(captures.size)for(const artifact of [...await artifacts.records(sha256)].reverse()){if(captures.has(artifact.digest))continue;const source=await artifacts.source(by,sha256,{consumer,record:artifact.digest});if(source)return source;}
      if(runId){const generated=await artifacts.sourceForRun(by,sha256,runId,{consumer});if(generated)return generated;}
    }
    return this.spaceSource(by,sha256,runId,consumer);
  }
  /** Space authorization alone, for exact-reference scope checks; never falls back to an unrelated capture. */
  async spaceSource(by: Principal, sha256: string, runId?: string,consumer:import('../../contracts/generated/vocabulary.ts').ProducerKind='model',capture?:string): Promise<ArtifactSource | null> {
    const records = await this.#ctx.records.store.findMany<z.infer<typeof SpaceSourceBody>>({ key: 'knowledge.space.source_hash', values: [sha256], kind: 'knowledge_space_source' });
    for (const record of records) {
      const body = SpaceSourceBody.parse(record.body);
      if(capture&&body.artifact!==capture)continue;
      if (!(await this.mayRead(by, body.space, body.path)))
        continue;
      let owner = await this.#ctx.records.principals.get(body.space === 'team' ? body.by : body.space);
      if (body.space === 'team' && (!owner || owner.disabled))
        owner = (await this.#ctx.records.principals.list?.() ?? []).find(user => !user.disabled && user.role === 'admin') ?? null;
      if (!owner || owner.disabled)
        continue;
      if (runId) {
        const run = (await this.#ctx.records.store.find<any>({ key: 'runs.id', value: runId, kind: 'run', limit: 1 })).items[0];
        const locks = run?.body.knowledge_spaces;
        if (!locks)
          continue;
        const version = body.space === 'team' ? await this.version(locks.team) : body.space === locks.owner ? await this.version(locks.personal) : await this.current(body.space);
        if (!version || !version.body.sources.includes(record.digest) || !(await this.runAllows(by, version.root, body.path, runId)))
          continue;
      }
      return this.#ctx.records.artifacts.source(owner, sha256, { record: body.artifact, consumer });
    }
    return null;
  }
  async personalGround(by:Principal,reference:string,artifact?:string):Promise<boolean>{
    let ref;try{ref=parseReference(reference);}catch{return false;}
    if(ref.scheme==='tree'){const version=await this.version(ref.root);return !!version&&version.body.space!=='team'&&await this.mayRead(by,version.body.space,ref.path);}
    if(ref.scheme!=='src')return false;
    const source=artifact?null:await this.source(by,ref.sha256);if(!artifact&&!source)return false;
    const records=await this.#ctx.records.store.findMany<z.infer<typeof SpaceSourceBody>>({key:'knowledge.space.source_hash',values:[ref.sha256],kind:'knowledge_space_source'});
    return records.some(record=>record.body.space!=='team'&&record.body.artifact===(artifact??source?.artifact.digest));
  }
  /** Space authorization alone, for exact-reference scope checks; never falls back to an unrelated capture. */
  async mayReadSource(by: Principal, sha256: string, runId?: string,consumer:import('../../contracts/generated/vocabulary.ts').ProducerKind='model',capture?:string): Promise<boolean> {
    const records = await this.#ctx.records.store.findMany<z.infer<typeof SpaceSourceBody>>({ key: 'knowledge.space.source_hash', values: [sha256], kind: 'knowledge_space_source' });
    for (const record of records) {
      const body = SpaceSourceBody.parse(record.body);
      if(capture&&body.artifact!==capture)continue;
      if (!(await this.mayRead(by, body.space, body.path)))
        continue;
      let owner = await this.#ctx.records.principals.get(body.space === 'team' ? body.by : body.space);
      if (body.space === 'team' && (!owner || owner.disabled))
        owner = (await this.#ctx.records.principals.list?.() ?? []).find(user => !user.disabled && user.role === 'admin') ?? null;
      if (!owner || owner.disabled)
        continue;
      if (runId) {
        const run = (await this.#ctx.records.store.find<any>({ key: 'runs.id', value: runId, kind: 'run', limit: 1 })).items[0];
        const locks = run?.body.knowledge_spaces;
        if (!locks)
          continue;
        const version = body.space === 'team' ? await this.version(locks.team) : body.space === locks.owner ? await this.version(locks.personal) : await this.current(body.space);
        if (!version || !version.body.sources.includes(record.digest) || !(await this.runAllows(by, version.root, body.path, runId)))
          continue;
      }
      const source=await this.#ctx.records.store.get<import('../records/api.ts').SourceArtifactBody>(body.artifact);if(source?.kind==='source_artifact'&&source.body.sha256===sha256&&await this.#ctx.records.artifacts.canRead(owner,source))return true;
    }
    return false;
  }
  async hasSource(sha256: string): Promise<boolean> { return (await this.#ctx.records.store.find({ key: 'knowledge.space.source_hash', value: sha256, kind: 'knowledge_space_source', limit: 1 })).items.length > 0; }
  treeReader(): TreeReader {
    const principal = async (reader: ReaderIdentity) => reader.user ? this.#ctx.records.principals.get(reader.user) : null;
    return {
      hasRoot: async (root, reader) => {
        const by = await principal(reader);
        if (!by)
          return false;
        const version = await this.version(root);
        return version ? (await this.paths(by, version.body.space)).length > 0 : this.#legacy.hasRoot?.(root, reader) ?? false;
      },
      read: async (root, path, entry, reader): Promise<TreeRead | null> => {
        const version = await this.version(root);
        if (!version)
          return this.#legacy.read(root, path, entry, reader);
        const by = await principal(reader);
        if (!by)
          return null;
        if (!(await this.runAllows(by, root, path, reader.run)))
          return null;
        const mount = version.body.products.find(p => withinSpacePath(path, p.path));
        if (mount) {
          if (!(await this.#ctx.packs.readableProducts(by)).has(mount.product))
            return null;
          return this.#legacy.read(mount.root, path.slice(mount.path.length) || '/', entry, reader);
        }
        if (entry) {
          const found = await this.entry(by, root, path, entry);
          return found ? { text: found.body.content.statement, mediaType: 'text/plain', readTier: 'model_readable', data: found.body.content.data as any, grounds: found.body.grounds.map(g => g.reference), validity: { status: found.row.status,grounds_withdrawn:found.grounds_withdrawn,...(found.grounds_withdrawn_hidden_count?{grounds_withdrawn_hidden_count:found.grounds_withdrawn_hidden_count}:{}) } } : null;
        }
        const page = await this.getNodes({ root, paths: [path], depth: 0 }, by);
        return page?.nodes.length ? { text: canonicalize(page.nodes[0]), mediaType: 'application/json', readTier: 'model_readable' } : null;
      },
      readEntry: (entry, reader) => this.#legacy.readEntry(entry, reader),
    };
  }
}
