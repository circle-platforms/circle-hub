// End to end through the real Hub packages (registry, connectors, knowledge, runs) on synthetic systems: the products sync
// into roots, the draft pack reviews a mind map read from the agile platform, the Hub's own checks judge it, and the
// verification pack verifies the draft in another session with another model. The second product (Lumen API, REST endpoints)
// is reviewed by the same workflow pack: the core knows neither product.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { ItemProjection, RunSummary } from '../../../contracts/src/run.ts';
import type { Submission } from '../../../contracts/src/submission.ts';
import type { RequirementResult, ValidationResult } from '../../../contracts/src/validation.ts';
import { kityminderParser } from '../../../hub/refs/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { DOCUMENTS } from '../../../tests/fixtures/agile/index.ts';
import { compactText, fixtureBytes, largeDocument } from '../../../tests/fixtures/mindmaps/index.ts';
import { ALIAS, RELEASED, UNRELEASED, LINE } from '../../product/famx/testing/site.ts';
import { reviewMindmap } from '../../product/lumen-api/testing/store.ts';
import { PACK_DIRECTORIES } from '../case-review/packaging.ts';
import { openReviewBed, type ReviewBed } from './testing/bed.ts';

let postgres: TemporaryPostgres;
let bed: ReviewBed;

before(async () => {
  postgres = await startPostgres();
  bed = await openReviewBed(postgres);
});
after(async () => {
  await bed?.close();
  await postgres?.stop();
});

// Scripted clients declare exact identities and families independently of their display names.
const DRAFTER = 'alpha-drafter 1.0 (scripted, temperature 0)';
const VERIFIER = 'omega-checker 2.0 (scripted, temperature 0)';
const DRAFTER_IDENTITY={model_id:'synthetic-drafter',model_family_id:'synthetic-family-alpha'};
const VERIFIER_IDENTITY={model_id:'synthetic-verifier',model_family_id:'synthetic-family-omega'};
const DECLARED_SOURCES={stories:['31057'],bugs:['31057']};
const MINDMAP = `agile:mindmap:${DOCUMENTS.review}`;

type Item = ItemProjection;
type Claim = Record<string, unknown>;

function runOf(answer: { call_result: string; run?: RunSummary; errors: unknown[] }): RunSummary {
  assert.equal(answer.call_result, 'ok', JSON.stringify(answer.errors).slice(0, 2000));
  assert.ok(answer.run);
  return answer.run;
}

const byTitle = (run: RunSummary, title: string): Item[] => run.items.filter((i) => i.label === title);
const one = (run: RunSummary, title: string): Item => {
  const found = byTitle(run, title);
  assert.ok(found.length > 0, `no item titled ${title}`);
  return found[0];
};
const sourceOf = (run: RunSummary, prefix: string): string => {
  const found = run.sources.find((s) => (s.external ?? '').startsWith(prefix));
  assert.ok(found, `no source ${prefix}`);
  return found.reference;
};

function requirement(result: ValidationResult, item: string, key: string): RequirementResult {
  for (const list of Object.values(result.partitions)) {
    for (const it of list) if (it.item === item) {
      const found = it.requirements.find((r) => r.requirement === key);
      assert.ok(found, `${item} has no ${key}`);
      return found;
    }
  }
  assert.fail(`item ${item} is in no partition`);
}

/** A slot record for every item: the given findings, an empty list elsewhere. */
function handled(run: RunSummary, key: string, claims: Map<string, Claim[]>): Array<Record<string, unknown>> {
  // An empty optional quality slot declares no semantic judgment. Only its declaring pack receives it.
  return run.items.map((i) => ({ item: i.id, handling: 'handled', slots: { [key]: claims.get(i.id) ?? [], ...(run.requirements.some(requirement=>requirement.key==='expected_quality')?{expected_quality:[]}:{} ) } }));
}

describe('the bed', () => {
  test('publishes every pack with its publish check and syncs both products into roots through the connectors', () => {
    for (const [id, outcome] of Object.entries(bed.publications)) assert.equal(outcome.ok, true, id);
    const famx = bed.syncs.famx;
    assert.equal(famx.error, null);
    // Device aliases are exact declared spellings, including unpublished builds retained by the plan.
    assert.deepEqual(famx.builds.map(b=>[b.name,b.outcome]),[[RELEASED.replaceAll('_','.'),'skipped'],[UNRELEASED.replaceAll('_','.'),'skipped'],[RELEASED,'produced'],[UNRELEASED,'skipped'],[ALIAS,'skipped']]);
    assert.equal(famx.builds.find(build=>build.name===ALIAS)?.base,RELEASED);
    const lumen = bed.syncs['lumen-api'];
    assert.equal(lumen.counts.produced, 2);
    assert.equal(bed.plmWrites(), 0, 'the PLM write route was never reached');
  });
});

describe('the draft review (case-review) and its independent verification (case-review-verify)', () => {
  let draft: RunSummary;
  let draftRecord: string;

  test('start_run on the agile mind map binds the product by either name, the expected sources and the locked root', async () => {
    const detail = await bed.service.startRunDetailed(bed.reviewer, { pack: 'case-review', product: 'FAMY', version: LINE, inputs: { subject: { external: MINDMAP } }, parameters:DECLARED_SOURCES }, bed.call('sess-draft'));
    draft = runOf(detail.answer);
    assert.equal(draft.product, 'famx');
    assert.equal(draft.build, ALIAS);
    assert.equal(draft.root, bed.syncs.famx.builds.find(build=>build.name===RELEASED)?.root, 'the FAMY alias locks the root of its base build');
    assert.ok(draft.items.length > 0 && draft.items.length <= 100);
    for (const item of draft.items) assert.ok((item.summary ?? '').length <= 200);
    const roles = draft.sources.map((s) => [s.external?.split('@')[0] ?? '', s.role]);
    // Since 07925a53 (declared location grammars, owner U19/U20 2026-10-24) the identifiers come only from whole
    // story:/bug: fields (the fixture's folders above the review document) and the run parameters; prose retrieval
    // binds nothing: no spec search, no strategy hint, no similar-list hint.
    assert.deepEqual(roles.filter(([external]) => external.startsWith('plm:')).sort(), [['plm:bug:31057', 'expected'], ['plm:story:31057', 'expected']]);
    assert.ok(roles.every(([external]) => !external.startsWith('manual:spec-search:') && !external.startsWith('manual:qa-search:') && !external.startsWith('agile:search:')), 'keyword retrieval selects no candidate source at all');
    assert.deepEqual(detail.unavailable ?? [], []);
    assert.ok(draft.instructions.length <= 8000);
  });

  // The whole-submission refusals run in a run of their own, so that the repair rounds of the main draft stay untouched.
  let rejects: RunSummary;

  test('a location outside the target keeps the whole submission from being accepted', async () => {
    rejects = runOf(await bed.service.startRun(bed.reviewer, { pack: 'case-review', product: 'FAMX', version: LINE, inputs: { subject: { external: MINDMAP } }, parameters:DECLARED_SOURCES }, bed.call('sess-rejects')));
    const item = one(rejects, 'widget health interval pool1 5');
    const story = sourceOf(rejects, 'plm:story:');
    const claims = new Map([[item.id, [{ text: '位置写成了需求', code: 'coverage_gap', rank: 'minor', location: story, grounds: [story] }]]]);
    const answer = await bed.service.submitResult(bed.reviewer, { run: rejects.run, model: DRAFTER, model_identity:DRAFTER_IDENTITY, items: handled(rejects, 'findings', claims), cross_item: [{ nature: 'judgment', statement: '等级理由：示例', grounds: [], code: 'level', rank: 'P4' }] }, bed.call('sess-rejects'));
    assert.equal(answer.acceptance, 'not_accepted');
    assert.ok(answer.errors.some((e) => e.code === 'REFERENCE_UNRESOLVED' && (e.path ?? '').endsWith('/location')), JSON.stringify(answer.errors).slice(0, 800));
  });

  test('a quotation that is not verbatim keeps the whole submission from being accepted', async () => {
    const item = one(rejects, 'widget health interval pool1 5');
    const claims = new Map([[item.id, [{ text: '引文改了字', code: 'literal_issue', rank: 'minor', location: item.location, quotes: [{ reference: item.location, text: 'widget health interval pool1 50' }] }]]]);
    const answer = await bed.service.submitResult(bed.reviewer, { run: rejects.run, model: DRAFTER, model_identity:DRAFTER_IDENTITY, items: handled(rejects, 'findings', claims), cross_item: [{ nature: 'judgment', statement: '等级理由：示例', grounds: [], code: 'level', rank: 'P4' }] }, bed.call('sess-rejects'));
    assert.equal(answer.acceptance, 'not_accepted');
    assert.ok(answer.errors.some((e) => e.code === 'QUOTE_MISMATCH'));
  });

  test('a command line the case does not write is the model\'s statement: sent back for repair, never a fact about the case', async () => {
    const run = runOf(await bed.service.startRun(bed.reviewer, { pack: 'case-review', product: 'FAMX', version: LINE, inputs: { subject: { external: MINDMAP } }, parameters:DECLARED_SOURCES }, bed.call('sess-cited')));
    const normal = one(run, 'widget health interval pool1 5');
    const negative = byTitle(run, 'widget health retries pool1 0').find((i) => i.fields.negative === true)!;
    const finding = (item: Item, command: string): Claim => ({ text: '引用的命令行不在这个用例里', code: 'literal_issue', rank: 'minor', location: item.location, quotes: [{ reference: item.location, text: item.label }], commands: [{ command }] });
    const claims = new Map<string, Claim[]>([
      [normal.id, [finding(normal, 'widget health interval pool1 999')]],
      [negative.id, [finding(negative, 'widget health interval pool1 5')]],
    ]);
    const answer = await bed.service.submitResult(bed.reviewer, { run: run.run, model: DRAFTER, model_identity:DRAFTER_IDENTITY, items: handled(run, 'findings', claims), cross_item: [{ nature: 'judgment', statement: '等级理由：示例', grounds: [], code: 'level', rank: 'P4' }] }, bed.call('sess-cited'));
    assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors).slice(0, 1500));
    for (const item of [normal, negative]) {
      const repair = answer.errors.find((e) => e.code === 'case-review.command_not_in_case' && e.item === item.id);
      assert.ok(repair && repair.requirement === 'findings' && (repair.rounds_left ?? 0) >= 1, JSON.stringify(answer.errors).slice(0, 1500));
    }
    // No fact about the case comes from a line the case does not write: the normal case has nothing to check, and the
    // negative case's expected refutation is neither met nor faked by another case's valid line.
    const normalCatalog = requirement(answer.result!, normal.id, 'catalog');
    assert.equal(normalCatalog.status,'satisfied');
    assert.equal(normalCatalog.layers[0].terminal,'pass','a settled fact is not rewritten by another requirement repair');
    assert.notEqual(normalCatalog.layers[0].code, 'core.catalog.param_out_of_range');
    const negativeCatalog = requirement(answer.result!, negative.id, 'catalog');
    assert.equal(negativeCatalog.status,'satisfied');
    assert.ok(negativeCatalog.claims.some(c=>c.statement.code==='core.catalog.param_out_of_range' && c.statement.data?.command==='widget health retries pool1 0'));
    assert.ok(!negativeCatalog.claims.some(c=>c.statement.data?.command==='widget health interval pool1 5'));
    assert.notEqual(negativeCatalog.unsatisfied_reason, 'outcome_mismatch', JSON.stringify(negativeCatalog).slice(0, 800));
  });

  test('the Hub judges the literal issues and the cited commands itself; a contradicted command statement and an unquoted finding go back for repair', async () => {
    const negative = byTitle(draft, 'widget health retries pool1 0').find((i) => i.fields.negative === true);
    assert.ok(negative, 'the negative case');
    const probe = one(draft, 'widget health probe pool1 tcp');
    const interval = one(draft, 'widget health interval pool1 5');
    // Keyword retrieval binds nothing since 07925a53 (U19/U20): there is no hint source to cite.
    const story = sourceOf(draft, 'plm:story:');
    const claims = new Map<string, Claim[]>([
      [negative.id, [{ text: '只测了越界值 0，缺少 11 和超长字符串', code: 'edge_case_gap', rank: 'minor', location: negative.location, quotes: [{ reference: negative.location, text: 'widget health retries pool1 0' }], commands: [{ command: 'widget health retries pool1 0' }] }]],
      [probe.id, [{ text: '期望结果写的是 http，与操作 tcp 不一致', code: 'self_contradiction', rank: 'major', location: probe.location, quotes: [{ reference: probe.location, text: 'widget health probe pool1 tcp' }], commands: [{ command: 'widget health probe pool1 tcp' }] }]],
      [interval.id, [
        { text: '命令 widget health interval 在这个构建里不存在', code: 'literal_issue', rank: 'minor', location: interval.location, quotes: [{ reference: interval.location, text: 'widget health interval pool1 5' }], commands: [{ command: 'widget health interval', present: false }] },
        { text: '需求里还测了 HTTPS 探测，这里没有覆盖', code: 'coverage_gap', rank: 'major', location: interval.location, grounds: [story] },
      ]],
    ]);
    const answer = await bed.service.submitResult(bed.reviewer, { run: draft.run, model: DRAFTER, model_identity:DRAFTER_IDENTITY, items: handled(draft, 'findings', claims), cross_item: [{ nature: 'judgment', statement: '等级理由：覆盖了全部功能，有一些反向用例，兼容性不足；证据缺口：命令的已验证测试事实（足迹）还没有', grounds: [story], code: 'level', rank: 'P4' }] }, bed.call('sess-draft'));
    assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors).slice(0, 2000));
    const result = answer.result!;
    // The negative case cites its out-of-range command line: the expected refutation, shown at advisory tier.
    const catalog = requirement(result, negative.id, 'catalog');
    assert.equal(catalog.status, 'satisfied');
    assert.deepEqual(catalog.layers.find((l) => l.layer === 'static'), { layer: 'static', terminal: 'violation', code: 'core.catalog.param_out_of_range', tier: 'advisory' });
    // The strict command grammar (27f1918d) declares the probe argument fully (the {http|tcp} enumeration), so the
    // catalog check of an otherwise valid command completes; the unchecked-constraint gap lives on in the pack's own
    // command-tree tests (an unrecognized limit write stays an unchecked constraint there).
    const probeCatalog=requirement(result,probe.id,'catalog');
    assert.equal(probeCatalog.status,'satisfied');
    // The statement that an existing command does not exist: a violation routed to repair, not a whole rejection.
    const contradicted = answer.errors.find((e) => e.code === 'core.catalog.membership_contradicted');
    assert.ok(contradicted && contradicted.item === interval.id && contradicted.requirement === 'findings' && (contradicted.rounds_left ?? 0) >= 1, JSON.stringify(answer.errors));
    // With keyword retrieval retired the coverage gap must ground on the bound story source, so no hint-only repair remains.
    assert.equal(requirement(result, interval.id, 'findings').layers[0].terminal, 'violation');
    // Literal issues are the Hub's facts: the two identical cases of the document are duplicates.
    const duplicates = byTitle(draft, 'show health 显示所有池的状态');
    assert.equal(duplicates.length, 2);
    for (const d of duplicates) assert.equal(requirement(result, d.id, 'literal').layers[0].code, 'core.structure.duplicate_key');
    assert.equal(requirement(result, interval.id, 'literal').status, 'unsatisfied');
    assert.equal(requirement(result,interval.id,'literal').layers[0].code,'case-review.tag_variant');
    // A tag outside the closed set (Configure) is an undeclared tag: advisory, naming the allowed exact spellings;
    // the author picks from them, nothing is inferred (owner R2 2026-10-24).
    assert.deepEqual(requirement(result, probe.id, 'literal').layers[0], { layer: 'static', terminal: 'violation', code: 'case-review.tag_variant', tier: 'advisory', attribution: 'author_input' });
    const spelling = requirement(result, probe.id, 'literal').claims.find((c) => c.statement.code === 'case-review.tag_variant');
    assert.ok(spelling && spelling.statement.data?.issues!==undefined && JSON.stringify(spelling.statement.data.issues).includes('Configure') && spelling.statement.text.includes('configuration'), JSON.stringify(spelling?.statement));
    assert.ok(result.cross_item.some((c) => c.requirement === 'level' && c.statement.rank === 'P4'));
  });

  test('a corrected submission is accepted without repair errors', async () => {
    const negative = byTitle(draft, 'widget health retries pool1 0').find((i) => i.fields.negative === true)!;
    const probe = one(draft, 'widget health probe pool1 tcp');
    const interval = one(draft, 'widget health interval pool1 5');
    const story = sourceOf(draft, 'plm:story:');
    const claims = new Map<string, Claim[]>([
      [negative.id, [{ text: '只测了越界值 0，缺少 11 和超长字符串', code: 'edge_case_gap', rank: 'minor', location: negative.location, quotes: [{ reference: negative.location, text: 'widget health retries pool1 0' }], commands: [{ command: 'widget health retries pool1 0' }] }]],
      [probe.id, [{ text: '期望结果写的是 http，与操作 tcp 不一致', code: 'self_contradiction', rank: 'major', location: probe.location, quotes: [{ reference: probe.location, text: 'widget health probe pool1 tcp' }], commands: [{ command: 'widget health probe pool1 tcp' }] }]],
      [interval.id, [{ text: '需求要求探测间隔 1 到 60 秒，缺少边界值 1 和 60', code: 'edge_case_gap', rank: 'minor', location: interval.location, quotes: [{ reference: interval.location, text: 'widget health interval pool1 5' }], grounds: [story], commands: [{ command: 'widget health interval', present: true }] }]],
    ]);
    const answer = await bed.service.submitResult(bed.reviewer, { run: draft.run, model: DRAFTER, model_identity:DRAFTER_IDENTITY, items: handled(draft, 'findings', claims), cross_item: [{ nature: 'judgment', statement: '等级理由：覆盖了全部功能，有一些反向用例，兼容性不足；证据缺口：命令的已验证测试事实（足迹）还没有', grounds: [story], code: 'level', rank: 'P4' }] }, bed.call('sess-draft'));
    assert.equal(answer.acceptance, 'accepted');
    assert.deepEqual(answer.errors.filter(error=>error.requirement==='findings'),[],'the corrected findings have no repair errors');
    for(const error of answer.errors){assert.ok(['literal','catalog','expected_quality'].includes(error.requirement??''));assert.ok(['missing_input','repair_exhausted'].includes(error.code));assert.ok(error.fix?.includes('请求 rec:'));}
    assert.equal(requirement(answer.result!,interval.id,'expected_quality').status,'pending','no quality judgment was submitted');
    assert.equal(requirement(answer.result!, interval.id, 'findings').status, 'satisfied');
    assert.equal(requirement(answer.result!, interval.id, 'catalog').status, 'satisfied');
    const stored = await bed.service.getResult(bed.reviewer, draft.run);
    assert.ok(stored);
    draftRecord = stored.record;
  });

  let verify: RunSummary;

  test('start_run of the verification: the draft items with their draft findings and the draft level', async () => {
    const answer = await bed.service.startRun(bed.reviewer, { pack: 'case-review-verify', parameters:DECLARED_SOURCES, product: 'FAMX', version: LINE, build: ALIAS, inputs: { target: { external: MINDMAP }, draft: { reference: `rec:${draftRecord}` } }, predecessor: draft.run }, bed.call('sess-verify'));
    verify = runOf(answer);
    assert.deepEqual(verify.items.map((i) => i.id).sort(), draft.items.map((i) => i.id).sort());
    const probe = one(verify, 'widget health probe pool1 tcp');
    const findings = probe.fields.draft_findings as Array<{ reference: string; code: string; rank: string; location: string }>;
    assert.equal(findings.length, 1);
    assert.match(findings[0].reference, new RegExp(`^rec:${draftRecord}#/partitions/[a-z]+/[0-9]+/requirements/[0-9]+/claims/[0-9]+$`));
    assert.deepEqual([findings[0].code, findings[0].rank], ['self_contradiction', 'major']);
    assert.equal(findings[0].location, one(draft, 'widget health probe pool1 tcp').location);
    assert.match(probe.summary ?? '', /初评 1 条发现：self_contradiction\/major/);
    assert.equal((probe.fields.draft_level as { rank: string }).rank, 'P4');
    assert.equal(verify.predecessor, draft.run);
  });

  const dispositions = (run: RunSummary, verdicts: Record<string, string>): Map<string, Claim[]> => {
    const out = new Map<string, Claim[]>();
    for (const item of run.items) {
      const list = (item.fields.draft_findings as Array<{ reference: string }>).map((f) => ({
        text: '对照被复核脑图和需求核实',
        code: verdicts[item.label] ?? 'verified',
        rank: 'major',
        location: item.location,
        quotes: [{ reference: item.location, text: item.label }],
        data: { finding: f.reference },
      }));
      out.set(item.id, list);
    }
    return out;
  };

  test('the verification from the draft\'s own session and model is not independent', async () => {
    const answer = await bed.service.submitResult(bed.reviewer, { run: verify.run, model: DRAFTER, model_identity:DRAFTER_IDENTITY, items: handled(verify, 'verification', dispositions(verify, {})), cross_item: [{ nature: 'judgment', statement: '结论 PASS', grounds: [], code: 'PASS', rank: 'P4' }] }, bed.call('sess-draft'));
    assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors).slice(0, 1500));
    const probe = one(verify, 'widget health probe pool1 tcp');
    const status = requirement(answer.result!, probe.id, 'verification');
    assert.equal(status.status, 'unsatisfied');
    assert.equal(status.unsatisfied_reason, 'independence_unknown');
  });

  test('a PASS that refutes a draft finding is sent back with a fix; a consistent PARTIAL from another session and model is accepted and independent', async () => {
    const probe = one(verify, 'widget health probe pool1 tcp');
    const refuted = await bed.service.submitResult(bed.reviewer, { run: verify.run, model: VERIFIER, model_identity:VERIFIER_IDENTITY, items: handled(verify, 'verification', dispositions(verify, { [probe.label]: 'refuted' })), cross_item: [{ nature: 'judgment', statement: '结论 PASS', grounds: [], code: 'PASS', rank: 'P4' }] }, bed.call('sess-verify'));
    assert.equal(refuted.acceptance, 'accepted');
    const inconsistent = refuted.errors.find((e) => e.code === 'case-review-verify.pass_with_refuted');
    assert.ok(inconsistent && inconsistent.requirement === 'verification' && (inconsistent.rounds_left ?? 0) >= 1, JSON.stringify(refuted.errors).slice(0, 1500));
    assert.match(inconsistent.message, /FAIL 或 PARTIAL/);

    const claims = dispositions(verify, {});
    const interval = one(verify, 'widget health interval pool1 5');
    claims.set(interval.id, [...(claims.get(interval.id) ?? []), { text: '缺少探测间隔为 0 的反向用例', code: 'new_finding', rank: 'minor', location: interval.location, quotes: [{ reference: interval.location, text: interval.label }], data: { probe: 'negative_gap' } }]);
    const partial = await bed.service.submitResult(bed.reviewer, { run: verify.run, model: VERIFIER, model_identity:VERIFIER_IDENTITY, items: handled(verify, 'verification', claims), cross_item: [{ nature: 'judgment', statement: '结论理由：初评基本正确，遗漏了一个反向用例；对初评等级的质疑：P4 合适', grounds: [interval.location], code: 'PARTIAL', rank: 'P4' }, { nature: 'judgment', statement: '补：探测间隔为 0 的反向用例；因为：只覆盖上界外的 61；期望：提示参数超出范围 1-60', grounds: [interval.location], code: 'suggestion', rank: 'minor' }] }, bed.call('sess-verify'));
    assert.equal(partial.acceptance, 'accepted');
    assert.deepEqual(partial.errors.filter((e) => e.rounds_left !== undefined), [], JSON.stringify(partial.errors).slice(0, 1500));
    const status = requirement(partial.result!, interval.id, 'verification');
    assert.equal(status.status, 'satisfied', JSON.stringify(status).slice(0, 1500));
    const final = partial.result!.cross_item.find((c) => c.requirement === 'final' && c.statement.code === 'PARTIAL');
    assert.ok(final && final.warrant.independence !== undefined);
  });

  // A second verification of the same draft in a session of its own, so that the repair rounds of the first stay untouched.
  let second: RunSummary;
  const targetModel = kityminderParser.parse(fixtureBytes('review-150.km.json')).model;
  /** A quotation of the target the draft did not make: the case's first expected result, at its own node. */
  const expectedQuote = (item: Item): { reference: string; text: string } => {
    const node = targetModel.nodes.find((n) => n.id === item.fields.nodeId);
    const child = node === undefined ? undefined : targetModel.nodes[node.children[0]];
    assert.ok(child, `${item.label} has no expected result`);
    return { reference: item.location.replace(/\/kityminder@1\/.+$/, `/kityminder@1/${child.selector}`), text: child.text };
  };
  /** One disposition per draft finding: the code given by the item label (verified elsewhere), with these quotations. */
  const disposeEvery = (run: RunSummary, quotes: (item: Item) => Array<{ reference: string; text: string }>, codes: Record<string, string> = {}): Map<string, Claim[]> => {
    const out = new Map<string, Claim[]>();
    for (const item of run.items) {
      const findings = item.fields.draft_findings as Array<{ reference: string }>;
      out.set(item.id, findings.map((f) => ({ text: '对照被复核脑图和需求核实', code: codes[item.label] ?? 'verified', rank: 'minor', location: item.location, quotes: quotes(item), data: { finding: f.reference } })));
    }
    return out;
  };

  test('the verifier\'s statement that an existing command does not exist goes back for repair; a PASS that quotes no part of the target of its own is refused', async () => {
    second = runOf(await bed.service.startRun(bed.reviewer, { pack: 'case-review-verify', parameters:DECLARED_SOURCES, product: 'FAMX', version: LINE, build: ALIAS, inputs: { target: { external: MINDMAP }, draft: { reference: `rec:${draftRecord}` } }, predecessor: draft.run }, bed.call('sess-verify-2')));
    const text = '探测间隔 1 到 60 秒';
    const found = await bed.service.resolveReference(bed.reviewer, { run: second.run, text, expect: 'quotation' }, bed.call('sess-verify-2'));
    const story = found.references.find((r) => r.role === 'expected');
    assert.ok(story, JSON.stringify(found).slice(0, 800));
    // Every disposition copies the draft finding's location and quotes only the story; on one case the verifier also says that
    // a command the build's catalog has does not exist.
    const claims = disposeEvery(second, () => [{ reference: story.reference, text }]);
    const interval = one(second, 'widget health interval pool1 5');
    claims.set(interval.id, (claims.get(interval.id) ?? []).map((c) => ({ ...c, commands: [{ command: 'widget health interval', present: false }] })));
    assert.ok((claims.get(interval.id) ?? []).length > 0, 'the case carries a draft finding');
    const answer = await bed.service.submitResult(bed.reviewer, { run: second.run, model: VERIFIER, model_identity:VERIFIER_IDENTITY, items: handled(second, 'verification', claims), cross_item: [{ nature: 'judgment', statement: '结论 PASS', grounds: [story.reference], code: 'PASS', rank: 'P4' }] }, bed.call('sess-verify-2'));
    assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors).slice(0, 1500));
    const contradicted = answer.errors.find((e) => e.code === 'core.catalog.membership_contradicted');
    assert.ok(contradicted && contradicted.item === interval.id && contradicted.requirement === 'verification' && (contradicted.rounds_left ?? 0) >= 1, JSON.stringify(answer.errors).slice(0, 1500));
    assert.equal(requirement(answer.result!, interval.id, 'verification').layers[0].terminal, 'violation');
    const evidence = answer.errors.find((e) => e.code === 'case-review-verify.pass_without_evidence');
    assert.ok(evidence && evidence.requirement === 'verification' && (evidence.rounds_left ?? 0) >= 1, JSON.stringify(answer.errors).slice(0, 1500));
  });

  test('a PASS is refused while a draft finding has no disposition: the case that holds it was skipped', async () => {
    const probe = one(second, 'widget health probe pool1 tcp');
    assert.equal((probe.fields.draft_findings as unknown[]).length, 1);
    const claims = disposeEvery(second, (item) => [expectedQuote(item)]);
    const items = second.items.map((i) => (i.id === probe.id ? { item: i.id, handling: 'skipped', reason: '没有时间看这一条' } : { item: i.id, handling: 'handled', slots: { verification: claims.get(i.id) ?? [] } }));
    const answer = await bed.service.submitResult(bed.reviewer, { run: second.run, model: VERIFIER, model_identity:VERIFIER_IDENTITY, items, cross_item: [{ nature: 'judgment', statement: '结论 PASS', grounds: [], code: 'PASS', rank: 'P4' }] }, bed.call('sess-verify-2'));
    assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors).slice(0, 1500));
    const unverified = answer.errors.find((e) => e.code === 'case-review-verify.pass_with_unverified');
    assert.ok(unverified && unverified.requirement === 'verification' && (unverified.rounds_left ?? 0) >= 1, JSON.stringify(answer.errors).slice(0, 1500));
    assert.ok(!answer.errors.some((e) => e.code === 'case-review-verify.pass_without_evidence'), 'the expected results the verifier quoted are its own check of the target');
  });

  test('a refutation of a minor draft finding with the level unchanged is a consistent PARTIAL', async () => {
    const negative = byTitle(second, 'widget health retries pool1 0').find((i) => (i.fields.draft_findings as Array<{ rank: string }>).some((f) => f.rank === 'minor'));
    assert.ok(negative, 'the negative case with its minor draft finding');
    const claims = disposeEvery(second, (item) => [expectedQuote(item)], { [negative.label]: 'refuted' });
    const answer = await bed.service.submitResult(bed.reviewer, { run: second.run, model: VERIFIER, model_identity:VERIFIER_IDENTITY, items: handled(second, 'verification', claims), cross_item: [{ nature: 'judgment', statement: '结论理由：初评基本正确，推翻了一条次要发现；对初评等级的质疑：P4 合适', grounds: [], code: 'PARTIAL', rank: 'P4' }] }, bed.call('sess-verify-2'));
    assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors).slice(0, 1500));
    assert.deepEqual(answer.errors.filter((e) => e.rounds_left !== undefined), [], JSON.stringify(answer.errors).slice(0, 1500));
    assert.equal(requirement(answer.result!, negative.id, 'verification').status, 'satisfied');
    const consistent = answer.result!.cross_item.find((c) => c.requirement === 'final' && c.statement.verdict === 'support');
    assert.ok(consistent && /PARTIAL/.test(consistent.statement.text), JSON.stringify(answer.result!.cross_item.map((c) => c.statement)).slice(0, 1500));
  });

  test('case-review examples/submit-result.json is accepted by submitResult', async () => {
    const raw = JSON.parse(await readFile(join(PACK_DIRECTORIES['case-review'], 'examples', 'submit-result.json'), 'utf8')) as Record<string, unknown>;
    const started = await bed.service.startRun(bed.reviewer, { pack: 'case-review', product: 'FAMY', version: LINE, inputs: { subject: { external: MINDMAP } }, parameters:DECLARED_SOURCES }, bed.call('sess-example-draft-start'));
    const exampleRun=runOf(started);
    const body = { ...raw, run:exampleRun.run,model_identity:DRAFTER_IDENTITY,items:(raw.items as Array<{slots?:Record<string,unknown>}>).map(item=>({...item,...(item.slots?{slots:{...item.slots,expected_quality:[]}}:{})})) };
    const answer = await bed.service.submitResult(bed.reviewer, body as Submission, bed.call('sess-example-draft-sub'));
    assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
  });

  test('case-review-verify examples/submit-result.json is accepted by submitResult', async () => {
    const raw = JSON.parse(await readFile(join(PACK_DIRECTORIES['case-review-verify'], 'examples', 'submit-result.json'), 'utf8')) as Record<string, unknown>;
    const started = await bed.service.startRun(bed.reviewer, { pack: 'case-review-verify', parameters:DECLARED_SOURCES, product: 'FAMX', version: LINE, inputs: { target: { external: MINDMAP }, draft: { reference: `rec:${draftRecord}` } }, predecessor: draft.run }, bed.call('sess-example-verify-start'));
    const body = { ...raw, run: runOf(started).run };
    const answer = await bed.service.submitResult(bed.reviewer, body as Submission, bed.call('sess-example-verify-sub'));
    assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
  });
});

describe('a large document', () => {
  test('is refused with the blocks to review one by one, and a block starts a run of at most 100 items', async () => {
    const upload = await bed.upload(bed.reviewer, new TextEncoder().encode(compactText(largeDocument())), 'large.km.json');
    const refused = await bed.service.startRun(bed.reviewer, { pack: 'case-review', product: 'FAMX', version: LINE, inputs: { subject: { reference: upload } } }, bed.call('sess-large'));
    assert.equal(refused.call_result, 'error');
    const error = refused.errors.find((e) => e.code === 'case-review.too_many_cases');
    assert.ok(error, JSON.stringify(refused.errors).slice(0, 800));
    const first = /block=("[^"]+")（[^，]+，([0-9]+) 例）/.exec(error.fix ?? '');
    assert.ok(first, error.fix);
    const block = runOf(await bed.service.startRun(bed.reviewer, { pack: 'case-review', product: 'FAMX', version: LINE, inputs: { subject: { reference: upload } }, parameters: { block: JSON.parse(first[1]) as string } }, bed.call('sess-large')));
    assert.equal(block.items.length, Number(first[2]));
    assert.ok(block.items.length <= 100);
  });
});

describe('the second product: REST endpoints reviewed by the same workflow pack', () => {
  test('the catalog of the build the run locks judges the cited endpoints; a negative case expects its refutation', async () => {
    const upload = await bed.upload(bed.reviewer, reviewMindmap(), 'lumen-review.km.json');
    const latest = runOf(await bed.service.startRun(bed.reviewer, { pack: 'case-review', product: 'Lumen API', version: '2.1', inputs: { subject: { reference: upload } } }, bed.call('sess-lumen')));
    assert.equal(latest.product, 'lumen-api');
    assert.equal(latest.build, 'lumen-2.1.0-b7');
    assert.equal(latest.items.length, 6);
    const negative = one(latest, 'GET /v1/pools 500');
    const remove = one(latest, 'DELETE /v1/pools/{id} true');
    const finding = (item: Item, claim: Claim): Claim => ({ text: '示例发现', code: 'edge_case_gap', rank: 'minor', location: item.location, quotes: [{ reference: item.location, text: item.label }], ...claim });
    const claims = new Map<string, Claim[]>([
      [negative.id, [finding(negative, { commands: [{ command: 'GET /v1/pools 500' }] })]],
      [remove.id, [finding(remove, { commands: [{ command: 'DELETE /v1/pools/{id}', present: true }, { command: 'PATCH /v1/pools', present: false }] })]],
    ]);
    const answer = await bed.service.submitResult(bed.reviewer, { run: latest.run, model: DRAFTER, model_identity:DRAFTER_IDENTITY, items: handled(latest, 'findings', claims), cross_item: [{ nature: 'judgment', statement: '等级理由：示例', grounds: [], code: 'level', rank: 'P5' }] }, bed.call('sess-lumen'));
    assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors).slice(0, 1500));
    const catalog = requirement(answer.result!, negative.id, 'catalog');
    assert.equal(negative.fields.negative,null);
    assert.equal(catalog.status, 'unsatisfied');
    assert.equal(catalog.unsatisfied_reason,'outcome_mismatch');
    assert.equal(catalog.layers[0].code, 'core.catalog.param_out_of_range');
    // GET /v1/health has no explicit empty parameter table, so this source is incomplete.
    // The known DELETE head is usable, but PATCH absence cannot be established from a partial catalog.
    const removal=requirement(answer.result!,remove.id,'catalog');
    assert.equal(removal.status,'pending');
    assert.ok(removal.claims.some(claim=>claim.statement.verdict==='unknown'));
    assert.ok(removal.layers[0].missing);
    // The two identical health cases are duplicates for this product too.
    for (const d of byTitle(latest, 'GET /v1/health')) assert.equal(requirement(answer.result!, d.id, 'literal').layers[0].code, 'core.structure.duplicate_key');

    // The older reference omits DELETE, but its missing empty parameter table also makes it incomplete.
    // Absence is unknown with a bound exit, rather than a fabricated contradiction.
    const older = runOf(await bed.service.startRun(bed.reviewer, { pack: 'case-review', product: 'Lumen API', version: '2.0', inputs: { subject: { reference: upload } } }, bed.call('sess-lumen')));
    assert.equal(older.build, 'lumen-2.0.4-b30');
    const removeOld = one(older, 'DELETE /v1/pools/{id} true');
    const oldAnswer = await bed.service.submitResult(bed.reviewer, { run: older.run, model: DRAFTER, model_identity:DRAFTER_IDENTITY, items: handled(older, 'findings', new Map([[removeOld.id, [finding(removeOld, { commands: [{ command: 'DELETE /v1/pools/{id}', present: true }] })]]])), cross_item: [{ nature: 'judgment', statement: '等级理由：示例', grounds: [], code: 'level', rank: 'P5' }] }, bed.call('sess-lumen'));
    const oldCatalog=requirement(oldAnswer.result!,removeOld.id,'catalog');
    assert.equal(oldCatalog.status,'pending');
    assert.ok(oldCatalog.claims.some(claim=>claim.statement.verdict==='unknown'&&claim.statement.reason==='integrity_unproven'));
    assert.ok(oldCatalog.layers[0].missing&&oldCatalog.layers[0].exit);
    assert.ok(!oldAnswer.errors.some(error=>error.code==='core.catalog.membership_contradicted'&&error.item===removeOld.id));
  });
});
