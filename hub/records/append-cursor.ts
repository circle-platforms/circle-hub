// Following the append log: what was appended since the last read, at a cost set by that alone. A position alone is not a
// safe cursor, because positions are handed out before commit: a transaction holding a position can commit after a newer one
// was read, and `seq > cursor` would never see it. So a cursor has two marks. Below `settled` nothing can still appear; above
// it every read looks again, and `seen` keeps a record from being returned twice. `settled` moves to the position of the last
// horizon once every transaction open at that horizon has ended (AppendHorizon). Only a later horizon can show that, so `settled`
// is one read behind even when nothing is open. An open transaction delays `settled`, never what is returned.
import { setTimeout as delay } from 'node:timers/promises';
import type { AppendedEntry, AppendedQuery, RecordStore } from './api.ts';

export interface AppendCursor {
  /** Every record at or below this position is visible, and was read or came before this cursor. */
  settled: number;
  /** The last horizon read: its position and its `next`. */
  held: { position: number; next: number };
  /** The positions above `settled` already returned. */
  seen: Set<number>;
}

const START_TRIES = 20;
const START_WAIT_MS = 100;

/**
 * A cursor at the end of the log. What it starts from is settled by nothing before it, so it first waits for the transactions
 * open now to end, a short while at most: a caller that reads the whole history once right after this sees what they wrote.
 * A transaction open longer than the wait may commit unseen, and only a later whole read of the history finds that.
 */
export async function openAppendCursor(store: Required<Pick<RecordStore, 'appendHorizon'>>, options: { tries?: number; waitMs?: number } = {}): Promise<AppendCursor> {
  const first = await store.appendHorizon();
  for (let now = first, tries = options.tries ?? START_TRIES; now.oldest < first.next && tries > 0; tries--) {
    await delay(options.waitMs ?? START_WAIT_MS);
    now = await store.appendHorizon();
  }
  return { settled: first.position, held: { position: first.position, next: first.next }, seen: new Set() };
}

/** What the log gained since the last read of this cursor: every matching record exactly once, whatever order they committed in. */
export async function readAppended(store: Required<Pick<RecordStore, 'appendHorizon' | 'appended'>>, cursor: AppendCursor, query: Omit<AppendedQuery, 'after' | 'through'>): Promise<AppendedEntry[]> {
  const horizon = await store.appendHorizon();
  const rows = horizon.position > cursor.settled ? await store.appended({ ...query, after: cursor.settled, through: horizon.position }) : [];
  const fresh = rows.filter((row) => !cursor.seen.has(row.position));
  // After the read: this horizon proves the last one's position is complete, and `rows` was read later still, so it holds it all.
  if (horizon.oldest >= cursor.held.next) cursor.settled = cursor.held.position;
  cursor.held = { position: horizon.position, next: horizon.next };
  cursor.seen = new Set(rows.filter((row) => row.position > cursor.settled).map((row) => row.position));
  return fresh;
}
