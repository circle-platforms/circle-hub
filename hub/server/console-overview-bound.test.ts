import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runRecord } from '../../contracts/src/fixtures.ts';
import type { ServerDeps } from './api.ts';
import { overviewPage } from './console/overview.ts';
import type { PageContext } from './console/pages.ts';

const NOW = new Date('2026-11-04T08:00:00.000Z');
const RECENT = 12;

/** Overview over RECENT listed runs, with `others` requests of runs the page does not list; counts every request it is given. */
async function overview(others: number): Promise<{ body: string; read: number; queries: unknown[]; calls: (string | undefined)[] }> {
  const items = Array.from({ length: RECENT }, (_, n) => ({ ...runRecord, run: `run_${String(n).padStart(26, '0')}`, started_at: new Date(NOW.getTime() - n * 60_000).toISOString() }));
  const request = (run: string, n: number, answered: string | null) => ({ record: String(n).padStart(64, '0'), run, kind: 'clarification', audience: runRecord.runner, due: '2026-11-05T00:00:00.000Z', missing: '合成待回应事项', next_action: '合成后续处理', source: 'e'.repeat(64), code: 'awaiting_step', answered_by: answered });
  const listed = items.flatMap((run, n) => [request(run.run, 2 * n, null), request(run.run, 2 * n + 1, 'a'.repeat(64))]);
  const unrelated = Array.from({ length: others }, (_, n) => request('run_' + 'z'.repeat(26), 1000 + n, null));
  const queries: unknown[] = [], calls: (string | undefined)[] = [];
  let read = 0;
  const deps = {
    now: () => NOW,
    config: { dataDir: '/nonexistent/synthetic' },
    knowledge: { builds: async () => [] },
    packs: { list: async () => [] },
    records: { callLog: { query: async () => ({ items: [], next: null }) }, store: {} },
    runs: {
      listRuns: async (_by: unknown, query: unknown) => { queries.push(query); return { items, next: null }; },
      getRun: async () => null,
      listRequests: async (_by: unknown, run?: string) => {
        calls.push(run);
        const rows = run === undefined ? [...listed, ...unrelated] : listed.filter((row) => row.run === run);
        read += rows.length;
        return rows;
      },
    },
  };
  const ctx: PageContext = { deps: deps as unknown as ServerDeps, principal: { id: runRecord.runner, name: '合成用户', role: 'user' }, admin: false, url: new URL('/console/overview', 'http://127.0.0.1'), userName: async () => '合成用户', chrome: (title) => ({ title, user: { name: '合成用户', role: '用户', admin: false }, csrf: null }) } as PageContext;
  return { body: String((await overviewPage(ctx)).body), read, queries, calls };
}

test('the overview reads the requests of the runs it lists, however many requests other runs hold', async () => {
  const small = await overview(0);
  const large = await overview(5000);
  assert.equal(large.read, small.read, 'requests of other runs add no read');
  assert.equal(large.read, 2 * RECENT);
  assert.deepEqual(large.calls.toSorted(), Array.from({ length: RECENT }, (_, n) => `run_${String(n).padStart(26, '0')}`), 'one read per listed run, and none of every request');
  assert.ok(large.queries.every((query) => (query as { requests?: boolean }).requests === false), 'the run listing is not asked for the request fields it would read in full');
  assert.equal(large.body, small.body, 'the page is the same');
  assert.match(large.body, new RegExp(`等待回应中的请求[\\s\\S]*?${RECENT}`), 'unanswered requests of the listed runs are still counted');
});
