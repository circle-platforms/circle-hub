import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import normalize, { CANONICAL_TAGS, TAG_SPELLINGS, canonicalTags, isNegative, normalizeTag, normalizeTags, tagKey } from './tags.ts';
import { isFailure, reviewProjection, table } from '../testing/test-support.ts';

describe('normalizeTag', () => {
  it('maps the spellings seen in real documents to the canonical categories', () => {
    const cases: Array<[string, string]> = [
      ['Function', 'Functional'],
      ['function', 'Functional'],
      ['Functional', 'Functional'],
      ['[Function]', 'Functional'],
      ['[Functional]', 'Functional'],
      ['[Functional', 'Functional'],
      ['Functional]', 'Functional'],
      ['功能', 'Functional'],
      ['功能测试', 'Functional'],
      ['Configuration', 'Configuration'],
      ['configuration', 'Configuration'],
      ['[Configuration]', 'Configuration'],
      ['[configuration]', 'Configuration'],
      ['Configure', 'Configuration'],
      ['配置', 'Configuration'],
      ['Integration', 'Integration'],
      ['[Integration]', 'Integration'],
      ['集成', 'Integration'],
      ['Compatibility', 'Compatibility'],
      ['compatibility', 'Compatibility'],
      ['兼容性', 'Compatibility'],
      ['兼容', 'Compatibility'],
      ['Negative', 'Negative'],
      ['negative', 'Negative'],
      ['[Negative]', 'Negative'],
      ['负向', 'Negative'],
      ['负面测试', 'Negative'],
      ['Stress', 'Stress'],
      ['stress', 'Stress'],
      ['[Stress]', 'Stress'],
      ['压力', 'Stress'],
      ['压力测试', 'Stress'],
      ['Stress Test', 'Stress'],
      ['  Negative  ', 'Negative'],
      ['ＦＵＮＣＴＩＯＮＡＬ', 'Functional'],
      ['（配置）', 'Configuration'],
      ['【压力】', 'Stress'],
      ['Functional testing', 'Functional'],
      ['negative-case', 'Negative'],
    ];
    for (const [raw, canonical] of cases) assert.deepEqual(normalizeTag(raw), { canonical, raw }, raw);
  });

  it('keeps release-specific and unknown tags as written with canonical null', () => {
    for (const raw of ['20260301ADD', 'R2ADD', 'PILOT', 'Boundary', '[Boundary]', 'Add', '第二阶段', '已评审', 'smoke', 'regression', '测试', 'test', 'Non-negative', 'negatively', '']) {
      assert.deepEqual(normalizeTag(raw), { canonical: null, raw }, raw);
    }
  });

  it('is total on values that are not text', () => {
    assert.deepEqual(normalizeTag(null), { canonical: null, raw: '' });
    assert.deepEqual(normalizeTag(undefined), { canonical: null, raw: '' });
    assert.deepEqual(normalizeTag({ tag: 'Function' }), { canonical: null, raw: '' });
    assert.deepEqual(normalizeTag(['Function']), { canonical: null, raw: '' });
    assert.deepEqual(normalizeTag(7), { canonical: null, raw: '7' });
    assert.deepEqual(normalizeTag(true), { canonical: null, raw: 'true' });
    const huge = `Function${'x'.repeat(1_000_000)}`;
    assert.equal(normalizeTag(huge).canonical, null);
    assert.equal(normalizeTag(`[${'['.repeat(150)}Function`).canonical, 'Functional');
  });

  it('detects a negative case by the canonical tag only', () => {
    assert.equal(isNegative(['Configuration', '[Negative]']), true);
    assert.equal(isNegative(['负向']), true);
    assert.equal(isNegative(['Non-negative', 'NEG-01', 'negatively', 'Boundary']), false);
    assert.equal(isNegative([]), false);
  });

  it('lists canonical categories once, in canonical order', () => {
    assert.deepEqual(canonicalTags(['stress', 'Function', '[Functional', 'BANKLIKE', 'negative']), ['Functional', 'Negative', 'Stress']);
  });
});

describe('the spelling table', () => {
  it('names every category once and maps every spelling to its own category', () => {
    assert.deepEqual([...CANONICAL_TAGS].sort(), Object.keys(TAG_SPELLINGS).sort());
    const owner = new Map<string, string>();
    for (const [tag, spellings] of Object.entries(TAG_SPELLINGS)) {
      for (const spelling of spellings) {
        assert.equal(owner.has(spelling), false, `${spelling} belongs to two categories`);
        owner.set(spelling, tag);
        assert.equal(tagKey(spelling), spelling, `${spelling} is written in folded form`);
        assert.equal(normalizeTag(spelling).canonical, tag);
      }
    }
  });

  it('names the same categories as the template table, and the tag check (advisory) judges spellings by them', () => {
    const template = table('template-v3.json') as { categories: Array<{ tags?: string[] }> };
    assert.deepEqual(
      template.categories.flatMap((category) => category.tags ?? []),
      [...CANONICAL_TAGS],
    );
    const checks = JSON.parse(readFileSync(new URL('../checks.json', import.meta.url), 'utf8')) as { checks: Array<{ id: string; function?: { export: string }; tier?: string; judges: string }> };
    const tags = checks.checks.find((check) => check.id === 'tags');
    assert.deepEqual([tags?.function?.export, tags?.tier, tags?.judges], ['tagSpelling', 'advisory', 'subject']);
    const codes = table('codes.json') as { checks: Array<{ code: string; when: string }> };
    const variant = codes.checks.find((entry) => entry.code === 'case-review.tag_variant');
    assert.ok(variant !== undefined);
    for (const tag of CANONICAL_TAGS) assert.ok(variant.when.includes(tag), tag);
  });

  it('maps every tag of the review fixture that names a category', () => {
    const tags = new Set(reviewProjection().items.flatMap((item) => item.fields.tags));
    const unmapped = [...tags].filter((tag) => normalizeTag(tag).canonical === null).sort();
    assert.deepEqual(unmapped, ['20260301ADD', 'R2ADD']);
  });
});

describe('the default export', () => {
  it('normalizes a tag list', () => {
    const out = normalize({ tags: ['Function', '[Negative]', 'R2ADD'] });
    assert.deepEqual(out, {
      tags: [
        { canonical: 'Functional', raw: 'Function' },
        { canonical: 'Negative', raw: '[Negative]' },
        { canonical: null, raw: 'R2ADD' },
      ],
      canonical: ['Functional', 'Negative'],
      negative: true,
    });
  });

  it('never throws and refuses inputs without a tag list', () => {
    for (const input of [null, undefined, 1, 'x', [], {}, { tags: 'Function' }, { tags: null }]) {
      const out = normalize(input);
      assert.ok(isFailure(out), JSON.stringify(input));
      assert.equal(out.error.code, 'case-review.invalid_input');
    }
    const odd = normalizeTags({ tags: [null, {}, [], 5, 'function'] });
    assert.ok(!isFailure(odd));
    assert.deepEqual(odd.canonical, ['Functional']);
  });

  it('is deterministic', () => {
    const input = { tags: ['配置', 'Configure', '[Stress]', 'x'] };
    assert.deepEqual(normalize(input), normalize(structuredClone(input)));
  });
});
