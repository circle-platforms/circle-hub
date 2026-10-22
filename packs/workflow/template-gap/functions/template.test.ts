import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { baseDocument } from '../testing/mindmap.ts';
import { bind, project, projectionInput, table } from '../testing/support.ts';
import type { DocumentCases } from './cases.ts';
import { projectDocuments } from './project.ts';
import { CANONICAL_TAGS, TAG_SPELLINGS, canonicalTag, canonicalTags } from './tags.ts';
import { MAX_EVIDENCE, TEMPLATE_SCHEMA, categoryFacts, keywordForm, matchForm, readTemplate, type Template } from './template.ts';
import { fold } from './text.ts';
import type { CaseRecord } from './types.ts';

const TABLE = table('template-v3.json') as Record<string, unknown> & { categories: Array<Record<string, unknown>> };

type Spec = { id: string; path?: string[]; title?: string; tags?: string[]; steps?: string[]; expected?: string[]; preconditions?: string[] };

/** Cases with their node table: every case below its own chain of ancestors (its path). */
function document(...specs: Spec[]): Pick<DocumentCases, 'cases' | 'nodes'> {
  const texts: string[] = [];
  const parents: number[] = [];
  const cases: CaseRecord[] = specs.map((spec) => {
    let parent = -1;
    for (const text of spec.path ?? []) {
      texts.push(text);
      parents.push(parent);
      parent = texts.length - 1;
    }
    texts.push(spec.title ?? '');
    parents.push(parent);
    return { id: spec.id, nodeId: spec.id, visit: texts.length - 1, title: spec.title ?? '', tags: spec.tags ?? [], steps: spec.steps ?? [], expected: spec.expected ?? [], preconditions: spec.preconditions ?? [] };
  });
  return { cases, nodes: { texts, parents: Int32Array.from(parents) } };
}

const only = (category: Record<string, unknown>): Template => {
  const template = readTemplate({ schema: TEMPLATE_SCHEMA, id: 't', origin: '测试', categories: [{ id: 'k', label: '类别', ...category }] });
  assert.ok(typeof template !== 'string', String(template));
  return template;
};
const shows = (template: Template, spec: Spec): boolean => categoryFacts(template, document(spec))[0].present;

describe('the template table', () => {
  it('is admitted: 24 categories, all required, the six test types by tag, the others by keywords', () => {
    const template = readTemplate(TABLE);
    assert.ok(typeof template !== 'string', String(template));
    assert.equal(template.id, 'template-v3');
    assert.equal(template.categories.length, 24);
    assert.ok(template.categories.every((category) => category.required), 'every category of template v3 is required (brief 6a, 6b)');
    const byTag = template.categories.filter((category) => category.tags.length > 0);
    assert.deepEqual(byTag.flatMap((category) => category.tags), [...CANONICAL_TAGS]);
    assert.ok(byTag.every((category) => category.group === 'test_type'));
    assert.ok(template.categories.filter((category) => category.tags.length === 0).every((category) => category.group !== 'test_type' && category.contains.length > 0));
    assert.ok(typeof TABLE.origin === 'string' && /决定/.test(TABLE.origin) && /24 个类别都必选/.test(TABLE.origin));
  });

  it('refuses a template that fails admission (closed shape, origin, literal keywords), and the projection refuses with the pack fix', () => {
    const category = { id: 'x', label: 'x', contains: ['x'] };
    const cases: Array<[unknown, RegExp]> = [
      [[], /不是对象/],
      ['template', /不是对象/],
      [{ ...TABLE, schema: 'case-review.template@1' }, /schema/],
      [{ ...TABLE, id: ' ' }, /id/],
      [{ ...TABLE, origin: undefined }, /origin/],
      [{ ...TABLE, extra: 1 }, /extra/],
      [{ ...TABLE, categories: [] }, /categories/],
      [{ ...TABLE, categories: [{ ...category, id: 'Bad Id' }] }, /第 1 个类别id/],
      [{ ...TABLE, categories: [category, category] }, /第 2 个类别id x 重复/],
      [{ ...TABLE, categories: [{ ...category, pattern: 'a.*b' }] }, /pattern/],
      [{ ...TABLE, categories: [{ ...category, tags: ['Boundary'] }] }, /tags/],
      [{ ...TABLE, categories: [{ ...category, fields: ['nowhere'] }] }, /fields/],
      [{ ...TABLE, categories: [{ ...category, contains: ['x', ' '] }] }, /contains/],
      [{ ...TABLE, categories: [{ id: 'x', label: 'x' }] }, /判定条件/],
      [{ ...TABLE, categories: [{ ...category, required: 'yes' }] }, /required/],
    ];
    for (const [bad, problem] of cases) {
      const reason = readTemplate(bad);
      assert.ok(typeof reason === 'string', JSON.stringify(bad)?.slice(0, 60));
      assert.match(reason, problem);
      const out = projectDocuments(projectionInput([bind(baseDocument())]), { table: bad });
      assert.ok('error' in out);
      assert.equal(out.error.code, 'template-gap.template_invalid');
    }
  });
});

describe('matching', () => {
  it('normalizes texts and keywords: NFKC, case, white space, arrows; a space at a keyword end is a word boundary', () => {
    assert.equal(matchForm('  新版本 →  新版本 '), '新版本->新版本');
    assert.equal(matchForm('ＳＨＯＷ　Pool'), 'show pool');
    assert.equal(keywordForm(' Add '), ' add ');
    const add = only({ contains: [' add '], prefixes: ['add '], fields: ['title'] });
    for (const title of ['relay endpoint add 192.0.2.30 80', 'add pool', 'widget pool add', 'Widget Pool ADD']) assert.ok(shows(add, { id: 'a', title }), title);
    for (const title of ['address of the endpoint', 'padding', 'added']) assert.ok(!shows(add, { id: 'a', title }), title);
    const arrow = only({ contains: ['新版本->新版本'] });
    for (const title of ['新版本→新版本', '新版本 ⇒ 新版本 升级', '新版本-->新版本']) assert.ok(shows(arrow, { id: 'a', title }), title);
    const no = only({ equals: ['no'], fields: ['path'] });
    assert.ok(shows(no, { id: 'a', path: ['根', ' NO '] }));
    assert.ok(!shows(no, { id: 'a', path: ['根', 'no 与 clear'] }), 'equals is the whole text');
  });

  it('writes arrows as the earlier pattern did on folded texts, in linear time', () => {
    // The earlier pattern, kept here as the reference: on texts whose white space is folded it gives the same forms.
    const EARLIER = /\s*(?:→|⟶|⇒|=>|—>|–>|-+>)\s*/gu;
    const samples = ['老版本->新版本', '老版本 -> 新版本', 'a-->b', 'a - -> b', 'x->->y', '==>', '——>', '新版本 → 新版本', '-->', 'a ->', '-> b', 'a --- b', 'a-b->c', 'new => old', 'a –> b', 'a ⟶b'];
    for (const text of samples) assert.equal(matchForm(text), fold(text).replace(EARLIER, '->'), text);
    // A run of dashes or of U+FEFF (which \s matches and the white space fold keeps) made the earlier pattern quadratic:
    // about 0.7 s for 40,000 dashes and 2 s for 40,000 U+FEFF here. Eight times as long takes a few milliseconds now.
    for (const text of ['-'.repeat(320_000), '﻿'.repeat(320_000), `${'-'.repeat(320_000)}>`, '- '.repeat(160_000)]) {
      const started = performance.now();
      matchForm(text);
      const took = performance.now() - started;
      assert.ok(took < 500, `${took.toFixed(0)} ms for ${text.length} characters`);
    }
  });

  it('searches only the fields a category names; preconditions are searched only where named', () => {
    const titleOnly = only({ contains: ['删除'], fields: ['title', 'steps'] });
    assert.ok(shows(titleOnly, { id: 'a', steps: ['先删除'] }));
    assert.ok(!shows(titleOnly, { id: 'a', expected: ['删除成功'], preconditions: ['删除旧对象'], path: ['删除'] }));
    const withExpected = only({ contains: ['显示'], fields: ['expected'] });
    assert.ok(shows(withExpected, { id: 'a', expected: ['页面显示结果'] }));
    const defaults = only({ contains: ['安全'] });
    assert.ok(shows(defaults, { id: 'a', path: ['安全'] }) && shows(defaults, { id: 'b', title: '安全加固' }), 'path and title by default');
    assert.ok(!shows(defaults, { id: 'a', steps: ['安全'] }));
    const preconditions = only({ contains: ['已有'], fields: ['preconditions'] });
    assert.ok(shows(preconditions, { id: 'a', preconditions: ['已有对象'] }));
    // The path is the ancestors only: a case's own title does not show a path-only category.
    const pathOnly = only({ contains: ['安全'], fields: ['path'] });
    assert.ok(!shows(pathOnly, { id: 'a', path: ['根'], title: '安全' }));
    assert.ok(shows(pathOnly, { id: 'a', path: ['安全', '根下的分组'], title: '用例' }), 'any ancestor, not only the parent');
  });

  it('shows a test type by the canonical form of any spelling of its tag', () => {
    const negative = only({ tags: ['Negative'] });
    for (const tag of ['Negative', 'negative', '[Negative]', '负向', '负面测试', 'negative-case', '  Negative  ']) assert.ok(shows(negative, { id: 'a', tags: [tag] }), tag);
    for (const tag of ['Non-negative', 'negatively', 'Boundary', '']) assert.ok(!shows(negative, { id: 'a', tags: [tag] }), tag);
    for (const canonical of CANONICAL_TAGS) for (const spelling of TAG_SPELLINGS[canonical]) assert.equal(canonicalTag(spelling), canonical, spelling);
    assert.deepEqual(canonicalTags(['stress', 'Function', '功能', 'R2ADD', null]), ['Functional', 'Stress']);
  });

  it('evidence is the sorted case ids, at most MAX_EVIDENCE, and count counts them all', () => {
    const template = only({ tags: ['Functional'] });
    const ids = Array.from({ length: 30 }, (_, i) => `d:${String(29 - i).padStart(2, '0')}`);
    const [fact] = categoryFacts(template, document(...ids.map((id) => ({ id, tags: ['Function'] }))));
    assert.equal(fact.count, 30);
    assert.equal(fact.evidence.length, MAX_EVIDENCE);
    assert.deepEqual(fact.evidence, [...ids].sort().slice(0, MAX_EVIDENCE));
    assert.deepEqual(categoryFacts(template, document()), [{ id: 'k', label: '类别', group: null, required: true, present: false, count: 0, evidence: [] }]);
  });

  it('normalizes every node text once: a long ancestor text over many cases, and a deep chain over many cases, stay fast', () => {
    const km = (root: unknown) => new TextEncoder().encode(JSON.stringify({ root, template: 'right', theme: 'classic', version: '1.4.43' }));
    const n = (id: string, text: string, extra: Record<string, unknown> = {}, ...children: unknown[]) => ({ data: { id, text, ...extra }, children });
    const kase = (id: string) => n(id, `用例 ${id}`, { priority: 2, resource: ['Function'] }, n(`${id}e`, '期望'));
    // Before: the 200,000-character root text was normalized again for every case and category (0.8 s for 300 cases here).
    const wide = km(n('r', '标题'.repeat(100_000), {}, ...Array.from({ length: 2_000 }, (_, i) => kase(`w${i}`))));
    // Before: every case copied and normalized its 150 ancestors (0.9 s and 430 MB for 3,000 cases here; this is 20,000).
    let chain: unknown = n('g149', '分组 149', { priority: 1 }, ...Array.from({ length: 20_000 }, (_, i) => kase(`d${i}`)));
    for (let k = 148; k >= 0; k--) chain = n(`g${k}`, `分组 ${k} ${'说明'.repeat(20)}`, { priority: 1 }, chain);
    const deep = km(n('r', '根', {}, chain));
    for (const [name, bytes, cases] of [['wide', wide, 2_000], ['deep', deep, 20_000]] as const) {
      const input = bind(bytes, { external: 'agile:mindmap:700100' });
      const started = performance.now();
      const [item] = project([input]).items;
      const took = performance.now() - started;
      assert.equal(item.fields.caseCount, cases, name);
      assert.ok(took < 1_500, `${name}: ${took.toFixed(0)} ms`);
    }
  });
});
