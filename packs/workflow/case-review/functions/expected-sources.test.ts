import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ExternalObjectId } from '../../../../contracts/src/reference.ts';
import sourcesDefault, { expectedSources, extractIds, featureTerms, leadingIds, markedIds, specSearchId } from './expected-sources.ts';
import { assertJson, isFailure, parseFixture } from '../testing/test-support.ts';
import type { SourcesOutput } from './types.ts';

/** `kind:id`, with `?` for an id whose kind no word names. */
const ids = (text: string): string[] => extractIds(text).map((found) => `${found.kind ?? '?'}:${found.id}`);
const ok = (out: SourcesOutput) => {
  assert.ok(!isFailure(out), JSON.stringify(out));
  return out;
};
/** Ranges as a product pack would give them: story numbers are the small range of the defect system. */
const RANGES = { story: { max: 49_999 }, bug: { min: 50_000 } };

describe('the id extractor', () => {
  it('reads ids the way real titles write them; only bug, 缺陷, story and 需求 next to a number name its kind (invented numbers)', () => {
    const cases: Array<[string, string[]]> = [
      ['bug to case 70412 示例网关探测失败', ['?:70412']],
      ['bug-to-case 136001', ['?:136001']],
      ['Bug-to-Case-41250 健康检查', ['?:41250']],
      ['bug to case-20111-添加示例设置', ['?:20111']],
      ['bug to case 140001&137002', ['?:140001', '?:137002']],
      ['bug to case - 91001 - 示例统计页面为空', ['?:91001']],
      ['bug to case-需求20931 示例', ['story:20931']],
      ['bug to case-bug 70412', ['bug:70412']],
      ['Bug 118000&118001&19100 页面检查', ['bug:118000', 'bug:118001', 'bug:19100']],
      ['Test List of Bug 138001 示例', ['bug:138001']],
      ['bug57001 示例客户-3.2.1.36.4-统计清零', ['bug:57001']],
      ['缺陷 66001 修复验证', ['bug:66001']],
      ['需求20931', ['story:20931']],
      ['需求 4021-示例网关会话保持功能测试', ['story:4021']],
      ['Story#20777 示例', ['story:20777']],
      ['PLM20518-示例端点管理', ['?:20518']],
      ['PLM-需求 20519', ['story:20519']],
      ['31057-示例网关支持HTTP探活与权重联动', ['?:31057']],
      ['146001 146002示例池支持批量配置', ['?:146001', '?:146002']],
      ['54001 示例模块重启后统计清零', ['?:54001']],
      ['回归 - 112233', ['?:112233']],
      ['回归测试-20902-示例端点回归', ['?:20902']],
      ['二轮回归-130001', ['?:130001']],
      ['三轮回归 - 130002', ['?:130002']],
      ['Test-129001-示例会话超时', ['?:129001']],
      ['３１０５８－全角编号', ['?:31058']],
    ];
    for (const [text, expected] of cases) assert.deepEqual(ids(text), expected, text);
  });

  it('does not read release trains, ordering prefixes, years, dates, versions or words that only contain a marker', () => {
    for (const text of [
      '030：SYNTH测试项目',
      '020：3.2.1',
      '201：3.2.1-主线-2026/06/30',
      '906：3.2.1-主线-20260715',
      '1001：3.2 主线',
      '1001: 3.2 主线',
      '2026年用例',
      '2026 年度回归',
      '20260715 新增',
      '3.2.1-R2-2026/7',
      '24/1：示例模块',
      'debug 12345 日志',
      'history 12345',
      'bug 3.2.1',
      'bug 0123',
      'Story#',
      '需求待定',
      '示例模块-138000',
      '用例模板（示例）',
      '',
    ]) {
      assert.deepEqual(ids(text), [], text);
    }
  });

  it('does not repeat as unmarked a number that a word names, and reads each number once', () => {
    assert.deepEqual(ids('31057-bug 70412'), ['bug:70412', '?:31057']);
    assert.deepEqual(ids('70412 bug to case 70412'), ['?:70412']);
    assert.deepEqual(ids('19333 需求 19333'), ['story:19333']);
    assert.equal(leadingIds('31057-x')[0].marker, null);
    assert.equal(markedIds('Story#20777')[0].marker, 'story');
    assert.equal(markedIds('bug to case 70412')[0].marker, null, '"bug to case" names a document type, not the kind of the number');
  });

  it('is linear and total on hostile text', () => {
    const start = performance.now();
    assert.deepEqual(ids(`bug${' '.repeat(100_000)}12345`), []);
    assert.deepEqual(ids('bug '.repeat(50_000)), []);
    assert.deepEqual(ids('9'.repeat(1_000_000)), []);
    assert.deepEqual(ids(`${'回归'.repeat(10_000)}12345`), []);
    assert.ok(performance.now() - start < 1000);
  });
});

describe('feature terms and the manual search id', () => {
  it('takes the feature words of a title', () => {
    assert.deepEqual(featureTerms('31057-示例网关支持HTTP探活与权重联动'), ['示例网关', 'HTTP', '探活', '权重联动']);
    assert.deepEqual(featureTerms('bug to case 70412 示例配置文件支持导入导出DNS记录'), ['示例配置文件', '导入导出', 'DNS', '记录']);
    assert.deepEqual(featureTerms('Bug 153001-示例客户-SYNTH3.2.1.27版本-探测进程退出_TLSV1.3', ['SYNTH']), ['示例客户', '探测进程退出', 'TLSV1.3']);
    assert.deepEqual(featureTerms('PLM20518-示例端点管理 bug57001 2026'), ['示例端点管理']);
    assert.deepEqual(featureTerms('bug to case 70412'), []);
    assert.equal(featureTerms('一二三四五六七八九十'.repeat(10)).length, 1);
    assert.equal([...featureTerms('一二三四五六七八九十'.repeat(10))[0]].length, 32);
    assert.equal(featureTerms('alpha beta gamma delta epsilon zeta eta theta iota kappa', [], 3).length, 3);
  });

  it('keeps feature words whole: a joining character splits only between two words, 检查 and 功能 stay inside a run', () => {
    assert.deepEqual(featureTerms('bug to case 70420-示例端口检查支持-grpc'), ['示例端口检查', 'grpc']);
    assert.deepEqual(featureTerms('中心示例区域后台管理'), ['中心示例区域后台管理'], '中 and 后 at the start of a word stay');
    assert.deepEqual(featureTerms('示例源地址和目的地址'), ['示例源地址', '目的地址']);
    assert.deepEqual(featureTerms('示例端点地址以及端口范围'), ['示例端点地址', '端口范围']);
    assert.deepEqual(featureTerms('会话保持时间可配置'), ['会话保持时间可配置']);
    assert.deepEqual(featureTerms('示例后端服务器在线检测'), ['示例后端服务器在线检测'], 'positional characters do not split 后端 or 在线');
    assert.deepEqual(featureTerms('示例目的地址'), ['示例目的地址']);
    assert.deepEqual(featureTerms('功能测试'), [], 'a generic word alone is not a search term');
    assert.deepEqual(featureTerms('示例会话保持功能'), ['示例会话保持功能']);
  });

  it('leaves out an author name written as the last three-character segment', () => {
    assert.deepEqual(featureTerms('需求 20931-示例端点管理-王小明'), ['示例端点管理']);
    assert.deepEqual(featureTerms('需求 20931-示例端点_王小明'), ['示例端点']);
    assert.deepEqual(featureTerms('需求 20931-示例端点-会话保持'), ['示例端点', '会话保持'], 'four characters are a feature word');
    assert.deepEqual(featureTerms('需求 20931-示例端点-日志'), ['示例端点', '日志'], 'two characters are a feature word');
    assert.deepEqual(featureTerms('王小明'), ['王小明'], 'a title that is only the segment is kept');
  });

  it('writes a valid external object id, encoding what the id may not contain', () => {
    assert.equal(specSearchId(['示例网关', 'HTTP']), 'manual:spec-search:示例网关+HTTP');
    assert.equal(specSearchId(['a b', 'c@d', '50%', 'x+y']), 'manual:spec-search:a%20b+c%40d+50%25+x%2By');
    assert.equal(specSearchId([]), null);
    assert.equal(specSearchId(['\ud800']), null);
    for (const terms of [['示例'], ['a b'], ['c@d', 'é'], ['tab\there']]) {
      const id = specSearchId(terms);
      assert.ok(id !== null && ExternalObjectId.safeParse(id).success, id ?? 'null');
    }
  });
});

describe('expectedSources', () => {
  const model = parseFixture('review-150.km.json').model;

  it('reads an unmarked id as a story and as a bug, says why, and warns once', () => {
    const out = ok(expectedSources({ documents: [{ slot: 'mindmap', documentId: '880001', model }], product: { names: ['SYNTH'] } }));
    assert.deepEqual(out.external, ['plm:story:31057', 'plm:bug:31057', 'manual:spec-search:示例网关+HTTP+探活+权重联动']);
    assert.equal(out.basis[0].from, 'root');
    assert.equal(out.basis[0].marker, null);
    assert.match(out.basis[0].reason, /没有标明是需求还是缺陷，需求和缺陷都读取/);
    assert.deepEqual(
      out.warnings.map((warning) => [warning.code, warning.data]),
      [['case-review.id_kind_unknown', { ids: ['31057'], count: 1, read: 'both' }]],
    );
    for (const id of out.external) assert.ok(ExternalObjectId.safeParse(id).success, id);
    assertJson(out);
  });

  it('decides an unmarked id by the id ranges of the defect system when the product pack gives them', () => {
    const out = ok(expectedSources({ documents: [{ documentId: '880001', model }], parameters: { idRanges: RANGES } }));
    assert.deepEqual(out.external, ['plm:story:31057', 'manual:spec-search:示例网关+HTTP+探活+权重联动']);
    assert.match(out.basis[0].reason, /编号范围/);
    assert.deepEqual(out.warnings, []);
    const large = ok(expectedSources({ documents: [{ documentId: 'd', title: 'bug to case-137002-示例设备启动失败' }], parameters: { idRanges: RANGES, specSearch: false } }));
    assert.deepEqual(large.external, ['plm:bug:137002']);
    const feature = ok(expectedSources({ documents: [{ documentId: 'd', title: 'bug to case-20111-添加示例设置' }], parameters: { idRanges: RANGES, specSearch: false } }));
    assert.deepEqual(feature.external, ['plm:story:20111'], 'a story number after "bug to case" is read as a story, not as an unrelated old bug');
  });

  it('lets a kind without a range cover every id, and falls back to bareIds where both ranges or none hold', () => {
    const storyOnly = { story: { max: 49_999 } };
    const big = ok(expectedSources({ documents: [{ documentId: 'd', title: '137002-示例' }], parameters: { idRanges: storyOnly, specSearch: false } }));
    assert.deepEqual(big.external, ['plm:bug:137002']);
    const small = ok(expectedSources({ documents: [{ documentId: 'd', title: '19333-示例' }], parameters: { idRanges: storyOnly, specSearch: false } }));
    assert.deepEqual(small.external, ['plm:story:19333', 'plm:bug:19333']);
    const neither = ok(expectedSources({ documents: [{ documentId: 'd', title: '30000-示例' }], parameters: { idRanges: { story: { max: 29_999 }, bug: { min: 50_000 } }, bareIds: 'skip', specSearch: false } }));
    assert.deepEqual(neither.external, []);
    assert.equal(neither.warnings[0].data?.read, 'none');
  });

  it('keeps a word next to the number above the ranges', () => {
    const out = ok(expectedSources({ documents: [{ documentId: 'd', title: 'Bug 19222 示例' }], parameters: { idRanges: RANGES, specSearch: false } }));
    assert.deepEqual(out.external, ['plm:bug:19222']);
    assert.match(out.basis[0].reason, /标明是缺陷/);
  });

  it('reads the title the source system lists and the folders above the document, nearest first', () => {
    const out = ok(
      expectedSources({
        documents: [
          {
            documentId: '880001',
            model,
            title: 'bug to case 70412&70413 示例网关探测失败',
            ancestors: ['030：SYNTH测试项目', '020：3.2.1', '003：3.2.1-R2-2026/7', '需求 20931-健康检查', 'Bug 66001-示例客户-设备重启'],
          },
        ],
        parameters: { idRanges: RANGES },
      }),
    );
    assert.deepEqual(out.external, ['plm:bug:70412', 'plm:bug:70413', 'plm:story:31057', 'plm:bug:66001', 'plm:story:20931', 'manual:spec-search:示例网关探测失败']);
    assert.deepEqual(
      out.basis.map((entry) => entry.from),
      ['title', 'title', 'root', 'ancestor', 'ancestor', 'title'],
    );
  });

  it('lets explicit ids replace the ids found in titles, and checks them', () => {
    const out = ok(expectedSources({ documents: [{ documentId: '880001', model }], parameters: { stories: ['20001', 20002], bugs: ['x1', ' 30003 '], specSearch: false } }));
    assert.deepEqual(out.external, ['plm:story:20001', 'plm:story:20002', 'plm:bug:30003']);
    assert.ok(out.basis.every((entry) => entry.from === 'parameter'));
    assert.deepEqual(out.warnings.map((warning) => warning.code), ['case-review.parameter_ignored']);
  });

  it('follows bareIds and maxTerms, and ignores invalid parameters with a warning', () => {
    const bug = ok(expectedSources({ documents: [{ documentId: 'd', model }], parameters: { bareIds: 'bug', maxTerms: 2 } }));
    assert.deepEqual(bug.external, ['plm:bug:31057', 'manual:spec-search:示例网关+HTTP']);
    assert.deepEqual(bug.warnings, [], 'reading unmarked ids as one kind is the caller’s explicit choice');
    const story = ok(expectedSources({ documents: [{ documentId: 'd', model }], parameters: { bareIds: 'story', specSearch: false } }));
    assert.deepEqual(story.external, ['plm:story:31057']);
    const skip = ok(expectedSources({ documents: [{ documentId: 'd', model }], parameters: { bareIds: 'skip', specSearch: false } }));
    assert.deepEqual(skip.external, []);
    assert.deepEqual(skip.warnings.map((warning) => warning.code), ['case-review.id_kind_unknown']);
    const bad = ok(expectedSources({ documents: [{ documentId: 'd', model }], parameters: { bareIds: 'epic', specSearch: 'yes', maxTerms: 99, stories: 'x', idRanges: { story: { max: -1 } } } }));
    assert.deepEqual(
      bad.warnings.filter((warning) => warning.code === 'case-review.parameter_ignored').map((warning) => warning.data?.parameter),
      ['stories', 'idRanges', 'bareIds', 'specSearch', 'maxTerms'],
    );
    assert.deepEqual(bad.external, ['plm:story:31057', 'plm:bug:31057', 'manual:spec-search:示例网关+HTTP+探活+权重联动']);
    for (const idRanges of [{ story: { min: 5, max: 4 } }, { epic: {} }, { story: { max: 1.5 } }, { bug: 'x' }, 'x', []]) {
      const out = ok(expectedSources({ documents: [{ documentId: 'd', title: '31057-x' }], parameters: { idRanges, specSearch: false } }));
      assert.equal(out.warnings[0].data?.parameter, 'idRanges', JSON.stringify(idRanges));
    }
  });

  it('skips documents it cannot read with a warning and refuses input without documents', () => {
    const out = ok(expectedSources({ documents: [null, { model }, { documentId: 'x' }, { documentId: 'y', title: '   ' }] }));
    assert.deepEqual(out.external, []);
    assert.deepEqual(
      out.warnings.map((warning) => warning.code),
      ['case-review.document_skipped', 'case-review.document_skipped', 'case-review.document_skipped', 'case-review.document_skipped'],
    );
    for (const input of [null, {}, { documents: 'x' }, 7]) {
      const refused = sourcesDefault(input);
      assert.ok(isFailure(refused));
      assert.equal(refused.error.code, 'case-review.invalid_input');
    }
  });

  it('is deterministic and fast on a huge title', () => {
    const title = `需求 20931 ${'示例功能'.repeat(250_000)} @ x`;
    const start = performance.now();
    const out = ok(expectedSources({ documents: [{ documentId: 'h', title }] }));
    assert.ok(performance.now() - start < 2000);
    assert.equal(out.external[0], 'plm:story:20931');
    for (const id of out.external) assert.ok(ExternalObjectId.safeParse(id).success, id);
    assert.deepEqual(sourcesDefault({ documents: [{ documentId: 'h', title }] }), out);
  });
});
