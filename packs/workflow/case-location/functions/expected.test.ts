// The expected sources of a case-location run, on identifiers the author declared as whole fields (famx-id-fields@1).
// A title, a folder label or a map path that is prose contributes nothing: no marker word, no misspelling, no padded or
// date-shaped number is read. What the grammar reads is bound with role expected, and an identifier of undeclared kind is
// read both ways, with the warning that names the missing fact and the author's exit.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ExpectedSourcesInput, ExpectedSourcesOutput } from '../../../../contracts/src/pack.ts';
import expected, { MAX_SOURCES, expectedSources } from './expected.ts';
import { projectItems } from './project.ts';
import { BOUND, assertTotal, boundDocument, hostileInputs, smallMap } from './test-support.ts';
import type { BoundInput, ProjectedItem } from './types.ts';

const TREE = { root: 'FAMY', ancestors: ['030：FAMX/FAMY测试项目', '060：10.6.1'] };

function sourcesFor(titles: string[], parameters: Record<string, unknown> = {}, tree: { root: string; ancestors: string[] } = TREE) {
  const inputs: BoundInput[] = titles.map((title, k) => boundDocument(`2420${k}`, smallMap(`2420${k}`, title), { title, ...tree }));
  const { items } = projectItems({ inputs, parameters, context: { ...BOUND, parameters } }) as { items: ProjectedItem[] };
  const input = { inputs, parameters, context: { ...BOUND, parameters }, items };
  assert.ok(ExpectedSourcesInput.safeParse(input).success, 'expected-sources-input@1');
  const out = expectedSources(input);
  assert.ok(ExpectedSourcesOutput.safeParse(out).success);
  return out;
}

describe('expected sources', () => {
  it('binds the stories and bugs the declared fields name, with role expected', () => {
    const out = sourcesFor(['story:20931', 'bug:118000,118001', '没有编号']);
    assert.deepEqual(
      out.sources.map((s) => [s.external, s.role]),
      [
        ['plm:story:20931', 'expected'],
        ['plm:bug:118000', 'expected'],
        ['plm:bug:118001', 'expected'],
      ],
    );
    assert.ok(out.sources.every((s) => /\p{Script=Han}/u.test(s.reason)));
    assert.match(out.sources[0].reason, /标题里标明的需求 20931/);
    assert.deepEqual(out.warnings, []);
  });

  it('binds nothing for identifiers written inside prose, and warns about no unknown kind', () => {
    // The retired rule read a kind from the word before a number and tolerated misspellings of it. A title that is not a
    // declared field contributes no identifier, so there is nothing of unknown kind to warn about either.
    const out = sourcesFor(['bug to case 90101 会话保持', '需求20931 证书链校验', 'Bug 118000&118001 内存泄漏', 'but61001']);
    assert.deepEqual(out.sources, []);
    assert.deepEqual(out.warnings, []);
  });

  it('binds the kind the declared id ranges give an undeclared identifier, and says it is a declaration', () => {
    const out = sourcesFor(['bug:90101', '33001'], { id_ranges: { story: { max: 49999 }, bug: { min: 50000 } } });
    assert.deepEqual(
      out.sources.map((s) => s.external),
      ['plm:bug:90101', 'plm:story:33001'],
    );
    assert.match(out.sources.find((s) => s.external === 'plm:story:33001')!.reason, /按调用方声明的编号范围（参数 id_ranges）读作需求/);
    assert.deepEqual(out.warnings, []);
    // A range given alone classifies only the identifiers it covers.
    const alone = sourcesFor(['33001', 'bug:74001'], { id_ranges: { story: { min: 10000, max: 49999 } } });
    assert.deepEqual(
      alone.sources.map((s) => s.external),
      ['plm:story:33001', 'plm:bug:74001'],
    );
    assert.deepEqual(alone.warnings, []);
  });

  it('binds the identifiers a folder below the version level declares', () => {
    const out = sourcesFor(['会话保持'], {}, { root: 'FAMY', ancestors: [...TREE.ancestors, '004：10.6.1-R2-2026/7', 'SSL', 'story:20931'] });
    assert.deepEqual(
      out.sources.map((s) => [s.external, s.reason]),
      [['plm:story:20931', '条目 24200 的上级目录里标明的需求 20931']],
    );
    // The same folder written as prose declares nothing.
    const prose = sourcesFor(['会话保持'], {}, { root: 'FAMY', ancestors: [...TREE.ancestors, '004：10.6.1-R2-2026/7', 'SSL', '需求20931 证书链'] });
    assert.deepEqual(prose.sources, []);
  });

  it('caps the number of sources with a warning', () => {
    const titles = Array.from({ length: 30 }, (_, k) => `bug:${Array.from({ length: 10 }, (_, j) => 60000 + k * 10 + j).join(',')}`);
    const out = sourcesFor(titles);
    assert.equal(out.sources.length, MAX_SOURCES);
    assert.deepEqual(
      out.warnings.map((w) => [w.code, w.data?.dropped]),
      [['case-location.sources_capped', 100]],
    );
  });

  it('is total on hostile input', () => {
    for (const [k, input] of hostileInputs().entries()) {
      const out = assertTotal(expected, input, `hostile ${k}`);
      assert.ok(ExpectedSourcesOutput.safeParse(out).success, `hostile ${k}`);
    }
  });
});

it('reads only whole declared fields: no padding, no embedded field, no folded form', () => {
  // A padded number is outside the declared decimal grammar, and a field embedded in a title is not a field.
  const out = sourcesFor(['bug:001234', 'bug:1234 合成标题', 'ＢＵＧ:1234', 'bug:1234']);
  assert.deepEqual(out.sources.map((source) => source.external), ['plm:bug:1234']);
  assert.match(out.sources[0].reason, /标题里标明的缺陷 1234/);
  assert.deepEqual(out.warnings, []);
});

describe('an identifier of undeclared kind is read both ways', () => {
  it('binds it as a story and as a bug when no field and no range decides its kind', () => {
    const out = sourcesFor(['33001']);
    assert.deepEqual(
      out.sources.map((s) => s.external),
      ['plm:story:33001', 'plm:bug:33001'],
    );
    assert.ok(out.sources.every((s) => s.reason.includes('没有标明类型')));
    assert.match(out.warnings[0]?.message ?? '', /分别读取，存在的那一个决定种类/);
    assert.match(out.warnings[0]?.message ?? '', /下一步作者补类型/);
  });

  it('a kind decided by a declared field or a declared range stays a single read, not two', () => {
    const marked = sourcesFor(['story:33001']);
    assert.deepEqual(marked.sources.map((s) => s.external), ['plm:story:33001']);
    assert.deepEqual(marked.warnings, []);
    const ranged = sourcesFor(['33001'], { id_ranges: { story: { max: 49999 }, bug: { min: 50000 } } });
    assert.deepEqual(ranged.sources.map((s) => s.external), ['plm:story:33001']);
  });

  it('two reads of one undeclared identifier do not double-count against the source cap', () => {
    const out = sourcesFor(['33001']);
    assert.equal(out.sources.filter((s) => s.external.endsWith(':33001')).length, 2);
  });
});
