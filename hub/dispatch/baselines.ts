import type { RemoteLease } from './session-types.ts';
import { sha256Hex, type ActionBody, type Principal } from '../records/api.ts';
import { at, type ExecutorDefinition } from './definition.ts';
import { digestOfValue, newJob, type JobBinding } from './journal.ts';
import { captureText, type BedBaselineRecord } from './bed-state.ts';
import type { RpcClient } from './transport.ts';
import type { DispatchService } from './service.ts';
import { environmentOf } from './precheck-context.ts';

type BaselineContext = Pick<DispatchService, 'registry' | 'options' | 'now' | 'getBaseline'>;
interface RecordBaselineContext extends BaselineContext {
  assertNoSecrets(value: unknown): Promise<void>;
  secret(binding: JobBinding, d: ExecutorDefinition): Promise<string | null>;
  session(binding: JobBinding, d: ExecutorDefinition, secret: string): RpcClient;
  acquire(binding: JobBinding, d: ExecutorDefinition, client: RpcClient, context: Record<string, unknown>): Promise<RemoteLease>;
  context(binding: JobBinding): Record<string, unknown>;
  heartbeat(binding: JobBinding, d: ExecutorDefinition, client: RpcClient, lease: RemoteLease): { stop: () => Promise<void> };
  release(binding: JobBinding, client: RpcClient, lease: RemoteLease): Promise<void>;
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

    const binding: JobBinding = {
      job: newJob(),
      initiated_by: by.id,
      executor,
      executor_digest: registered.resolved_digest,
      executor_source_digest: registered.digest,
      variables: registered.variables,
      scope: { target: d.target, origin: new URL(d.endpoint).origin },
      target_key: digestOfValue([...d.resources].sort()),
      input: null,
      user: by.id,
      resources: [],
      context: { ...environmentOf(d.precheck_context), target: d.target, ...(d.resources.length ? { seats: d.resources.length } : {}), ...(d.manifest_sha256 ? { manifest_sha256: d.manifest_sha256 } : {}) },
    };
    await this.assertNoSecrets(binding);
    const material = await this.secret(binding, d);
    if (material === null) throw new Error('执行器凭据不可用');
    const client = this.session(binding, d, material);
    let lease: RemoteLease | undefined;
    let stop = async () => {};
    try {
      await client.connect();
      lease = await this.acquire(binding, d, client, this.context(binding));
      stop = this.heartbeat(binding, d, client, lease).stop;
      const context = { ...this.context(binding), lease_id: lease.id, lease_token: lease.token };
      const response = await client.declaredRead(item.call, context, `bed.baseline.${item.id}`);
      const raw = at(response.value, item.output ?? '/output');
      if (typeof raw !== 'string') throw new Error(`探针 ${probeId} 未返回文本内容（指针 ${item.output ?? '/output'}）`);
      const text = captureText(raw, item.lead, item.trail);
      const sha256 = sha256Hex(new TextEncoder().encode(text));
      const artifact = await this.options.records.artifacts.ingest({
        bytes: new TextEncoder().encode(text),
        mediaType: 'text/plain',
        origin: { upload: { session: 'bed-baseline' } },
        author: { user: by.id },
        provenanceType: 'observed',
        visibility: { readers: [by.id], admins: true, packs: [], shareable: false },
      });
      const reference = `art:${artifact.body.sha256}`;
      const now = this.now().toISOString();
      const recordBody: BedBaselineRecord = {
        executor,
        probe: probeId,
        sha256,
        reference,
        text,
        recorded_by: by.id,
        created_at: now,
        reason: reason ?? null,
      };
      await this.options.records.store.put<ActionBody>({
        kind: 'action',
        schema: 'action@1',
        provenance: 'observed',
        created_at: now,
        body: {
          action: 'validate',
          run: null,
          item: null,
          inputs: [reference, response.source],
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
    } finally {
      await stop();
      if (lease) await this.release(binding, client, lease);
    }
  }

export async function setBaseline(this: BaselineContext, by: Principal, executor: string, probeId: string, text: string, reason?: string | null): Promise<BedBaselineRecord> {
    await this.registry.admin(by);
    const artifact = await this.options.records.artifacts.ingest({
      bytes: new TextEncoder().encode(text),
      mediaType: 'text/plain',
      origin: { upload: { session: 'bed-baseline' } },
      author: { user: by.id },
      provenanceType: 'observed',
      visibility: { readers: [by.id], admins: true, packs: [], shareable: false },
    });
    const sha256 = sha256Hex(new TextEncoder().encode(text));
    const reference = `art:${artifact.body.sha256}`;
    const now = this.now().toISOString();
    const recordBody: BedBaselineRecord = {
      executor,
      probe: probeId,
      sha256,
      reference,
      text,
      recorded_by: by.id,
      created_at: now,
      reason: reason ?? null,
    };
    await this.options.records.store.put<ActionBody>({
      kind: 'action',
      schema: 'action@1',
      provenance: 'observed',
      created_at: now,
      body: {
        action: 'validate',
        run: null,
        item: null,
        inputs: [reference],
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

