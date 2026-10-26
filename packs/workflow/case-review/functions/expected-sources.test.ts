// The expected sources of a case-review run under the owner's R6/U19/U20 rules (2026-10-24): a source is bound only from
// an identity the author declared — the `stories` / `bugs` parameters, or a whole `bug:<list>` / `story:<list>` field in a
// title or a folder label — or from a candidate a model proposes with a verbatim quote the Hub verifies. No identifier is
// read out of prose, and keyword retrieval selects no candidate source at all: its results are neither an input nor a
// basis of recall, so no `manual:spec-search` id is produced any more.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ExternalObjectId } from '../../../../contracts/src/reference.ts';
import sourcesDefault, { expectedSources, extractIds, featureTerms, leadingIds, markedIds, specSearchId } from './expected-sources.ts';
import { assertJson, isFailure, parseFixture } from '../testing/test-support.ts';
import type { SourcesOutput } from './types.ts';

/** `kind:id`, with `?` for an id whose kind nothing declares. */
const ids = (text: string): string[] => extractIds(text).map((found) => `${found.kind ?? '?'}:${found.id}`);
const ok = (out: SourcesOutput) => {
  assert.ok(!isFailure(out), JSON.stringify(out));
  return out;
};
/** Ranges as a product pack would give them: story numbers are the small range of the defect system. */
const RANGES = { story: { max: 49_999 }, bug: { min: 50_000 } };

describe('the declared identifier grammar', () => {
  it('reads a whole bug or story field, with a comma-separated decimal list', () => {
    assert.deepEqual(ids('bug:61001'), ['bug:61001']);
    assert.deepEqual(ids('story:20931'), ['story:20931']);
    assert.deepEqual(ids('bug:118000,118001'), ['bug:118000', 'bug:118001']);
    assert.deepEqual(markedIds('story:20931,20932').map((found) => [found.kind, found.id]), [['story', '20931'], ['story', '20932']]);
  });

  it('reads nothing out of prose, markers, misspellings, padding, folding, dates or versions', () => {
    for (const text of [
      'bug to case 70412', 'Bug 118000&118001', 'bug57001', 'Test List of Bug 138001', '需求20931', 'Story#20777',
      'PLM20518-示例', 'bug to case-需求20931', '31057-示例', '146001 146002', '回归 - 112233', 'Test-129001-示例',
      '缺陷 61008：显示错误', 'but61001', 'bugt61001', 'ro61001', '201：3.2.1-主线-2026-06-30', '2026/7 回归',
      '10.6.1.32 验证', '20260531', 'bug:61001 示例', 'bug: 61001', 'BUG:61001', 'ｂｕｇ:61001', 'bug:061001',
      'bug:', 'bug:61001,', 'story:20931 bug:61001',
    ]) {
      assert.deepEqual(ids(text), [], JSON.stringify(text));
    }
    // An unmarked list has no declared kind, and nothing guesses one.
    assert.deepEqual(leadingIds('31057'), [], 'a bare number is not a declared field');
    assert.deepEqual(markedIds('31057'), []);
  });

  it('selects no candidate source by keyword: the retired retrieval entry points stay empty', () => {
    // U19/U20 (owner, 2026-10-24): keyword retrieval is forbidden even for candidate sources, and its results are not an
    // input or a basis of recall. The scoring and ranking entry points are gone, so these stay empty for every title.
    for (const title of ['示例网关 HTTP 探活', '健康检查', 'bug to case 61001 会话保持', 'SSL 卸载']) {
      assert.deepEqual(featureTerms(title, ['SYNTH']), []);
      assert.equal(specSearchId(featureTerms(title)), null);
    }
    assert.deepEqual(featureTerms('示例网关 HTTP 探活', ['SYNTH'], 16), []);
  });

  it('is total and linear on hostile text', () => {
    for (const text of ['', 'x'.repeat(100_000), `bug:${'6'.repeat(13)}`, `bug:61001,${'6'.repeat(13)}`, 'bug:'.padEnd(50_000, '6'), `${'需求20931 '.repeat(20_000)}`]) {
      assert.deepEqual(extractIds(text), text === '' ? [] : [], JSON.stringify(text.slice(0, 24)));
    }
    const list = `bug:${Array.from({ length: 200 }, (_, k) => 10000 + k).join(',')}`;
    assert.equal(extractIds(list).length, 200);
  });
});

describe('expectedSources', () => {
  const model = parseFixture('review-150.km.json').model;

  it('binds the identifiers the author declared as parameters, and checks them', () => {
    const out = ok(expectedSources({ documents: [{ documentId: '880001', model }], parameters: { stories: ['20001', 20002], bugs: ['x1', ' 30003 '] } }));
    assert.deepEqual(out.external, ['plm:story:20001', 'plm:story:20002', 'plm:bug:30003']);
    assert.ok(out.basis.every((entry) => entry.from === 'parameter'));
    assert.deepEqual(out.warnings.map((warning) => warning.code), ['case-review.parameter_ignored']);
    for (const id of out.external) assert.ok(ExternalObjectId.safeParse(id).success, id);
    assertJson(out);
  });

  it('binds a whole declared field of a title or of a folder label, nearest first', () => {
    const out = ok(
      expectedSources({
        documents: [
          {
            documentId: '880001',
            model,
            title: 'bug:70412,70413',
            ancestors: ['030：SYNTH测试项目', '020：3.2.1', '003：3.2.1-R2-2026/7', 'story:20931', 'bug:66001'],
          },
        ],
      }),
    );
    assert.deepEqual(out.external, ['plm:bug:70412', 'plm:bug:70413', 'plm:bug:66001', 'plm:story:20931']);
    assert.deepEqual(out.basis.map((entry) => entry.from), ['title', 'title', 'ancestor', 'ancestor']);
    assert.deepEqual(out.warnings, []);
  });

  it('binds nothing and says what is missing when no identifier is declared', () => {
    // The fixture document's root and title carry numbers in prose; none of them is a declared field, and no keyword
    // retrieval runs, so the run has no expected source and the warning names the author's exit.
    const out = ok(expectedSources({ documents: [{ slot: 'mindmap', documentId: '880001', model }], product: { names: ['SYNTH'] } }));
    assert.deepEqual(out.external, []);
    assert.deepEqual(out.basis, []);
    assert.deepEqual(out.warnings.map((warning) => warning.code), ['case-review.id_kind_unknown']);
    assert.match(out.warnings[0].message, /缺少显式来源编号/);
    assert.match(out.warnings[0].message, /下一步作者用参数 stories、bugs 声明来源/);
    assert.match(out.warnings[0].message, /逐字引文/);
    // The empty list above is the whole point: keyword retrieval selects no source, so no read id is bound at all.
    assertJson(out);
  });

  it('never produces a retrieval id, whatever the caller declares', () => {
    for (const parameters of [{ specSearch: true }, { specSearch: true, maxTerms: 2 }, { idRanges: RANGES, specSearch: true }, {}]) {
      const out = ok(expectedSources({ documents: [{ documentId: '880001', model }], parameters }));
      assert.deepEqual(out.external.filter((id) => !id.startsWith('plm:')), [], JSON.stringify(parameters));
    }
  });

  it('classifies a declared field by nothing else: ranges and bareIds have no undeclared id to decide', () => {
    // The retired rule read unmarked numbers and let the product's id ranges or bareIds choose a kind. With no prose
    // reading there is no unmarked id, so these parameters decide nothing and warn about no kind.
    for (const parameters of [{ idRanges: RANGES }, { bareIds: 'bug' }, { bareIds: 'skip' }, { idRanges: RANGES, bareIds: 'story' }]) {
      const out = ok(expectedSources({ documents: [{ documentId: 'd', title: '137002-示例设备启动失败' }], parameters }));
      assert.deepEqual(out.external, [], JSON.stringify(parameters));
    }
    const declared = ok(expectedSources({ documents: [{ documentId: 'd', title: 'bug:137002' }], parameters: { idRanges: RANGES } }));
    assert.deepEqual(declared.external, ['plm:bug:137002']);
    assert.match(declared.basis[0].reason, /标明是缺陷|缺陷/);
  });

  it('ignores invalid parameters with a warning and keeps the declared ones', () => {
    const bad = ok(expectedSources({ documents: [{ documentId: 'd', model }], parameters: { bareIds: 'epic', specSearch: 'yes', maxTerms: 99, stories: 'x', idRanges: { story: { max: -1 } } } }));
    assert.deepEqual(
      bad.warnings.filter((warning) => warning.code === 'case-review.parameter_ignored').map((warning) => warning.data?.parameter),
      ['stories', 'idRanges', 'bareIds', 'specSearch', 'maxTerms'],
    );
    assert.deepEqual(bad.external, []);
    for (const idRanges of [{ story: { min: 5, max: 4 } }, { epic: {} }, { story: { max: 1.5 } }, { bug: 'x' }, 'x', []]) {
      const out = ok(expectedSources({ documents: [{ documentId: 'd', title: 'story:31057' }], parameters: { idRanges } }));
      assert.equal(out.warnings[0].data?.parameter, 'idRanges', JSON.stringify(idRanges));
      assert.deepEqual(out.external, ['plm:story:31057']);
    }
  });

  it('skips documents it cannot read with a warning and refuses input without documents', () => {
    const out = ok(expectedSources({ documents: [null, { model }, { documentId: 'x' }, { documentId: 'y', title: '   ' }] }));
    assert.deepEqual(out.external, []);
    assert.deepEqual(
      out.warnings.map((warning) => warning.code),
      ['case-review.document_skipped', 'case-review.document_skipped', 'case-review.document_skipped', 'case-review.document_skipped', 'case-review.id_kind_unknown'],
    );
    for (const input of [null, {}, { documents: 'x' }, 7]) {
      const refused = sourcesDefault(input);
      assert.ok(isFailure(refused));
      assert.equal(refused.error.code, 'case-review.invalid_input');
    }
  });

  it('is deterministic and fast on a huge title', () => {
    const title = `story:20931 ${'示例功能'.repeat(250_000)}`;
    const start = performance.now();
    const out = ok(expectedSources({ documents: [{ documentId: 'h', title }] }));
    assert.ok(performance.now() - start < 2000);
    // The title is not a whole declared field once prose follows it, so nothing is bound and the exit is named.
    assert.deepEqual(out.external, []);
    assert.deepEqual(out.warnings.map((warning) => warning.code), ['case-review.id_kind_unknown']);
    const declared = ok(expectedSources({ documents: [{ documentId: 'h', title: 'story:20931' }] }));
    assert.deepEqual(declared.external, ['plm:story:20931']);
    for (const id of declared.external) assert.ok(ExternalObjectId.safeParse(id).success, id);
    assert.deepEqual(sourcesDefault({ documents: [{ documentId: 'h', title: 'story:20931' }] }), declared);
  });
});
