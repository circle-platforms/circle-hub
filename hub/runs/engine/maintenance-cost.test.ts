// The guard of decision 146 on scheduled maintenance: what a round costs follows what changed, not the history. Read from the
// usage the trace of the round reports, so it counts what the database returned, never a clock. No pack function runs here.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createRequestService } from '../../requests/api.ts';
import { installTraceSink, type SpanRow } from '../../telemetry/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { openHarness, type Harness } from './testing/harness.ts';
import { FAR_AHEAD, requestOf, storeQuietRun } from './testing/maintenance.ts';
import { putAction } from './store.ts';

let pg: TemporaryPostgres;
// Its own cluster: an idle round costs its least once the cursor has settled, and any other test file's open transaction delays that.
before(async () => { pg = await startPostgres({ private: true }); });
after(async () => { await pg?.stop(); });

interface Cost { queries: number; rows: number; bytes: number }

/** What the round `work` runs reads, as its own trace reports it. */
async function costOf(work: () => Promise<void>): Promise<Cost> {
  const spans: SpanRow[] = [];
  const uninstall = installTraceSink({ push: (row) => spans.push(row) });
  try { await work(); } finally { uninstall(); }
  const usage = spans.find((row) => row.is_root && row.name === 'maintain-runs')!.usage;
  return { queries: usage['db.queries'] ?? 0, rows: usage['db.rows'] ?? 0, bytes: usage['db.bytes'] ?? 0 };
}

const PAST = '2026-10-21T08:00:00.000Z';
const DIGITS_PER_ROW = 3;
const IDLE_QUERIES = 2;

/** Runs shaped like a production history: most requests overdue and unanswered, some answered, a few still ahead. */
async function history(h: Harness, runs: number) {
  const requests = createRequestService(h.kit);
  const stored = [];
  for (let at = 0; at < runs; at++) {
    const run = await storeQuietRun(h), n = String(at).padStart(3, '0');
    stored.push(run);
    for (let m = 0; m < 3; m++) await requests.write(requestOf(run, h.alice.id, PAST, `合成逾期 ${n}-${m}`));
    await requests.write(requestOf(run, h.alice.id, FAR_AHEAD, `合成未到期 ${n}`));
    const answered = await requests.write(requestOf(run, h.alice.id, PAST, `合成已答 ${n}`));
    await requests.answer(answered.digest, run.digest);
    await requests.write(requestOf(run, h.admin.id, PAST, `合成包修复 ${n}`, { kind: 'repair', pack_digest: h.review.pack.digest }));
  }
  return stored;
}

async function measure(runs: number) {
  const h = await openHarness(pg);
  try {
    const stored = await history(h, runs);
    const round = () => h.service.maintain({ incremental: true });
    // Until the rounds have taken in all that was written. A transaction elsewhere in the cluster can make that take a round more.
    const settled = async () => { for (let tries = 0; tries < 50 && (await costOf(round)).queries > IDLE_QUERIES; tries++); };
    await settled();
    const idle = await costOf(round), again = await costOf(round);
    // One thing happens to one run: a new action and a new overdue request.
    const at = new Date().toISOString();
    await putAction(h.kit.store, { action: 'validate', run: stored[0].body.run, inputs: [], startedAt: at, endedAt: at, acceptance: null, codes: [], detail: { synthetic: true } });
    await createRequestService(h.kit).write(requestOf(stored[0], h.alice.id, PAST, '合成新事'));
    const change = await costOf(round);
    await settled();
    const quietAgain = await costOf(round);
    const full = await costOf(() => h.service.maintain());
    return { idle, again, change, quietAgain, full, accounts: (await h.kit.principals.list()).length };
  } finally { await h.close(); }
}

test('a round reads a fixed small amount when nothing changed and what changed when something did, whatever the history', async () => {
  const small = await measure(6), large = await measure(24);
  const same = (a: Cost, b: Cost, what: string) => {
    assert.deepEqual([a.queries, a.rows], [b.queries, b.rows], what);
    // Positions are read as text: a longer log takes a digit more to write down, which is all the bytes may differ by.
    assert.ok(Math.abs(a.bytes - b.bytes) <= DIGITS_PER_ROW * a.rows, `${what}: ${a.bytes} and ${b.bytes} bytes`);
  };
  same(large.idle, small.idle, 'the same rows and queries with four times the runs and requests');
  same(small.again, small.idle, 'and the same round after round');
  same(large.again, large.idle, 'and the same round after round');
  same(large.quietAgain, large.idle, 'and again once what changed has settled');
  assert.equal(small.idle.queries, IDLE_QUERIES, 'the account list and the end of the log');
  assert.equal(small.idle.rows, small.accounts + 1);
  same(large.change, small.change, 'one change costs the same over any history');
  assert.ok(small.change.rows > small.idle.rows, 'and it is read');
  assert.ok(large.full.rows > small.full.rows * 3 && large.full.queries > small.full.queries * 2, 'the counters do see history: a pass over everything grows with it');
});
