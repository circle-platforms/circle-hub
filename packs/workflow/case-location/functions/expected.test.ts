import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ExpectedSourcesInput, ExpectedSourcesOutput } from '../../../../contracts/src/pack.ts';
import expected, { MAX_SOURCES, expectedSources } from './expected.ts';
import { projectItems } from './project.ts';
import { BOUND, assertTotal, boundDocument, hostileInputs, smallMap } from './test-support.ts';
import type { BoundInput, ProjectedItem } from './types.ts';

const TREE = { root: 'NSAE', ancestors: ['030：APV/NSAE测试项目', '060：10.6.1'] };

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
  it('binds the stories and bugs a word marks, with role expected, and no record for an id of unknown kind', () => {
    const out = sourcesFor(['需求20931 证书链校验', 'Bug 118000&118001 内存泄漏', 'bug to case 90101 会话保持', '没有编号']);
    assert.deepEqual(
      out.sources.map((s) => [s.external, s.role]),
      [
        ['plm:story:20931', 'expected'],
        ['plm:bug:118000', 'expected'],
        ['plm:bug:118001', 'expected'],
        ['plm:bug:90101', 'expected'],
      ],
    );
    assert.ok(out.sources.every((s) => /\p{Script=Han}/u.test(s.reason)));
    assert.deepEqual(out.warnings, []);
  });

  it('binds the kind the declared id ranges give an unmarked id, and says it is a declaration', () => {
    const out = sourcesFor(['bug to case 90101', '33001-证书', 'bug 90101 再次'], { id_ranges: { story: { max: 49999 }, bug: { min: 50000 } } });
    assert.deepEqual(
      out.sources.map((s) => s.external),
      ['plm:bug:90101', 'plm:story:33001'],
    );
    assert.match(out.sources.find((s) => s.external === 'plm:story:33001')!.reason, /按调用方声明的编号范围（参数 id_ranges）读作需求/);
    assert.deepEqual(out.warnings, []);
    // A range given alone classifies only its own ids.
    const alone = sourcesFor(['33001-证书', 'bug to case 74001'], { id_ranges: { story: { min: 10000, max: 49999 } } });
    assert.deepEqual(
      alone.sources.map((s) => s.external),
      ['plm:story:33001', 'plm:bug:74001'],
    );
    assert.deepEqual(alone.warnings, []);
  });

  it('binds the ids folders below the version level name', () => {
    const out = sourcesFor(['会话保持'], {}, { root: 'NSAE', ancestors: [...TREE.ancestors, '004：10.6.1-R2-2026/7', 'SSL', '需求20931 证书链'] });
    assert.deepEqual(
      out.sources.map((s) => [s.external, s.reason]),
      [['plm:story:20931', '条目 24200 的上级目录里标明的需求 20931']],
    );
  });

  it('caps the number of sources with a warning', () => {
    const titles = Array.from({ length: 30 }, (_, k) => `bug ${Array.from({ length: 10 }, (_, j) => 60000 + k * 10 + j).join('&')}`);
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

it('binds bug-to-case identifiers as defects and states the convention without unknown-kind warnings', () => {
  const out = sourcesFor(['bug to case 90101 合成标题', 'bug to case-需求20931 合成标题', 'PLM90102 合成标题']);
  assert.deepEqual(out.sources.map(source => source.external), ['plm:bug:90101', 'plm:story:20931']);
  assert.match(out.sources[0].reason, /标题里“bug to case”后面的编号.*按缺陷号读/);
  assert.deepEqual(out.warnings.map(warning => warning.data?.ids), [['90102']]);
});

it('reads normalized identities while its reasons retain zero-padded original spellings', () => {
  const out = sourcesFor(['bug 001234 合成标题', 'bug 00 合成标题']);
  assert.deepEqual(out.sources.map(source => source.external), ['plm:bug:1234', 'plm:bug:0']);
  assert.match(out.sources[0].reason, /001234/); assert.match(out.sources[1].reason, /00/);
});
