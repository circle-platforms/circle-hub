// The two layers beside the tree (K03), with their write and read API; milestone 1 does not populate them. Neither ever
// enters a root digest: they are claim records next to the tree, not tree nodes.
// - Observation layer: echoes the Hub collected itself in a verification run and the pack declares product observations;
//   append only; device, build, collection time and echo digest; no run id (K03 R[3]); readable by whoever may read the product.
// - Candidate layer: a person's candidates, visible to that person only (admins included, K03 R[4]); bound to the node
//   path, the cited fragment's digest and the root (K03 R[5]); grounded in an uploaded session excerpt whose quotation is
//   verified before the candidate is stored (K03 R[4], R[6]).
import { KnowledgeCandidateBody, KnowledgeObservationBody } from '../../contracts/src/knowledge.ts';
import type { Applicability } from '../../contracts/src/product.ts';
import { labelOf, type PermissionRole, type ValidityStatus } from '../../contracts/generated/vocabulary.ts';
import type { Page, Principal } from '../records/api.ts';
import { sha256Hex } from '../records/api.ts';
import { ReferenceSyntaxError, parseReference, pathOf, pathSegments, resolveReference, verifyQuote, type SourceReader } from '../refs/api.ts';
import type { KnowledgeContext } from './context.ts';
import { KnowledgeError } from './errors.ts';
import type { TreeReading } from './read.ts';
import { INDEX, KnowledgeStore, SCHEMAS } from './store.ts';

export class ObservationLayer {
  readonly #context: KnowledgeContext;
  readonly #reading: TreeReading;

  constructor(context: KnowledgeContext, reading: TreeReading) {
    this.#context = context;
    this.#reading = reading;
  }

  /** Appends one observation. Called by the Hub's own verification runs (trusted caller); the echo must be a stored source. */
  async append(observation: KnowledgeObservationBody): Promise<string> {
    const parsed = KnowledgeObservationBody.safeParse(observation);
    if (!parsed.success) throw new KnowledgeError('观察记录不合格：只带产品、构建、设备、采集时刻、回显源文件摘要和声明它的任务包');
    if ((await this.#context.records.artifacts.records(parsed.data.echo)).length === 0) throw new KnowledgeError('回显源文件不在 Hub 里，先存源文件再记观察（B05 R[2]）');
    const record = await this.#context.store.putClaim(SCHEMAS.observation, 'observed', parsed.data, [{ key: INDEX.observation, value: parsed.data.product }]);
    return record.digest;
  }

  /** Observations of a product, oldest first, by cursor (K05 R[1]); null when the reader may not read the product. */
  async list(product: string, reader: Principal, query: { cursor?: string | null; limit?: number } = {}): Promise<Page<KnowledgeObservationBody & { record: string }> | null> {
    if (!(await this.#reading.mayReadProducts(reader, [product]))) return null;
    const page = await this.#context.store.records.find<unknown>({ key: INDEX.observation, value: product, kind: 'claim', cursor: query.cursor ?? null, limit: query.limit ?? 100 });
    const items: Array<KnowledgeObservationBody & { record: string }> = [];
    for (const record of page.items) {
      const body = KnowledgeStore.observationOf(record);
      if (body !== null && body.product === product) items.push({ ...body, record: record.digest });
    }
    return { items, next: page.next };
  }
}

export interface CandidateInput {
  root: string;
  path: string;
  statement: string;
  /** The uploaded session excerpt (src reference) and the quotation from it the candidate rests on. */
  ground: { reference: string; quote: string };
  applicability?: Applicability | null;
}

export interface CandidateView {
  record: string;
  candidate: KnowledgeCandidateBody;
  /** valid, or cited_fragment_changed when the reader's root has other text at the path (K03 R[5]). */
  status: Extract<ValidityStatus, 'valid' | 'cited_fragment_changed'>;
  note: string | null;
}

export class CandidateLayer {
  readonly #context: KnowledgeContext;
  readonly #reading: TreeReading;

  constructor(context: KnowledgeContext, reading: TreeReading) {
    this.#context = context;
    this.#reading = reading;
  }

  async #account(owner: Principal): Promise<{ id: string; role: PermissionRole }> {
    const account = await this.#context.records.principals.get(owner?.id);
    if (account === null || account.disabled) throw new KnowledgeError('对你不可用', { code: 'SOURCE_UNAVAILABLE' });
    return { id: account.id, role: account.role };
  }

  /** SHA-256 of the text at a path of a root, as the tree reader gives it. */
  async #fragmentDigest(root: string, path: string, reader: { id: string; role: PermissionRole }): Promise<string | null> {
    const read = await this.#reading.treeReader().read(root, path, null, { user: reader.id, role: reader.role });
    return read === null ? null : sha256Hex(read.text);
  }

  async add(owner: Principal, input: CandidateInput): Promise<string> {
    const account = await this.#account(owner);
    let path: string;
    try {
      path = pathOf(pathSegments(input.path));
    } catch (error) {
      if (error instanceof ReferenceSyntaxError) throw new KnowledgeError(`路径写法不对：${error.message}`, { code: 'REFERENCE_UNRESOLVED' });
      throw error;
    }
    const cited = await this.#fragmentDigest(input.root, path, account);
    if (cited === null) throw new KnowledgeError('对你不可用', { code: 'SOURCE_UNAVAILABLE' });
    let ground;
    try {
      ground = parseReference(input.ground.reference);
    } catch (error) {
      if (error instanceof ReferenceSyntaxError) throw new KnowledgeError(`根据的引用写法不对：${error.message}`, { code: 'REFERENCE_UNRESOLVED' });
      throw error;
    }
    if (ground.scheme !== 'src') throw new KnowledgeError('候选的根据要先作为源文件上传（会话摘录），再用 src 引用', { code: 'REFERENCE_UNRESOLVED' });
    // The excerpt is the owner's own upload, private to them (K03 R[4]).
    const artifact = await this.#context.records.artifacts.readable({ id: account.id, name: account.id, role: account.role }, ground.sha256);
    const own = artifact !== null && 'upload' in artifact.body.origin && artifact.body.author.user === account.id && !artifact.body.visibility.admins;
    if (!own) throw new KnowledgeError('候选的根据必须是你本人上传、只对你可见的会话摘录', { code: 'SOURCE_UNAVAILABLE' });
    const sources: SourceReader = {
      read: async (sha256) => {
        const source = await this.#context.records.artifacts.source({ id: account.id, name: account.id, role: account.role }, sha256, { consumer: 'model' });
        return source === null || source.bytes === null ? null : { bytes: source.bytes, mediaType: source.mediaType, size: source.size, readTier: source.readTier };
      },
    };
    const resolved = await resolveReference(ground, { reader: { user: account.id, role: account.role }, parsers: this.#context.parsers, sources });
    const verdict = verifyQuote(resolved, input.ground.quote);
    if (verdict !== true) throw new KnowledgeError(verdict === false ? '引文与根据的原文对不上（逐字核对）' : '根据的原文不可读，无法核对引文', { code: verdict === false ? 'QUOTE_MISMATCH' : 'REFERENCE_UNRESOLVED' });
    const products = await this.#reading.productsOfRoot(input.root);
    const body = KnowledgeCandidateBody.safeParse({
      owner: account.id,
      product: [...products].sort()[0],
      root: input.root,
      path,
      cited_fragment: cited,
      statement: input.statement,
      ground: { reference: resolved.resolved ? resolved.reference : input.ground.reference, quote: input.ground.quote },
      applicability: input.applicability ?? null,
    });
    if (!body.success) throw new KnowledgeError('候选不合格');
    const record = await this.#context.store.putClaim(SCHEMAS.candidate, 'candidate', body.data, [{ key: INDEX.candidate, value: account.id }]);
    return record.digest;
  }

  /** The owner's own candidates (nobody else's, admins included), with their status against the root the owner reads. */
  async list(owner: Principal, readerRoot: string | null = null): Promise<CandidateView[]> {
    const account = await this.#account(owner);
    const records = await this.#context.store.all<unknown>({ key: INDEX.candidate, value: account.id, kind: 'claim' });
    const out: CandidateView[] = [];
    for (const record of records) {
      const candidate = KnowledgeStore.candidateOf(record);
      if (candidate === null || candidate.owner !== account.id) continue;
      let status: CandidateView['status'] = 'valid';
      let note: string | null = null;
      if (readerRoot !== null && readerRoot !== candidate.root) {
        const now = await this.#fragmentDigest(readerRoot, candidate.path, account);
        if (now !== candidate.cited_fragment) {
          status = 'cited_fragment_changed';
          note = `${labelOf('validity_status', 'cited_fragment_changed')}（根 ${candidate.root.slice(0, 12)} → ${readerRoot.slice(0, 12)}）`;
        }
      }
      out.push({ record: record.digest, candidate, status, note });
    }
    return out;
  }
}
