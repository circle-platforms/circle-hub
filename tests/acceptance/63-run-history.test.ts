import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { RunHistoryExport } from '../../contracts/src/run.ts';
import { canonicalBytes, newId, sha256Hex } from '../../hub/records/api.ts';
import type { JobBinding } from '../../hub/dispatch/journal.ts';
import { definition } from '../../hub/dispatch/testing/definition.ts';
import type { TestUser } from '../../hub/server/testing-real.ts';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { DOCUMENTS } from '../fixtures/agile/index.ts';
import { bedPacks, openBed, type Bed } from './support/hub.ts';
import type { McpClient } from './support/mcp.ts';
import { startReview } from './support/review.ts';

describe('scenario 63: a run lists the earlier target verifications of the subject it judges', () => {
  let postgres: TemporaryPostgres;
  let bed: Bed;
  let writer: TestUser, other: TestUser;
  let client: McpClient, otherClient: McpClient;
  let executorDigest: string;
  const EXECUTOR = 'exe_0000000000000000000000000a';
  const SUBJECT = `agile:mindmap:${DOCUMENTS.tiny}`, ANOTHER = `agile:mindmap:${DOCUMENTS.untagged}`;

  before(async () => {
    postgres = await startPostgres();
    bed = await openBed({ postgres, repositoryPacks: await bedPacks(), syncOneName: false, plm: false });
    writer = await bed.user('合成编写者', ['case-review']);
    other = await bed.user('另一位合成编写者', ['case-review']);
    client = await bed.connect(writer, 'sess-s63');
    otherClient = await bed.connect(other, 'sess-s63-b');
    executorDigest = (await bed.hub.records.objects.put(canonicalBytes(definition('http://192.0.2.20:7000/mcp')), 'application/json')).sha256;
  });
  after(async () => {
    await bed?.close();
    await postgres?.stop();
  });

  const review = async (as: McpClient, external: string) => startReview(as, { product: bed.product.names[0], version: bed.site.LINE, inputs: { subject: { external } } });
  type Verdict = 'pass' | 'fail';
  async function job(run: { run: string; items: Array<{ id: string }> }, runner: TestUser, planRun: string, end: { effective: { at: string; verdict: Verdict } } | 'not_sent' | 'running'): Promise<string> {
    const journal = bed.hub.hub.dispatch!.journal, id = sha256Hex(newId('job')), workbook = sha256Hex(`synthetic workbook of ${run.run}`);
    const items = run.items.map((item) => item.id);
    const binding = {
      job: id, initiated_by: bed.hub.admin.principal.id, executor: EXECUTOR, executor_digest: executorDigest, target_key: sha256Hex('synthetic-bed'), user: runner.principal.id, resources: ['synthetic/device/a'],
      input: { run: run.run, user: runner.principal.id, lineage: run.run, ancestors: [], item: items[0], items, plan_run: planRun, sha256: workbook, target: 'synthetic-bed', manifest_sha256: 'a'.repeat(64), build: 'synthetic-build', generator: 'synthetic-workflow@1.0.0', result: `rec:${'b'.repeat(64)}` },
    } satisfies JobBinding;
    await journal.append(binding, 'reservation', 'validate', 'completed', { binding });
    if (end === 'running') return id;
    if (end === 'not_sent') { await journal.append(binding, 'complete', 'validate', 'completed', { done: true, outcome: 'not_dispatched', submit_invoked: false, public_reason: '合成：没有发出' }); return id; }
    const rows = items.map((item) => ({ item, dynamic_terminal: end.effective.verdict, accepted_as_fact: false, qualifier: { nature: 'judgment', marks: ['target_reported', 'report_for_dispatch', 'local_ops_not_excluded'] }, missing_facts: [] }));
    const projection = await bed.hub.records.artifacts.ingest({ bytes: canonicalBytes({ job: id, sha256: workbook, rows }), mediaType: 'application/json', origin: { generated: { generator: 'dispatch@1', inputs: [] } }, author: { user: null }, provenanceType: 'projected', visibility: { readers: [runner.principal.id], admins: true, packs: [], shareable: false } });
    await journal.append(binding, 'result', 'read_back', 'completed', { reference: `src:${projection.body.sha256}` });
    await journal.append(binding, 'complete', 'read_back', 'completed', { done: true, outcome: 'effective', ended_at: end.effective.at });
    return id;
  }
  const history = (run: string, token: string, query = '') => fetch(`${bed.hub.url}/run-export/${run}/history${query}`, { headers: { authorization: `Bearer ${token}` } });

  test('what is listed, in which order, within which bound, and what stays out', async () => {
    const plan1 = await review(client, SUBJECT), first = await review(client, SUBJECT);
    const plan2 = await review(client, SUBJECT), second = await review(client, SUBJECT);
    const unsent = await review(client, SUBJECT), running = await review(client, SUBJECT);
    const elsewhere = await review(client, ANOTHER), theirs = await review(otherClient, SUBJECT);
    assert.ok(first.sources.find((source) => source.role === 'subject')?.external?.startsWith(`${SUBJECT}@`), 'the subject is bound by its external identity with the revision read');
    const firstJob = await job(first, writer, plan1.run, { effective: { at: '2026-11-18T03:00:00.000Z', verdict: 'fail' } });
    const secondJob = await job(second, writer, plan2.run, { effective: { at: '2026-11-19T03:00:00.000Z', verdict: 'pass' } });
    await job(unsent, writer, plan2.run, 'not_sent');
    await job(running, writer, plan2.run, 'running');
    await job(elsewhere, writer, elsewhere.run, { effective: { at: '2026-11-19T04:00:00.000Z', verdict: 'pass' } });
    await job(theirs, other, theirs.run, { effective: { at: '2026-11-19T05:00:00.000Z', verdict: 'fail' } });

    const now = await review(client, SUBJECT);
    const answer = await history(now.run, writer.token);
    assert.equal(answer.status, 200, await answer.clone().text());
    const bytes = Buffer.from(await answer.arrayBuffer());
    assert.equal(answer.headers.get('content-digest'), `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`);
    const listed = RunHistoryExport.parse(JSON.parse(bytes.toString('utf8')));
    const items = (run: typeof first) => run.items.map((item) => item.id);
    assert.ok(items(first).length >= 1 && items(first).every((item) => items(now).includes(item)), 'the rows of an earlier run are keyed by the items of the same subject');
    assert.deepEqual(listed, {
      schema: 'run-history@1', run: now.run, subjects: [SUBJECT], limit: 8, complete: true,
      runs: [
        { run: second.run, started_at: second.started_at, build: second.build ?? null, jobs: [{ job: secondJob, plan_run: plan2.run, ended_at: '2026-11-19T03:00:00.000Z', outcome: 'effective', rows: items(second).map((item) => ({ item, dynamic_terminal: 'pass' })) }] },
        { run: first.run, started_at: first.started_at, build: first.build ?? null, jobs: [{ job: firstJob, plan_run: plan1.run, ended_at: '2026-11-18T03:00:00.000Z', outcome: 'effective', rows: items(first).map((item) => ({ item, dynamic_terminal: 'fail' })) }] },
      ],
    }, 'the two runs of this subject whose job took effect, newest first; the job never sent, the one still running, the other subject and the other writer stay out');

    const bounded = RunHistoryExport.parse(await (await history(now.run, writer.token, '?limit=1')).json());
    assert.deepEqual([bounded.limit, bounded.runs.map((run) => run.run)], [1, [second.run]]);
    for (const query of ['?limit=0', '?limit=9', '?limit=two', '?limit=1&x=1', '?other=1']) assert.equal((await history(now.run, writer.token, query)).status, 400, query);

    const jobs = await fetch(`${bed.hub.url}/run-export/${second.run}/jobs`, { headers: { authorization: `Bearer ${writer.token}` } });
    assert.equal(jobs.status, 200, await jobs.clone().text());
    const exported = await jobs.json() as { jobs: Array<{ job: string; outcome: string; rows: Array<{ item: string; dynamic_terminal: string }> }> };
    assert.deepEqual(exported.jobs.map((row) => [row.job, row.outcome, row.rows.map((r) => [r.item, r.dynamic_terminal])]), [[secondJob, 'effective', items(second).map((item) => [item, 'pass'])]]);

    const others = RunHistoryExport.parse(await (await history((await review(otherClient, SUBJECT)).run, other.token)).json());
    assert.deepEqual(others.runs.map((run) => run.run), [theirs.run]);
    assert.equal((await history(now.run, other.token)).status, 404);
    assert.equal((await history(now.run, 'not-a-token')).status, 401);
    const all = RunHistoryExport.parse(await (await history(now.run, bed.hub.admin.token)).json());
    assert.deepEqual(all.runs.map((run) => run.run), [theirs.run, second.run, first.run]);
  });

  test('a subject nothing verified answers an empty list, not an error', async () => {
    const lonely = await review(client, `agile:mindmap:${DOCUMENTS.unlisted}`);
    const answer = await history(lonely.run, writer.token);
    assert.equal(answer.status, 200, await answer.clone().text());
    assert.deepEqual(RunHistoryExport.parse(await answer.json()), { schema: 'run-history@1', run: lonely.run, subjects: [`agile:mindmap:${DOCUMENTS.unlisted}`], limit: 8, complete: true, runs: [] });
  });
});
