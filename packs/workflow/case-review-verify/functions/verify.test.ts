import {kityminderParser} from "../../../../hub/testing/parsers.ts";
// The functions of the verification pack against the contract shapes: the projection of a draft validation result onto the
// target, the expected sources, the two checks, the copies of the draft pack's modules and the pack codes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CORE_VIOLATION_CODES } from '../../../../contracts/generated/protocol.ts';
import { ExpectedSourcesOutput, ProjectionOutput } from '../../../../contracts/src/pack.ts';
import { CheckOutcome } from '../../../../contracts/src/tables.ts';
import { ValidationResult } from '../../../../contracts/src/validation.ts';

import { callPackFunction, osIsolationAvailable } from '../../../../hub/rules/api.ts';
import expectedFn, { expected } from './expected.ts';
import projectionFn, { MAX_SUMMARY, projection } from './projection.ts';
import verifyFn, { CODES, dispositions, dispositionsCheck, verdict, verdictCheck, suggestionTargets } from './verify.ts';
import { claimSubject } from './subjects.ts';
import { createReviewScope } from './review-scope.ts';

const TARGET = 'a'.repeat(64);
const RECORD = 'b'.repeat(64);
const RUN = 'run_01m5h9zm2nhzbz2hrfjfb6azta';
const context = { product: 'sample', names: ['Widget'], line: '1.0', build: 'Rel_1_0_1', root: 'd'.repeat(64), parameters: {}, groups: [] };

const mindmap = kityminderParser.parse(
  new TextEncoder().encode(
    JSON.stringify({
      root: {
        data: { id: 'root', text: '需求 20931 示例网关健康检查' },
        children: [
          { data: { id: 'g1', text: '基本功能', priority: 1 }, children: [
            { data: { id: 'c1', text: '设置探测间隔', priority: 2, resource: ['Functional'] }, children: [{ data: { id: 'c1e', text: '间隔生效' }, children: [] }] },
            { data: { id: 'c2', text: '设置重试次数', priority: 2, resource: ['Functional'] }, children: [{ data: { id: 'c2e', text: '次数生效' }, children: [] }] },
          ] },
        ],
      },
    }),
  ),
).model;

const loc = (node: string, sha = TARGET) => `src:${sha}/kityminder@1/n/${node}`;
const validity = { status: 'valid', bound: [TARGET], premises: [] };

function judgment(requirement: string, statement: Record<string, unknown>, resolutions: unknown[] = []): Record<string, unknown> {
  return {
    requirement,
    pointer: '/items/0/slots/findings/0',
    statement,
    qualifier: { nature: 'judgment', provenance: 'declared', basis_rank: 'judgment', marks: ['semantics_unasserted'] },
    grounds: [],
    warrant: { producer: 'model', id: 'alpha-drafter 1.0' },
    ...(resolutions.length > 0 ? { resolution: 'resolved', resolutions } : {}),
    validity,
  };
}

const fact = (requirement: string) => ({
  requirement,
  statement: { text: '检查通过', verdict: 'support' },
  qualifier: { nature: 'fact', provenance: 'projected', basis_rank: 'rule_over_observation', source_role: 'subject', marks: [] },
  grounds: [],
  warrant: { producer: 'function', id: 'structure@1', independence: 'judge_not_author' },
  validity,
});

function item(node: string, label: string, findings: Record<string, unknown>[]) {
  return {
    item: `880001:${node}`,
    label,
    location: loc(node),
    requirements: [
      { requirement: 'literal', layers: [{ layer: 'static', terminal: 'pass' }], status: 'satisfied', claims: [fact('literal')] },
      { requirement: 'findings', layers: [{ layer: 'static', terminal: 'judgment' }], status: 'satisfied', claims: [...findings, fact('findings')] },
    ],
  };
}

function draftResult(changes: Record<string, unknown> = {}) {
  const finding = judgment('findings', { text: '期望结果不可验证', code: 'coverage_gap', rank: 'major' }, [
    { pointer: '/items/0/slots/findings/0/location', text: loc('c1'), resolution: 'resolved', references: [loc('c1')] },
    { pointer: '/items/0/slots/findings/0/quotes/0', text: '设置探测间隔', resolution: 'resolved', references: [`${loc('c1')}:0-18`] },
    { pointer: '/items/0/slots/findings/0/commands/0', text: 'widget health interval pool1 5', resolution: 'resolved', references: [`tree:${'d'.repeat(64)}/commands/widget/health/interval`] },
  ]);
  const result = {
    schema: 'validation@1',
    run: RUN,
    submission: 'e'.repeat(64),
    acceptance: 'accepted',
    errors: [],
    rounds: { used: 0, max: 2 },
    partitions: { delivered: [item('c2', '设置重试次数', []), item('c1', '设置探测间隔', [finding])], rejected: [], quarantined: [], incomplete: [] },
    cross_item: [fact('literal'), judgment('level', { text: '等级理由：示例', code: 'level', rank: 'P4' })],
    coverage: { complete: true, examined: 2, total: 2 },
    locks: { pack: 'case-review@1.0.0', pack_digest: 'f'.repeat(64) },
    trace: '4bf92f3577b34da6a3ce929d0e0e4736',
    ...changes,
  };
  const entries = Object.values(result.partitions).flat();
  const scope = createReviewScope({
    source: TARGET,
    document: '880001',
    parameters: { case_rule: 'marked', case_priority: 2, group_priority: 1, precondition_priority: 3 },
    expected: entries.map(entry => ({ item: entry.item, location: entry.location })),
    selected: entries.map(entry => entry.item),
  });
  if (!Object.hasOwn(changes, 'cross_item')) result.cross_item.splice(1, 0, { ...fact('level'), statement: { text: '冻结整份识别范围', verdict: 'support', data: { review_scope: scope } } });
  return result;
}

const record = (body: unknown) => ({ kind: 'validation_result', schema: 'validation@1', provenance: 'projected', created_at: '2026-10-22T08:00:00.000Z', body });
const target = (sha = TARGET) => ({ slot: 'target', external: 'agile:mindmap:880001', sha256: sha, media_type: 'application/json', parser: 'kityminder@1', model: mindmap, meta: { title: '需求 20931 示例网关健康检查', ancestors: ['Widget', 'bug 57001'] } });
const draft = (model: unknown, meta: Record<string, unknown> = { record: RECORD, kind: 'validation_result', schema: 'validation@1' }) => ({ slot: 'draft', external: null, sha256: 'c'.repeat(64), media_type: 'application/json', parser: 'json@1', model, meta });
const input = (inputs: unknown[]) => ({ inputs, parameters: {}, context });

type Projected = { items: Array<{ id: string; label: string; summary?: string; location: { slot?: string; selector: string }; fields: Record<string, unknown> }>; groups: Array<Record<string, unknown>>; warnings: Array<{ code: string }> };

function projected(value: unknown): Projected {
  assert.ok(ProjectionOutput.safeParse(value).success, JSON.stringify(ProjectionOutput.safeParse(value).error?.issues?.slice(0, 3)));
  assert.ok(!('error' in (value as object)), JSON.stringify((value as { error?: unknown }).error));
  return value as Projected;
}

function refused(value: unknown, code: string): void {
  assert.ok(ProjectionOutput.safeParse(value).success);
  const error = (value as { error?: { code: string; message: string; fix: string } }).error;
  assert.equal(error?.code, code, JSON.stringify(value).slice(0, 400));
  assert.match(error.fix, /\p{Script=Han}/u);
}

describe('projection of the draft result onto the target', () => {
  it('the synthetic draft result is a validation@1 value', () => {
    assert.ok(ValidationResult.safeParse(draftResult()).success, JSON.stringify(ValidationResult.safeParse(draftResult()).error?.issues?.slice(0, 3)));
  });

  it('gives the draft items in the order of the target, each with its draft findings by rec: reference and the draft level', () => {
    const out = projected(projection(input([target(), draft(record(draftResult()))])));
    assert.deepEqual(out.items.map((i) => i.id), ['880001:c1', '880001:c2']);
    const [first, second] = out.items;
    assert.deepEqual(first.location, { slot: 'target', parser: 'kityminder@1', selector: 'n/c1' });
    const findings = first.fields.draft_findings as Array<Record<string, unknown>>;
    assert.deepEqual(findings, [
      {
        reference: `rec:${RECORD}#/partitions/delivered/1/requirements/1/claims/0`,
        code: 'coverage_gap',
        rank: 'major',
        text: '期望结果不可验证',
        location: loc('c1'),
        quotes: [{ reference: `${loc('c1')}:0-18`, text: '设置探测间隔' }],
        commands: ['widget health interval pool1 5'],
      },
    ]);
    assert.deepEqual(second.fields.draft_findings, [], 'Hub facts are not draft findings');
    assert.deepEqual(first.fields.draft_level, { reference: `rec:${RECORD}#/cross_item/2`, rank: 'P4', text: '等级理由：示例' });
    assert.deepEqual(first.fields.path, ['需求 20931 示例网关健康检查', '基本功能']);
    assert.equal(first.fields.draft_partition, 'delivered');
    for (const i of out.items) assert.ok(typeof i.summary === 'string' && i.summary.length <= MAX_SUMMARY);
    assert.match(first.summary ?? '', /^初评 1 条发现：coverage_gap\/major｜初评分区 delivered/);
    assert.deepEqual(out.groups[0], { kind: 'draft_level', reference: `rec:${RECORD}#/cross_item/2`, rank: 'P4', text: '等级理由：示例' });
    assert.deepEqual(out.groups[2], {
      kind: 'draft',
      record: RECORD,
      run: RUN,
      items: 2,
      findings: 1,
      case_rule: 'marked',
      marked_only: 0,
      rule_summary: '用例规则：标签或标记；其中 0 个只靠标记识别（没有标签）',
      data: { case_rule: 'marked', marked_only: 0 },
    });
  });

  it('takes the validation result itself when bound below the record, the references carrying its pointer', () => {
    const out = projected(projection(input([target(), draft(draftResult(), { record: RECORD, pointer: '/result' })])));
    assert.match((out.items[0].fields.draft_findings as Array<{ reference: string }>)[0].reference, new RegExp(`^rec:${RECORD}#/result/partitions/`));
  });

  it('rejects a draft without a level and names the initial review that needs repair',()=>{
    const out=projection(input([target(),draft(record(draftResult({cross_item:[]})))]));refused(out,'case-review-verify.draft_level_missing');
  });

  it('requires a frozen whole-document scope and refuses changed recognition parameters', () => {
    const out = projected(projection(input([target(), draft(record(draftResult()))])));
    assert.equal(out.groups[1].kind, 'case_review_scope');
    const scope = (out.groups[1].data as any).review_scope;
    assert.equal(scope.expected.length, 2);
    assert.deepEqual(scope.parameters, { case_rule: 'marked', case_priority: 2, group_priority: 1, precondition_priority: 3 });
    const legacy = draftResult({ cross_item: [fact('literal'), judgment('level', { text: '等级理由：示例', code: 'level', rank: 'P4' })] });
    refused(projection(input([target(), draft(record(legacy))])), 'case-review-verify.draft_scope_missing');
    refused(projection({ ...input([target(), draft(record(draftResult()))]), parameters: { case_priority: 3 } }), 'case-review-verify.draft_scope_mismatch');
  });

  it('refuses inputs that are not a target and a draft result of that target', () => {
    refused(projection(null), 'case-review-verify.invalid_input');
    refused(projection(input([draft(record(draftResult()))])), 'case-review-verify.invalid_input');
    refused(projection(input([{ ...target(), parser: 'json@1' }, draft(record(draftResult()))])), 'case-review-verify.invalid_input');
    refused(projection(input([target()])), 'case-review-verify.invalid_input');
    refused(projection(input([target(), draft({ kind: 'run', body: {} })])), 'case-review-verify.draft_invalid');
    refused(projection(input([target(), draft(record(draftResult()), { kind: 'validation_result' })])), 'case-review-verify.draft_invalid');
    refused(projection(input([target(), draft(record(draftResult({ acceptance: 'not_accepted' })))])), 'case-review-verify.draft_not_accepted');
    refused(projection(input([target('9'.repeat(64)), draft(record(draftResult()))])), 'case-review-verify.target_mismatch');
    const moved = draftResult();
    moved.partitions.delivered[0] = { ...moved.partitions.delivered[0], location: loc('gone') };
    refused(projection(input([target(), draft(record(moved))])), 'case-review-verify.draft_item_missing');
    const many = draftResult();
    many.partitions.delivered = Array.from({ length: 101 }, (_, k) => item(`x${k}`, `用例 ${k}`, []));
    refused(projection(input([target(), draft(record(many))])), 'case-review-verify.too_many_items');
    refused(projection(input([target(), draft(record(draftResult({ partitions: { delivered: [], rejected: [], quarantined: [], incomplete: [] } })))])), 'case-review-verify.draft_invalid');
    const hostile = input([target(), { ...draft(null), get model(): never { throw new Error('boom'); } }]);
    refused(projectionFn(hostile), 'case-review-verify.internal_error');
  });

  it('refuses a validation result of another workflow pack as the draft', () => {
    for (const pack of ['template-gap@1.0.0', 'case-review-verify@1.0.0', 'case-reviewer@1.0.0']) {
      refused(projection(input([target(), draft(record(draftResult({ locks: { pack, pack_digest: 'f'.repeat(64) } })))])), 'case-review-verify.draft_invalid');
    }
    refused(projection(input([target(), draft(record(draftResult({ locks: {} })))])), 'case-review-verify.draft_invalid');
    projected(projection(input([target(), draft(record(draftResult({ locks: { pack: 'case-review@2.3.0', pack_digest: 'f'.repeat(64) } })))])));
  });
});

describe('expected sources of the verification', () => {
  it('bind the evidence of the target again: only the identifiers its author declared, and no retrieval source', () => {
    const out = expected({ inputs: [target(), draft(record(draftResult()))], parameters: { history_search: true }, context, items: [] });
    assert.ok(ExpectedSourcesOutput.safeParse(out).success);
    assert.ok('sources' in out);
    const externals = out.sources.map((s) => `${s.role} ${s.external}`);
    // U19/U20 (owner, 2026-10-24): keyword retrieval selects no candidate source, so no spec search, no test strategy
    // search and no similar-list hint is bound whatever the switches say; and famx-id-fields@1 reads an identifier only
    // from a whole declared field, so a number written inside the target's title or a folder label binds nothing.
    assert.deepEqual(externals.filter((entry) => !entry.includes('plm:')), [], externals.join(' '));
    assert.ok(!externals.some((entry) => entry.includes('manual:spec-search:') || entry.includes('manual:qa-search:') || entry.includes('agile:search:')), externals.join(' '));
    assert.ok(!externals.includes('expected plm:story:20931'), externals.join(' '));
    assert.ok(!externals.includes('expected plm:bug:57001'), externals.join(' '));
    const declaredTarget = { ...target(), meta: { title: 'story:20931', ancestors: ['Widget', 'bug:57001'] } };
    const declared = expected({ inputs: [declaredTarget, draft(record(draftResult()))], parameters: {}, context, items: [] });
    assert.ok('sources' in declared);
    assert.ok(declared.sources.some((s) => s.external === 'plm:story:20931' && s.role === 'expected'), JSON.stringify(declared.sources));
    assert.ok(declared.sources.some((s) => s.external === 'plm:bug:57001' && s.role === 'expected'), JSON.stringify(declared.sources));
    const without = expected({ inputs: [target(), draft(record(draftResult()))], parameters: { history_search: false, strategy_search: false }, context, items: [] });
    assert.ok('sources' in without && without.sources.every((s) => s.role === 'expected'));
    assert.equal((expectedFn(null) as { error: { code: string } }).error.code, 'case-review-verify.invalid_input');
  });
});

const ref = (k: number) => `rec:${RECORD}#/partitions/delivered/${k}/requirements/1/claims/0`;
const claim = (code: string, changes: Record<string, unknown> = {}) => ({ text: '复核', code, rank: 'major', location: loc('c1'), quotes: [{ reference: loc('c1'), text: '设置探测间隔' }], ...changes });

describe('the checks', () => {
  const itemSubject = (claims: unknown[] | null, findings: unknown[] = [{ reference: ref(1), rank: 'major' }]) => ({ subject: { item: '880001:c1', label: 'l', location: loc('c1'), fields: { draft_findings: findings }, slots: claims === null ? null : { verification: claims }, evidence: [] } });
  const runSubject = (claims: unknown[], cross: unknown[], level: string | null = 'P4') => ({
    subject: { items: [{ id: '880001:c1', label: 'l', location: loc('c1'), fields: { draft_findings: [{ reference: ref(1), rank: 'major' }], draft_level: level === null ? null : { rank: level } }, slots: { verification: claims } }], cross_item: cross },
  });
  const final = (code: string, rank: string | undefined = 'P4', grounds: string[] = []) => ({ nature: 'judgment', statement: code, grounds, code, ...(rank !== undefined ? { rank } : {}) });

  it('give check-outcome@1 values with the pack codes only', () => {
    const outcomes = [
      ...dispositions(itemSubject([claim('verified', { data: { finding: ref(9) } }), claim('new_finding', { quotes: [], location: undefined, data: {} })])),
      ...verdict(runSubject([claim('refuted', { data: { finding: ref(1) } }), claim('new_finding', { data: { probe: 'edge_case_gap' } })], [final('PASS', 'P5')])),
      ...verdict(runSubject([], [final('FAIL')])),
      ...verdict(runSubject([], [final('PARTIAL')])),
    ];
    for (const o of outcomes) {
      assert.ok(CheckOutcome.safeParse(o).success, JSON.stringify(o));
      if (o.code !== undefined) assert.ok(Object.values(CODES).includes(o.code as never), o.code);
    }
    const codes = new Set(outcomes.map((o) => o.code));
    for (const code of [CODES.findingUnknown, CODES.probeMissing, CODES.locationMissing, CODES.quoteMissing, CODES.dispositionMissing, CODES.passRefuted, CODES.passNewFinding, CODES.passLevelChanged, CODES.failWithoutRefutation, CODES.partialWithoutChange]) assert.ok(codes.has(code), code);
  });

  it('a verdict without a draft level to compare, or without any verdict, is unknown, not a pass', () => {
    assert.deepEqual(verdict(runSubject([claim('verified', { data: { finding: ref(1) } })], [final('PASS')], null)).map((o) => [o.verdict, o.reason]), [['refute', undefined]]);
    assert.deepEqual(verdict(runSubject([], [])).map((o) => [o.verdict, o.reason]), [['refute', undefined]]);
    assert.deepEqual(verdict(runSubject([], [final('PARTIAL')], null)).map((o) => [o.verdict, o.reason]), [['refute', undefined]]);
    assert.deepEqual(dispositions(itemSubject(null)).map((o) => [o.verdict, o.reason]), [['refute', undefined]]);
  });

  it('a PASS needs a quotation of its own into the target: a location, a ground, a quotation of another source or a copy of the draft\'s quotation is not one', () => {
    const spec = `src:${'e'.repeat(64)}/markdown@1/s/x`;
    const draftQuote = { reference: `${loc('c1')}:0-18`, text: '设置探测间隔' };
    const subjectWith = (claims: unknown[], grounds: string[] = []) => ({
      subject: {
        items: [{ id: '880001:c1', label: 'l', location: loc('c1'), fields: { draft_findings: [{ reference: ref(1), rank: 'major', quotes: [draftQuote] }], draft_level: { rank: 'P4' } }, slots: { verification: claims } }],
        cross_item: [final('PASS', 'P4', grounds)],
      },
    });
    const verified = (changes: Record<string, unknown>) => claim('verified', { data: { finding: ref(1) }, ...changes });
    const codesOf = (value: unknown) => verdict(value).map((o) => o.code ?? o.verdict);
    // Location in the target, the only quotation in an expected source (a PLM story, a spec).
    assert.deepEqual(codesOf(subjectWith([verified({ quotes: [{ reference: spec, text: '取值范围' }] })], [loc('c1')])), [CODES.passWithoutEvidence]);
    // The draft's own quotation copied (the draft pinned a range, the verifier cites the fragment), white space aside.
    assert.deepEqual(codesOf(subjectWith([verified({ quotes: [{ reference: loc('c1'), text: '设置探测间隔 ' }] })])), [CODES.passWithoutEvidence]);
    // A quotation of the target the draft did not make.
    assert.deepEqual(codesOf(subjectWith([verified({ quotes: [{ reference: loc('c1e'), text: '间隔生效' }] })])), ['support']);
  });

  it('PARTIAL is consistent with a refuted or partly correct draft finding, while PASS cannot carry a correction', () => {
    const runOf = (claims: unknown[], code: string, rank = 'P4', draftRank = 'minor') => ({
      subject: { items: [{ id: '880001:c1', label: 'l', location: loc('c1'), fields: { draft_findings: [{ reference: ref(1), rank: draftRank }], draft_level: { rank: 'P4' } }, slots: { verification: claims } }], cross_item: [final(code, rank)] },
    });
    const minorRefuted = [claim('refuted', { rank: 'minor', data: { finding: ref(1) } })];
    assert.deepEqual(verdict(runOf(minorRefuted, 'PASS')).map((o) => o.code), [CODES.passRefuted]);
    assert.deepEqual(verdict(runOf(minorRefuted, 'PARTIAL')).map((o) => o.verdict), ['support'], 'an honest verifier has a consistent verdict');
    assert.deepEqual(verdict(runOf([claim('partial', { rank: 'minor', data: { finding: ref(1) } })], 'PARTIAL', 'P2')).map((o) => o.verdict), ['support']);
    assert.deepEqual(verdict(runOf([claim('partial', { rank: 'major', data: { finding: ref(1) } })], 'PASS')).map((o) => o.code), [CODES.passPartial]);
    assert.deepEqual(verdict(runOf([claim('verified', { data: { finding: ref(1) } })], 'PARTIAL')).map((o) => o.code), [CODES.partialWithoutChange]);
  });

  it('uses only remaining verified, corrected and new findings for the final severity band', () => {
    const runOf = (claims: unknown[], code: string, rank = 'P4') => ({
      subject: { items: [{ id: '880001:c1', label: 'l', location: loc('c1'), fields: { draft_findings: [{ reference: ref(1), rank: 'minor' }], draft_level: { rank: 'P4' } }, slots: { verification: claims } }], cross_item: [final(code, rank)] },
    });
    const critical = claim('verified', { rank: 'critical', data: { finding: ref(1) } });
    assert.deepEqual(verdict(runOf([critical], 'PARTIAL', 'P6')).map(outcome => outcome.verdict), ['support']);
    assert.deepEqual(verdict(runOf([critical], 'PARTIAL', 'P5')).map(outcome => outcome.code), [CODES.levelSeverityMismatch]);
    const fresh = claim('new_finding', { rank: 'minor', data: { probe: 'edge_case_gap' } });
    assert.deepEqual(verdict(runOf([fresh], 'PARTIAL', 'P2')).map(outcome => outcome.verdict), ['support']);
    const missing = claim('verified', { rank: undefined, data: { finding: ref(1) } });
    assert.ok(verdict(runOf([missing], 'PARTIAL')).some(outcome => outcome.code === CODES.severityMissing));
  });

  it('FAIL rests on the draft\'s rank of the refuted finding, not on the rank the verifier gives its refutation', () => {
    const runOf = (draftRank: string, verifierRank: string) => ({
      subject: { items: [{ id: '880001:c1', label: 'l', location: loc('c1'), fields: { draft_findings: [{ reference: ref(1), rank: draftRank }], draft_level: { rank: 'P4' } }, slots: { verification: [claim('refuted', { rank: verifierRank, data: { finding: ref(1) } })] } }], cross_item: [final('FAIL', 'P5')] },
    });
    assert.deepEqual(verdict(runOf('minor', 'major')).map((o) => o.code), [CODES.failWithoutRefutation]);
    assert.deepEqual(verdict(runOf('minor', 'critical')).map((o) => o.code), [CODES.failWithoutRefutation]);
    assert.deepEqual(verdict(runOf('major', 'minor')).map((o) => o.verdict), ['support']);
    assert.deepEqual(verdict(runOf('critical', 'minor')).map((o) => o.verdict), ['support']);
  });

  it('a PASS is refused while a draft finding has no disposition, on a skipped item too', () => {
    const items = [
      { id: '880001:c1', label: 'l', location: loc('c1'), fields: { draft_findings: [{ reference: ref(0), rank: 'minor' }], draft_level: { rank: 'P4' } }, slots: { verification: [claim('verified', { data: { finding: ref(0) }, quotes: [{ reference: loc('c1e'), text: '间隔生效' }] })] } },
      { id: '880001:c2', label: 'm', location: loc('c2'), fields: { draft_findings: [{ reference: ref(1), rank: 'major' }], draft_level: { rank: 'P4' } }, slots: null },
    ];
    const out = verdict({ subject: { items, cross_item: [final('PASS', 'P4')] } });
    assert.deepEqual(out.map((o) => o.code), [CODES.passUnverified]);
    assert.match(out[0].statement, /1 条初评发现没有处置/);
    assert.equal(out[0].item, '880001:c1', 'reported on the first handled item');
    const covered = verdict({ subject: { items: [items[0], { ...items[1], slots: { verification: [claim('verified', { data: { finding: ref(1) }, quotes: [{ reference: loc('c2'), text: '设置重试次数' }] })] } }], cross_item: [final('PASS', 'P4')] } });
    assert.deepEqual(covered.map((o) => o.verdict), ['support']);
  });

  it('primary and verification item IDs match one by one under marked and tagged rules, and inherits draft rule', async () => {
    const { projectItems } = await import('../../case-review/functions/project.ts');
    const mindmapWithUntagged = kityminderParser.parse(
      new TextEncoder().encode(
        JSON.stringify({
          root: {
            data: { id: 'root', text: '需求 20931 示例网关健康检查' },
            children: [
              { data: { id: 'g1', text: '基本功能', priority: 1 }, children: [
                { data: { id: 'c1', text: '设置探测间隔', priority: 2, resource: ['Functional'] }, children: [{ data: { id: 'c1e', text: '间隔生效' }, children: [] }] },
                { data: { id: 'c2', text: '设置重试次数', priority: 2, resource: ['Functional'] }, children: [{ data: { id: 'c2e', text: '次数生效' }, children: [] }] },
                { data: { id: 'u1', text: '未打标签用例', priority: 2 }, children: [{ data: { id: 'u1e', text: '未打标签生效' }, children: [] }] },
              ] },
            ],
          },
        }),
      ),
    ).model;
    const targetInput = { slot: 'target', external: 'agile:mindmap:880001', sha256: TARGET, media_type: 'application/json', parser: 'kityminder@1', model: mindmapWithUntagged, meta: { title: '测试' } };

    // 1. Marked rule (default)
    const reviewMarked = projectItems({ documents: [{ slot: 'subject', documentId: '880001', model: mindmapWithUntagged }], parameters: { caseRule: 'marked' } });
    assert.ok(!('error' in reviewMarked));
    assert.deepEqual(reviewMarked.items.map((i) => i.id), ['880001:c1', '880001:c2', '880001:u1']);

    const draftMarkedResult = draftResult({
      partitions: {
        delivered: reviewMarked.items.map((item) => ({ item: item.id, label: item.label, location: loc(item.fields.nodeId as string), requirements: [] })),
        rejected: [], quarantined: [], incomplete: [],
      },
    });
    const verifyMarked = projected(projection({ inputs: [targetInput, draft(record(draftMarkedResult))], parameters: { case_rule: 'marked' }, context }));
    assert.deepEqual(verifyMarked.items.map((i) => i.id), reviewMarked.items.map((i) => i.id));
    assert.equal(verifyMarked.groups[2].case_rule, 'marked');
    assert.equal(verifyMarked.groups[2].marked_only, 1);
    assert.match(String(verifyMarked.groups[2].rule_summary), /用例规则：标签或标记；其中 1 个只靠标记识别（没有标签）/);

    // 2. Tagged rule
    const reviewTagged = projectItems({ documents: [{ slot: 'subject', documentId: '880001', model: mindmapWithUntagged }], parameters: { caseRule: 'tagged' } });
    assert.ok(!('error' in reviewTagged));
    assert.deepEqual(reviewTagged.items.map((i) => i.id), ['880001:c1', '880001:c2']);

    const draftTaggedResult = draftResult({
      partitions: {
        delivered: reviewTagged.items.map((item) => ({ item: item.id, label: item.label, location: loc(item.fields.nodeId as string), requirements: [] })),
        rejected: [], quarantined: [], incomplete: [],
      },
    });
    (draftTaggedResult.cross_item[1].statement as any).data.review_scope.parameters.case_rule = 'tagged';
    const verifyTagged = projected(projection({ inputs: [targetInput, draft(record(draftTaggedResult))], parameters: { case_rule: 'tagged' }, context }));
    assert.deepEqual(verifyTagged.items.map((i) => i.id), reviewTagged.items.map((i) => i.id));
    assert.equal(verifyTagged.groups[2].case_rule, 'tagged');
    assert.equal(verifyTagged.groups[2].marked_only, 0);
    assert.match(String(verifyTagged.groups[2].rule_summary), /用例规则：只认标签；其中 0 个只靠标记识别（没有标签）/);

    // 3. Draft used tagged, verify did NOT specify case_rule: verify inherits tagged rule from draft
    const verifyInherited = projected(projection({ inputs: [targetInput, draft(record(draftTaggedResult))], parameters: {}, context }));
    assert.deepEqual(verifyInherited.items.map((i) => i.id), reviewTagged.items.map((i) => i.id));
    assert.equal(verifyInherited.groups[2].case_rule, 'tagged');
    assert.equal(verifyInherited.groups[2].marked_only, 0);
  });

  it('verdict check statement includes case_rule summary and data includes case_rule and marked_only', () => {
    const items = [
      { id: '880001:c1', label: 'l', location: loc('c1'), fields: { draft_findings: [{ reference: ref(1), rank: 'major' }], draft_level: { rank: 'P4' }, case_rule: 'marked', marked_only: 2 }, slots: { verification: [claim('verified', { data: { finding: ref(1) }, quotes: [{ reference: loc('c1e'), text: '间隔生效' }] })] } },
    ];
    const out = verdict({ subject: { items, cross_item: [final('PASS', 'P4')] } });
    assert.deepEqual(out.map((o) => o.verdict), ['support']);
    assert.match(out[0].statement, /用例规则：标签或标记；其中 2 个只靠标记识别（没有标签）/);
    assert.deepEqual((out[0].data as Record<string, unknown>).case_rule, 'marked');
    assert.deepEqual((out[0].data as Record<string, unknown>).marked_only, 2);
  });

  it('report a run-wide problem on the first handled item and point at the verdict', () => {
    const subject = { subject: { items: [{ id: 'a:1', label: 'x', location: loc('c1'), fields: {}, slots: null }, { id: 'a:2', label: 'y', location: loc('c2'), fields: { draft_level: { rank: 'P4' } }, slots: { verification: [] } }], cross_item: [{ nature: 'judgment', statement: 's', grounds: [], code: 'PARTIAL', rank: 'P4' }] } };
    const [o] = verdict(subject);
    assert.deepEqual([o.verdict, o.code, o.item, o.pointer], ['refute', CODES.partialWithoutChange, 'a:2', '/cross_item/0']);
  });

  it('are total on hostile input and dispatch by the subject shape without a named export', () => {
    const hostile = { subject: { get slots(): never { throw new Error('boom'); } } };
    assert.deepEqual((dispositionsCheck(hostile) as Array<{ reason: string }>).map((o) => o.reason), ['check_error']);
    assert.deepEqual((verdictCheck({ subject: { get items(): never { throw new Error('boom'); } } }) as Array<{ reason: string }>).map((o) => o.reason), ['check_error']);
    assert.deepEqual(verifyFn(runSubject([], [final('FAIL')])), verdictCheck(runSubject([], [final('FAIL')])));
    assert.deepEqual(verifyFn(itemSubject([])), dispositionsCheck(itemSubject([])));
  });
});

describe('the command statements of the verifier', () => {
  it('claimSubject lists the statements that a command exists or does not, for the catalog check over the artifact under verification', () => {
    const item = { id: '880001:c1', label: 'l', location: loc('c1'), fields: {} };
    const slots = { verification: [{ text: 't', code: 'refuted', commands: [{ command: 'widget health interval', present: false }, { command: 'widget health interval pool1 5' }] }, { text: 'u', code: 'new_finding', commands: [{ command: 'widget pool show', present: true }] }, { text: 'v', commands: 'x' }] };
    const out = claimSubject({ applies: 'item', item, slots, evidence: [], context }) as Record<string, unknown>;
    assert.deepEqual(out, { item: '880001:c1', location: loc('c1'), claims: [{ command: 'widget health interval', present: false }, { command: 'widget pool show', present: true }] });
    assert.deepEqual((claimSubject({ applies: 'item', item, slots: null, evidence: [], context }) as { claims: unknown[] }).claims, []);
    const checks = JSON.parse(readFileSync(new URL('../checks.json', import.meta.url), 'utf8')) as { checks: Array<{ id: string; interpreter?: string; catalog?: string; judges: string; table?: string }> };
    const commandClaims = checks.checks.find((c) => c.id === 'command_claims');
    assert.deepEqual([commandClaims?.interpreter, commandClaims?.catalog, commandClaims?.judges], ['catalog@1', 'commands@1', 'artifact_under_verification']);
    const requirements = JSON.parse(readFileSync(new URL('../requirements.json', import.meta.url), 'utf8')) as { requirements: Array<{ key: string; checks: string[]; error_handling: Array<{ code: string; action: string }> }> };
    const verification = requirements.requirements.find((r) => r.key === 'verification');
    assert.ok(verification?.checks.includes('command_claims'));
    assert.ok(verification?.error_handling.some((row) => row.code === 'core.catalog.membership_contradicted' && row.action === 'repair'));
  });
});

describe('the pack', () => {
  const here = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
  const draftPack = (name: string) => readFileSync(new URL(`../../case-review/functions/${name}`, import.meta.url), 'utf8');

  it('carries exact shared definitions with explicit draft type-owner and pack-name bindings', () => {
    for (const name of ['text.ts', 'types.ts', 'expected-sources.ts', 'generated/vocabulary.ts', 'levels.ts', 'review-scope.ts']) {
      // Template types belong to the draft module; type-only references are erased in the sandbox.
      const expected=name==='types.ts'?draftPack(name).replaceAll("import('./template-coverage.ts')","import('../../case-review/functions/template-coverage.ts')"):draftPack(name);
      assert.equal(here(name),expected,`${name}: synchronize the shared draft definitions`);
    }
    assert.equal(here('common.ts'), draftPack('common.ts').replace("export const PACK = 'case-review';", "export const PACK = 'case-review-verify';"));
  });

  it('declares every code its functions give, and only those', () => {
    const codes = JSON.parse(readFileSync(new URL('../tables/codes.json', import.meta.url), 'utf8')) as Record<string, Array<{ code: string }>>;
    const declared = new Set([...codes.refusals, ...codes.warnings, ...codes.checks].map((c) => c.code));
    for (const code of Object.values(CODES)) assert.ok(declared.has(code), code);
    const requirements = JSON.parse(readFileSync(new URL('../requirements.json', import.meta.url), 'utf8')) as { requirements: Array<{ error_handling: Array<{ code: string }> }> };
    for (const row of requirements.requirements.flatMap((r) => r.error_handling)) assert.ok(declared.has(row.code) || Object.hasOwn(CORE_VIOLATION_CODES, row.code), row.code);
    for (const code of declared) assert.match(code, /^case-review-verify\.[a-z_]+$/);
  });

  it('runs its functions in the Hub sandbox with the same results as in process', async (t) => {
    if (!(await osIsolationAvailable())) return t.skip('sandbox-exec is not available on this machine');
    const packDir = fileURLToPath(new URL('../', import.meta.url));
    const projectionInput = input([target(), draft(record(draftResult()))]);
    const calls: Array<[string, string | undefined, unknown, (x: unknown) => unknown]> = [
      ['functions/projection.ts', undefined, projectionInput, projectionFn],
      ['functions/expected.ts', undefined, { ...projectionInput, items: [] }, expectedFn],
      ['functions/verify.ts', 'dispositionsCheck', { subject: { item: 'a:1', fields: { draft_findings: [{ reference: ref(1) }] }, slots: { verification: [] }, evidence: [] } }, dispositionsCheck],
      ['functions/verify.ts', 'verdictCheck', { subject: { items: [], cross_item: [] } }, verdictCheck],
      ['functions/subjects.ts', 'claimSubject', { applies: 'item', item: { id: 'a:1', label: 'l', location: loc('c1'), fields: {} }, slots: { verification: [{ text: 't', commands: [{ command: 'show pool', present: true }] }] }, evidence: [], context }, claimSubject],
    ];
    for (const [module, name, value, fn] of calls) {
      const result = await callPackFunction({ packDir, module, ...(name !== undefined ? { export: name } : {}) }, value);
      assert.equal(result.osIsolation, true);
      assert.deepEqual(result.output, JSON.parse(JSON.stringify(fn(value))), `${module} ${name ?? 'default'}`);
    }
  });
});

describe('suggestion target and completeness checks',()=>{
  const subject=(suggestions:Record<string,unknown>[])=>({
    items:[{id:'skipped',location:loc('c2'),fields:{},slots:null},{id:'handled',location:loc('c1'),fields:{},slots:{verification:[]}}],
    cross_item:[{code:'PARTIAL',statement:'结论',rank:'P4'},...suggestions],
  });
  const suggestion=(grounds:string[],statement='补：间隔为 0 的用例；因为：只测上界；期望：拒绝非法输入')=>({code:'suggestion',statement,grounds,rank:'minor'});
  it('supports case and subitem targets and the absence of suggestions',()=>{
    for(const suggestions of [[],[suggestion([loc('c1')])],[suggestion([loc('g1')])]]){
      const outcomes=suggestionTargets({subject:subject(suggestions)});assert.ok(outcomes.length>0);assert.ok(outcomes.every(outcome=>outcome.verdict==='support'));
    }
  });
  it('refutes missing targets, expectation-only grounds and missing or empty labeled parts at their cross-item pointer',()=>{
    for(const candidate of [suggestion([]),suggestion(['src:'+'c'.repeat(64)+'/markdown@1/h/spec']),suggestion([loc('c1')],'补：用例；因为：缺口'),suggestion([loc('c1')],'补：；因为：缺口；期望：成功')]){
      const outcomes=suggestionTargets({subject:subject([candidate])});
      assert.ok(outcomes.some(outcome=>outcome.verdict==='refute'));assert.ok(outcomes.every(outcome=>outcome.item==='handled'&&outcome.pointer==='/cross_item/1'));
      assert.ok(outcomes.some(outcome=>outcome.code===(candidate.grounds.length===0||candidate.grounds[0].includes('markdown@1')?'case-review-verify.suggestion_target_missing':'case-review-verify.suggestion_incomplete')));
    }
  });
});

describe('read-only preservation of the initial Hub facts',()=>{
  it('keeps source-attributed refutations and their original record references in the accepted disposition fact',()=>{
    const source=draftResult(),bad={...fact('literal'),statement:{verdict:'refute',code:'core.structure.required_empty',text:'期望为空'}};
    source.partitions.delivered[0].requirements[0].claims.push(bad as any);
    Object.assign(source.partitions.delivered[0].requirements[0].layers[0],{terminal:'violation',attribution:'author_input',code:'core.structure.required_empty'});
    const projectedRun=projected(projection(input([target(),draft(record(source))])));
    const original=projectedRun.items.find(item=>item.id.endsWith(':c2'))!;
    const snapshot=original.fields.draft_source_facts as Array<{reference:string;claim:unknown}>;
    assert.equal(snapshot.length,1);assert.deepEqual(snapshot[0].claim,bad);assert.match(snapshot[0].reference,new RegExp('^rec:'+RECORD+'#/partitions/delivered/0/requirements/0/claims/1$'));
    const kept=dispositions({subject:{item:original.id,location:loc('c2'),fields:original.fields,slots:{verification:[]}}});
    assert.deepEqual(kept[0].data?.source_facts,snapshot);assert.ok(kept[0].grounds.includes(snapshot[0].reference));
  });
});

it('an expected catalog refutation is not preserved as an attributed source defect',()=>{
  const source=draftResult(),entry=source.partitions.delivered[0];
  entry.requirements.push({requirement:'catalog',layers:[{layer:'static',terminal:'violation',code:'core.catalog.param_out_of_range'}],status:'satisfied',
    claims:[{...fact('catalog'),statement:{verdict:'refute',code:'core.catalog.param_out_of_range',text:'反向预期反驳',data:{negative_case:true,expected:true}}}]} as any);
  const result=projected(projection(input([target(),draft(record(source))])));
  assert.deepEqual(result.items.find(item=>item.id.endsWith(':c2'))!.fields.draft_source_facts,[]);
});

it('mixed expected and author-input catalog refutations preserve only the unexpected claim',()=>{
  const source=draftResult(),entry=source.partitions.delivered[0];
  const unexpected={...fact('catalog'),statement:{verdict:'refute',code:'core.catalog.not_member',text:'合成未知命令',data:{expected:false}}};
  entry.requirements.push({requirement:'catalog',layers:[{layer:'static',terminal:'violation',code:'core.catalog.not_member',attribution:'author_input'}],status:'unsatisfied',claims:[
    {...fact('catalog'),statement:{verdict:'refute',code:'core.catalog.param_out_of_range',text:'合成期望越界',data:{expected:true,negative_case:true}}},unexpected]} as any);
  const result=projected(projection(input([target(),draft(record(source))])));
  const snapshots=result.items.find(item=>item.id.endsWith(':c2'))!.fields.draft_source_facts as Array<{claim:unknown}>;
  assert.deepEqual(snapshots.map(row=>row.claim),[unexpected]);
});
