import type { ActionBody, RecordsKit } from '../records/api.ts';
import { sha256Hex } from '../records/api.ts';
import type { ExecutorDefinition } from './definition.ts';
import { rpcResponse, toolContent } from './observations.ts';
import type { Exchange } from './transport.ts';

export const BOOKING_PROBE_KEY = 'dispatch.booking_probe';
export const bookingProbeKey = (run: string, executor: string, inventory: string, device: string): string => `${run}:${executor}:${inventory}#${device}`;

interface Identity {
  ancestors: readonly string[];
  user: string;
  executor: string;
  executorDigest: string;
}

async function exchange(records: RecordsKit, user: string, reference: string, observedAt: string): Promise<Exchange> {
  if (!reference.startsWith('src:')) throw new Error('not a source reference');
  const sha = reference.slice(4);
  const source = await records.artifacts.source({ id: user, name: '', role: 'user' }, sha, { consumer: 'function' });
  if (!source?.bytes || sha256Hex(source.bytes) !== sha) throw new Error('cached response failed its integrity check');
  const value = toolContent(rpcResponse(new TextDecoder('utf-8', { fatal: true }).decode(source.bytes)));
  return { value, source: reference, received_at: observedAt, started_at: observedAt };
}

/** Re-read the original responses of one complete booking observation. Nothing is replayed across executor definitions or
 * mixed from different bookings: a missing interface response, changed digest or unreadable original means a fresh probe. */
export async function replayBookingProbes(records: RecordsKit, identity: Identity, d: ExecutorDefinition): Promise<{ run: string; exchanges: ReadonlyMap<string, Exchange> } | null> {
  if (!d.probes || !d.manifest_sha256) return null;
  for (const run of identity.ancestors) {
    const exchanges = new Map<string, Exchange>();
    let complete = true;
    for (const seat of d.probes.seats) {
      const found = (await records.store.find<ActionBody>({ kind: 'action', key: BOOKING_PROBE_KEY, value: bookingProbeKey(run, identity.executor, d.manifest_sha256, seat.manifest.device), newestFirst: true, limit: 1 })).items[0];
      const detail = found?.body.detail;
      const observation = detail?.observation;
      const references = detail?.probe_references;
      if (!found || detail?.executor !== identity.executor || detail?.executor_digest !== identity.executorDigest || typeof observation !== 'object' || observation === null || typeof references !== 'object' || references === null) { complete = false; break; }
      try {
        for (const check of ['version', 'interfaces'] as const) {
          const reference = (references as Record<string, unknown>)[check];
          if (typeof reference !== 'string') throw new Error('incomplete booking observation');
          exchanges.set(`${seat.index}.${check}`, await exchange(records, identity.user, reference, String((observation as Record<string, unknown>).observed_at)));
        }
      } catch { complete = false; break; }
    }
    if (complete) return { run, exchanges };
  }
  return null;
}
