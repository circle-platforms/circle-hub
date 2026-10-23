import { KnowledgeObservationBody } from '../../contracts/src/knowledge.ts';
import type { Page, Principal } from '../records/api.ts';
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
