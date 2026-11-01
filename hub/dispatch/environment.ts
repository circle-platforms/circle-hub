// The state of a runtime environment as the journal establishes it, read-only, for administrators (the console's
// environments). Occupancy is the jobs that hold the environment's physical target by the same rule that blocks a new
// dispatch (holdsPhysicalTarget: an active reservation, an intent without an end, an unresolved effect); a held job is
// frozen when it waits for a disposition of an unconfirmed result (isFrozen); a bed left unrestored by a job blocks the
// next dispatch until a precheck finds it clean or an administrator clears it. The latest dispatch is the newest
// reservation that was not read-only, and the reported version is what the executor said of itself (serverInfo.version)
// in the newest MCP initialize the Hub kept. A fact that could not be read is false in `known` and named in `missing`:
// unknown, never shown as free, as none or as held.
import type { EffectOutcome } from '../../contracts/generated/vocabulary.ts';
import type { ActionBody, Page, StoredRecord } from '../records/api.ts';

/** A JSON value as an object: the value when it is one, else an empty one. */
const object = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

export interface EnvironmentJob {
  job: string;
  /** The run the job verified, from its reservation; null when the reservation names none. */
  run: string | null;
  /** The job waits for a disposition of an unconfirmed result (an open uncertain request, isFrozen). */
  frozen: boolean;
  outcome: EffectOutcome;
  phase: string;
}

export interface EnvironmentFacts {
  executor: string;
  enabled: boolean;
  /** The registered source definition: its digest, and when that registration was decided (null when unknown). */
  registration: { digest: string; decided_at: string | null };
  /**
   * Which facts were read: occupancy (the jobs holding the target and the bed hold), the latest dispatch, the reported
   * version. False means unknown, and the matching field below is null without meaning "none".
   */
  known: { occupancy: boolean; latest: boolean; version: boolean };
  /** Jobs holding the physical target, frozen ones first; null when they could not be read. */
  holding: EnvironmentJob[] | null;
  /** The bed a job left unrestored (an open bed hold); null when there is none or it could not be read. */
  bed_hold: { job: string; bed: string } | null;
  /** The newest dispatch that was not read-only, with the current status of its job; null when there is none. */
  latest: { job: string; run: string | null; at: string; outcome: EffectOutcome; frozen: boolean } | null;
  /** The version the executor reported in the newest session the Hub kept; null when none was kept or none reported. */
  reported_version: string | null;
  /** What could not be read, in words, for the page. */
  missing: string[];
}

/** How many newest-first pages of an executor's journal are read for its latest dispatch and session, and their size. */
export const NEWEST_PAGES = 50;
export const NEWEST_PAGE_SIZE = 100;

const RUN_ID = /^run_[0-9a-z]{26}$/;

/** The run a reservation's binding verified (the verification run, else the run it names), if any. */
export function bindingRun(binding: unknown): string | null {
  const b = object(binding);
  const input = object(b.input);
  const run = typeof input.run === 'string' ? input.run : typeof b.run === 'string' ? b.run : null;
  return run !== null && RUN_ID.test(run) ? run : null;
}

/**
 * The serverInfo.version of an MCP initialize answer as the Hub kept it (a JSON body, a batch, or server-sent events);
 * null when it is not there.
 */
export function reportedVersion(bytes: Uint8Array): string | null {
  const text = new TextDecoder().decode(bytes);
  const answers: unknown[] = [];
  try {
    answers.push(JSON.parse(text));
  } catch {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      try {
        answers.push(JSON.parse(line.slice(5).trim()));
      } catch {
        // Not a JSON event: skipped.
      }
    }
  }
  for (const answer of answers.flatMap((value) => (Array.isArray(value) ? value : [value]))) {
    const version = object(object(object(answer).result).serverInfo).version;
    if (typeof version === 'string' && version.length > 0 && version.length <= 200 && !/[\u0000-\u001f\u007f]/.test(version)) return version;
  }
  return null;
}

/**
 * The newest reservation that was not read-only and the newest kept initialize answer, reading an executor's events newest
 * first page by page until both are found, the events end or `pages` were read. `exhausted` says the events ended: what
 * was not found then does not exist; otherwise it is unknown.
 */
export async function scanNewest(read: (cursor: string | null) => Promise<Page<StoredRecord<ActionBody>>>, pages = NEWEST_PAGES): Promise<{ reservation: StoredRecord<ActionBody> | null; initialize: StoredRecord<ActionBody> | null; exhausted: boolean }> {
  let reservation: StoredRecord<ActionBody> | null = null;
  let initialize: StoredRecord<ActionBody> | null = null;
  let cursor: string | null = null;
  for (let n = 0; n < pages; n += 1) {
    const page = await read(cursor);
    const found = newestOf(page.items);
    reservation ??= found.reservation;
    initialize ??= found.initialize;
    cursor = page.next;
    if (cursor === null) return { reservation, initialize, exhausted: true };
    if (reservation !== null && initialize !== null) break;
  }
  return { reservation, initialize, exhausted: false };
}

/** The newest reservation that was not read-only and the newest kept initialize answer, from an executor's newest events. */
export function newestOf(events: readonly StoredRecord<ActionBody>[]): { reservation: StoredRecord<ActionBody> | null; initialize: StoredRecord<ActionBody> | null } {
  let reservation: StoredRecord<ActionBody> | null = null;
  let initialize: StoredRecord<ActionBody> | null = null;
  for (const event of events) {
    const detail = event.body.detail;
    if (reservation === null && detail.phase === 'reservation' && detail.read_only !== true) reservation = event;
    if (initialize === null && detail.phase === 'initialize.response') initialize = event;
    if (reservation !== null && initialize !== null) break;
  }
  return { reservation, initialize };
}
