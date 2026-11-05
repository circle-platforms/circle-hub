// Synthetic runs and requests for tests of maintenance rounds. Nothing here runs a pack function, so these tests need no sandbox.
import { runRecord } from '../../../../contracts/src/fixtures.ts';
import { RunRecord } from '../../../../contracts/src/run.ts';
import { newId, type StoredRecord } from '../../../records/api.ts';
import type { RequestBody } from '../../../requests/api.ts';
import { createEngineContext, type EngineContext } from '../deps.ts';
import type { Harness } from './harness.ts';
import { putRun } from '../store.ts';

export const FAR_AHEAD = '2030-01-01T00:00:00.000Z';

/** A run a visit has nothing to do for: judged work (no production to recover), its deadline far ahead, nothing bound. */
export function quietRun(h: Pick<Harness, 'alice' | 'review'>, overrides: Partial<RunRecord> = {}): RunRecord {
  const { client_key: _key, request_digest: _digest, client_key_expires_at: _expiry, ...base } = runRecord;
  return RunRecord.parse({
    ...base, run: newId('run'), runner: h.alice.id, pack: `${h.review.pack.id}@${h.review.pack.version}`, pack_digest: h.review.pack.digest,
    sources: [], items: [], target_basis: [], submission_due: FAR_AHEAD,
    requirements: runRecord.requirements.map((requirement) => ({ ...requirement, accepted_producer: 'judgment' })),
    ...overrides,
  });
}

export const storeQuietRun = (h: Pick<Harness, 'alice' | 'review' | 'kit'>, overrides: Partial<RunRecord> = {}, at = '2026-10-22T08:00:00.000Z'): Promise<StoredRecord<RunRecord>> =>
  putRun(h.kit.store, quietRun(h, overrides), at);

/** A request of a run; `missing` is what names it in a test. */
export const requestOf = (run: StoredRecord<RunRecord>, audience: string, due: string, missing: string, overrides: Partial<RequestBody> = {}): RequestBody =>
  ({ run: run.body.run, kind: 'clarification', audience, due, missing, next_action: '合成的下一步', source: run.digest, code: 'missing_input', ...overrides });

/** The engine on a harness's records with a clock of its own, for what the service does not expose: a round's memory and `stop`. */
export const engineOn = (h: Pick<Harness, 'kit' | 'workflows' | 'packs' | 'knowledge' | 'external'>, now: () => Date): EngineContext =>
  createEngineContext({ records: h.kit, workflows: h.workflows, packs: h.packs, knowledge: h.knowledge, external: h.external, now });
