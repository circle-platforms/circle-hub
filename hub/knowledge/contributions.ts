import {admitApplicability} from './applicability-claims.ts';
// K03: deterministic admission beside the tree. The caller supplies the run boundary's scoped resolver;
// it never supplies an evidence grade, provenance or an applicability declaration.
import {readPackDirectory} from '../runs/api.ts';
import {ProductDeclaration} from '../../contracts/src/product.ts';
import { ContributionInput, ContributionSource, KnowledgeContributionBody, WithheldContributionBody, MAX_NODE_CONTRIBUTIONS, type KnowledgeContributionPageView, type KnowledgeContributionView } from '../../contracts/src/contributions.ts';
import type { RootSource } from '../../contracts/src/knowledge.ts';
import { CORE_VIOLATION_CODES, PROTOCOL_CODES, type CoreViolationCode, type ProtocolCode } from '../../contracts/generated/protocol.ts';
import { labelOf, type ProvenanceType } from '../../contracts/generated/vocabulary.ts';
import type { Principal, SourceArtifact, Transaction, StoredRecord } from '../records/api.ts';
import { digestOf, scanForCredentials, sha256Hex } from '../records/api.ts';
import { ReferenceSyntaxError, parseReference, pathSegments, quoteMatches } from '../refs/api.ts';
import type { KnowledgeContext } from './context.ts';
import { CompositionView } from './composition.ts';
import { KnowledgeError } from './errors.ts';
import type { TreeReading } from './read.ts';
import { canonicalSize } from './digest.ts';
import { CAPTURED_GROUND, DECLARATION_GROUND, declarationGradeBody } from './declaration-grade.ts';
import { operationIdentity, operationRecord, reproductionLease } from './feeding.ts';
import { operationDeviceNote } from './operation-device.ts';
import { INDEX, KnowledgeStore, SCHEMAS } from './store.ts';

export interface ContributionScope {
  run?:string;classifications?:readonly string[];
  root: string | null;
  additionalRoots?: Array<{root:string;composition:string|null}>;
  product: string | null;
  composition:string|null;
  model?: string;
  session?: string|null;
  resolve(reference: string): Promise<{ ok: true; value: { reference: string; text: string | null;
    recordSource?: { sha256: string; record: string; provenance: ProvenanceType; kind:string;schema:string } } } | { ok: false; message: string; code?: ProtocolCode }>;
}
export interface ContributionOrigin {
  run: string; submission: string; session: string | null; model: string;
}
export type PreparedContribution = Omit<KnowledgeContributionBody, 'submitted_at' | 'run' | 'submission' | 'session' | 'model'>;
interface GroundState {visible:boolean;held:boolean}
interface Preparation {
  composition: CompositionView;
  compositions: CompositionView[];
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
export type ContributionAdmissionCode = Extract<CoreViolationCode, `core.contribution.${string}`> | Extract<ProtocolCode, 'CREDENTIAL_IN_UPLOAD'>;
export class ContributionRefusal extends KnowledgeError {
  readonly admissionCode: ContributionAdmissionCode;
  override readonly fix: string;
  constructor(code: ContributionAdmissionCode, message: string, detail: Record<string, unknown> = {}) {
    super(message, {detail}); this.admissionCode = code;
    this.fix = code === 'CREDENTIAL_IN_UPLOAD' ? PROTOCOL_CODES[code].fix : CORE_VIOLATION_CODES[code].fix;
  }
}
const refuse = (code: ContributionAdmissionCode, message: string, detail: Record<string, unknown> = {}): never => { throw new ContributionRefusal(code, message, detail); };

function scanPublicText(texts: readonly string[]): void {
  for (const text of texts) {
    const scan = scanForCredentials(new TextEncoder().encode(text));
    if (!scan.inspected || scan.truncated || scan.findings.length > 0) refuse("CREDENTIAL_IN_UPLOAD", '回注文字、模型声明或会话标识未通过完整凭据扫描，缺少可安全公开的文本');
  }
}

function identityOf(prepared: PreparedContribution): string {
  const feeding=prepared.feeding;
  const operation=feeding&&operationRecord(feeding.schema)?operationIdentity(feeding as unknown as Record<string,unknown>):undefined;
  return digestOf({product:prepared.product,root:prepared.root,path:prepared.path,kind:prepared.kind,statement:prepared.statement,
      source:{reference:prepared.source.reference,quote:prepared.source.quote},
      ...(operation===undefined?prepared.feeding===undefined?{}:{feeding:prepared.feeding}:{operation}),
      ...(prepared.applicability_claim===undefined?{}:{applicability_claim:prepared.applicability_claim}),
      ...(prepared.relation===undefined?{}:{relation:{kind:prepared.relation.kind,other:{reference:prepared.relation.other.reference,quote:prepared.relation.other.quote}}})});
}

export const HISTORICAL_CAPTURE_TIME = '历史记录未记明采集时刻是否由客户端声明：at 可能是上传时刻，不能当作已声明的采集时间';

function noteWithDevice(body: KnowledgeContributionBody, note: string): string;
function noteWithDevice(body: KnowledgeContributionBody, note: string | null): string | null;
function noteWithDevice(body: KnowledgeContributionBody, note: string | null): string | null {
  const device = operationDeviceNote(body.feeding);
  const feeding = body.feeding;
  // Every operation record says when its capture time was not declared, with or without a device. A record from before the
  // declaration existed carries no marker: its view says the source of its `at` is unknown, and its bytes stay as they were
  // (round-five review, item 8).
  const time = !feeding || !operationRecord(feeding.schema) ? null
    : !('captured_at_declared' in feeding) ? HISTORICAL_CAPTURE_TIME
    : feeding.captured_at_declared === false ? `采集时间未声明，记录里没有采集时刻；Hub 收到 ${feeding.received_at}` : null;
  return [note, device, time].filter((value): value is string => value !== null).join('；') || null;
}

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

  async #preparation(scope: ContributionScope, reader: Principal, cacheScope = scope): Promise<Preparation> {
    let readers = this.#preparations.get(cacheScope);
    if (readers === undefined) { readers = new Map(); this.#preparations.set(cacheScope, readers); }
    const key=JSON.stringify([reader.id,scope.root,scope.composition]);
    let preparation = readers.get(key);
    if (preparation === undefined) {
      preparation = (async () => {
        if (scope.product === null || scope.root === null || !(await this.mayRead(scope.product, reader))) return refuse("core.contribution.product_unavailable", '缺少当前产品的读取权限');
        const body=scope.composition===null?null:await this.#context.store.composition(scope.composition);
        if(body===null||body.product!==scope.product||body.root!==scope.root)return refuse("core.contribution.composition_missing", '缺少本次运行锁定的产品、根和组成快照对应事实');
        const composition=new CompositionView(this.#context.store,scope.composition!,body);
        const compositions = [composition];
        for(const lock of scope.additionalRoots ?? []) {
          const extra=lock.composition===null?null:await this.#context.store.composition(lock.composition);
          if(extra===null||extra.product!==scope.product||extra.root!==lock.root)return refuse("core.contribution.composition_missing", '缺少本次运行锁定的额外根和组成快照对应事实');
          if(!compositions.some(view=>view.record===lock.composition))compositions.push(new CompositionView(this.#context.store,lock.composition!,extra));
        }
        const originals = new Map<string,RootSource>();
        for(const view of compositions)for(const source of await view.sources())originals.set(source.sha256,source);
        // Root publication authorizes its readers. The service account only rechecks the effective tier
        // of shared, Hub-owned originals; it is never used for personal sources or scoped resolution.
        const custodian = await this.#custodian(reader);
        return {composition, compositions, originals, custodian, lineage:new Map(), fragments:new Map()};
      })();
      readers.set(key, preparation);
    }
    return preparation;
  }

  async prepare(reader: Principal, raw: unknown, scope: ContributionScope): Promise<PreparedContribution> {
    const checked = ContributionInput.safeParse(raw);
    if (!checked.success) return fail('回注结构不合格：只收产出种类、陈述、根、路径、原文引文和关系；适用条件主张只收生成结构；不得自报来源类型、依据等级或改写原条目条件；按 start_run 的槽位 schema 修正后重交');
    const input = checked.data;
    const cacheScope = scope;
    const additional = scope.additionalRoots?.find(lock => lock.root === input.root);
    if (additional) scope = { ...scope, root: additional.root, composition: additional.composition,
      additionalRoots: [...(scope.root === null ? [] : [{root:scope.root,composition:scope.composition}]),...(scope.additionalRoots??[]).filter(lock=>lock!==additional)] };
    if (scope.root !== input.root || scope.product === null) return fail('回注必须使用本次运行锁定的产品和根；缺少与锁定根的对应关系，按 start_run 的 root 原样填写，或为目标根另开运行','REFERENCE_UNRESOLVED');
    if(input.feeding!==undefined){
      const layer=this.#context.feeding;if(!layer)return fail('缺喂入核验服务；管理员恢复后重试');
      const value=await layer.prepare(reader,input.feeding,{composition:scope.composition,product:scope.product,root:scope.root,run:scope.run,classifications:scope.classifications});
      if(value.schema==='retraction@1')return fail('撤回请使用管理员喂入撤回入口，不得伪装对象回注');
      if(operationRecord(value.schema)&&input.kind!=='assertion')return fail('操作记录的产出种类只能是声明（assertion）；观察、步骤和教训写在 feeding 里');
      const ref=parseReference(input.source.reference);
      const same=ref.scheme==='src'&&ref.sha256===value.source.bytes;
      // An operation's echo stays on the capture. Its phenomenon quote may cite a different observed original, such as the problem ticket.
      if(!same&&!(ref.scheme==='src'&&operationRecord(value.schema)))return fail('回注主引文必须指向同一喂入原件');
      await layer.quote(reader,{reference:input.source.reference,text:input.source.quote});
      const pinned=same?await layer.originalRecord(reader,value,{run:scope.run}):(await this.#context.records.artifacts.readable(reader,ref.sha256))?.digest;
      const original=pinned?await this.#context.records.artifacts.source(reader,ref.sha256,{consumer:'model',record:pinned}):null;if(!original?.bytes)return fail('缺当前可读的原件；恢复来源后重交');
      if(same&&operationRecord(value.schema)&&original.artifact.body.provenance_type!=='client_captured')return fail('操作记录的根据必须是出处为 client_captured 的上传原件；其他出处仍拒收');
      if(!same&&original.artifact.body.provenance_type!=='observed'&&original.artifact.body.provenance_type!=='projected')return fail('现象引文必须出自问题单原件');
      const node=await this.#reading.nodeAt(input.root,pathSegments(input.path));if(!node)return fail('归位路径在锁定树苗中不存在');
      const fragment=await this.#reading.treeReader({composition:scope.composition}).read(input.root,input.path,null,{user:reader.id,role:reader.role});if(!fragment)return fail('归位节点当前不可读');
      scanPublicText([input.statement,JSON.stringify(value),scope.model??'',scope.session??'']);
      // basis_rank has no value labeled 声明. The stored rank stays the existing contribution default; the record is kept out of evidence by its schema and claim qualifier.
      const provenance=operationRecord(value.schema)&&same?'client_captured':value.schema==='fed-note@1'?'declared':original.artifact.body.provenance_type as Extract<ProvenanceType, 'observed' | 'projected' | 'declared' | 'client_captured'>;
      return {layer:'contribution',product:scope.product,root:input.root,path:input.path,cited_fragment:sha256Hex(fragment.text),kind:input.kind,statement:input.statement,source:{...input.source,fragment:sha256Hex(input.source.quote),provenance,records:[original.artifact.digest],sources:[ref.sha256]},feeding:value as KnowledgeContributionBody['feeding'],submitted_by:reader.id,basis_rank:'judgment',applicability:null};
    }
    const {composition, compositions, originals, lineage, custodian, fragments} = await this.#preparation(scope, reader, cacheScope);
    let segments:string[];
    try{segments=pathSegments(input.path);}catch(error){if(error instanceof ReferenceSyntaxError)return fail(`归位路径不是规范写法：${error.message}；按 get_nodes 返回的 path 原样填写后重交`,'REFERENCE_UNRESOLVED');throw error;}
    const node = await this.#reading.nodeAt(input.root, segments);
    if (node === null) return fail(`归位路径在锁定的根里解析不出：${input.path}；缺少这个路径的节点，按 get_nodes 返回的现有 path 修正后重交`,'REFERENCE_UNRESOLVED');
    const inspect = async (record: SourceArtifact, seen: ReadonlySet<string> = new Set()): Promise<void> => {
      if (seen.has(record.digest)) return refuse("core.contribution.lineage_unproven", '来源血缘成环，缺少可追溯的 Hub 原件');
      if (seen.size >= 64) return refuse("core.contribution.lineage_unproven", '来源血缘超过 64 环的核验上限，缺少可完整核验的生成链');
      const body = record.body;
      if (body.author.user !== null || 'upload' in body.origin || body.provenance_type === 'declared' || body.provenance_type === 'candidate') return refuse("core.contribution.signature_required", SIGNATURE);
      if (!body.visibility.admins) return refuse("core.contribution.personal_source", '个人来源不能通过回注放宽可见范围，缺少可发布的原文根据');
      const readable = await this.#context.records.artifacts.source(custodian, body.sha256, { consumer: 'model', record: record.digest });
      if (readable?.bytes === null || readable === null) return refuse("core.contribution.source_unavailable", '所引原文当前不可供模型核验，缺少可读原文事实', {principal:custodian.id,record:record.digest,read_tier:readable?.readTier??null});
      if ('read' in body.origin && body.provenance_type === 'observed') return;
      if (!('generated' in body.origin) || body.provenance_type !== 'projected' || body.origin.generated.inputs.length === 0) return refuse("core.contribution.lineage_unproven", '来源没有可追溯的 Hub 原件');
      const next = new Set(seen).add(record.digest);
      for (const reference of body.origin.generated.inputs) {
        let ref;
        try { ref = parseReference(reference); } catch { return refuse("core.contribution.lineage_unproven", '生成来源的输入引用格式有误，缺少可追溯的原件定位'); }
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
        if (parent?.kind !== 'source_artifact') return refuse("core.contribution.lineage_unproven", '生成记录的输入没有对应的源文件记录');
        if (next.has(parent.digest)) return refuse("core.contribution.lineage_unproven", '来源血缘成环，缺少可追溯的原件');
        let pending = lineage.get(parent.digest);
        if (pending === undefined) { pending = inspect(parent as SourceArtifact, next); lineage.set(parent.digest, pending); }
        await pending;
      }
    };
    const quote = async (quoted: ContributionInput['source']): Promise<import('zod').z.infer<typeof ContributionSource>> => {
      const resolved = await scope.resolve(quoted.reference);
      if (!resolved.ok) return fail(`${resolved.message}；缺少可核对的运行内原文。恢复读取条件后重交；未绑定该源或根时另开运行绑定它，片段不存在时用 get_nodes 返回的引用修正`, resolved.code ?? 'REFERENCE_UNRESOLVED');
      if (resolved.value.text === null || !quoteMatches(resolved.value.text, quoted.quote)) return fail(`引文没有逐字出自所引片段 ${resolved.value.reference}；用 get_nodes 重新读取这个引用，逐字修正引文后重交`, 'QUOTE_MISMATCH');
      const ref = parseReference(resolved.value.reference);
      let shas: string[] = [];
      if (ref.scheme === 'src') {
        const actual=await this.#context.records.artifacts.readable(reader,ref.sha256);
        if(actual===null)return fail('引用的原件当前不可读；恢复读取权限后重交','SOURCE_UNAVAILABLE');
        if(actual.body.provenance_type==='client_captured')return fail(CAPTURED_GROUND+'。改交观察、步骤或教训，或改引锁定根里的原文。');
        await inspect(actual); // distinguish a session declaration from an outside-root Hub original
        shas = [ref.sha256];
      }
      else if (ref.scheme === 'rec') {
        const record=resolved.value.recordSource;
        if(record?.kind==='submission'||(record?.kind==='source_artifact'&&(record.provenance==='declared'||record.provenance==='candidate')))return refuse("core.contribution.signature_required", SIGNATURE);
        const stored=await this.#context.records.store.get(ref.record);
        if(stored&&declarationGradeBody(stored.body))return refuse("core.contribution.record_not_original", DECLARATION_GROUND);
        return refuse("core.contribution.record_not_original", '记录转述或回注条目不能作回注根据，缺少锁定根中的原文片段');
      }
      else if (ref.scheme === 'tree') {
        for(const sourceComposition of compositions.filter(view=>view.body.root===ref.root)){
        const rows = await sourceComposition.rowsAt(ref.path);
        if(ref.path==='/'&&ref.entry!==undefined)for await(const row of sourceComposition.unplacedRows())if(row.entry===ref.entry)rows.set(row.entry,{...row,path:'/'});
        for (const row of rows.values()) if (ref.entry === undefined || row.entry === ref.entry) for (const f of row.fragments) {
          const ground = parseReference(f);
          if (ground.scheme === 'src') shas.push(ground.sha256);
        }
      }
      }
      // A run-bound record not in the root is not silently attached to a root node.
      if (shas.length === 0) return refuse("core.contribution.source_not_original", '这个节点没有原文条目，读到的只是子节点名单，缺少原文片段');
      shas = [...new Set(shas)].sort();
      const records: string[] = [];
      for (const sha of shas) {
        const source = originals.get(sha);
        if (source === undefined) return refuse("core.contribution.source_outside_root", OUTSIDE);
        const record = await this.#context.records.store.get(source.artifact);
        if (record?.kind !== 'source_artifact') return fail('来源记录不可读', 'SOURCE_UNAVAILABLE');
        let promise = lineage.get(record.digest);
        if (promise === undefined) { promise = inspect(record as SourceArtifact); lineage.set(record.digest, promise); }
        await promise;
        records.push(record.digest);
      }
      const artifact = await this.#context.records.store.get<SourceArtifact['body']>(records[0]);
      const provenance=ContributionSource.shape.provenance.safeParse(ref.scheme==='tree'?'projected':artifact?.body.provenance_type);
      if(!provenance.success)return refuse("core.contribution.signature_required", SIGNATURE);
      if(provenance.data==='client_captured')return fail(CAPTURED_GROUND+'。改交观察、步骤或教训，或改引锁定根里的原文。');
      return { ...quoted, reference: resolved.value.reference, fragment: sha256Hex(resolved.value.text),
        provenance: provenance.data,
        records: [...new Set([...records, ...(resolved.value.recordSource === undefined ? [] : [resolved.value.recordSource.record])])], sources: shas };
    };
    const source = await quote(input.source);
    if(input.kind === 'placement_proposal') {
      const ref=parseReference(input.source.reference);
      const producers=new Set<string>();
      const matches=(row:{entry:string;fragments:string[]})=>ref.scheme==='tree'
        ? ref.root===input.root && (ref.entry!==undefined ? ref.entry===row.entry : 'path' in row && row.path===ref.path)
        : ref.scheme==='src' && row.fragments.some(fragment=>fragment===input.source.reference || (input.source.reference===`src:${ref.sha256}` && fragment.startsWith(`src:${ref.sha256}/`)));
      for await(const row of composition.rows()) if(matches(row))row.producers.forEach(id=>producers.add(id));
      for await(const row of composition.unplacedRows())if(matches(row))row.producers.forEach(id=>producers.add(id));
      if(producers.size===0)return fail('归位提议缺少可定位到生产器的原条目或原文片段；用 get_nodes 返回的条目引用重交','REFERENCE_UNRESOLVED');
      const producer=composition.body.producer;
      const pack=await this.#context.packs.pack(`${producer.pack}@${producer.version}`);
      if(pack===null||pack.digest!==producer.digest)return fail('缺少产出此组成的原包版本；恢复该版本后重交','REFERENCE_UNRESOLVED');
      if(pack.kind!=='product')return fail('原条目的生产器包不是产品包，没有可核验的生产器声明；恢复该包版本后重交','REFERENCE_UNRESOLVED');
      let raw:unknown;
      try {
        const current=await this.#context.packs.productById(producer.pack);
        if(current?.id===pack.id&&current.version===pack.version&&current.digest===producer.digest)raw=current.product;
        else {
          const loaded=await readPackDirectory(pack.directory);
          if(!loaded.ok||loaded.pack.digest!==producer.digest||loaded.pack.manifest.kind!=='product'||loaded.pack.manifest.id!==pack.id||loaded.pack.manifest.version!==pack.version)throw new Error('unverified product declaration');
          const file=loaded.pack.files.find(file=>file.path==='product.json');
          if(!file)throw new Error('missing product declaration');
          raw=JSON.parse(Buffer.from(file.bytes).toString('utf8'));
        }
      } catch { return fail('缺少与原包版本及摘要一致的已核验产品声明；请管理员恢复该版本的完整包后重交','REFERENCE_UNRESOLVED'); }
      const parsed=ProductDeclaration.safeParse(raw);
      if(!parsed.success)return fail('原包的已核验产品声明不符合 product@1；请管理员恢复正确声明后重交','REFERENCE_UNRESOLVED');
      const declaration=parsed.data;
      if([...producers].some(id=>declaration.producers.find(p=>p.id===id)?.placement!=='judgment_allowed'))
        return fail('原条目的生产器未允许 bot 提议归位；仅接受声明 judgment_allowed 的生产器所产出的条目');
    }

    const applicabilityClaim=input.kind==='applicability_claim'?await admitApplicability(this.#context,this.#reading,composition,input,source,originals,custodian,reader):undefined;
    const relation = input.relation === undefined ? undefined : { kind: input.relation.kind, other: await quote(input.relation.other) };
    scanPublicText([input.statement, source.quote, scope.model ?? '', scope.session ?? '', ...(relation === undefined ? [] : [relation.other.quote]),...(applicabilityClaim===undefined?[]:[JSON.stringify(applicabilityClaim)])]);
    if(relation!==undefined&&(source.reference===relation.other.reference||(source.fragment===relation.other.fragment&&(quoteMatches(source.quote,relation.other.quote)||quoteMatches(relation.other.quote,source.quote)))))return refuse("core.contribution.self_relation", '关系双方指向同一片段或重叠引文，缺少两个独立的原文端点');
    if (!fragments.has(input.path)) fragments.set(input.path, (async () => {
      const fragment = await this.#reading.treeReader({composition:composition.record}).read(input.root, input.path, null, { user: reader.id, role: reader.role });
      return fragment === null ? null : sha256Hex(fragment.text);
    })());
    const fragment = await fragments.get(input.path)!;
    if (fragment === null) return fail('被归位节点此刻不可读，须恢复节点读取后重交', 'SOURCE_UNAVAILABLE');
    return { layer: 'contribution', product: scope.product, root: input.root, path: input.path,
      cited_fragment: fragment, kind: input.kind, statement: input.statement, source,
      ...(applicabilityClaim===undefined?{}:{applicability_claim:applicabilityClaim}),
      ...(relation === undefined ? {} : { relation }), submitted_by: reader.id,
      // Semantic integration is attributed to Circle, not promoted into a Hub observation by a matching quote.
      basis_rank: 'judgment', applicability: null };
  }

  /** Lock an entire transaction's identities in one global order before preserving item order in receipts. */
  async lockIdentities(prepared: readonly PreparedContribution[], tx: Transaction): Promise<void> {
    for (const key of [...new Set(prepared.map(identityOf))].sort()) await this.#context.store.records.lock(`knowledge.contribution:${key}`, tx);
  }

  /** Called only after every requirement of the item is satisfied; validation result and layer share the transaction. */
  async append(prepared: PreparedContribution, origin: ContributionOrigin, tx: Transaction): Promise<string> {
    scanPublicText([origin.model,origin.session??'']);
    const key = identityOf(prepared);
    await this.#context.store.records.lock(`knowledge.contribution:${key}`, tx);
    const old = await this.#context.store.records.find({ key: 'knowledge.contribution.identity', value: key, kind: 'claim', limit: 1 }, tx);
    if (old.items.length > 0) return old.items[0].digest;
    const principal=await this.#context.records.principals.get(prepared.submitted_by);
    const feedingRecord=prepared.feeding&&principal?await this.#context.feeding?.appendPrepared(principal,prepared.feeding,{product:prepared.product,root:prepared.root,run:origin.run},origin.model,tx):undefined;
    const body = KnowledgeContributionBody.parse({ ...prepared,...(feedingRecord?{feeding_record:feedingRecord}:{}), session:origin.session,model:origin.model, submitted_at: this.#context.now().toISOString() });
    const operation=body.feeding!==undefined&&operationRecord(body.feeding.schema);
    const lease=operation?await reproductionLease(this.#context.records.store,origin.run):null;
    return (await this.#context.store.putClaim(SCHEMAS.contribution, operation?'client_captured':'declared', body,
      [{ key: INDEX.contribution, value: body.product }, { key: 'knowledge.contribution.identity', value: key },
        {key:'knowledge.contribution.node',value:digestOf({product:body.product,path:body.path})},
        ...(operation?[{key:'knowledge.contribution.run',value:origin.run}]:[]),
        ...(lease?[{key:'knowledge.contribution.lease',value:lease}]:[])], tx)).digest;
  }

  async read(digest: string, reader: Principal): Promise<StoredRecord | null> {
    const record = await this.#context.records.store.get(digest);
    if(record?.kind==='claim'&&record.schema==='claim@1')return await this.#context.feeding?.readRecord(digest,reader)??null;
    const body = record === null ? null : KnowledgeStore.contributionOf(record);
    if(body===null||!(await this.mayRead(body.product,reader)))return null;
    const state=await this.#groundsState(body,reader,new Map());
    return state.visible&&!state.held?record:null;
  }

  /** A copied quotation does not bypass a later credential hold on its original. Tier-aware reads do not rescan. */
  async #groundsState(body: KnowledgeContributionBody, reader: Principal, cache: Map<string, Promise<GroundState>>): Promise<GroundState> {
    let held=false;
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
            if (record === null) return {visible:false,held:false};
            if (record.kind !== 'source_artifact') return {visible:tree,held:false};
            const original = record as SourceArtifact;
            if (!original.body.visibility.admins) return {visible:false,held:false};
            if(body.feeding?.schema==='fed-note@1'&&reader.role!=='admin'&&body.feeding.by!==reader.id)return {visible:false,held:false};
            const principal = tree ? await this.#custodian(reader) : reader;
            const current = await this.#context.records.artifacts.source(principal, original.body.sha256, {consumer:tree?'function':'model',record:digest});
            if(current===null)return {visible:false,held:false};
            if(current.bytes!==null)return {visible:true,held:false};
            return {visible:current.readTier==='retain_only',held:current.readTier==='retain_only'};
          })();
          cache.set(key, readable);
        }
        const state=await readable;if(!state.visible)return state;held ||= state.held;
      }
    }
    return {visible:true,held};
  }

  #withheld(record:string,body:KnowledgeContributionBody):KnowledgeContributionView {
    const {statement:_statement,source,relation,applicability_claim:_applicabilityClaim,feeding:_feeding,feeding_record:_feedingRecord,...metadata}=body;const {quote:_quote,...safeSource}=source;
    const safeOther=relation===undefined?undefined:(({quote:_quote,...rest})=>rest)(relation.other);
    return {record,contribution:WithheldContributionBody.parse({...metadata,source:safeSource,...(relation===undefined?{}:{relation:{kind:relation.kind,other:safeOther}})}),status:'credential_unreadable',
      note:noteWithDevice(body,`${labelOf('validity_status','credential_unreadable')}；缺少当前可供模型读取的原件，须由管理员核查扫描结论；确属误报才受理后重读，真凭据须清理并重新采集；不要转述陈述或引文`)};
  }

  async readView(digest:string,reader:Principal):Promise<KnowledgeContributionView|null>{
    const record=await this.#context.records.store.get(digest);const body=record===null?null:KnowledgeStore.contributionOf(record);
    if(body===null||!(await this.mayRead(body.product,reader)))return null;
    const state=await this.#groundsState(body,reader,new Map());if(!state.visible)return null;
    const feedingState=body.feeding_record?await this.#context.feeding?.recordState(body.feeding_record,reader,digest):null;
    return state.held?this.#withheld(digest,body):{record:digest,contribution:body,status:feedingState?.validity==='invalid'?'grounds_withdrawn':'valid',note:noteWithDevice(body,feedingState?.validity==='invalid'?'根据已失效；查看喂入撤回和来源修订记录':null)};
  }

  async has(root:string,reader:Principal):Promise<boolean>{
    for(const product of await this.#reading.productsOfRoot(root))if(await this.mayRead(product,reader)){
      if((await this.#context.store.records.find({key:INDEX.contribution,value:product,kind:'claim',limit:1})).items.length>0)return true;
    }
    return false;
  }

  /** Keyset page of the node index. Query size and returned bytes are bounded even when source ACLs hide rows. */
  async page(root:string,path:string,reader:Principal,options:{cursor?:string|null;limit?:number;bytes?:number}={}):Promise<{items:KnowledgeContributionPageView[];next:string|null}>{
    const products:string[]=[];for(const product of [...await this.#reading.productsOfRoot(root)].sort())if(await this.mayRead(product,reader))products.push(product);
    const q=digestOf({root,path});let product=products[0];let cursor:string|null=null;
    if(options.cursor){try{const saved=JSON.parse(Buffer.from(options.cursor,'base64url').toString());if(saved.q!==q||typeof saved.p!=='string'||!(saved.c===null||typeof saved.c==='string'))throw new Error();product=saved.p;cursor=saved.c;}catch{throw new KnowledgeError('回注游标不属于此根和路径；按原查询重新读取第一页',{code:'REFERENCE_UNRESOLVED'});}}
    let at=product===undefined?products.length:products.indexOf(product);if(at<0){at=products.findIndex(p=>p>product!);cursor=null;}if(at<0)at=products.length;
    const encode=()=>at>=products.length?null:Buffer.from(JSON.stringify({q,p:products[at],c:cursor})).toString('base64url');
    const limit=Math.min(MAX_NODE_CONTRIBUTIONS,Math.max(1,options.limit??MAX_NODE_CONTRIBUTIONS));
    const budget=Math.max(0,options.bytes??this.#context.limits.pageBytes);let bytes=0,scanned=0;
    const cache={digests:new Map<string,string|null>(),endpoints:new Map<string,Promise<string|null>>(),readable:new Map<string,Promise<GroundState>>()};
    const items:KnowledgeContributionPageView[]=[];
    const deferred = () => ({items,next:encode()});
    while(at<products.length&&items.length<limit&&scanned<MAX_NODE_CONTRIBUTIONS*4){
      const before=cursor;const selected=await this.#context.store.records.find({key:'knowledge.contribution.node',value:digestOf({product:products[at],path}),kind:'claim',cursor,limit:1,newestFirst:true});
      const record=selected.items[0];scanned++;
      if(record===undefined){at++;cursor=null;continue;}
      const body=KnowledgeStore.contributionOf(record);
      const view=body?.product===products[at]&&body.path===path?(await this.#views(root,[record],reader,cache))[0]:undefined;
      if(view!==undefined){
        let shown:KnowledgeContributionPageView=view;let size=canonicalSize(view)+1;
        if(size>budget-bytes){
          if(items.length>0)return deferred();
          shown={record:view.record,status:view.status,note:(view.note??'')+'；本条回注超过节点页字节上限，缺少本页正文；用 get_nodes 按 rec:'+view.record+' 游标分段读取'};
          size=canonicalSize(shown)+1;
          // The first reference marker may exceed this soft budget; consuming it guarantees cursor progress.
        }
        items.push(shown);bytes+=size;
      }
      cursor=selected.next;if(cursor===null)at++;
    }
    return deferred();
  }

  /** Small-result convenience only. Larger callers must follow page.next; never silently return an incomplete array. */
  async list(root:string,paths:readonly string[],reader:Principal):Promise<KnowledgeContributionView[]>{
    const items:KnowledgeContributionView[]=[];
    let bytes=0;
    for(const path of new Set(paths)){
      if(items.length>=MAX_NODE_CONTRIBUTIONS)throw new KnowledgeError('查询达到单页上限，剩余路径尚未核验；请改用 page 并持续读取 next',{code:'REFERENCE_UNRESOLVED'});
      const page=await this.page(root,path,reader,{limit:MAX_NODE_CONTRIBUTIONS-items.length,bytes:Math.max(0,this.#context.limits.pageBytes-bytes)});
      if(page.next!==null||page.items.some(v=>v.contribution===undefined))throw new KnowledgeError('回注超过单页范围，缺少剩余正文；请改用 page 并持续读取 next，或用 get_nodes 游标续读',{code:'REFERENCE_UNRESOLVED'});
      for(const view of page.items)if(view.contribution!==undefined){items.push(view as KnowledgeContributionView);bytes+=canonicalSize(view)+1;}
    }
    return items;
  }

  async #views(root:string,records:StoredRecord[],reader:Principal,cache:{digests:Map<string,string|null>;endpoints:Map<string,Promise<string|null>>;readable:Map<string,Promise<GroundState>>}):Promise<KnowledgeContributionView[]>{
    const out: KnowledgeContributionView[] = [];
    const {digests,endpoints,readable}=cache;
    for (const record of records) {
      const body = KnowledgeStore.contributionOf(record);
      if (body === null) continue;
      const state=await this.#groundsState(body,reader,readable);if(!state.visible)continue;
      if(state.held){out.push(this.#withheld(record.digest,body));continue;}
      if(body.feeding_record&&(await this.#context.feeding?.recordState(body.feeding_record,reader,record.digest))?.validity==='invalid'){out.push({record:record.digest,contribution:body,status:'grounds_withdrawn',note:noteWithDevice(body,'喂入主张根据已撤回或原件已修订；历史引文仍保留')});continue;}
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
        note: noteWithDevice(body, changed ? `${labelOf('validity_status','cited_fragment_changed')}（根 ${body.root.slice(0, 12)} → ${root.slice(0, 12)}）${changedEndpoints.length===0?'':`；变化端点：${changedEndpoints.join('、')}`}` : null) });
    }
    return out;
  }
}
