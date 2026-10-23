import type { ActionBody, Principal, RecordsKit, StoredRecord, Transaction } from '../records/api.ts';
import type { ActionKind, ActionResult } from '../../contracts/generated/vocabulary.ts';
import { newId, sha256Hex, canonicalBytes } from '../records/api.ts';
import type { HolderSnapshot } from '../leases/api.ts';
import type { VerifiedInput } from './proof.ts';
export interface JobBinding { job: string; initiated_by: string; acting_by?: string; executor: string; executor_digest: string; target_key: string; input: VerifiedInput | null; user: string; resources: string[]; fences?: HolderSnapshot[]; context?: Record<string, unknown>; }
export type Event = StoredRecord<ActionBody>;
export class Journal {
  readonly records: RecordsKit;
  readonly now: () => Date;
  constructor(records: RecordsKit, now: () => Date) { this.records = records; this.now = now; }
  async events(job: string): Promise<Event[]> { return this.records.store.findMany<ActionBody>({ key: 'dispatch.job', values: [job], kind: 'action' }); }
  async targets(resources: readonly string[]): Promise<Event[]> { return this.records.store.findMany<ActionBody>({ key: 'dispatch.resource', values: resources.map(r => sha256Hex(r)), kind: 'action' }); }
  async append(binding: JobBinding, phase: string, action: ActionKind, result: ActionResult, detail: Record<string, unknown> = {}, inputs: string[] = [], unique_key?: string, tx?: Transaction) {
    const time = this.now().toISOString();
    return this.records.store.put<ActionBody>({ kind: 'action', schema: 'action@1', provenance: 'observed', created_at: time,
      body: { action, run: binding.input?.run ?? null, item: binding.input?.item ?? null, inputs, component: 'dispatch@1', lease: binding.fences?.length ? { lease: binding.fences[0].lease, fencing: binding.fences[0].fencing } : null, started_at: typeof detail.started_at === 'string' ? detail.started_at : time, ended_at: typeof detail.ended_at === 'string' ? detail.ended_at : time, result,
        error_code: result === 'error' ? (phase === 'heartbeat' ? 'LEASE_UNAVAILABLE' : 'SOURCE_UNAVAILABLE') : null, acceptance: phase === 'gate' && detail.allow_submit === true ? 'accepted' : null, codes: result === 'error' ? [phase === 'heartbeat' ? 'LEASE_UNAVAILABLE' : 'SOURCE_UNAVAILABLE'] : [], detail: { job: binding.job, initiated_by: binding.initiated_by, acting_by: binding.acting_by ?? binding.initiated_by, phase, event: newId('evt'), ...detail } },
      index: [{ key: 'dispatch.job', value: binding.job }, { key: 'dispatch.phase', value: phase }, { key: 'dispatch.target', value: binding.target_key }, ...binding.resources.map(r => ({ key: 'dispatch.resource', value: sha256Hex(r) })),
        ...(binding.input ? [{ key: 'dispatch.lineage', value: binding.input.lineage }, ...(phase === 'intent' ? [{ key: 'dispatch.bytes', value: binding.input.sha256 }] : [])] : [])], ...(unique_key ? { unique_key } : {}) }, tx);
  }
  async raw(binding: JobBinding, bytes: Uint8Array, operation: string, complete: boolean): Promise<{ reference: string; record: string }> {
    const source = await this.records.artifacts.ingest({ bytes, mediaType: 'application/json', origin: { read: { object: `executor:${binding.executor}:${binding.job}:${operation}` } }, author: { user: null }, provenanceType: 'observed',
      visibility: { readers: [binding.user], admins: true, packs: [], shareable: false }, readTier: 'function_bytes_only', name: complete ? 'response.json' : 'incomplete-response.json' });
    return { reference: `src:${source.body.sha256}`, record: `rec:${source.digest}` };
  }
  async binding(job: string): Promise<JobBinding> {
    const event = (await this.events(job)).find(e => e.body.detail.phase === 'reservation');
    if (!event) throw new Error('作业对你不可用');
    return event.body.detail.binding as unknown as JobBinding;
  }
}
export const newJob = () => sha256Hex(newId('job'));
export function isFrozen(events: readonly Event[]): boolean {
  let frozen = false;
  for (const e of events) {
    if (e.body.detail.uncertain === true) frozen = true;
    if (e.body.detail.unfreeze === true) frozen = false;
  }
  return frozen;
}
export const isDone = (events: readonly Event[]) => events.some(e => e.body.detail.done === true);
export const eventOf = (events: readonly Event[], phase: string) => [...events].reverse().find(e => e.body.detail.phase === phase);
export const digestOfValue = (value: unknown) => sha256Hex(canonicalBytes(value));
