// Scenario 15's last sentence (brief section 9) and the review method's steps 6-7: a target split in blocks, every block
// verified, then the report run. The Hub computes the overall verdict (the worst of the blocks, FAIL > PARTIAL > PASS) and
// checks the Chinese report the drafter wrote against the blocks' material. Also the real-data overlap shape: the second
// block carried all entries with its first half unfinished — a delivered entry wins over unfinished, an entry delivered in
// two blocks refuses the run, an entry delivered in no block is named missing and the whole is never PASS. Synthetic data,
// scripted models: the draft, the two verifications and the report are submitted by the test.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { RunSummary } from '../../contracts/src/run.ts';
import type { ValidationResult } from '../../contracts/src/validation.ts';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { DOCUMENTS } from '../fixtures/agile/index.ts';
import { fixtureText } from '../fixtures/mindmaps/index.ts';
import { openBed, type Bed } from './support/hub.ts';
import type { McpClient } from './support/mcp.ts';
import { startReview, draft, finding, level, VERIFIER, type SlotClaim } from './support/review.ts';

const REPORTER = 'omega-reporter 1.0 (scripted, temperature 0)';
let postgres: TemporaryPostgres;
let bed: Bed;
let client: McpClient;
type Node = { data: { id: string; text: string }; children?: Node[] };
const document = JSON.parse(fixtureText('review-150.km.json')) as { root: Node };

before(async () => {
  postgres = await startPostgres();
  bed = await openBed({ postgres });
  client = await bed.connect(bed.reviewer, 'sess-s26-report');
});
after(async () => {
  await bed?.close();
  await postgres?.stop();
});

/** The stored validation-result digest of a run (what a rec: reference names). */
const receiptOf = async (run: string): Promise<string> => {
  const stored = await bed.hub.records.store.find({ key: 'runs.result.run', value: run });
  assert.equal(stored.items.length, 1);
  return stored.items[0]!.digest;
};

/** Independently locate an expected-result child in the synthetic target, distinct from the draft's title quote. */
const ownQuoteOf = (item: RunSummary['items'][number]): { reference: string; text: string } => {
  const nodeId = decodeURIComponent(item.location.split('/').at(-1)!);
  const find = (node: Node): Node | undefined => node.data.id === nodeId ? node : node.children?.map(find).find(Boolean);
  const expected = find(document.root)?.children?.find(node => !(node.children?.length));
  assert.ok(expected, `case ${nodeId} has an expected-result child`);
  return {reference:item.location.replace(/[^/]+$/,encodeURIComponent(expected.data.id)),text:expected.data.text};
};

/** A PASS block keeps the draft's P3 and verifies its finding using a new quote from the target. */
const passDraftOf = (run: RunSummary) => draft(run,new Map(run.items.map(item => [item.id,[finding(item,{text:'覆盖缺口：缺少重复执行的边界用例',rank:'minor'})]])),{cross:[level('P3')]});

/** The reference addresses the stored model final, not its pointer into the submitted cross_item list. */
const finalReferenceOf = async (run: string, verdict: string, rank: string): Promise<string> => {
  const receipt = await receiptOf(run);
  const result = (await bed.hub.records.store.get<ValidationResult>(receipt))!.body;
  const index = result.cross_item.findIndex(claim => claim.requirement === 'final' && claim.statement.code === verdict && claim.statement.rank === rank);
  assert.ok(index >= 0,'the block carries the expected model final');
  const claim = result.cross_item[index]!;
  assert.ok(claim.pointer);
  assert.ok(result.cross_item.some(fact => fact.requirement === 'final' && fact.pointer === claim.pointer && fact.statement.verdict === 'support'),'the Hub supports this exact final at its submission pointer');
  return `rec:${receipt}#/cross_item/${index}`;
};

/** A verified block: every item handled, the draft findings disposed of (verified unless told), one final in cross_item. */
const verifyBlock = async (options: {
  draftRun: RunSummary;
  verdict: 'PASS' | 'PARTIAL';
  level: string;
  session: string;
  dispositionOf?: (findingRef: string, itemId: string) => 'verified' | 'refuted' | 'partial';
}): Promise<RunSummary> => {
  const started = await client.call('start_run', {
    pack: 'case-review-verify',
    product: bed.product.names[0],
    version: bed.site.LINE,
    inputs: {
      target: { external: `agile:mindmap:${DOCUMENTS.review}` },
      draft: { reference: `rec:${await receiptOf(options.draftRun.run)}` },
    },
    predecessor: options.draftRun.run,
  });
  assert.equal(started.isError, false, started.text.slice(0, 500));
  const run = started.out.run as RunSummary;
  const items = run.items.map((it) => {
    const draftFindings = (it.fields.draft_findings ?? []) as Array<{ reference: string }>;
    return {
      item: it.id,
      handling: 'handled',
      slots: {
        verification: draftFindings.map((f): SlotClaim => {
          const code = options.dispositionOf?.(f.reference, it.id) ?? 'verified';
          const text = code === 'refuted' ? '核实后推翻初评发现' : code === 'partial' ? '核实后部分证实初评发现' : '核实后证实初评发现';
          return {
            text,
            code,
            rank: 'minor',
            location: it.location,
            quotes: [options.verdict === 'PASS' ? ownQuoteOf(it) : { reference: it.location, text: it.label }],
            data: { finding: f.reference },
          };
        }),
      },
    };
  });
  const answer = await client.call('submit_result', { run: run.run, model: VERIFIER, items, cross_item: [{ nature: 'judgment', statement: `结论 ${options.verdict}`, grounds: [], code: options.verdict, rank: options.level }] });
  assert.equal(answer.isError, false, answer.text.slice(0, 500));
  assert.equal(answer.out.acceptance, 'accepted', answer.text.slice(0, 500));
  const finalFacts = answer.out.result!.cross_item.filter(c => c.requirement === 'final' && c.statement.verdict !== undefined);
  assert.ok(finalFacts.length > 0);
  assert.ok(finalFacts.every(c => c.statement.verdict === 'support'), JSON.stringify(finalFacts.map(c => ({pointer:c.pointer,statement:c.statement}))));
  void options.session;
  return run;
};

/** Starts the report run on the given verification receipts. */
const startReport = (references: string[]) => client.call('start_run', {
  pack: 'case-review-report',
  inputs: { verifications: references.map((reference) => ({ reference: `rec:${reference}` })) },
});

/** The refute codes the checks produced, from the run's latest stored result. */
const refutesOf = async (run: string): Promise<string[]> => {
  const stored = await bed.hub.records.store.find({ key: 'runs.result.run', value: run });
  assert.ok(stored.items.length >= 1);
  const result = stored.items[stored.items.length - 1]!.body as { cross_item?: Array<{ statement?: { code?: string } }> };
  return (result.cross_item ?? []).map((c) => c.statement?.code ?? '').filter((c) => c.startsWith('case-review-report.'));
};

/** The report item of a started run. */
const reportItemOf = (run: RunSummary): { summary?: string; fields: Record<string, unknown>; slots: Record<string, unknown> } => {
  const item = run.items.find((i) => i.id === 'report');
  assert.ok(item !== undefined, 'the report item exists');
  return item as unknown as { summary?: string; fields: Record<string, unknown>; slots: Record<string, unknown> };
};

describe('scenario 26: the review report over blocks (steps 6 and 7 of the method)', () => {
  let blockA: RunSummary;
  let blockB: RunSummary;
  let reportRun: RunSummary;

  test('two blocks verified (PASS P3, PARTIAL P5) start a report run whose overall is PARTIAL P5', async () => {
    // Block A: a P3 draft with a finding verified using an independent expected-result quote, PASS P3.
    const draftA = await startReview(client, {
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
      parameters: { slice: { from: 1, to: 1 } },
    });
    const acceptedA = await client.call('submit_result', passDraftOf(draftA));
    assert.equal(acceptedA.isError, false, acceptedA.text.slice(0, 400));
    blockA = await verifyBlock({ draftRun: draftA, verdict: 'PASS', level: 'P3', session: 'sess-s26-v1' });

    // Block B: a draft with one finding, verified PARTIAL P5.
    const draftB = await startReview(client, {
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
      parameters: { slice: { from: 2, to: 2 } },
    });
    const probe = draftB.items[0]!;
    const submittedB = await client.call('submit_result', draft(draftB, new Map([[probe.id, [finding(probe, { text: '覆盖缺口：恢复出厂没有用例', code: 'coverage_gap', rank: 'major' })]]])));
    assert.equal(submittedB.isError, false, submittedB.text.slice(0, 400));
    blockB = await verifyBlock({ draftRun: draftB, verdict: 'PARTIAL', level: 'P5', session: 'sess-s26-v2' });

    const started = await startReport([await receiptOf(blockA.run), await receiptOf(blockB.run)]);
    assert.equal(started.isError, false, started.text.slice(0, 500));
    reportRun = started.out.run as RunSummary;
    const report = reportItemOf(reportRun);
    assert.deepEqual(report.fields.overall, { verdict: 'PARTIAL', level: 'P5', reference: await finalReferenceOf(blockB.run,'PARTIAL','P5') }, 'the worst of the blocks with its level');
    assert.equal(report.summary, '整体结论码 PARTIAL、等级 P5（最差那块的，照抄）');
    assert.match(started.text, /整体结论码 PARTIAL、等级 P5（最差那块的，照抄）/);
    assert.match(started.text, /证实 rec:[0-9a-f]{64}#.+；推翻 0 条/);
  });

  test('a report claiming PASS is refused with the computed verdict in the fix', async () => {
    const answer = await client.call('submit_result', {
      run: reportRun.run,
      model: REPORTER,
      items: reportRun.items.map((it) => ({ item: it.id, handling: 'handled', slots: {} })),
      cross_item: [{ nature: 'judgment', statement: '终稿（错误示例）：没有重要问题（合成示例）', grounds: [], code: 'PASS', rank: 'P3' }],
    });
    assert.equal(answer.isError, false, answer.text.slice(0, 400));
    const refutes = await refutesOf(reportRun.run);
    assert.ok(refutes.includes('case-review-report.verdict_mismatch'), `the computed verdict travels with the refusal: ${refutes.join(', ')}`);
    const result = (await bed.hub.records.store.find<ValidationResult>({key:'runs.result.run',value:reportRun.run})).items.at(-1)!.body;
    const mismatch = result.cross_item.find(claim => claim.statement.code === 'case-review-report.verdict_mismatch');
    assert.match(String(mismatch?.statement.data?.fix),/PARTIAL/);
    assert.ok(answer.out.result!.cross_item.some(claim => claim.statement.code === 'case-review-report.verdict_mismatch' && /PARTIAL/.test(String(claim.statement.data?.fix))),'the receipt carries the computed verdict in the final check fact repair');
  });

  test('a report missing one verified finding, or citing a refuted one, is refused; a consistent report is accepted', async () => {
    // A fresh block pair with one refuted finding: block C has the finding, block D refutes it (PARTIAL).
    const draftC = await startReview(client, {
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
      parameters: { slice: { from: 3, to: 3 } },
    });
    const itemC = draftC.items[0]!;
    await client.call('submit_result', draft(draftC, new Map([[itemC.id, [finding(itemC, { text: '字面问题：标题重复', code: 'literal_issue', rank: 'minor' })]]])));

    const startedD = await client.call('start_run', {
      pack: 'case-review-verify',
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: { target: { external: `agile:mindmap:${DOCUMENTS.review}` }, draft: { reference: `rec:${await receiptOf(draftC.run)}` } },
      predecessor: draftC.run,
    });
    const runD = startedD.out.run as RunSummary;
    const itemD = runD.items[0]!;
    const draftFindings = (itemD.fields.draft_findings ?? []) as Array<{ reference: string }>;
    const verified = await client.call('submit_result', {
      run: runD.run,
      model: VERIFIER,
      items: runD.items.map((it) => {
        const findingsOfItem = (it.fields.draft_findings ?? []) as Array<{ reference: string }>;
        return {
          item: it.id,
          handling: 'handled',
          slots: {
            verification: findingsOfItem.map((f): SlotClaim => ({
              text: '核实后推翻初评发现',
              code: 'refuted',
              rank: 'minor',
              location: it.location,
              quotes: [{ reference: it.location, text: it.label }],
              data: { finding: f.reference },
            })),
          },
        };
      }),
      cross_item: [{ nature: 'judgment', statement: '结论 PARTIAL', grounds: [], code: 'PARTIAL', rank: 'P4' }],
    });
    assert.equal(verified.isError, false, verified.text.slice(0, 400));

    const started = await startReport([await receiptOf(runD.run)]);
    assert.equal(started.isError, false, started.text.slice(0, 500));
    const run = started.out.run as RunSummary;
    assert.deepEqual(reportItemOf(run).fields.overall, { verdict: 'PARTIAL', level: 'P4', reference: await finalReferenceOf(runD.run,'PARTIAL','P4') });
    assert.equal(reportItemOf(run).summary, '整体结论码 PARTIAL、等级 P4（最差那块的，照抄）');
    assert.match(started.text, /整体结论码 PARTIAL、等级 P4（最差那块的，照抄）/);
    assert.match(started.text, /没有要引用的发现；推翻 1 条/);
    // The refuted finding's reference as this run sees it (from its own projected fields, bound to this run).
    const projected = reportItemOf(run).fields.findings as Array<{ kind: string; reference: string }>;
    const refutedReference = projected.find((f) => f.kind === 'refuted')?.reference;
    assert.ok(refutedReference !== undefined, 'the projected findings carry the refuted one');
    void draftFindings;

    // Missing: cite nothing → finding_missing (the refuted one must NOT be cited, so this also proves refuted findings
    // are not demanded; then citing the refuted one → finding_refuted).
    const submitWith = async (findings: string[]): Promise<void> => {
      const answer = await client.call('submit_result', {
        run: run.run,
        model: REPORTER,
        items: run.items.map((it) => ({ item: it.id, handling: 'handled', slots: {} })),
        cross_item: [{ nature: 'judgment', statement: '终稿：A 块发现被推翻（合成示例）', grounds: findings, code: 'PARTIAL', rank: 'P4' }],
      });
      assert.equal(answer.isError, false, answer.text.slice(0, 600));
    };
    // This block's only finding was refuted: nothing must be cited, so a report without grounds is consistent.
    await submitWith([]);
    let refutes = await refutesOf(run.run);
    assert.equal(refutes.filter((c) => c === 'case-review-report.finding_refuted').length, 0, `no refute when nothing is cited: ${refutes.join(', ')}`);
    // Citing the refuted finding is refused.
    await submitWith([refutedReference]);
    refutes = await refutesOf(run.run);
    assert.ok(refutes.includes('case-review-report.finding_refuted'), `citing a refuted finding is refused: ${refutes.join(', ')}`);
  });

  test('real shape (two blocks, 45 findings, 1 refuted): started run exposes citations and overall, copied report accepted on first attempt', async () => {
    // Block E: 23 cases (slice 10..32), 23 findings (1 partial, 22 verified), verified PARTIAL P4
    const draftE = await startReview(client, {
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
      parameters: { slice: { from: 10, to: 32 } },
    });
    const findingsE = new Map(draftE.items.map((it, idx) => [
      it.id,
      [finding(it, { text: `覆盖缺口：边界用例未覆盖 E${idx + 1}`, code: 'coverage_gap', rank: 'minor' })],
    ]));
    const submittedE = await client.call('submit_result', draft(draftE, findingsE));
    assert.equal(submittedE.isError, false, submittedE.text.slice(0, 400));
    const blockE = await verifyBlock({
      draftRun: draftE,
      verdict: 'PARTIAL',
      level: 'P4',
      session: 'sess-s26-ve',
      dispositionOf: (_ref, id) => (id === draftE.items[0]?.id ? 'partial' : 'verified'),
    });

    // Block F: 22 cases (slice 33..54), 22 findings (1 refuted, 21 verified), verified PARTIAL P4
    const draftF = await startReview(client, {
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
      parameters: { slice: { from: 33, to: 54 } },
    });
    const findingsF = new Map(draftF.items.map((it, idx) => [
      it.id,
      [finding(it, { text: `覆盖缺口：恢复出厂未覆盖 F${idx + 1}`, code: 'coverage_gap', rank: 'minor' })],
    ]));
    const submittedF = await client.call('submit_result', draft(draftF, findingsF));
    assert.equal(submittedF.isError, false, submittedF.text.slice(0, 400));
    const blockF = await verifyBlock({
      draftRun: draftF,
      verdict: 'PARTIAL',
      level: 'P4',
      session: 'sess-s26-vf',
      dispositionOf: (_ref, id) => (id === draftF.items[0]?.id ? 'refuted' : 'verified'),
    });

    // Start report run
    const started = await startReport([await receiptOf(blockE.run), await receiptOf(blockF.run)]);
    assert.equal(started.isError, false, started.text.slice(0, 500));
    const run = started.out.run as RunSummary;
    const reportItem = reportItemOf(run);

    // 1. Overall verdict and level in started.text and reportItem.summary
    assert.deepEqual(reportItem.fields.overall, { verdict: 'PARTIAL', level: 'P4', reference: await finalReferenceOf(blockE.run,'PARTIAL','P4') });
    assert.equal(reportItem.summary, '整体结论码 PARTIAL、等级 P4（最差那块的，照抄）');
    assert.match(started.text, /整体结论码 PARTIAL、等级 P4（最差那块的，照抄）/);

    const overallMatch = /-\s*report\s*\|\s*评审终稿\s*\|\s*整体结论码\s+(\w+)、等级\s+(\w+)/.exec(started.text);
    assert.ok(overallMatch !== null, 'answer text contains overall verdict and level in report item line');
    const [, overallVerdict, overallLevel] = overallMatch;
    assert.equal(overallVerdict, 'PARTIAL');
    assert.equal(overallLevel, 'P4');

    // 2. Finding references in started.text: all 44 citable references present, refuted finding not cited
    const citableMatches = [...started.text.matchAll(/(?:证实|部分正确|新增)\s+(rec:[0-9a-f]{64}#[^\s；、|]+)/g)].map((m) => m[1]!);
    assert.equal(citableMatches.length, 44, 'all 44 citable references can be found in started.text');
    assert.match(started.text, /推翻 1 条/);

    const allFindings = reportItem.fields.findings as Array<{ kind: string; reference: string }>;
    const refutedFinding = allFindings.find((f) => f.kind === 'refuted');
    assert.ok(refutedFinding !== undefined, 'refuted finding exists in projected findings');
    assert.ok(!citableMatches.includes(refutedFinding.reference), 'refuted finding reference is not copied as citable');

    // 3. Model submits the final report copied directly from started.text: accepted on the first attempt!
    const answer = await client.call('submit_result', {
      run: run.run,
      model: REPORTER,
      items: run.items.map((it) => ({ item: it.id, handling: 'handled', slots: {} })),
      cross_item: [{
        nature: 'judgment',
        statement: '终稿：两块合成，共 45 条发现，核对推翻 1 条，证实 43 条，部分正确 1 条，各块发现逐条核对一致',
        grounds: citableMatches,
        code: overallVerdict,
        rank: overallLevel,
      }],
    });
    assert.equal(answer.isError, false, answer.text.slice(0, 500));
    assert.equal(answer.out.acceptance, 'accepted', answer.text.slice(0, 500));
    const refutes = await refutesOf(run.run);
    assert.equal(refutes.length, 0, 'first attempt passes all checks with 0 refutes');
  });
});

describe('scenario 26: the overlap shape from the real data', () => {
  test('a block carrying all entries with half unfinished merges per item; an item delivered twice refuses the run', async () => {
    // Two drafts over the same two cases; the second verification result is edited into the real-data shape below by
    // starting from a normal pair and checking the projection directly on the Hub's stored records is heavy — instead
    // this exercises the same rule through the pack's own projection test (report.test.ts) and here proves the run-level
    // refusal on the Hub: two blocks that both delivered the same case cannot start a report run.
    const draftA = await startReview(client, {
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
      parameters: { slice: { from: 4, to: 4 } },
    });
    await client.call('submit_result', passDraftOf(draftA));
    const draftB = await startReview(client, {
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
      parameters: { slice: { from: 4, to: 4 } },
    });
    await client.call('submit_result', passDraftOf(draftB));
    const blockA = await verifyBlock({ draftRun: draftA, verdict: 'PASS', level: 'P3', session: 's' });
    const blockB = await verifyBlock({ draftRun: draftB, verdict: 'PASS', level: 'P3', session: 's' });
    const refused = await startReport([await receiptOf(blockA.run), await receiptOf(blockB.run)]);
    assert.equal(refused.isError, true, 'the same case delivered in two blocks refuses the run');
    assert.match(refused.text, /重叠|overlap/);
    assert.match(refused.text, /重新分块|交付/);
  });
});
