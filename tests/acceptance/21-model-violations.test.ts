// Scenario 21 (brief section 9 & task acceptance.md):
// A scripted model that cites a finding with a location that does not exist, a non-verbatim quotation,
// a command the catalog lacks as present, and a verdict inconsistent with its dispositions:
// each is refused or routed to repair exactly as the pack and the brief say, and the stored records show it.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { RunSummary } from '../../contracts/src/run.ts';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { DOCUMENTS } from '../fixtures/agile/index.ts';
import { openConsole, type ConsoleClient } from './support/console.ts';
import { openBed, type Bed } from './support/hub.ts';
import { type McpClient } from './support/mcp.ts';
import { VERIFIER, draft, finding, startReview } from './support/review.ts';

let postgres: TemporaryPostgres;
let bed: Bed;
let client: McpClient;
let consoleClient: ConsoleClient;

before(async () => {
  postgres = await startPostgres();
  bed = await openBed({ postgres });
  client = await bed.connect(bed.reviewer, 'sess-s21-violations');
  consoleClient = await openConsole(bed.hub, bed.reviewer.token);
});

after(async () => {
  await bed?.close().catch(() => {});
  await postgres?.stop().catch(() => {});
});

describe('scenario 21: model violations handling and error routing', () => {
  test('1. location that does not exist: whole submission is refused (not_accepted) with REFERENCE_UNRESOLVED', async () => {
    const run = await startReview(client, {
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
    });
    assert.ok(run.run);

    const item0 = run.items[0];
    const invalidFinding = finding(item0, {
      text: '引用的节点位置不存在',
      code: 'case-review.location_missing',
      rank: 'major',
      location: 'src:0000000000000000000000000000000000000000000000000000000000000000/kityminder@1/n/no_such_node',
    });
    const sub = draft(run, new Map([[item0.id, [invalidFinding]]]));

    const answer = await client.call('submit_result', sub);
    assert.equal(answer.isError, true);
    assert.equal(answer.out.call_result, 'error');
    assert.equal(answer.out.acceptance, 'not_accepted');
    assert.ok(answer.out.errors.some((e) => e.code === 'REFERENCE_UNRESOLVED'));

    // Stored action record confirms the refusal
    const actions = await bed.hub.records.store.find({ key: 'runs.action.run', value: run.run });
    const validateAction = actions.items.find((a) => (a.body as { action?: string }).action === 'validate');
    assert.ok(validateAction);
    const body = validateAction.body as { acceptance?: string; codes?: string[] };
    assert.equal(body.acceptance, 'not_accepted');
    assert.ok(body.codes?.includes('REFERENCE_UNRESOLVED'));
  });

  test('2. non-verbatim quotation: refused as not_accepted with QUOTE_MISMATCH, fix and rounds left', async () => {
    const run = await startReview(client, {
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
    });
    assert.ok(run.run);

    const item0 = run.items[0];
    const badFinding = finding(item0, {
      quotes: [{ reference: item0.location, text: '这一句肯定不是脑图节点里的原文内容' }],
    });
    const sub = draft(run, new Map([[item0.id, [badFinding]]]));

    const answer = await client.call('submit_result', sub);
    assert.equal(answer.isError, true);
    assert.equal(answer.out.call_result, 'error');
    assert.equal(answer.out.acceptance, 'not_accepted');
    assert.ok(answer.out.errors.some((e) => e.code === 'QUOTE_MISMATCH'));
    const quoteErr = answer.out.errors.find((e) => e.code === 'QUOTE_MISMATCH')!;
    assert.ok(quoteErr.fix, 'must carry a fix with verbatim quotation suggestion');
    assert.ok(quoteErr.rounds_left !== undefined && quoteErr.rounds_left >= 0);

    // Stored verbatim submission in records store
    const submissions = await bed.hub.records.store.find({ key: 'runs.submission.run', value: run.run });
    assert.equal(submissions.items.length, 1);

    // Stored action record confirms rejection
    const actions = await bed.hub.records.store.find({ key: 'runs.action.run', value: run.run });
    const validateAction = actions.items.find((a) => (a.body as { action?: string }).action === 'validate');
    assert.ok(validateAction);
    const body = validateAction.body as { acceptance?: string; codes?: string[] };
    assert.equal(body.acceptance, 'not_accepted');
    assert.ok(body.codes?.includes('QUOTE_MISMATCH'));
  });

  test('3. command catalog lacks claimed as present: routed to repair with core.catalog.membership_contradicted', async () => {
    const run = await startReview(client, {
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
    });
    assert.ok(run.run);

    const item0 = run.items[0];
    const contradictedFinding = finding(item0, {
      text: '认为命令 show health 不存在',
      code: 'edge_case_gap',
      commands: [{ command: 'show health', present: false }],
    });
    const sub = draft(run, new Map([[item0.id, [contradictedFinding]]]));

    const answer = await client.call('submit_result', sub);
    // Not a whole-submission refusal: submission accepted, error routed to repair
    assert.equal(answer.isError, false);
    assert.equal(answer.out.call_result, 'ok');
    assert.equal(answer.out.acceptance, 'accepted');
    assert.ok(
      answer.out.errors.some((e) => e.code === 'core.catalog.membership_contradicted'),
      `expected core.catalog.membership_contradicted, got: ${JSON.stringify(answer.out.errors)}`,
    );
    const err = answer.out.errors.find((e) => e.code === 'core.catalog.membership_contradicted')!;
    assert.equal(err.rounds_left, 2, '2 repair rounds remaining');

    // Stored action record exists
    const actions = await bed.hub.records.store.find({ key: 'runs.action.run', value: run.run });
    const validateAction = actions.items.find((a) => (a.body as { action?: string }).action === 'validate');
    assert.ok(validateAction);
  });

  test('4. verdict inconsistent with its dispositions: routed to repair with case-review-verify.pass_with_refuted', async () => {
    // First complete a normal draft run with 1 finding
    const draftRun = await startReview(client, {
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
    });

    const probe = draftRun.items.find((i) => i.label === 'widget health probe pool1 tcp') ?? draftRun.items[0];
    const draftFinding = finding(probe, {
      text: '自相矛盾：tcp 探测写了 http',
      code: 'self_contradiction',
      rank: 'major',
    });
    const sub = draft(draftRun, new Map([[probe.id, [draftFinding]]]));

    const draftAnswer = await client.call('submit_result', sub);
    assert.equal(draftAnswer.isError, false, draftAnswer.text);
    assert.equal(draftAnswer.out.acceptance, 'accepted');

    // Retrieve stored draft record digest
    const stored = await bed.hub.records.store.find({ key: 'runs.result.run', value: draftRun.run });
    assert.equal(stored.items.length, 1);
    const draftRecord = stored.items[0].digest;

    // Start verification run
    const verifyStarted = await client.call('start_run', {
      pack: 'case-review-verify',
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: {
        target: { external: `agile:mindmap:${DOCUMENTS.review}` },
        draft: { reference: `rec:${draftRecord}` },
      },
      predecessor: draftRun.run,
    });
    assert.equal(verifyStarted.isError, false, verifyStarted.text);
    const verifyRun = verifyStarted.out.run as RunSummary;

    // Build verifier submission with dispositions refuting the draft finding, but claiming PASS in cross_item verdict
    const verifyProbe = verifyRun.items.find((i) => i.label === probe.label) ?? verifyRun.items[0];
    const draftFindings = (verifyProbe.fields.draft_findings ?? []) as Array<{ reference: string }>;
    assert.ok(draftFindings.length >= 1, 'draft findings must be bound to verification item');

    const verifyItems = verifyRun.items.map((it) => {
      if (it.id === verifyProbe.id) {
        return {
          item: it.id,
          handling: 'handled',
          slots: {
            verification: draftFindings.map((f) => ({
              text: '核实后反驳初评发现',
              code: 'refuted',
              rank: 'major',
              location: it.location,
              quotes: [{ reference: it.location, text: it.label }],
              data: { finding: f.reference },
            })),
          },
        };
      }
      return {
        item: it.id,
        handling: 'handled',
        slots: { verification: [] },
      };
    });

    const verifySub = {
      run: verifyRun.run,
      model: VERIFIER,
      items: verifyItems,
      cross_item: [{ nature: 'judgment', statement: '结论 PASS', grounds: [], code: 'PASS', rank: 'P4' }],
    };

    const verifyAnswer = await client.call('submit_result', verifySub);
    // Inconsistent verdict is routed to repair
    const inconsistentErr = verifyAnswer.out.errors.find((e) => e.code === 'case-review-verify.pass_with_refuted');
    assert.ok(
      inconsistentErr,
      `expected case-review-verify.pass_with_refuted error, got: ${JSON.stringify(verifyAnswer.out.errors)}`,
    );
    assert.ok(
      inconsistentErr.rounds_left !== undefined && inconsistentErr.rounds_left >= 1,
      'repair row specifies rounds_left',
    );
    assert.match(inconsistentErr.message, /FAIL 或 PARTIAL/);

    // Stored records confirm the error was recorded
    const actions = await bed.hub.records.store.find({ key: 'runs.action.run', value: verifyRun.run });
    assert.ok(actions.items.length >= 1);
  });
});
