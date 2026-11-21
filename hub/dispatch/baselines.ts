import { sha256Hex, type ActionBody, type Principal } from '../records/api.ts';
import { at } from './definition.ts';
import { captureText, type BedBaselineRecord } from './bed-state.ts';
import type { DispatchService } from './service.ts';
import { probeBinding, withLease, type LeaseSessionContext } from './devices.ts';

type BaselineContext = Pick<DispatchService, 'registry' | 'options' | 'now' | 'getBaseline'>;
type RecordBaselineContext = BaselineContext & LeaseSessionContext;

async function keepBaseline(ctx: BaselineContext, by: Principal, executor: string, probeId: string, text: string, reason: string | null | undefined, observed: readonly string[]): Promise<BedBaselineRecord> {
  const bytes = new TextEncoder().encode(text);
  const artifact = await ctx.options.records.artifacts.ingest({
    bytes,
    mediaType: 'text/plain',
    origin: { upload: { session: 'bed-baseline' } },
    author: { user: by.id },
    provenanceType: 'observed',
    visibility: { readers: [by.id], admins: true, packs: [], shareable: false },
  });
  const reference = `art:${artifact.body.sha256}`;
  const now = ctx.now().toISOString();
  const recordBody: BedBaselineRecord = {
    executor,
    probe: probeId,
    sha256: sha256Hex(bytes),
    reference,
    text,
    recorded_by: by.id,
    created_at: now,
    reason: reason ?? null,
  };
  await ctx.options.records.store.put<ActionBody>({
    kind: 'action',
    schema: 'action@1',
    provenance: 'observed',
    created_at: now,
    body: {
      action: 'validate',
      run: null,
      item: null,
      inputs: [reference, ...observed],
      component: 'dispatch@1',
      lease: null,
      started_at: now,
      ended_at: now,
      result: 'completed',
      error_code: null,
      acceptance: null,
      codes: [],
      detail: {
        phase: 'bed_baseline',
        ...recordBody,
      },
    },
    index: [
      { key: 'bed.baseline', value: `${executor}:${probeId}` },
      { key: 'bed.baseline.executor', value: executor },
      { key: 'dispatch.phase', value: 'bed_baseline' },
    ],
  });
  return recordBody;
}

export async function recordBaseline(this: RecordBaselineContext, by: Principal, executor: string, probeId: string, reason?: string | null): Promise<BedBaselineRecord> {
    await this.registry.admin(by);
    const registered = await this.registry.get(executor);
    if (!registered?.definition.enabled) throw new Error('执行器不可用或已禁用');
    const d = registered.definition;
    const spec = d.bed_state;
    if (!spec) throw new Error('执行器未声明 bed_state');
    const item = spec.items.find(i => i.id === probeId);
    if (!item) throw new Error(`执行器未声明探针 ${probeId}`);
    return withLease(this, probeBinding(by, registered), d, async (client, leased) => {
      const context = await leased();
      const response = await client.declaredRead(item.call, context, `bed.baseline.${item.id}`);
      const raw = at(response.value, item.output ?? '/output');
      if (typeof raw !== 'string') throw new Error(`探针 ${probeId} 未返回文本内容（指针 ${item.output ?? '/output'}）`);
      return keepBaseline(this, by, executor, probeId, captureText(raw, item.lead, item.trail), reason, [response.source]);
    });
  }

export async function setBaseline(this: BaselineContext, by: Principal, executor: string, probeId: string, text: string, reason?: string | null): Promise<BedBaselineRecord> {
    await this.registry.admin(by);
    return keepBaseline(this, by, executor, probeId, text, reason, []);
  }

export async function getBaseline(this: BaselineContext, executor: string, probeId: string): Promise<BedBaselineRecord | null> {
    const rows = await this.options.records.store.findMany<ActionBody>({
      kind: 'action',
      key: 'bed.baseline',
      values: [`${executor}:${probeId}`],
    });
    const last = rows.at(-1);
    if (!last || last.body.detail.phase !== 'bed_baseline') return null;
    return last.body.detail as unknown as BedBaselineRecord;
  }

export async function listBaselines(this: BaselineContext, by: Principal, executor?: string): Promise<BedBaselineRecord[]> {
    await this.registry.admin(by);
    let rows: Array<{ body: ActionBody; created_at?: string }>;
    if (executor) {
      rows = await this.options.records.store.findMany<ActionBody>({
        kind: 'action',
        key: 'bed.baseline.executor',
        values: [executor],
      });
    } else {
      rows = await this.options.records.store.findMany<ActionBody>({
        kind: 'action',
        key: 'dispatch.phase',
        values: ['bed_baseline'],
      });
    }
    const map = new Map<string, BedBaselineRecord>();
    for (const row of rows) {
      if (row.body.detail.phase === 'bed_baseline') {
        const record = row.body.detail as unknown as BedBaselineRecord;
        map.set(`${record.executor}:${record.probe}`, record);
      }
    }
    return [...map.values()].sort((a, b) => (a.executor === b.executor ? a.probe.localeCompare(b.probe) : a.executor.localeCompare(b.executor)));
  }

export async function showBaseline(this: BaselineContext, by: Principal, executor: string, probeId: string): Promise<BedBaselineRecord> {
    await this.registry.admin(by);
    const baseline = await this.getBaseline(executor, probeId);
    if (!baseline) throw new Error(`未找到执行器 ${executor} 探针 ${probeId} 的登记基线`);
    return baseline;
  }
