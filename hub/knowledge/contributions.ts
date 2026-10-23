// K03: deterministic admission beside the tree. The caller supplies the run boundary's scoped resolver;
// it never supplies an evidence grade, provenance or an applicability declaration.
import { ContributionInput, KnowledgeContributionBody, type KnowledgeContributionView } from '../../contracts/src/contributions.ts';
import type { RootSource } from '../../contracts/src/knowledge.ts';
import type { ProtocolCode } from '../../contracts/generated/protocol.ts';
import type { ProvenanceType } from '../../contracts/generated/vocabulary.ts';
import type { Principal, SourceArtifact, Transaction, StoredRecord } from '../records/api.ts';
import { digestOf, sha256Hex } from '../records/api.ts';
import { parseReference, pathSegments, quoteMatches } from '../refs/api.ts';
import type { KnowledgeContext } from './context.ts';
import type { CompositionView } from './composition.ts';
import { KnowledgeError } from './errors.ts';
import type { TreeReading } from './read.ts';
import { INDEX, KnowledgeStore, SCHEMAS } from './store.ts';

export interface ContributionScope {
  root: string | null;
  product: string | null;
  resolve(reference: string): Promise<{ ok: true; value: { reference: string; text: string | null;
    recordSource?: { sha256: string; record: string; provenance: ProvenanceType } } } | { ok: false; message: string; code?: ProtocolCode }>;
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
        if (scope.product === null || scope.root === null || !(await this.mayRead(scope.product, reader))) return fail('产品不可读', 'SOURCE_UNAVAILABLE');
        const composition = (await this.#reading.compositionsOf(scope.root)).find(c => c.body.product === scope.product);
        if (composition === undefined) return fail('锁定根的组成不可读，须恢复该根的组成记录后重交', 'SOURCE_UNAVAILABLE');
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
    if (!checked.success) return fail('回注结构不合格：只收产出种类、陈述、根、路径、原文引文和关系；不得自报来源类型、依据等级或适用条件');
    const input = checked.data;
    if (scope.root !== input.root || scope.product === null) return fail('回注必须使用本次运行锁定的产品和根');
    const {composition, originals, lineage, custodian, fragments} = await this.#preparation(scope, reader);
    const node = await this.#reading.nodeAt(input.root, pathSegments(input.path));
    if (node === null) return fail(`归位路径在锁定的根里解析不出：${input.path}`);
    const inspect = async (record: SourceArtifact, seen: ReadonlySet<string> = new Set()): Promise<void> => {
      if (seen.has(record.digest)) return fail('来源血缘成环，须修复生成记录的输入引用后重交', 'REFERENCE_UNRESOLVED');
      if (seen.size >= 64) return fail('来源血缘超过 64 环的核验上限，须缩短生成链后重交');
      const body = record.body;
      if (body.author.user !== null || 'upload' in body.origin || body.provenance_type === 'declared') return fail(SIGNATURE);
      if (!body.visibility.admins) return fail('个人来源不能通过回注放宽可见范围');
      const readable = await this.#context.records.artifacts.source(custodian, body.sha256, { consumer: 'model', record: record.digest });
      if (readable?.bytes === null || readable === null) return fail(`所引原文此刻不可读，须由管理员 ${custodian.name} 恢复读取档位或权限后重交`, 'SOURCE_UNAVAILABLE');
      if ('read' in body.origin && body.provenance_type === 'observed') return;
      if (!('generated' in body.origin) || body.provenance_type !== 'projected' || body.origin.generated.inputs.length === 0) return fail('来源没有可追溯的 Hub 原件', 'SOURCE_UNAVAILABLE');
      const next = new Set(seen).add(record.digest);
      for (const reference of body.origin.generated.inputs) {
        let ref;
        try { ref = parseReference(reference); } catch { return fail('生成来源的输入引用格式有误，须修复生成记录后重交'); }
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
        if (parent?.kind !== 'source_artifact') return fail('生成记录的输入没有对应的源文件记录，须修复输入引用后重交', 'REFERENCE_UNRESOLVED');
        if (next.has(parent.digest)) return fail('来源血缘成环，须修复生成记录的输入引用后重交', 'REFERENCE_UNRESOLVED');
        let pending = lineage.get(parent.digest);
        if (pending === undefined) { pending = inspect(parent as SourceArtifact, next); lineage.set(parent.digest, pending); }
        await pending;
      }
    };
    const quote = async (quoted: ContributionInput['source']): Promise<KnowledgeContributionBody['source']> => {
      const resolved = await scope.resolve(quoted.reference);
      if (!resolved.ok) return fail(resolved.message, resolved.code ?? 'REFERENCE_UNRESOLVED');
      if (resolved.value.text === null || !quoteMatches(resolved.value.text, quoted.quote)) return fail(`引文没有逐字出自所引片段 ${resolved.value.reference}；用 get_nodes 重新读取这个引用，逐字修正引文后重交`, 'QUOTE_MISMATCH');
      const ref = parseReference(resolved.value.reference);
      let shas: string[] = [];
      if (ref.scheme === 'src') shas = [ref.sha256];
      else if (ref.scheme === 'rec' && resolved.value.recordSource !== undefined) {
        shas = [resolved.value.recordSource.sha256];
        if (resolved.value.recordSource.provenance === 'declared' || resolved.value.recordSource.provenance === 'candidate') return fail(SIGNATURE);
      }
      else if (ref.scheme === 'tree' && ref.root === input.root) {
        const rows = await composition.rowsAt(ref.path);
        for (const row of rows.values()) if (ref.entry === undefined || row.entry === ref.entry) for (const f of row.fragments) {
          const ground = parseReference(f);
          if (ground.scheme === 'src') shas.push(ground.sha256);
        }
      }
      // A run-bound record not in the root is not silently attached to a root node.
      if (shas.length === 0) return fail(OUTSIDE);
      shas = [...new Set(shas)].sort();
      const records: string[] = [];
      for (const sha of shas) {
        const source = originals.get(sha);
        if (source === undefined) return fail(OUTSIDE);
        const record = await this.#context.records.store.get(source.artifact);
        if (record?.kind !== 'source_artifact') return fail('来源记录不可读', 'SOURCE_UNAVAILABLE');
        let promise = lineage.get(record.digest);
        if (promise === undefined) { promise = inspect(record as SourceArtifact); lineage.set(record.digest, promise); }
        await promise;
        records.push(record.digest);
      }
      const artifact = await this.#context.records.store.get<SourceArtifact['body']>(records[0]);
      return { ...quoted, reference: resolved.value.reference, fragment: sha256Hex(resolved.value.text),
        provenance: resolved.value.recordSource?.provenance ?? (ref.scheme === 'tree' ? 'projected' : artifact!.body.provenance_type),
        records: [...new Set([...records, ...(resolved.value.recordSource === undefined ? [] : [resolved.value.recordSource.record])])], sources: shas };
    };
    const source = await quote(input.source);
    const relation = input.relation === undefined ? undefined : { kind: input.relation.kind, other: await quote(input.relation.other) };
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
      basis_rank: parseReference(source.reference).scheme === 'rec' || (relation !== undefined && parseReference(relation.other.reference).scheme === 'rec') ? 'relay' : 'judgment', applicability: null };
  }

  /** Called only after every requirement of the item is satisfied; validation result and layer share the transaction. */
  async append(prepared: PreparedContribution, origin: ContributionOrigin, tx: Transaction): Promise<string> {
    const key = digestOf({ ...prepared, ...origin });
    const old = await this.#context.store.records.find({ key: 'knowledge.contribution.identity', value: key, kind: 'claim', limit: 1 }, tx);
    if (old.items.length > 0) return old.items[0].digest;
    const body = KnowledgeContributionBody.parse({ ...prepared, ...origin, submitted_at: this.#context.now().toISOString() });
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
      for (const digest of source.records) {
        let readable = cache.get(digest);
        if (readable === undefined) {
          readable = (async () => {
            const record = await this.#context.records.store.get(digest);
            if (record === null) return false;
            if (record.kind !== 'source_artifact') return true; // record relays also carry their rooted original records
            const original = record as SourceArtifact;
            if (!original.body.visibility.admins) return false;
            const custodian = await this.#custodian(reader);
            const current = await this.#context.records.artifacts.source(custodian, original.body.sha256, {consumer:'model',record:digest});
            return current !== null && current.bytes !== null;
          })();
          cache.set(digest, readable);
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
    const readable = new Map<string, Promise<boolean>>();
    for (const record of records) {
      const body = KnowledgeStore.contributionOf(record);
      if (body === null || !paths.includes(body.path)) continue;
      if (!(await this.#groundsReadable(body, reader, readable))) continue;
      if (!digests.has(body.path)) {
        const fragment = await this.#reading.treeReader().read(root, body.path, null, { user: reader.id, role: reader.role });
        digests.set(body.path, fragment === null ? null : sha256Hex(fragment.text));
      }
      const changed = digests.get(body.path) !== body.cited_fragment;
      out.push({ record: record.digest, contribution: body, status: changed ? 'cited_fragment_changed' : 'valid',
        note: changed ? `被引片段已变（根 ${body.root.slice(0, 12)} → ${root.slice(0, 12)}）` : null });
    }
    return out;
  }
}
