// The workflow adapters of the draft pack against the contract shapes of contracts/src/pack.ts: the projection (blocks, the
// 100-item limit, summaries), the expected sources (meta, product names, hints), the subject builders and the pack check.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ExpectedSourcesOutput, ItemSubjectInput, ProjectionOutput, RunSubjectInput } from '../../../../contracts/src/pack.ts';
import { CheckOutcome } from '../../../../contracts/src/tables.ts';
import { callPackFunction, osIsolationAvailable } from '../../../../hub/rules/api.ts';
import { COMMAND_NOT_IN_CASE, HINT_ONLY, LOCATION_MISSING, QUOTE_MISSING, findingSources, negativeCommands } from './checks.ts';
import expectedFn, { HISTORY_SEARCH, STRATEGY_SEARCH, expected } from './expected.ts';
import { quotedFromCase } from './lines.ts';
import { project as projectDirect, parseFixture, parseLarge, parseText } from '../testing/test-support.ts';
import projectionFn, { MAX_ITEMS, MAX_SUMMARY, projection } from './projection.ts';
import { projectItems } from './project.ts';
import { caseLines, citedCommands, commandSubject, scanSubject, structureSubject } from './subjects.ts';
import subjectsFn from './subjects.ts';
import checksFn from './checks.ts';

const SHA = 'a'.repeat(64);
const context = { product: 'sample', names: ['Widget', 'Gadget'], line: '1.0', build: 'Rel_1_0_1', root: 'd'.repeat(64), parameters: {}, groups: [] };

function bound(model: unknown, options: { external?: string | null; meta?: Record<string, unknown> | null; parser?: string } = {}) {
  return {
    slot: 'subject',
    external: options.external === undefined ? 'agile:mindmap:880001' : options.external,
    sha256: SHA,
    media_type: 'application/json',
    parser: options.parser ?? 'kityminder@1',
    model,
    meta: options.meta === undefined ? null : options.meta,
  };
}

const input = (model: unknown, parameters: Record<string, unknown> = {}, options: Parameters<typeof bound>[1] = {}) => ({ inputs: [bound(model, options)], parameters, context });

type Items = { items: Array<{ id: string; label: string; summary?: string; location: { slot?: string; parser: string; selector: string }; fields: Record<string, unknown> }>; groups: Array<Record<string, unknown>>; warnings: unknown[] };
type Refusal = { error: { code: string; message: string; fix: string; documents?: string[] }; warnings: unknown[] };

function items(value: unknown): Items {
  assert.ok(ProjectionOutput.safeParse(value).success, JSON.stringify(ProjectionOutput.safeParse(value).error?.issues?.slice(0, 3)));
  assert.ok(!('error' in (value as object)), JSON.stringify((value as Refusal).error));
  return value as Items;
}

function refusal(value: unknown, code: string): Refusal['error'] {
  assert.ok(ProjectionOutput.safeParse(value).success);
  const error = (value as Refusal).error;
  assert.ok(error !== undefined, 'expected a refusal');
  assert.equal(error.code, code);
  assert.match(error.message, /\p{Script=Han}/u);
  assert.match(error.fix, /\p{Script=Han}/u);
  return error;
}

describe('projection (ProjectionInput -> ProjectionOutput)', () => {
  const review = parseFixture('review-150.km.json').model;

  it('gives the cases of project.ts with a summary line of at most 200 characters each and the subject slot', () => {
    const out = items(projection(input(review)));
    const direct = projectDirect(review, '880001');
    assert.equal(out.items.length, direct.items.length);
    assert.deepEqual(out.items.map((i) => i.id), direct.items.map((i) => i.id));
    assert.ok(out.items.length <= MAX_ITEMS);
    for (const item of out.items) {
      assert.equal(item.location.slot, 'subject');
      assert.equal(item.location.parser, 'kityminder@1');
      assert.ok(typeof item.summary === 'string' && item.summary.length > 0 && item.summary.length <= MAX_SUMMARY, item.summary);
      assert.match(item.id, /^880001:/);
    }
    assert.equal(out.groups[0].kind, 'document');
    assert.equal(out.groups[0].cases, out.items.length);
    assert.ok(out.groups.filter((g) => g.kind === 'group').length > 0);
  });

  it('takes the document id from the agile id, else from the meta, else from the root node', () => {
    assert.match(items(projection(input(review))).items[0].id, /^880001:/);
    assert.match(items(projection(input(review, {}, { external: null, meta: { id: '42' } }))).items[0].id, /^42:/);
    const rootId = review.nodes[0].id as string;
    assert.ok(items(projection(input(review, {}, { external: null }))).items[0].id.startsWith(`${rootId}:`));
  });

  it('maps the workflow parameter names (case_rule) onto the case rule of project.ts', () => {
    const untagged = parseFixture('untagged.km.json').model;
    const defaultMarked = projection(input(untagged));
    assert.equal(items(defaultMarked).items.length, 3, 'marked is default and projects untagged cases');
    assert.equal(items(defaultMarked).groups[0].case_rule, 'marked');
    assert.equal(items(defaultMarked).groups[0].marked_only, 3);
    assert.match(String(items(defaultMarked).groups[0].rule_summary), /用例规则：标签或标记；其中 3 个只靠标记识别（没有标签）/);
    assert.deepEqual(items(defaultMarked).groups[0].data, { case_rule: 'marked', marked_only: 3 });

    const tagged = projectionFn(input(untagged, { case_rule: 'tagged' })) as Items | Refusal;
    assert.ok('error' in tagged);
    assert.match(tagged.error.fix, /case_rule/, 'the fix names the workflow parameter');
  });

  it('refuses a target of more than 100 cases with a fix that lists the blocks and their case counts', () => {
    const large = parseLarge().model;
    const error = refusal(projection(input(large)), 'case-review.too_many_cases');
    const listed = [...error.fix.matchAll(/block=("[^"]+"|\[[^\]]+\])（([^，]+)，([0-9]+) 例）/g)];
    assert.ok(listed.length >= 2, error.fix);
    for (const m of listed) assert.ok(Number(m[3]) <= MAX_ITEMS);
    assert.match(error.fix, /最差/);
    assert.deepEqual(error.documents, ['880001']);
    // Every listed block projects on its own within the limit; together they hold every case.
    let total = 0;
    for (const m of listed) {
      const out = items(projection(input(large, { block: JSON.parse(m[1]) as unknown })));
      assert.equal(out.items.length, Number(m[3]));
      assert.ok(out.items.every((i) => (i.summary ?? '').length <= MAX_SUMMARY));
      assert.ok(String((out.groups[0].block as { label: string }).label).startsWith(m[2].replace(/…$/, '')), m[2]);
      total += out.items.length;
    }
    const all = projectDirect(large, '880001');
    assert.equal(total, all.items.length);
    // The slices the fix names reach every case too, without overlap.
    const slices = /slice=\{"from":1,"to":100\}[^。]*共 ([0-9]+) 段/.exec(error.fix);
    assert.ok(slices, error.fix);
    const seen = new Set<string>();
    for (let k = 0; k < Number(slices[1]); k++) {
      const out = items(projection(input(large, { slice: { from: k * 100 + 1, to: k * 100 + 100 } })));
      for (const item of out.items) seen.add(item.id);
    }
    assert.equal(seen.size, all.items.length);
    // The essentials (one run per block, the worst verdict, the slices) come within the first 500 characters of the fix,
    // the part the server shows of a refusal.
    assert.match(error.fix.slice(0, 500), /最差[\s\S]*slice=/);
  });

  it('reviews an oversized group without subgroups and cases outside every group by slices, never by editing the target', () => {
    const cases = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({ data: { id: `${prefix}${i}`, text: `用例 ${prefix}${i}`, priority: 2, resource: ['Functional'] }, children: [{ data: { id: `${prefix}${i}e`, text: '成功' }, children: [] }] }));
    // One flat group of 150 cases next to a group of 20.
    const flat = parseText(JSON.stringify({ root: { data: { id: 'r', text: '根' }, children: [{ data: { id: 'big', text: '大分组', priority: 1 }, children: cases('b', 150) }, { data: { id: 'small', text: '小分组', priority: 1 }, children: cases('s', 20) }] } })).model;
    const error = refusal(projection(input(flat)), 'case-review.too_many_cases');
    assert.doesNotMatch(error.fix, /不在任何分组下/, 'the cases of the big group sit in a group');
    assert.match(error.fix, /block="big"（大分组，150 例/);
    assert.match(error.fix, /block="small"（小分组，20 例）/);
    const big = refusal(projection(input(flat, { block: 'big' })), 'case-review.too_many_cases');
    assert.doesNotMatch(big.fix, /没有分组节点|不在任何分组下/);
    assert.match(big.fix, /slice=\{"from":1,"to":100\}[^。]*共 2 段/);
    const first = items(projection(input(flat, { block: 'big', slice: { from: 1, to: 100 } })));
    const second = items(projection(input(flat, { block: 'big', slice: { from: 101, to: 200 } })));
    assert.deepEqual([first.items.length, second.items.length], [100, 50]);
    assert.deepEqual(first.groups[0].slice, { from: 1, to: 100, of: 150 });
    assert.ok(!first.items.some((a) => second.items.some((b) => a.id === b.id)));
    // 130 cases directly under the root and a group of 10.
    const loose = parseText(JSON.stringify({ root: { data: { id: 'r', text: '根' }, children: [...cases('l', 130), { data: { id: 'g', text: '分组', priority: 1 }, children: cases('g', 10) }] } })).model;
    const looseError = refusal(projection(input(loose)), 'case-review.too_many_cases');
    assert.match(looseError.fix, /130 例不在任何分组下/);
    assert.match(looseError.fix, /slice=\{"from":1,"to":100\}[^。]*共 2 段/);
    const all = new Set([...items(projection(input(loose, { slice: { from: 1, to: 100 } }))).items, ...items(projection(input(loose, { slice: { from: 101, to: 140 } }))).items].map((i) => i.id));
    assert.equal(all.size, 140);
  });

  it('refuses a slice that is reversed, longer than 100 cases or past the last case', () => {
    const review = parseFixture('review-150.km.json').model;
    for (const slice of [{ from: 5, to: 4 }, { from: 1, to: 101 }, { from: 500, to: 510 }]) refusal(projection(input(review, { slice })), 'case-review.slice_invalid');
    const tail = items(projection(input(review, { slice: { from: 60, to: 100 } })));
    const all = items(projection(input(review)));
    assert.deepEqual(tail.items.map((i) => i.id), all.items.slice(59).map((i) => i.id), 'a slice past the end stops at the last case');
  });

  it('projects a block of a document whose whole projection is larger than the sandbox output limit', () => {
    // 20 groups of 100 cases with long texts: the whole projection is above 8 MiB, one group is far below it.
    const long = '探'.repeat(800);
    const group = (g: number) => ({ data: { id: `g${g}`, text: `分组 ${g}`, priority: 1 }, children: Array.from({ length: 100 }, (_, i) => ({ data: { id: `c${g}-${i}`, text: `${long} ${g}-${i}`, priority: 2, resource: ['Functional'] }, children: [{ data: { id: `e${g}-${i}`, text: '探'.repeat(400) }, children: [] }] })) });
    const huge = parseText(JSON.stringify({ root: { data: { id: 'r', text: '根' }, children: Array.from({ length: 20 }, (_, g) => group(g)) } })).model;
    const whole = projectItems({ documents: [{ slot: 'subject', documentId: 'h', model: huge }] }) as { error?: { code: string } };
    assert.equal(whole.error?.code, 'case-review.too_large', 'the whole projection is above the default output limit');
    refusal(projection(input(huge)), 'case-review.too_many_cases');
    const block = items(projection(input(huge, { block: 'g7' })));
    assert.equal(block.items.length, 100);
  });

  it('restricts the items to a block named by node id or by the node texts from the root', () => {
    const groupNode = review.nodes.find((n) => n.text === '基本功能');
    assert.ok(groupNode?.id);
    const byId = items(projection(input(review, { block: groupNode.id })));
    const path: string[] = [];
    for (let at: number | null = review.nodes.indexOf(groupNode); at !== null && at !== 0; at = review.nodes[at].parent) path.unshift(review.nodes[at].text);
    const byPath = items(projection(input(review, { block: path })));
    const withRoot = items(projection(input(review, { block: [review.nodes[0].text, ...path] })));
    assert.deepEqual(byId.items.map((i) => i.id), byPath.items.map((i) => i.id));
    assert.deepEqual(byId.items.map((i) => i.id), withRoot.items.map((i) => i.id));
    assert.ok(byId.items.length > 0 && byId.items.length < items(projection(input(review))).items.length);
    assert.equal((byId.groups[0].block as { selector: string }).selector, groupNode.selector);
  });

  it('refuses a block that does not exist, is ambiguous or holds no case', () => {
    const fix = refusal(projection(input(review, { block: 'no-such-node' })), 'case-review.block_not_found').fix;
    assert.match(fix, /例）/, 'the fix lists the blocks');
    const group = (id: string, cases: string[]) => ({ data: { id, text: '组', priority: 1 }, children: cases.map((c) => ({ data: { id: c, text: `用例 ${c}`, priority: 2, resource: ['Functional'] }, children: [{ data: { id: `${c}e`, text: '成功' }, children: [] }] })) });
    const twins = parseText(JSON.stringify({ root: { data: { id: 'r', text: '根' }, children: [group('g1', ['c1']), group('g2', ['c2']), { data: { id: 'empty', text: '空组', priority: 1 }, children: [] }] } })).model;
    refusal(projection(input(twins, { block: ['组'] })), 'case-review.block_ambiguous');
    refusal(projection(input(twins, { block: 'empty' })), 'case-review.no_case');
    assert.equal(items(projection(input(twins, { block: 'g2' }))).items.length, 1);
  });

  it('refuses inputs that are not a projection input or not a mind map, and never throws', () => {
    refusal(projection(null), 'case-review.invalid_input');
    refusal(projection({ inputs: [], parameters: {}, context }), 'case-review.invalid_input');
    refusal(projection(input({ value: 1 }, {}, { parser: 'json@1' })), 'case-review.invalid_input');
    refusal(projection(input(parseFixture('outline.km.json').model)), 'case-review.no_case');
    const hostile = { inputs: [{ ...bound(review), get model(): never { throw new Error('boom'); } }], parameters: {}, context };
    const out = projectionFn(hostile) as Refusal;
    assert.equal(out.error.code, 'case-review.internal_error');
  });
});

describe('expected sources (ExpectedSourcesInput -> ExpectedSourcesOutput)', () => {
  const review = parseFixture('review-150.km.json').model;
  const run = (meta: Record<string, unknown> | null, parameters: Record<string, unknown> = {}, names = context.names) =>
    expected({ inputs: [bound(review, { meta })], parameters, context: { ...context, names }, items: [] });
  const externalsOf = (out: unknown): string[] => {
    assert.ok(ExpectedSourcesOutput.safeParse(out).success, JSON.stringify(out).slice(0, 400));
    assert.ok('sources' in (out as object));
    return (out as { sources: Array<{ external: string }> }).sources.map((s) => s.external);
  };

  it('binds the identifiers the author declared in a whole field of the title or of a folder label', () => {
    const out = run({ id: '880001', title: 'story:20931', ancestors: ['Gadget', '030：示例项目', '060：1.0', 'bug:57001'] });
    const externals = externalsOf(out);
    assert.deepEqual(externals, ['plm:story:20931', 'plm:bug:57001']);
    for (const s of (out as { sources: Array<{ reason: string; role: string }> }).sources) {
      assert.match(s.reason, /\p{Script=Han}/u);
      assert.equal(s.role, 'expected');
    }
    assert.deepEqual((out as { warnings: unknown[] }).warnings, []);
  });

  it('binds no retrieval source: keyword search selects no candidate, whatever the switches say', () => {
    // U19/U20 (owner, 2026-10-24): keyword retrieval is forbidden even for candidate sources, so no spec search, no test
    // strategy search and no similar-list hint is bound, and the switches that used to turn them off decide nothing.
    for (const parameters of [{}, { history_search: true, spec_search: true, strategy_search: true }, { spec_search: true, max_terms: 2 }]) {
      const out = run({ id: '880001', title: '需求20931-示例网关支持 Widget 健康检查', ancestors: ['Gadget', '030：示例项目', '060：1.0', 'bug 57001 回归'] }, parameters);
      const externals = externalsOf(out);
      assert.deepEqual(externals.filter((id) => !id.startsWith('plm:')), [], JSON.stringify(parameters));
      assert.ok(!externals.some((id) => id.startsWith('manual:spec-search:')), 'no spec search');
      assert.ok(!externals.some((id) => id.startsWith(STRATEGY_SEARCH)), 'no test strategy search');
      assert.ok(!externals.some((id) => id.startsWith(HISTORY_SEARCH)), 'no similar-list hint');
      // Prose names no identifier either, so nothing at all is bound and the author's exit is named.
      assert.deepEqual(externals, []);
      const warnings = (out as { warnings: Array<{ code: string; message: string }> }).warnings;
      assert.deepEqual(warnings.map((w) => w.code), ['case-review.id_kind_unknown']);
      assert.match(warnings[0].message, /下一步作者用参数 stories、bugs 声明来源/);
      assert.match(warnings[0].message, /逐字引文/);
    }
  });

  it('follows the workflow parameters: explicit identifiers, checked, and nothing else', () => {
    const out = run({ title: '需求20931-示例' }, { stories: ['31000'], bugs: [41000], history_search: false, spec_search: false, strategy_search: false });
    assert.deepEqual(externalsOf(out), ['plm:story:31000', 'plm:bug:41000']);
    const invalid = run({ title: '需求20931-示例' }, { stories: ['x1', '31000'] });
    assert.deepEqual(externalsOf(invalid), ['plm:story:31000']);
    assert.deepEqual((invalid as { warnings: Array<{ code: string }> }).warnings.map((w) => w.code), ['case-review.parameter_ignored']);
  });

  it('binds nothing without a subject and refuses what is not an input, with workflow names in its texts', () => {
    assert.deepEqual(expected({ inputs: [], parameters: {}, context, items: [] }), { sources: [], warnings: [] });
    const refused = expectedFn(null) as Refusal;
    assert.equal(refused.error.code, 'case-review.invalid_input');
    const out = expectedFn({ inputs: [bound(review, { meta: { title: '31057-示例' } })], parameters: { bare_ids: 'both' }, context, items: [] }) as { sources: Array<{ external: string }>; warnings: Array<{ code: string; message: string }> };
    assert.deepEqual(out.sources, [], 'an unmarked number in prose is not a declared identifier');
    const unknownKind = out.warnings.find((w) => w.code === 'case-review.id_kind_unknown');
    assert.ok(unknownKind !== undefined && /stories/.test(unknownKind.message) && /逐字引文/.test(unknownKind.message), JSON.stringify(out.warnings));
  });
});

describe('subject builders', () => {
  const review = parseFixture('review-150.km.json').model;
  const projected = items(projection(input(review))).items.map((i) => ({ id: i.id, label: i.label, location: `src:${SHA}/kityminder@1/${i.location.selector}`, fields: i.fields }));

  it('structureSubject: the run input of every item to the structure subjects', () => {
    const runInput = { applies: 'run', items: projected, context };
    assert.ok(RunSubjectInput.safeParse(runInput).success);
    const out = structureSubject(runInput) as { subjects: Array<{ id: string; location: string | null }> };
    assert.equal(out.subjects.length, projected.length);
    assert.equal(out.subjects[0].location, projected[0].location);
    assert.deepEqual(subjectsFn(runInput), out);
  });

  it('commandSubject: claims carry present, phrases are the command lines the case writes; a negative case without phrases has none', () => {
    const item = { ...projected[0], fields: { ...projected[0].fields, title: 'health interval pool1 5', steps: [], expected: ['显示 5'], preconditions: [] } };
    const slots = { findings: [{ text: 't', code: 'coverage_gap', rank: 'minor', commands: [{ command: 'show pool', present: true }, { command: 'pool delete', present: false }, { command: 'health interval pool1 5' }] }, { text: 'u', commands: 'not a list' }] };
    const itemInput = { applies: 'item', item, slots, evidence: [], context };
    assert.ok(ItemSubjectInput.safeParse(itemInput).success);
    assert.deepEqual(citedCommands(slots), { claims: [{ command: 'show pool', present: true }, { command: 'pool delete', present: false }], phrases: ['health interval pool1 5'] });
    const out = commandSubject(itemInput) as Record<string, unknown>;
    assert.deepEqual(out, { item: item.id, location: item.location, negative: false, claims: [{ command: 'show pool', present: true }, { command: 'pool delete', present: false }], phrases: ['health interval pool1 5'], unquoted: [] });
    assert.deepEqual(subjectsFn(itemInput), out);
    const negative = { ...item, fields: { ...item.fields, negative: true } };
    const none = commandSubject({ applies: 'item', item: negative, slots: { findings: [] }, evidence: [], context }) as Record<string, unknown>;
    assert.deepEqual(none.phrases,caseLines(negative.fields));
    assert.deepEqual((commandSubject({ applies: 'item', item, slots: null, evidence: [], context }) as Record<string, unknown>).phrases, []);
  });

  it('commandSubject: a command line the case does not write is no cited line of the case (it is the model\'s statement)', () => {
    const fields = { ...projected[0].fields, title: 'widget health interval pool1 5', steps: [{ text: '1.执行 widget health retries pool1 3。\nshow health', expected: ['显示 3'] }], expected: ['显示 3'], preconditions: [] };
    const item = { ...projected[0], fields };
    const quoted = ['widget health interval pool1 5','show health'];
    const invented = ['Widget  Health INTERVAL pool1 5','widget health retries pool1 3','widget health interval pool1 999', 'widget health interval pool1', 'health interval pool1 5', 'widget health retries pool1 33', 'widget health interval pool1 5 10'];
    const slots = { findings: [{ text: 't', commands: [...quoted, ...invented].map((command) => ({ command })) }] };
    const out = commandSubject({ applies: 'item', item, slots, evidence: [], context }) as { phrases: string[]; unquoted: string[] };
    assert.deepEqual(out.phrases, quoted);
    assert.deepEqual(out.unquoted, invented);
    // A negative case whose findings cite only lines it does not write has cited no line of its own: missing, not empty.
    const negative = commandSubject({ applies: 'item', item: { ...item, fields: { ...fields, negative: true } }, slots: { findings: [{ text: 't', commands: [{ command: 'widget health interval pool1 999' }] }] }, evidence: [], context }) as Record<string, unknown>;
    assert.deepEqual(negative.phrases,caseLines({...fields,negative:true}));
    assert.deepEqual(negative.unquoted, ['widget health interval pool1 999']);
    // The case's own fragment counts as its text too (a title longer than the fields keep).
    const clipped = { ...item, fields: { ...fields, title: 'x…' } };
    const fromFragment = commandSubject({ applies: 'item', item: clipped, slots: { findings: [{ text: 't', commands: [{ command: 'widget health interval pool1 5' }] }] }, evidence: [{ reference: item.location, resolved: true, source: SHA, role: 'subject', text: 'widget health interval pool1 5' }], context }) as { phrases: string[] };
    assert.deepEqual(fromFragment.phrases, ['widget health interval pool1 5']);
  });

  it('quotedFromCase: whole words of one line in the matching form; no argument cut off or added', () => {
    const lines = ['Box(config)#widget health interval pool1 5', '执行widget backend add 192.0.2.5 80后查看', 'widget health retries pool1 3.'];
    for (const yes of ['widget health interval pool1 5', 'WIDGET health interval POOL1 5', 'widget backend add 192.0.2.5 80', 'widget health retries pool1 3']) assert.equal(quotedFromCase(yes, lines), false, yes);
    for(const original of lines)assert.equal(quotedFromCase(original,lines),true,'an exact original line remains quotable; catalog validity is separate');
    for (const no of ['widget health interval pool1 50', 'widget health interval pool1', 'idget health interval pool1 5', 'widget backend add 192.0.2', 'widget backend add 192.0.2.5', 'health retries pool1 3', '', '   ']) assert.equal(quotedFromCase(no, lines), false, no);
  });

  it('scanSubject: the text lines of the case', () => {
    const item = { ...projected[0], fields: { ...projected[0].fields, title: 'a\nb', steps: [{ text: 'health interval pool1 5\nshow pool', expected: [] }], expected: ['x '], preconditions: [' '] } };
    assert.deepEqual(caseLines(item.fields), ['a', 'b', 'health interval pool1 5', 'show pool', 'x ', ' ']);
    const out = scanSubject({ applies: 'item', item, slots: null, evidence: [], context }) as { commands: string[]; id: string };
    assert.deepEqual(out.commands, ['a', 'b', 'health interval pool1 5', 'show pool', 'x ', ' ']);
    assert.equal(out.id, item.id);
  });
});

describe('the pack check findings_sources', () => {
  const subject = (findings: unknown[], evidence: unknown[]) => ({ check: 'findings_sources', table: null, subject: { item: 'd:c1', label: 'l', location: `src:${SHA}/kityminder@1/n/c1`, fields: {}, slots: { findings }, evidence }, context: { pack: 'case-review' }, sources: {} });
  const hint = `src:${'f'.repeat(64)}/kityminder@1/n/h1`;
  const spec = `src:${'e'.repeat(64)}/markdown@1/s/x`;

  it('gives check-outcome@1 values: support, or a refutation per finding with the pack codes', () => {
    const good = findingSources(subject([{ text: 't', location: `src:${SHA}/kityminder@1/n/c1`, quotes: [{ reference: spec, text: 'q' }] }], [{ reference: spec, resolved: true, role: 'expected' }]));
    assert.deepEqual(good.map((o) => o.verdict), ['support']);
    const bad = findingSources(subject([{ text: 't', location: `src:${SHA}/kityminder@1/n/c1`, grounds: [hint], quotes: [{ reference: hint, text: 'q' }] }, { text: 'u', quotes: [{ reference: spec, text: 'q' }] }], [{ reference: hint, resolved: true, role: 'hint' }, { reference: spec, resolved: true, role: 'expected' }]));
    assert.deepEqual(bad.map((o) => [o.code, o.pointer]), [[HINT_ONLY, '/slots/findings/0'], [LOCATION_MISSING, '/slots/findings/1']]);
    for (const o of [...good, ...bad]) assert.ok(CheckOutcome.safeParse(o).success, JSON.stringify(o));
  });

  it('refutes a finding without a verbatim quotation (grounds alone are no evidence) and a command line the case does not write', () => {
    const location = `src:${SHA}/kityminder@1/n/c1`;
    const fields = { title: 'widget health interval pool1 5', steps: [], expected: ['显示 5'], preconditions: [] };
    const withFields = (findings: unknown[]) => ({ ...subject(findings, [{ reference: spec, resolved: true, role: 'expected' }]), subject: { ...subject(findings, []).subject, fields, evidence: [{ reference: spec, resolved: true, role: 'expected' }] } });
    const out = findingSources(
      withFields([
        { text: 'ok', location, quotes: [{ reference: spec, text: 'q' }], commands: [{ command: 'widget health interval pool1 5' }, { command: 'show pool', present: true }] },
        { text: 'grounds only', location, grounds: [spec] },
        { text: 'invented line', location, quotes: [{ reference: spec, text: 'q' }], commands: [{ command: 'widget health interval pool1 999' }] },
      ]),
    );
    assert.deepEqual(out.map((o) => [o.verdict, o.code, o.pointer]), [
      ['refute', QUOTE_MISSING, '/slots/findings/1'],
      ['refute', COMMAND_NOT_IN_CASE, '/slots/findings/2/commands/0'],
    ]);
    assert.ok(out.every((o) => o.tier === 'blocking' && CheckOutcome.safeParse(o).success));
    assert.match(out[1].statement, /widget health interval pool1 999/);
    assert.deepEqual(findingSources(withFields([{ text: 'ok', location, quotes: [{ reference: spec, text: 'q' }], commands: [{ command: 'Widget Health Interval POOL1 5' }] }])).map((o) => o.verdict), ['refute']);
    assert.deepEqual(findingSources(withFields([{text:'ok',location,quotes:[{reference:spec,text:'q'}],commands:[{command:'widget health interval pool1 5'}]}])).map(o=>o.verdict),['support']);
  });

  it('is unknown without a slot record and total on hostile input', () => {
    const none = findingSources({ subject: { item: 'd:c1', slots: null, evidence: [] } });
    assert.deepEqual(none.map((o) => [o.verdict, o.reason]), [['support', undefined]]);
    const hostile = { subject: { get slots(): never { throw new Error('boom'); } } };
    const out = checksFn(hostile) as Array<{ verdict: string; reason: string }>;
    assert.deepEqual(out.map((o) => [o.verdict, o.reason]), [['unknown', 'check_error']]);
  });
});

describe('the adapters in the Hub sandbox', () => {
  it('give the same results as in process', async (t) => {
    if (!(await osIsolationAvailable())) return t.skip('sandbox-exec is not available on this machine');
    const packDir = fileURLToPath(new URL('../', import.meta.url));
    const review = parseFixture('review-150.km.json').model;
    const projectionInput = input(review, { case_rule: 'tagged' }, { meta: { title: '需求20931-示例网关', ancestors: ['bug 57001'] } });
    const projected = items(projection(projectionInput)).items.slice(0, 2).map((i) => ({ id: i.id, label: i.label, location: `src:${SHA}/kityminder@1/${i.location.selector}`, fields: i.fields }));
    const calls: Array<[string, string | undefined, unknown, (x: unknown) => unknown]> = [
      ['functions/projection.ts', undefined, projectionInput, projectionFn],
      ['functions/expected.ts', undefined, { ...projectionInput, items: [] }, expectedFn],
      ['functions/subjects.ts', 'structureSubject', { applies: 'run', items: projected, context }, structureSubject],
      ['functions/subjects.ts', 'commandSubject', { applies: 'item', item: projected[0], slots: { findings: [] }, evidence: [], context }, commandSubject],
      ['functions/checks.ts', 'findingSources', { subject: { item: projected[0].id, slots: { findings: [] }, evidence: [] } }, findingSources],
    ];
    for (const [module, name, value, fn] of calls) {
      const result = await callPackFunction({ packDir, module, ...(name !== undefined ? { export: name } : {}) }, value);
      assert.equal(result.osIsolation, true);
      assert.deepEqual(result.output, JSON.parse(JSON.stringify(fn(value))), `${module} ${name ?? 'default'}`);
    }
  });
});

it('negative cases without a cited command fall back to their own lines',()=>{
 const out=commandSubject({item:{id:'synthetic-negative',location:'src:'+SHA+'/kityminder@1/n/c1',fields:{negative:true,title:'health interval pool1 0',steps:[],expected:[],preconditions:[]}},slots:{findings:[]},evidence:[]}) as {phrases:string[]};
 assert.deepEqual(out.phrases,['health interval pool1 0']);
});


it('negative command checking without a catalog declares the missing fact at top level', () => {
  const outcomes = negativeCommands({ subject: { item: 'synthetic-negative', negative: true, phrases: ['demo probe'] } });
  assert.equal(outcomes[0].verdict, 'unknown');
  assert.match(outcomes[0].missing ?? '', /冻结命令目录/);
  assert.match(outcomes[0].statement, /重开评审/);
});
