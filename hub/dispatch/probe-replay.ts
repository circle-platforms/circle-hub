import type { ActionBody, Principal, RecordsKit } from '../records/api.ts';
import { sha256Hex } from '../records/api.ts';
import type { HolderSnapshot } from '../leases/api.ts';
import type { ExecutorDefinition } from './definition.ts';
import { digestOfValue } from './journal.ts';
import { rpcResponse, toolContent } from './observations.ts';
import type { Exchange } from './transport.ts';

export const BOOKING_PROBE_KEY = 'dispatch.booking_probe';
export const bookingProbeKey = (run: string, executor: string, inventory: string, device: string): string => `${run}:${executor}:${inventory}#${device}`;

export function leaseGeneration(rows: readonly Pick<HolderSnapshot, 'key' | 'lease'>[]): string {
  return digestOfValue(rows.map((row) => [row.key, row.lease]).sort((left, right) => (left[0]! < right[0]! ? -1 : left[0]! > right[0]! ? 1 : 0)));
}

export function leasesLive(rows: readonly Pick<HolderSnapshot, 'released' | 'expires_at'>[], now: number): boolean {
  return rows.length > 0 && rows.every((row) => !row.released && (row.expires_at === null || Date.parse(row.expires_at) > now));
}

export interface ReplayIdentity {
  ancestors: readonly string[];
  executor: string;
  executorDigest: string;
  leases: string;
}

export interface Replayed {
  run: string;
  observed_at: string;
  exchanges: ReadonlyMap<string, Exchange>;
}

async function exchange(records: RecordsKit, owner: Principal, reference: string, observedAt: string): Promise<Exchange> {
  if (!reference.startsWith('src:')) throw new Error('not a source reference');
  const sha = reference.slice(4);
  const source = await records.artifacts.source(owner, sha, { consumer: 'function' });
  if (!source?.bytes || sha256Hex(source.bytes) !== sha) throw new Error('kept answer failed its integrity check');
  const value = toolContent(rpcResponse(new TextDecoder('utf-8', { fatal: true }).decode(source.bytes)));
  return { value, source: reference, received_at: observedAt, started_at: observedAt };
}

export async function replayBookingVersions(records: RecordsKit, owner: Principal, identity: ReplayIdentity, d: ExecutorDefinition): Promise<Replayed | null> {
  if (!d.probes || !d.manifest_sha256) return null;
  for (const run of identity.ancestors) {
    const exchanges = new Map<string, Exchange>();
    let oldest = '';
    let complete = true;
    for (const seat of d.probes.seats) {
      const found = (await records.store.find<ActionBody>({ kind: 'action', key: BOOKING_PROBE_KEY, value: bookingProbeKey(run, identity.executor, d.manifest_sha256, seat.manifest.device), newestFirst: true, limit: 1 })).items[0];
      const detail = found?.body.detail;
      const references = detail?.probe_references;
      const observation = detail?.observation;
      const reference = typeof references === 'object' && references !== null ? (references as Record<string, unknown>).version : undefined;
      const observedAt = typeof observation === 'object' && observation !== null ? (observation as Record<string, unknown>).observed_at : undefined;
      if (!found || detail?.executor !== identity.executor || detail?.executor_digest !== identity.executorDigest || detail?.lease_generation !== identity.leases || typeof reference !== 'string' || typeof observedAt !== 'string') { complete = false; break; }
      try {
        exchanges.set(`${seat.index}.version`, await exchange(records, owner, reference, observedAt));
        if (oldest === '' || observedAt < oldest) oldest = observedAt;
      } catch { complete = false; break; }
    }
    if (complete) return { run, observed_at: oldest, exchanges };
  }
  return null;
}
