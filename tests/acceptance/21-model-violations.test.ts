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

  test('5. validation result exceeding maxRecordBytes returns not_accepted receipt instead of throwing', async () => {
    // Open a bed with maxRecordBytes capped at 256 KiB
    const limitedBed = await openBed({ postgres, limits: { maxRecordBytes: 256 * 1024 } });
    const limitedClient = await limitedBed.connect(limitedBed.reviewer, 'sess-s21-limit');
    try {
      const run = await startReview(limitedClient, {
        product: limitedBed.product.names[0],
        version: limitedBed.site.LINE,
        inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
      });
      assert.ok(run.run);

      // Normal draft submission on 64 items produces ~496 KiB ValidationResult, exceeding 256 KiB
      const sub = draft(run);
      const answer = await limitedClient.call('submit_result', sub);
      assert.equal(answer.isError, true);
      assert.equal(answer.out.call_result, 'error');
      assert.equal(answer.out.acceptance, 'not_accepted');

      const err = answer.out.errors.find((e) => e.code === 'SUBMISSION_SCHEMA_VIOLATION');
      assert.ok(err, `expected SUBMISSION_SCHEMA_VIOLATION, got: ${JSON.stringify(answer.out.errors)}`);
      assert.match(err.message, /超过 Hub 一条记录的上限 262144 字节，存不下，没有受理/);

      // Stored action record confirms the not_accepted receipt
      const actions = await limitedBed.hub.records.store.find({ key: 'runs.action.run', value: run.run });
      const validateAction = actions.items.find((a) => (a.body as { action?: string }).action === 'validate');
      assert.ok(validateAction);
      const body = validateAction.body as { acceptance?: string; codes?: string[] };
      assert.equal(body.acceptance, 'not_accepted');
      assert.ok(body.codes?.includes('SUBMISSION_SCHEMA_VIOLATION'));
    } finally {
      await limitedBed.close();
    }
  });

  test('6. deep nesting, reference cycle, and command string violations are refused with specific fixes without internal error', async () => {
    const run = await startReview(client, {
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
    });
    assert.ok(run.run);

    const item0 = run.items[0];

    // Case A: deep nesting (> 64 layers) is refused with SUBMISSION_SCHEMA_VIOLATION and fix "嵌套超过 64 层"
    const nest = (levels: number): Record<string, unknown> => {
      let value: Record<string, unknown> = { leaf: true };
      for (let i = 0; i < levels; i++) value = { d: value };
      return value;
    };
    const deepFinding = finding(item0, {
      data: nest(70),
    });
    const deepSub = draft(run, new Map([[item0.id, [deepFinding]]]));
    const deepAnswer = await client.call('submit_result', deepSub);
    assert.equal(deepAnswer.isError, true);
    assert.equal(deepAnswer.out.call_result, 'error');
    assert.equal(deepAnswer.out.acceptance, 'not_accepted');
    const deepErr = deepAnswer.out.errors.find((e) => e.code === 'SUBMISSION_SCHEMA_VIOLATION');
    assert.ok(deepErr, `expected SUBMISSION_SCHEMA_VIOLATION, got: ${JSON.stringify(deepAnswer.out.errors)}`);
    assert.match(deepErr.fix ?? '', /嵌套超过 64 层/);

    // Case B: commands written as strings gets specific fix naming expected shape
    const cmdFinding = finding(item0, {
      commands: ['zone show' as unknown as { command: string }],
    });
    const cmdSub = draft(run, new Map([[item0.id, [cmdFinding]]]));
    const cmdAnswer = await client.call('submit_result', cmdSub);
    assert.equal(cmdAnswer.isError, true);
    assert.equal(cmdAnswer.out.call_result, 'error');
    assert.equal(cmdAnswer.out.acceptance, 'not_accepted');
    const cmdErr = cmdAnswer.out.errors.find((e) => e.code === 'SUBMISSION_SCHEMA_VIOLATION');
    assert.ok(cmdErr, `expected SUBMISSION_SCHEMA_VIOLATION, got: ${JSON.stringify(cmdAnswer.out.errors)}`);
    assert.equal(cmdErr.path, '/items/0/slots/findings/0/commands/0');
    assert.equal(
      cmdErr.fix,
      '/items/0/slots/findings/0/commands/0 要的是对象 {"command": "<string>", "present"?: <boolean>}，收到的是字符串',
    );

    // Case C: reference cycle in grounds is refused with REFERENCE_UNRESOLVED and a fix naming the cyclic reference
    const originalTreeReader = bed.hub.deps.knowledge.treeReader.bind(bed.hub.deps.knowledge);
    const cyclicRef = `tree:${run.root}/cyclic`;
    bed.hub.deps.knowledge.treeReader = (lock) => {
      const real = originalTreeReader(lock);
      return {
        ...real,
        read: async (root, path, entry, reader) => {
          if (path === '/cyclic') {
            return {
              readTier: 'model_readable',
              mediaType: 'text/plain',
              text: 'cyclic node',
              grounds: [`tree:${root}/cyclic`],
              validity: null,
            };
          }
          return real.read(root, path, entry, reader);
        },
      };
    };
    try {
      const cycleFinding = finding(item0, {
        grounds: [cyclicRef],
      });
      const cycleSub = draft(run, new Map([[item0.id, [cycleFinding]]]));
      const cycleAnswer = await client.call('submit_result', cycleSub);
      assert.equal(cycleAnswer.isError, true);
      assert.equal(cycleAnswer.out.call_result, 'error');
      assert.equal(cycleAnswer.out.acceptance, 'not_accepted');
      const cycleErr = cycleAnswer.out.errors.find((e) => e.code === 'REFERENCE_UNRESOLVED');
      assert.ok(cycleErr, `expected REFERENCE_UNRESOLVED, got: ${JSON.stringify(cycleAnswer.out.errors)}`);
      assert.equal(cycleErr.path, '/items/0/slots/findings/0/grounds/0');
      assert.ok(cycleErr.fix?.startsWith(`成环的引用：${cyclicRef}`));
      const request=/请求 rec:([0-9a-f]{64})/.exec(cycleErr.fix??'');assert.ok(request,'exhausted work names its durable repair request');
      const stored=await bed.hub.records.store.get<{run:string;kind:string;audience:string}>(request[1]);
      assert.ok(stored);assert.equal(stored.kind,'request');assert.equal(stored.body.run,run.run);assert.equal(stored.body.kind,'repair');
      assert.equal(stored.body.audience,bed.reviewer.principal.id);
    } finally {
      bed.hub.deps.knowledge.treeReader = originalTreeReader;
    }
  });
});
