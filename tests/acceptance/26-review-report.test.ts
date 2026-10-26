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
import { startReview, draft, finding, level, VERIFIER, DRAFTER, VERIFIER_IDENTITY, DRAFTER_IDENTITY, readProjectedText, oracleCases, type SlotClaim } from './support/review.ts';

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
  const detail=await bed.hub.deps.runs.getRun(bed.reviewer.principal,run);
  assert.ok(detail?.latest);return detail.latest.record;
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
  suggestions?:(run:RunSummary)=>Record<string,unknown>[];
  freshText?:string;
  repairSuggestion?:boolean;
  keepUnrepaired?:boolean;
  model?:string;
  model_identity?:typeof VERIFIER_IDENTITY;
}): Promise<RunSummary> => {
  const verifier=await bed.connect(bed.reviewer,options.session);
  const started = await verifier.call('start_run', {
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
  if(options.freshText&&items[0])items[0].slots.verification.push({text:options.freshText,code:'new_finding',rank:'minor',location:run.items[0].location,quotes:[{reference:run.items[0].location,text:run.items[0].label}],data:{probe:'edge_case_gap'}});
  const cross:Record<string,unknown>[]=[{nature:'judgment',statement:'结论 '+options.verdict,grounds:[],code:options.verdict,rank:options.level},...(options.suggestions?.(run)??[])];
  const payload={run:run.run,model:options.model??VERIFIER,model_identity:options.model_identity??VERIFIER_IDENTITY,items,cross_item:cross};
  if(options.repairSuggestion){
    const bad=structuredClone(payload);bad.cross_item[1].grounds=[];
    const repair=await verifier.call('submit_result',bad);
    assert.equal(repair.out.acceptance,'accepted');
    const missing=repair.out.errors.find(error=>error.code==='case-review-verify.suggestion_target_missing'&&error.requirement==='verification');
    assert.ok(missing);assert.equal(missing.item,items[0].item);assert.ok((missing.rounds_left??0)>=1);
    const result=repair.out.result!;
    const facts=[...result.cross_item,...Object.values(result.partitions).flatMap(entries=>entries.flatMap(entry=>entry.requirements.flatMap(requirement=>requirement.claims)))];
    assert.ok(facts.some(claim=>claim.statement.code==='case-review-verify.suggestion_target_missing'&&claim.item===items[0].item&&claim.pointer==='/cross_item/1'),'the stored check fact names the exact suggestion, separately from the receipt item path');
    if(options.keepUnrepaired)return run;
  }
  const answer=await verifier.call('submit_result',payload);
  assert.equal(answer.isError, false, answer.text.slice(0, 500));
  assert.equal(answer.out.acceptance, 'accepted', answer.text.slice(0, 500));
  const finalFacts = answer.out.result!.cross_item.filter(c => c.requirement === 'final' && c.statement.verdict !== undefined);
  assert.ok(finalFacts.length > 0);
  assert.ok(finalFacts.every(c => c.statement.verdict === 'support'), JSON.stringify(finalFacts.map(c => ({pointer:c.pointer,statement:c.statement}))));
  return run;
};

/** Starts the report run on the given verification receipts. */
const startReport = (references: string[]) => client.call('start_run', {
  pack: 'case-review-report',
  inputs:{verifications:references.map(reference=>({reference:'rec:'+reference})),target:{external:'agile:mindmap:'+DOCUMENTS.review}},
});

/** The refute codes the checks produced, from the run's latest stored result. */
const refutesOf = async (run: string): Promise<string[]> => {
  const detail=await bed.hub.deps.runs.getRun(bed.reviewer.principal,run);
  assert.ok(detail?.latest);
  return detail.latest.result.cross_item.flatMap(claim=>typeof claim.statement.code==='string'&&claim.statement.code.startsWith('case-review-report.')?[claim.statement.code]:[]);

};

const recordReferenceOf=(text:string):string=>{
  const line=text.split('\n').find(line=>line.startsWith('完整的槽位模式'));
  assert.ok(line,'the response names its stored run record');
  const reference=/rec:[a-f0-9]{64}/.exec(line)?.[0];assert.ok(reference);return reference;
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
    assert.equal(reportRun.items[0].id,'report');
    const badSuggestion=await client.call('submit_result',{run:reportRun.run,model:REPORTER,
      items:reportRun.items.map(item=>({item:item.id,handling:'handled',slots:{}})),
      cross_item:[{nature:'judgment',statement:'简短总体意见',grounds:[],code:'PARTIAL',rank:'P5'},{nature:'judgment',statement:'补：用例；因为：缺口；期望：成功',grounds:[],code:'suggestion',rank:'P5'}]});
    assert.equal(badSuggestion.isError,true);assert.equal(badSuggestion.out.acceptance,'not_accepted');
    assert.ok(badSuggestion.out.errors.some(error=>error.code==='SUBMISSION_SCHEMA_VIOLATION'));

    const report = reportItemOf(reportRun);
    assert.deepEqual(report.fields.overall, { verdict: 'PARTIAL', level: 'P5', reference: await finalReferenceOf(blockB.run,'PARTIAL','P5') }, 'the worst of the blocks with its level');
    assert.match(report.summary??'',/^整体结论码 PARTIAL、等级 P5（最差那块的，照抄）；评审表/);
    assert.match(started.text, /整体结论码 PARTIAL、等级 P5（最差那块的，照抄）/);
    assert.match(started.text,/复核发现 1 条；推翻 0 条/);
    assert.match(started.text,/#\/items\/0\/fields\/review_tables/);
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

  test('a single-block report needs no per-finding citation and excludes refuted findings from its table', async () => {
    // A fresh block pair with one refuted finding: block C has the finding, block D refutes it (PARTIAL).
    const draftC = await startReview(client, {
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
      parameters: { slice: { from: 3, to: 3 } },
    });
    const itemC = draftC.items[0]!;
    await client.call('submit_result', draft(draftC, new Map([[itemC.id, [finding(itemC, { text: '字面问题：标题重复', code: 'literal_issue', rank: 'minor' })]]])));

    const independentVerifier=await bed.connect(bed.reviewer,'synthetic-refutation-independent');
    const startedD = await independentVerifier.call('start_run', {
      pack: 'case-review-verify',
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: { target: { external: `agile:mindmap:${DOCUMENTS.review}` }, draft: { reference: `rec:${await receiptOf(draftC.run)}` } },
      predecessor: draftC.run,
    });
    const runD = startedD.out.run as RunSummary;
    const itemD = runD.items[0]!;
    const draftFindings = (itemD.fields.draft_findings ?? []) as Array<{ reference: string }>;
    const verified = await independentVerifier.call('submit_result', {
      run: runD.run,
      model: VERIFIER,
      model_identity: VERIFIER_IDENTITY,
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
    assert.match(reportItemOf(run).summary??'',/^整体结论码 PARTIAL、等级 P4（最差那块的，照抄）；评审表/);
    assert.match(started.text, /整体结论码 PARTIAL、等级 P4（最差那块的，照抄）/);
    assert.match(started.text,/复核发现 0 条；推翻 1 条/);
    assert.equal(reportItemOf(run).fields.findings,undefined,'unused text copies are not projected');
    assert.equal((reportItemOf(run).fields.review_counts as {total:{refuted:number}}).total.refuted,1);
    void draftFindings;

    // The report now needs no per-finding transcription. Its table omits the refuted statement and keeps the count.
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
    // Optional valid references remain groundable; no retired per-finding citation rule is reintroduced.
    const read=await readProjectedText(client,recordReferenceOf(started.text)+'#/items/0/fields/review_tables');
    assert.ok(!read.text.includes('核实后推翻初评发现'));
  });

  test('two blocks retain all 44 findings in the table while a concise uncited report is accepted', async () => {
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
    assert.deepEqual(reportItem.fields.overall, { verdict: 'PARTIAL', level: 'P4', reference: (await Promise.all([finalReferenceOf(blockE.run,'PARTIAL','P4'),finalReferenceOf(blockF.run,'PARTIAL','P4')])).sort()[0] });
    assert.match(reportItem.summary??'',/^整体结论码 PARTIAL、等级 P4（最差那块的，照抄）；评审表/);
    assert.match(started.text, /整体结论码 PARTIAL、等级 P4（最差那块的，照抄）/);

    const overallMatch=/整体结论码\s+(\w+)、等级\s+(\w+)/.exec(started.text);
    assert.ok(overallMatch !== null, 'answer text contains overall verdict and level in report item line');
    const [, overallVerdict, overallLevel] = overallMatch;
    assert.equal(overallVerdict, 'PARTIAL');
    assert.equal(overallLevel, 'P4');

    // 2. All 44 findings remain in the deterministic table; individual references are not retranscribed.
    const citableMatches = [...started.text.matchAll(/(?:证实|部分正确|新增)\s+(rec:[0-9a-f]{64}#[^\s；、|]+)/g)].map((m) => m[1]!);
    assert.equal(citableMatches.length,0,'the reporter reads tables instead of retranscribing references');
    const counts=reportItem.fields.review_counts as {total:{findings:number;refuted:number}};assert.equal(counts.total.findings,44);assert.equal(counts.total.refuted,1);
    assert.match(started.text, /推翻 1 条/);

    assert.equal(reportItem.fields.findings,undefined,'the original receipts retain findings without a second text copy');

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

test('IPv4 subitem tables preserve original cells, dispositions, suggestions and every MCP page',async()=>{
  const find=(node:Node,predicate:(node:Node)=>boolean):Node|undefined=>predicate(node)?node:node.children?.map(child=>find(child,predicate)).find(Boolean);
  const group=find(document.root,node=>node.data.text==='IPv4');assert.ok(group);
  const cases=oracleCases(document).filter(item=>item.path.at(-1)==='IPv4');assert.ok(cases.length>=2);
  const half=Math.floor(cases.length/2);
  const startPart=async(from:number,to:number)=>{
    const run=await startReview(client,{product:bed.product.names[0],version:bed.site.LINE,inputs:{subject:{external:'agile:mindmap:'+DOCUMENTS.review}},
      parameters:{block:group.data.id,slice:{from,to}}});
    const submitted=await client.call('submit_result',passDraftOf(run));assert.equal(submitted.out.acceptance,'accepted');return run;
  };
  const first=await startPart(1,half),second=await startPart(half+1,cases.length);
  const suggestionText='补：补充 IPv4 边界用例；因为：只覆盖了正常值；期望：非法输入被拒绝';
  const blockA=await verifyBlock({draftRun:first,verdict:'PARTIAL',level:'P4',session:'synthetic-tables-a',
    dispositionOf:(_reference,id)=>id===first.items[0].id?'partial':'verified',
    suggestions:run=>[{nature:'judgment',code:'suggestion',rank:'minor',statement:suggestionText,grounds:[run.items[0].location]}],
    repairSuggestion:true});
  // A deliberately long accepted model statement forces the raw-table continuation to split a row.
  const longFinding='合成新增判断'.repeat(8000);
  const blockB=await verifyBlock({draftRun:second,verdict:'PARTIAL',level:'P5',session:'synthetic-tables-b',freshText:longFinding,
    suggestions:run=>[{nature:'judgment',code:'suggestion',rank:'minor',statement:'补：子项的新用例；因为：覆盖缺口；期望：结果可观察',
      grounds:[run.items[0].location.replace(/n\/[^/]+$/,'n/'+encodeURIComponent(group.data.id))]}]});
  const started=await startReport([await receiptOf(blockA.run),await receiptOf(blockB.run)]);
  assert.equal(started.isError,false,started.text.slice(0,1000));
  const run=started.out.run as RunSummary,report=reportItemOf(run);
  assert.equal(run.items[0].id,'report');assert.match(report.summary??'',/#\/items\/0\/fields\/review_tables/);
  const actual=await readProjectedText(client,recordReferenceOf(started.text)+'#/items/0/fields/review_tables');
  assert.equal(actual.text,report.fields.review_tables);
  assert.ok(actual.pages.length>1,'the public continuation reads every piece of the long row');
  assert.match(actual.text,/^## 用例评审结果：/);assert.match(actual.text,/### 1\..*IPv4/);
  const rows=actual.text.split('\n').filter(line=>/^\| \d+ \|/u.test(line));
  assert.equal(rows.length,cases.length);
  const cells=rows[0].split(/(?<!\\)(?:\\\\)*\|/u).slice(1,-1).map(cell=>cell.trim());
  const decode=(value:string)=>value.replace(/\\([\s\S])|↵/gu,(_all,escaped:string|undefined)=>escaped??'\n');
  const raw=find(document.root,node=>node.data.id===cases[0].nodeId)!;
  const data=raw.data as Record<string,unknown>,tags=Array.isArray(data.resource)?data.resource as string[]:[];
  let expected=raw.data.text+(tags.length?'；标签：'+tags.join('，'):'');let step=0;
  const caseIds=new Set(oracleCases(document).map(item=>item.nodeId));
  const descendantText=(node:Node):string[]=>caseIds.has(node.data.id)?[]:[node.data.text,...(node.children??[]).flatMap(descendantText)];
  for(const child of raw.children??[]){
    if(caseIds.has(child.data.id))continue;
    if(!child.children?.length)expected+='；'+((child.data as Record<string,unknown>).priority===3?'前置：':'期望：')+child.data.text;
    else expected+='；步骤 '+(++step)+'：'+descendantText(child).join(' → ');
  }
  assert.equal(decode(cells[1]),expected);
  assert.ok(decode(cells[4]).includes(suggestionText));
  assert.ok(actual.text.includes(longFinding));assert.match(actual.text,/子项上的建议：.*补：子项的新用例/);
  assert.match(actual.text,/【部分正确·次要】/);assert.match(actual.text,/【新增·次要·边界用例缺口】/);
  const counts=report.fields.review_counts as {total:{cases:number;findings:number;suggestions:number};subitems:unknown[]};
  assert.equal(counts.total.cases,cases.length);assert.equal(counts.total.findings,cases.length+1);assert.equal(counts.total.suggestions,2);assert.equal(counts.subitems.length,1);
});


test('report admission rejects an unrepaired accepted verification receipt',async()=>{
  const initial=await startReview(client,{product:bed.product.names[0],version:bed.site.LINE,inputs:{subject:{external:`agile:mindmap:${DOCUMENTS.review}`}},parameters:{slice:{from:1,to:1}}});
  await client.call('submit_result',passDraftOf(initial));
  const verified=await verifyBlock({draftRun:initial,verdict:'PARTIAL',level:'P4',session:'synthetic-unrepaired',repairSuggestion:true,keepUnrepaired:true,suggestions:run=>[{nature:'judgment',statement:'补：合成边界；因为：仅正常值；期望：非法输入拒绝',grounds:[run.items[0].location],code:'suggestion',rank:'minor'}]});
  const final=await startReport([await receiptOf(verified.run)]);assert.equal(final.isError,true);assert.ok(final.out.errors.some(error=>error.code==='case-review-report.block_unsettled'),JSON.stringify(final.out.errors));
});
test('report admission rejects a verification made by the drafter model in another session',async()=>{
  const initial=await startReview(client,{product:bed.product.names[0],version:bed.site.LINE,inputs:{subject:{external:`agile:mindmap:${DOCUMENTS.review}`}},parameters:{slice:{from:2,to:2}}});
  await client.call('submit_result',passDraftOf(initial));
  const verified=await verifyBlock({draftRun:initial,verdict:'PARTIAL',level:'P4',session:'synthetic-not-independent',model:DRAFTER,model_identity:DRAFTER_IDENTITY});
  const stored=(await bed.hub.deps.runs.getRun(bed.reviewer.principal,verified.run))!.latest!.result;
  assert.ok(Object.values(stored.partitions).flat().some(item=>item.requirements.some(requirement=>requirement.unsatisfied_reason==='independence_unknown')));
  const final=await startReport([await receiptOf(verified.run)]);assert.equal(final.isError,true);assert.ok(final.out.errors.some(error=>error.code==='case-review-report.block_unsettled'),JSON.stringify(final.out.errors));
});
