// K03: deterministic admission beside the tree. The caller supplies the run boundary's scoped resolver;
// it never supplies an evidence grade, provenance or an applicability declaration.
import { ContributionInput, ContributionSource, KnowledgeContributionBody, type KnowledgeContributionView } from '../../contracts/src/contributions.ts';
import type { RootSource } from '../../contracts/src/knowledge.ts';
import type { ProtocolCode } from '../../contracts/generated/protocol.ts';
import { labelOf, type ProvenanceType } from '../../contracts/generated/vocabulary.ts';
import type { Principal, SourceArtifact, Transaction, StoredRecord } from '../records/api.ts';
import { digestOf, scanForCredentials, sha256Hex } from '../records/api.ts';
import { ReferenceSyntaxError, parseReference, pathSegments, quoteMatches } from '../refs/api.ts';
import type { KnowledgeContext } from './context.ts';
import { CompositionView } from './composition.ts';
import { KnowledgeError } from './errors.ts';
import type { TreeReading } from './read.ts';
import { INDEX, KnowledgeStore, SCHEMAS } from './store.ts';

export interface ContributionScope {
  root: string | null;
  product: string | null;
  composition:string|null;
  resolve(reference: string): Promise<{ ok: true; value: { reference: string; text: string | null;
    recordSource?: { sha256: string; record: string; provenance: ProvenanceType; kind:string;schema:string } } } | { ok: false; message: string; code?: ProtocolCode }>;
}
export interface ContributionOrigin {
  run: string; submission: string; session: string | null; model: string;
}
export type PreparedContribution = Omit<KnowledgeContributionBody, 'submitted_at' | 'run' | 'submission' | 'session' | 'model'>;
interface Preparation {
  composition: CompositionView;
  originals: Map<string, RootSource>;
  lineage: Map<string, Promise<void>>;
  custodian: Principal;
  fragments: Map<string, Promise<string | null>>;
}
const OUTSIDE = '来源不在锁定的根里，这一版不收；以后按 K03 R[5] 只绑片段和源的修订、不绑节点';
const SIGNATURE = '需要负责人署名，署名流程以后做';
const fail = (message: string, code: ProtocolCode = 'SUBMISSION_SCHEMA_VIOLATION'): never => {
  throw new KnowledgeError(message, { code });
};

/** A known admission-policy refutation. It is not a malformed submission or an unresolved exact value. */
export class ContributionRefusal extends KnowledgeError {
  readonly rule:string;
  override readonly fix:string;
  constructor(rule:string,message:string,fix:string,detail:Record<string,unknown>={}){
    super(message,{detail});this.rule=rule;this.fix=fix;
  }
}
const refuse=(rule:string,message:string,fix='本条先标为 skipped 并写明缺少的根据，其余条目照常提交',detail:Record<string,unknown>={}):never=>{throw new ContributionRefusal(rule,message,fix,detail);};

export class ContributionLayer {
  readonly #context: KnowledgeContext;
  readonly #reading: TreeReading;
  // One boundary call shares its immutable root/source inventory and ancestry checks. Never reuse across submissions.
  readonly #preparations = new WeakMap<ContributionScope, Map<string, Promise<Preparation>>>();
  constructor(context: KnowledgeContext, reading: TreeReading) { this.#context = context; this.#reading = reading; }

  /** Every reader, including an admin, passes the product reader port. No run-admin bypass. */
  async mayRead(product: string, reader: Principal): Promise<boolean> {
    const account = await this.#context.records.principals.get(reader.id);
    return account !== null && !account.disabled && (await this.#context.packs.readableProducts(account)).has(product);
  }

  async #custodian(reader: Principal): Promise<Principal> {
    const configured = this.#context.admin === null ? null : await this.#context.records.principals.get(this.#context.admin.id);
    if (configured !== null && !configured.disabled && configured.role === 'admin') return configured;
    return (await this.#context.records.principals.list?.() ?? []).find(p => p.role === 'admin' && !p.disabled) ?? reader;
  }

  async #preparation(scope: ContributionScope, reader: Principal): Promise<Preparation> {
    let readers = this.#preparations.get(scope);
    if (readers === undefined) { readers = new Map(); this.#preparations.set(scope, readers); }
    let preparation = readers.get(reader.id);
    if (preparation === undefined) {
      preparation = (async () => {
        if (scope.product === null || scope.root === null || !(await this.mayRead(scope.product, reader))) return refuse('product_unavailable','缺少当前产品的读取权限','请管理员恢复产品读取权限后用新摘要申请核验；本条也可先标为 skipped');
        const body=scope.composition===null?null:await this.#context.store.composition(scope.composition);
        if(body===null||body.product!==scope.product||body.root!==scope.root)return refuse('composition_missing','缺少本次运行锁定的产品、根和组成快照对应事实','恢复已锁定的组成记录，或重新开运行锁定现有完整快照；本条先标为 skipped');
        const composition=new CompositionView(this.#context.store,scope.composition!,body);
        const originals = new Map((await composition.sources()).map(source => [source.sha256, source]));
        // Root publication authorizes its readers. The service account only rechecks the effective tier
        // of shared, Hub-owned originals; it is never used for personal sources or scoped resolution.
        const custodian = await this.#custodian(reader);
        return {composition, originals, custodian, lineage:new Map(), fragments:new Map()};
      })();
      readers.set(reader.id, preparation);
    }
    return preparation;
  }

  async prepare(reader: Principal, raw: unknown, scope: ContributionScope): Promise<PreparedContribution> {
    const checked = ContributionInput.safeParse(raw);
    if (!checked.success) return fail('回注结构不合格：只收产出种类、陈述、根、路径、原文引文和关系；不得自报来源类型、依据等级或适用条件；按 start_run 的槽位 schema 修正后重交');
    const input = checked.data;
    if (scope.root !== input.root || scope.product === null) return fail('回注必须使用本次运行锁定的产品和根；缺少与锁定根的对应关系，按 start_run 的 root 原样填写，或为目标根另开运行','REFERENCE_UNRESOLVED');
    const {composition, originals, lineage, custodian, fragments} = await this.#preparation(scope, reader);
    let segments:string[];
    try{segments=pathSegments(input.path);}catch(error){if(error instanceof ReferenceSyntaxError)return fail(`归位路径不是规范写法：${error.message}；按 get_nodes 返回的 path 原样填写后重交`,'REFERENCE_UNRESOLVED');throw error;}
    const node = await this.#reading.nodeAt(input.root, segments);
    if (node === null) return fail(`归位路径在锁定的根里解析不出：${input.path}；缺少这个路径的节点，按 get_nodes 返回的现有 path 修正后重交`,'REFERENCE_UNRESOLVED');
    const inspect = async (record: SourceArtifact, seen: ReadonlySet<string> = new Set()): Promise<void> => {
      if (seen.has(record.digest)) return refuse('lineage_unproven','来源血缘成环，缺少可追溯的 Hub 原件','修复生成记录的输入引用后重新生成并开运行；本条先标为 skipped');
      if (seen.size >= 64) return refuse('lineage_unproven','来源血缘超过 64 环的核验上限，缺少可完整核验的生成链','缩短生成链并重新生成资料后重交；本条先标为 skipped');
      const body = record.body;
      if (body.author.user !== null || 'upload' in body.origin || body.provenance_type === 'declared' || body.provenance_type === 'candidate') return refuse('signature_required',SIGNATURE,'缺少负责人署名；本版保留在 Circle，本条标为 skipped（待负责人署名），其余条目照常提交');
      if (!body.visibility.admins) return refuse('personal_source','个人来源不能通过回注放宽可见范围，缺少可发布的原文根据','改引锁定根中的非个人 Hub 原件；本条先标为 skipped，其余条目照常提交');
      const readable = await this.#context.records.artifacts.source(custodian, body.sha256, { consumer: 'model', record: record.digest });
      if (readable?.bytes === null || readable === null) return refuse('source_unavailable','所引原文当前不可供模型核验，缺少可读原文事实','请管理员核查并恢复原文读取条件后用新摘要重交；本条也可先标为 skipped',{principal:custodian.id,record:record.digest,read_tier:readable?.readTier??null});
      if ('read' in body.origin && body.provenance_type === 'observed') return;
      if (!('generated' in body.origin) || body.provenance_type !== 'projected' || body.origin.generated.inputs.length === 0) return refuse('lineage_unproven','来源没有可追溯的 Hub 原件','补齐生成器输入与原件记录后重新生成资料；本条先标为 skipped');
      const next = new Set(seen).add(record.digest);
      for (const reference of body.origin.generated.inputs) {
        let ref;
        try { ref = parseReference(reference); } catch { return refuse('lineage_unproven','生成来源的输入引用格式有误，缺少可追溯的原件定位','修复生成记录并重新生成资料；本条先标为 skipped'); }
        let parent: StoredRecord | null = null;
        if (ref.scheme === 'rec') parent = await this.#context.records.store.get(ref.record);
        else if (ref.scheme === 'src') {
          // A src input names bytes, not a record. Follow the record that could have supplied them at
          // generation time, with the same Hub-before-person rule as artifacts.readable(). A later
          // observation must never retroactively launder a human-supplied input.
          const candidates = (await this.#context.records.artifacts.records(ref.sha256))
            .filter(r => r.digest !== record.digest && r.created_at <= record.created_at);
          const hub = candidates.filter(r => r.body.author.user === null && !('upload' in r.body.origin));
          parent = (hub.length > 0 ? hub : candidates).at(-1) ?? null;
        }
        if (parent?.kind !== 'source_artifact') return refuse('lineage_unproven','生成记录的输入没有对应的源文件记录','修复输入引用并重新生成资料；本条先标为 skipped');
        if (next.has(parent.digest)) return refuse('lineage_unproven','来源血缘成环，缺少可追溯的原件','修复生成记录的输入引用后重新生成资料；本条先标为 skipped');
        let pending = lineage.get(parent.digest);
        if (pending === undefined) { pending = inspect(parent as SourceArtifact, next); lineage.set(parent.digest, pending); }
        await pending;
      }
    };
    const quote = async (quoted: ContributionInput['source']): Promise<KnowledgeContributionBody['source']> => {
      const resolved = await scope.resolve(quoted.reference);
      if (!resolved.ok) return fail(`${resolved.message}；缺少可核对的运行内原文。恢复读取条件后重交；未绑定该源或根时另开运行绑定它，片段不存在时用 get_nodes 返回的引用修正`, resolved.code ?? 'REFERENCE_UNRESOLVED');
      if (resolved.value.text === null || !quoteMatches(resolved.value.text, quoted.quote)) return fail(`引文没有逐字出自所引片段 ${resolved.value.reference}；用 get_nodes 重新读取这个引用，逐字修正引文后重交`, 'QUOTE_MISMATCH');
      const ref = parseReference(resolved.value.reference);
      let shas: string[] = [];
      if (ref.scheme === 'src') {
        const actual=await this.#context.records.artifacts.readable(reader,ref.sha256);
        if(actual===null)return fail('引用的原件当前不可读；恢复读取权限后重交','SOURCE_UNAVAILABLE');
        await inspect(actual); // distinguish a session declaration from an outside-root Hub original
        shas = [ref.sha256];
      }
      else if (ref.scheme === 'rec') {
        const record=resolved.value.recordSource;
        if(record?.kind==='submission'||(record?.kind==='source_artifact'&&(record.provenance==='declared'||record.provenance==='candidate')))return refuse('signature_required',SIGNATURE,'缺少负责人署名；本版保留在 Circle，本条先标为 skipped');
        return refuse('record_not_original','记录转述或回注条目不能作回注根据，缺少锁定根中的原文片段','改引锁定根里原文的 src: 或 tree: 引用；本条先标为 skipped');
      }
      else if (ref.scheme === 'tree' && ref.root === input.root) {
        const rows = await composition.rowsAt(ref.path);
        for (const row of rows.values()) if (ref.entry === undefined || row.entry === ref.entry) for (const f of row.fragments) {
          const ground = parseReference(f);
          if (ground.scheme === 'src') shas.push(ground.sha256);
        }
      }
      // A run-bound record not in the root is not silently attached to a root node.
      if (shas.length === 0) return refuse('source_not_original','这个节点没有原文条目，读到的只是子节点名单，缺少原文片段','改引叶节点条目或它在锁定根中的源文件；本条先标为 skipped');
      shas = [...new Set(shas)].sort();
      const records: string[] = [];
      for (const sha of shas) {
        const source = originals.get(sha);
        if (source === undefined) return refuse('source_outside_root',OUTSIDE,'缺少锁定根中的原文；本条标为 skipped（来源未入锁定根），其余条目照常提交；来源入根后重新开回注运行');
        const record = await this.#context.records.store.get(source.artifact);
        if (record?.kind !== 'source_artifact') return fail('来源记录不可读', 'SOURCE_UNAVAILABLE');
        let promise = lineage.get(record.digest);
        if (promise === undefined) { promise = inspect(record as SourceArtifact); lineage.set(record.digest, promise); }
        await promise;
        records.push(record.digest);
      }
      const artifact = await this.#context.records.store.get<SourceArtifact['body']>(records[0]);
      const provenance=ContributionSource.shape.provenance.safeParse(ref.scheme==='tree'?'projected':artifact?.body.provenance_type);
      if(!provenance.success)return refuse('signature_required',SIGNATURE,'缺少可追溯 Hub 原件，当前条目标为 skipped；署名流程以后做');
      return { ...quoted, reference: resolved.value.reference, fragment: sha256Hex(resolved.value.text),
        provenance: provenance.data,
        records: [...new Set([...records, ...(resolved.value.recordSource === undefined ? [] : [resolved.value.recordSource.record])])], sources: shas };
    };
    const source = await quote(input.source);
    const relation = input.relation === undefined ? undefined : { kind: input.relation.kind, other: await quote(input.relation.other) };
    for(const text of [input.statement,source.quote,...(relation===undefined?[]:[relation.other.quote])]){
      const scan=scanForCredentials(new TextEncoder().encode(text));
      if(!scan.inspected||scan.truncated||scan.findings.length>0)return refuse('sensitive_text','回注文字未通过完整凭据扫描，缺少可安全公开的文本','去掉明文凭据并缩短到可完整扫描的文本后重交；凭据保留在 Circle 本地，本条也可先标为 skipped');
    }
    if(relation!==undefined&&(source.reference===relation.other.reference||(source.fragment===relation.other.fragment&&(quoteMatches(source.quote,relation.other.quote)||quoteMatches(relation.other.quote,source.quote)))))return refuse('self_relation','关系双方指向同一片段或重叠引文，缺少两个独立的原文端点','改引两个不同片段的规范引用（同一文件须给出各自选择器）后重交；本条先标为 skipped');
    if (!fragments.has(input.path)) fragments.set(input.path, (async () => {
      const fragment = await this.#reading.treeReader({composition:composition.record}).read(input.root, input.path, null, { user: reader.id, role: reader.role });
      return fragment === null ? null : sha256Hex(fragment.text);
    })());
    const fragment = await fragments.get(input.path)!;
    if (fragment === null) return fail('被归位节点此刻不可读，须恢复节点读取后重交', 'SOURCE_UNAVAILABLE');
    return { layer: 'contribution', product: scope.product, root: input.root, path: input.path,
      cited_fragment: fragment, kind: input.kind, statement: input.statement, source,
      ...(relation === undefined ? {} : { relation }), submitted_by: reader.id,
      // Semantic integration is attributed to Circle, not promoted into a Hub observation by a matching quote.
      basis_rank: 'judgment', applicability: null };
  }

  /** Called only after every requirement of the item is satisfied; validation result and layer share the transaction. */
  async append(prepared: PreparedContribution, origin: ContributionOrigin, tx: Transaction): Promise<string> {
    const key = digestOf({product:prepared.product,root:prepared.root,path:prepared.path,kind:prepared.kind,statement:prepared.statement,
      source:{reference:prepared.source.reference,quote:prepared.source.quote},
      ...(prepared.relation===undefined?{}:{relation:{kind:prepared.relation.kind,other:{reference:prepared.relation.other.reference,quote:prepared.relation.other.quote}}})});
    const old = await this.#context.store.records.find({ key: 'knowledge.contribution.identity', value: key, kind: 'claim', limit: 1 }, tx);
    if (old.items.length > 0) return old.items[0].digest;
    const body = KnowledgeContributionBody.parse({ ...prepared, session:origin.session,model:origin.model, submitted_at: this.#context.now().toISOString() });
    return (await this.#context.store.putClaim(SCHEMAS.contribution, 'declared', body,
      [{ key: INDEX.contribution, value: body.product }, { key: 'knowledge.contribution.identity', value: key },
        {key:'knowledge.contribution.node',value:digestOf({product:body.product,path:body.path})}], tx)).digest;
  }

  async read(digest: string, reader: Principal): Promise<StoredRecord | null> {
    const record = await this.#context.records.store.get(digest);
    const body = record === null ? null : KnowledgeStore.contributionOf(record);
    return body !== null && await this.mayRead(body.product, reader) && await this.#groundsReadable(body, reader, new Map()) ? record : null;
  }

  /** A copied quotation does not bypass a later credential hold on its original. Tier-aware reads do not rescan. */
  async #groundsReadable(body: KnowledgeContributionBody, reader: Principal, cache: Map<string, Promise<boolean>>): Promise<boolean> {
    for (const source of [body.source, ...(body.relation === undefined ? [] : [body.relation.other])]) {
      const tree = parseReference(source.reference).scheme === 'tree';
      for (const digest of source.records) {
        // Public tree text only needs its original's current tier checked. Raw src/rec quotations must
        // remain within the actual reader's source ACL. Never reuse a tree-tier result for a raw endpoint.
        const key = `${tree ? 'tree' : 'original'}:${digest}`;
        let readable = cache.get(key);
        if (readable === undefined) {
          readable = (async () => {
            const record = await this.#context.records.store.get(digest);
            if (record === null) return false;
            if (record.kind !== 'source_artifact') return tree;
            const original = record as SourceArtifact;
            if (!original.body.visibility.admins) return false;
            const principal = tree ? await this.#custodian(reader) : reader;
            const current = await this.#context.records.artifacts.source(principal, original.body.sha256, {consumer:'model',record:digest});
            return current !== null && current.bytes !== null;
          })();
          cache.set(key, readable);
        }
        if (!(await readable)) return false;
      }
    }
    return true;
  }

  async list(root: string, paths: readonly string[], reader: Principal): Promise<KnowledgeContributionView[]> {
    const products = new Set((await this.#reading.compositionsOf(root)).map(c => c.body.product));
    const records: StoredRecord[] = [];
    for (const product of products) {
      if (!(await this.mayRead(product, reader))) continue;
      for (const path of new Set(paths)) records.push(...await this.#context.store.all({key:'knowledge.contribution.node',value:digestOf({product,path}),kind:'claim'}));
    }
    const out: KnowledgeContributionView[] = [];
    const digests = new Map<string, string | null>();
    const endpoints=new Map<string,Promise<string|null>>();
    const readable = new Map<string, Promise<boolean>>();
    for (const record of records) {
      const body = KnowledgeStore.contributionOf(record);
      if (body === null || !paths.includes(body.path)) continue;
      if (!(await this.#groundsReadable(body, reader, readable))) continue;
      if (!digests.has(body.path)) {
        const fragment = await this.#reading.treeReader().read(root, body.path, null, { user: reader.id, role: reader.role });
        digests.set(body.path, fragment === null ? null : sha256Hex(fragment.text));
      }
      let changed = digests.get(body.path) !== body.cited_fragment;
      const changedEndpoints:string[]=[];
      const cited:Array<[string,KnowledgeContributionBody['source']]>=[['主引文',body.source]];
      if(body.relation!==undefined)cited.push(['关系另一端',body.relation.other]);
      for(const [name,source] of cited){
        const ref=parseReference(source.reference);if(ref.scheme!=='tree')continue;
        const key=`${ref.path}@${ref.entry??''}`;
        if(!endpoints.has(key))endpoints.set(key,(async()=>{const value=await this.#reading.treeReader().read(root,ref.path,ref.entry??null,{user:reader.id,role:reader.role});return value===null?null:sha256Hex(value.text);})());
        if(await endpoints.get(key)!==source.fragment){changed=true;changedEndpoints.push(name);}
      }
      out.push({ record: record.digest, contribution: body, status: changed ? 'cited_fragment_changed' : 'valid',
        note: changed ? `${labelOf('validity_status','cited_fragment_changed')}（根 ${body.root.slice(0, 12)} → ${root.slice(0, 12)}）${changedEndpoints.length===0?'':`；变化端点：${changedEndpoints.join('、')}`}` : null });
    }
    return out;
  }
}
