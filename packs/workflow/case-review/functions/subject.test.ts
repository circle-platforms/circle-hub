import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CheckOutcome as CheckOutcomeShape } from '../../../../contracts/src/tables.ts';
import { buildCatalog, getInterpreter, type CheckOutcome } from '../../../../hub/rules/api.ts';
import { tagSpelling } from './checks.ts';
import subjectDefault, { buildSubjects, contentKey, groupKey, toCatalogSubject, toStructureSubject, toStructureSubjects } from './subject.ts';
import { assertJson, isFailure, parseFixture, project, reviewProjection, table } from '../testing/test-support.ts';
import type { CaseItem, ProjectionResult, StructureSubject } from './types.ts';

const ROOT = 'b'.repeat(64);
const SOURCE = 'c'.repeat(64);
/** Items as the Hub holds them: the location is a src: reference URI. */
const asHub = (projection: ProjectionResult): CaseItem[] =>
  projection.items.map((item) => ({ ...item, location: `src:${SOURCE}/kityminder@1/${item.location.selector}` }) as unknown as CaseItem);
const hubItems = (): CaseItem[] => asHub(reviewProjection());
const titled = (subjects: StructureSubject[], title: string): StructureSubject[] => subjects.filter((subject) => subject.title === title);

function run(interpreter: string, tableName: string, subject: unknown, extra: object = {}): CheckOutcome[] {
  const found = getInterpreter(interpreter);
  assert.ok(found, interpreter);
  return found.run({ interpreter, table: table(tableName), subject, context: { pack: 'case-review' }, ...extra });
}

const refutations = (outcomes: CheckOutcome[]) => outcomes.filter((outcome) => outcome.verdict === 'refute');
const described = (subjects: StructureSubject[], outcomes: CheckOutcome[]): string[] =>
  refutations(outcomes)
    .map((outcome) => `${subjects.find((subject) => subject.id === outcome.item)?.title} ${outcome.code}${outcome.pointer?.endsWith('/tags') ? ' /tags' : ''}`)
    .sort();

describe('toStructureSubject', () => {
  it('carries what the structure tables judge', () => {
    const items = hubItems();
    const subject = toStructureSubject(items.find((item) => item.fields.title === 'relay endpoint weight 192.0.2.21 101'));
    assert.equal(subject.kind, 'case');
    assert.equal(subject.location, `src:${SOURCE}/kityminder@1/${reviewProjection().items.find((item) => item.fields.title === 'relay endpoint weight 192.0.2.21 101')?.location.selector}`);
    assert.equal(subject.priority, 2);
    // 标签原文保留。Negative 不是闭集原文 negative，所以没有类别、不是反向。
    assert.deepEqual(subject.tags, ['Negative']);
    assert.deepEqual(subject.categories, []);
    assert.deepEqual(subject.categoryTags, []);
    assert.deepEqual(subject.tagVariants, [], 'spellings are compared only across the subjects of a document');
    assert.deepEqual(subject.otherTags, ['Negative']);
    assert.equal(subject.negative, null);
    assert.equal(subject.titleLength, [...'relay endpoint weight 192.0.2.21 101'].length);
    assert.equal(subject.expectedCount, 1);
    assert.equal(subject.group, groupKey('880001', subject.path));
    assert.equal(subject.content, JSON.stringify([[], ['提示参数超出范围 1-100'], []]));
    assertJson(subject);
  });

  it('separates category tags from release-specific ones', () => {
    const subject = toStructureSubject(hubItems().find((item) => item.fields.title === 'relay log level debug 后记录每次探测'));
    // Configuration 不是精确原文 configuration。R2ADD 在闭集里但不是测试类型，两者都留在 otherTags。
    assert.deepEqual(subject.categoryTags, []);
    assert.deepEqual(subject.otherTags, ['Configuration', 'R2ADD']);
  });

  it('accepts a location in any reference scheme the Hub writes, and nothing that is not a URI', () => {
    for (const location of [`src:${SOURCE}/kityminder@1/n/x`, `tree:${ROOT}/a`, `rec:${ROOT}`, 'future-scheme:abc']) {
      assert.equal(toStructureSubject({ location, fields: {} }).location, location);
    }
    for (const location of [{ parser: 'kityminder@1', selector: 'n/x' }, 'n/x', 'Src:abc', ':abc', 'src:', 7]) {
      assert.equal(toStructureSubject({ location, fields: {} }).location, null, JSON.stringify(location));
    }
  });

  it('groups by document and normalized path, so a repeated title under another path is another group', () => {
    const subjects = toStructureSubjects(hubItems());
    const repeated = titled(subjects, 'widget health interval pool1 5');
    assert.equal(repeated.length, 2);
    assert.notEqual(repeated[0].group, repeated[1].group);
    const duplicates = titled(subjects, 'show health 显示所有池的状态');
    assert.equal(duplicates[0].group, duplicates[1].group);
    assert.equal(duplicates[0].content, duplicates[1].content);
    const variants = titled(subjects, '添加 - 端点');
    assert.equal(variants[0].group, variants[1].group);
    assert.notEqual(variants[0].content, variants[1].content, 'the same title with other steps is another case');
    assert.equal(groupKey('d', ['A  b', 'Ｃ']), groupKey('d', ['a b', 'c']));
    assert.notEqual(groupKey('d', ['a', 'b']), groupKey('d', ['a b']));
    assert.notEqual(groupKey('d1', ['a']), groupKey('d2', ['a']));
    assert.equal(contentKey({ steps: [{ text: 'A  B' }], expected: ['Ｘ'] }), contentKey({ steps: [{ text: 'a b' }], expected: ['x'] }));
    assert.notEqual(contentKey({ expected: ['a', 'b'] }), contentKey({ expected: ['a b'] }));
  });

  it('is total: odd items give an empty subject that the structure check reports', () => {
    for (const item of [null, undefined, 1, 'x', [], {}, { fields: null }, { id: 5, fields: { tags: 'x', expected: [1, null], path: 'p', priority: Number.NaN, steps: [null, 3] } }]) {
      const subject = toStructureSubject(item);
      assert.equal(subject.kind, 'case');
      assert.deepEqual(subject.tags, []);
      assert.equal(subject.negative, null);
      assertJson(subject);
    }
    assert.equal(toStructureSubject({ id: 5, fields: {} }).id, '5');
    assert.equal(toStructureSubject({ fields: { priority: [2] } }).priority instanceof Array, true);
    assert.equal(toStructureSubject({ fields: { expectedCount: -1, expected: ['a'] } }).expectedCount, 1);
  });
});

describe('tables/structure.json (literal) on the review fixture', () => {
  const subjects = toStructureSubjects(hubItems());
  const outcomes = run('structure@1', 'structure.json', { subjects });
  const byItem = (title: string, code: string): CheckOutcome[] => {
    const ids = new Set(titled(subjects, title).map((subject) => subject.id));
    return outcomes.filter((outcome) => outcome.item !== undefined && ids.has(outcome.item) && outcome.code === code);
  };

  it('finds exactly the literal problems the fixture was built with', () => {
    assert.deepEqual(described(subjects, outcomes), [
      'relay endpoint add 192.0.2.41 80 后 show endpoints core.structure.required_empty /tags',
      'show health 显示所有池的状态 core.structure.duplicate_key',
      'show health 显示所有池的状态 core.structure.duplicate_key',
      'widget session clear pool1 后探测不受影响 core.structure.required_empty',
      '删除端点后会话迁移到其他端点 core.structure.required_empty /tags',
      '后端恢复后重新加入调度 core.structure.required_empty',
      '批量添加 16 个端点 core.structure.required_empty /tags',
      '非管理员账号不能修改健康检查 core.structure.type_mismatch',
    ]);
  });

  it('reports each problem at the right field, with the item location as ground', () => {
    assert.equal(byItem('后端恢复后重新加入调度', 'core.structure.required_empty')[0].pointer?.endsWith('/expected'), true);
    assert.equal(byItem('非管理员账号不能修改健康检查', 'core.structure.type_mismatch')[0].data?.constraint, 'range');
    assert.equal(byItem('widget session clear pool1 后探测不受影响', 'core.structure.required_empty')[0].pointer?.endsWith('/priority'), true);
    assert.equal(byItem('show health 显示所有池的状态', 'core.structure.duplicate_key')[0].pointer?.endsWith('/title'), true);
    for (const outcome of refutations(outcomes)) {
      assert.equal(outcome.tier, 'blocking');
      assert.equal(outcome.grounds.length, 1);
      assert.match(outcome.grounds[0], /^src:/);
    }
  });

  it('does not report several expected results, repeated titles under other paths, or a reused title with other steps', () => {
    assert.deepEqual(byItem('连续失败达到重试次数后摘除后端', 'core.structure.cardinality'), []);
    assert.deepEqual(byItem('widget health interval pool1 5', 'core.structure.duplicate_key'), []);
    assert.deepEqual(byItem('widget health retries pool1 3', 'core.structure.duplicate_key'), []);
    assert.deepEqual(byItem('添加 - 端点', 'core.structure.duplicate_key'), []);
    assert.equal(outcomes.filter((outcome) => outcome.verdict === 'support').length, subjects.length - 8);
  });

  it('accepts a case with one expected result per step', () => {
    const base = toStructureSubject(hubItems()[0]);
    const steps: StructureSubject = { ...base, id: 's', expected: ['第一步的结果', '第二步的结果'], expectedCount: 2 };
    assert.deepEqual(run('structure@1', 'structure.json', { subjects: [steps] }).map((outcome) => outcome.verdict), ['support']);
  });

  it('reports a blank title, a blank tag, a blank expected result and a priority written as text', () => {
    const base = toStructureSubject(hubItems()[0]);
    const odd: StructureSubject[] = [
      { ...base, id: 'a', title: '   ' },
      { ...base, id: 'b', title: 'b', tags: ['  '] },
      { ...base, id: 'c', title: 'c', expected: [' '] },
      { ...base, id: 'd', title: 'd', priority: '2' },
      { ...base, id: 'e', title: 'e', tags: [] },
    ];
    const codes = run('structure@1', 'structure.json', { subjects: odd }).map((outcome) => `${outcome.item} ${outcome.code ?? outcome.verdict}`);
    assert.deepEqual(codes, ['a core.structure.required_empty', 'b core.structure.required_empty', 'c core.structure.required_empty', 'd core.structure.type_mismatch', 'e core.structure.required_empty']);
  });

  it('reports the missing tags of the untagged cases when caseRule is marked', () => {
    const marked = toStructureSubjects(asHub(project(parseFixture('review-150.km.json').model, '880001', { caseRule: 'marked' })));
    const found = described(marked, run('structure@1', 'structure.json', { subjects: marked }));
    assert.deepEqual(found.filter((line) => line.endsWith('/tags')), [
      'relay endpoint add 192.0.2.41 80 后 show endpoints core.structure.required_empty /tags',
      '删除端点后会话迁移到其他端点 core.structure.required_empty /tags',
      '批量添加 16 个端点 core.structure.required_empty /tags',
    ]);
  });
});

describe('tables/structure-node-ids.json', () => {
  it('reports the two cases that share one id, at advisory tier', () => {
    const subjects = toStructureSubjects(hubItems());
    const outcomes = refutations(run('structure@1', 'structure-node-ids.json', { subjects }));
    assert.deepEqual(
      outcomes.map((outcome) => outcome.code),
      ['core.structure.duplicate_key', 'core.structure.duplicate_key'],
    );
    assert.ok(outcomes.every((outcome) => outcome.tier === 'advisory'));
  });

  it('reports a case without an id', () => {
    const base = toStructureSubject(hubItems()[0]);
    const outcomes = refutations(run('structure@1', 'structure-node-ids.json', { subjects: [{ ...base, nodeId: null }] }));
    assert.equal(outcomes[0].code, 'core.structure.required_empty');
  });
});

describe('the tag check (checks.ts tagSpelling): tag spellings consistent within a document', () => {
  const tagOutcomes = (subjects: StructureSubject[]): CheckOutcome[] => tagSpelling({ subject: { subjects } });

  it('reports resource texts outside the published closed set, at advisory tier, without folding spellings', () => {
    const subjects = toStructureSubjects(hubItems());
    const outcomes = tagOutcomes(subjects);
    const refuted = outcomes.filter((outcome) => outcome.verdict === 'refute');
    // 不再按文档里的常见拼写互相比较。不在闭集里的原文直接 tag_variant，指针在 resource。
    assert.ok(refuted.every((outcome) => outcome.code === 'case-review.tag_variant' && outcome.tier === 'advisory' && outcome.pointer?.endsWith('/resource')));
    assert.ok(refuted.length > 0);
    const configure = refuted.find((outcome) => outcome.statement.includes('Configure'));
    assert.ok(configure !== undefined && configure.statement.includes('functional'), configure?.statement);
    assert.ok(!outcomes.some((outcome) => /子节点/.test(outcome.statement)), 'the statement speaks of tags, not of child nodes');
    for (const outcome of outcomes) assert.ok(CheckOutcomeShape.safeParse(outcome).success, JSON.stringify(outcome));
  });

  it('accepts only the exact closed-set text, including when every case in a document writes that one text', () => {
    const item = (id: string, document: string, tags: string[]) => ({ id, location: `src:${SOURCE}`, fields: { document, title: id, tags, expected: ['x'], path: [] } });
    const exact = toStructureSubjects([item('a', 'd1', ['functional']), item('b', 'd1', ['functional', 'R2ADD'])]);
    assert.deepEqual(refutations(tagOutcomes(exact)), []);
    // Function 和 功能都不是闭集原文，写得再一致也要指出，不再当成同一种拼写。
    const folded = toStructureSubjects([item('a', 'd1', ['Function']), item('b', 'd1', ['功能'])]);
    assert.deepEqual(refutations(tagOutcomes(folded)).map((outcome) => outcome.code), ['case-review.tag_variant', 'case-review.tag_variant']);
  });

  it('is total on odd subjects', () => {
    // 没有 resource 是未声明，结论是 unknown，不能算已核对通过。
    assert.deepEqual(tagSpelling({ subject: { subjects: [null, { id: 'x', tagVariants: [{ tag: 1 }] }] } }).map((o) => o.verdict), ['unknown']);
    assert.deepEqual(tagSpelling(null), []);
  });
});

describe('tables/catalog.json: the optional scan of the case texts, advisory', () => {
  const catalog = buildCatalog({
    root: ROOT,
    entries: [
      { head: 'widget health interval', signatures: [[{ name: 'pool_name', type: 'string', maxLength: 32 }, { name: 'seconds', type: 'int', minimum: 1, maximum: 60 }]] },
      { head: 'relay endpoint weight', signatures: [[{ name: 'address', type: 'ipv4' }, { name: 'weight', type: 'int', minimum: 1, maximum: 100 }]] },
    ],
  });
  const item = (title: string): CaseItem => {
    const found = hubItems().find((candidate) => candidate.fields.title === title && candidate.fields.path.at(-1) !== 'IPv6');
    assert.ok(found, title);
    return found;
  };

  it('refutes an out-of-range value on a negative case as expected, at advisory tier', () => {
    const source = item('widget health interval pool1 61');
    assert.equal(toCatalogSubject(source, ['widget health interval pool1 61']).negative, null, 'Negative 不是精确原文 negative');
    const subject = toCatalogSubject({ ...source, fields: { ...source.fields, tags: ['negative'], resource: ['negative'] } }, ['widget health interval pool1 61']);
    assert.equal(subject.negative, true);
    const [outcome] = run('catalog@1', 'catalog.json', subject, { catalog });
    assert.equal(outcome.verdict, 'refute');
    assert.equal(outcome.code, 'core.catalog.param_out_of_range');
    assert.equal(outcome.tier, 'advisory');
    assert.equal(outcome.data?.negative_case, true);
    assert.equal(outcome.data?.expected, true);
  });

  it('treats a wrong type on a negative case as expected too', () => {
    const [outcome] = run('catalog@1', 'catalog.json', toCatalogSubject(item('relay endpoint weight 192.0.2.22 abc'), ['relay endpoint weight 192.0.2.22 abc']), { catalog });
    assert.equal(outcome.code, 'core.catalog.param_type_mismatch');
    assert.equal(outcome.data?.expected, true);
  });

  it('reports a case that is not negative at advisory tier as well, never blocking', () => {
    const outcomes = run('catalog@1', 'catalog.json', toCatalogSubject(item('widget health interval pool1 5'), ['widget health interval pool1 5', 'widget health interval pool1 600', 'show health']), { catalog });
    assert.deepEqual(
      outcomes.map((outcome) => `${outcome.verdict} ${outcome.tier}`),
      ['support advisory', 'refute advisory'],
    );
    assert.equal(outcomes[1].data?.expected, undefined);
  });

  it('judges an untagged case like any case: whether it is negative is unknown', () => {
    const untagged = asHub(project(parseFixture('review-150.km.json').model, '880001', { caseRule: 'marked' })).find((candidate) => candidate.fields.title === '批量添加 16 个端点');
    const subject = toCatalogSubject(untagged, ['widget health interval pool1 61']);
    assert.equal(subject.negative, null);
    const [outcome] = run('catalog@1', 'catalog.json', subject, { catalog });
    assert.equal(outcome.tier, 'advisory');
    assert.equal(outcome.data?.negative_case, undefined);
  });
});

describe('the default export', () => {
  it('builds the structure subjects, and the catalog subjects only when the scan is turned on', () => {
    const items = hubItems();
    const id = items[0].id;
    const off = subjectDefault({ items, commands: { [id]: ['widget health interval pool1 5'] } });
    assert.ok(!isFailure(off));
    const offOut = off as { subjects: StructureSubject[]; catalog: unknown[]; warnings: unknown[] };
    assert.equal(offOut.subjects.length, items.length);
    assert.deepEqual(offOut.catalog, [], 'the scan of the case texts is off by default');
    assert.deepEqual(offOut.warnings, []);
    const on = subjectDefault({ items, commands: { [id]: ['widget health interval pool1 5', 7] }, parameters: { scanCaseCommands: true } });
    const { catalog } = on as { catalog: Array<{ id: string; commands: string[] }> };
    assert.equal(catalog.length, items.length);
    assert.deepEqual(catalog[0].commands, ['widget health interval pool1 5']);
    assert.deepEqual(catalog[1].commands, []);
    assert.deepEqual(buildSubjects({ items }), buildSubjects({ items: structuredClone(items) }));
  });

  it('ignores a scanCaseCommands that is not a boolean, with a warning, and keeps the scan off', () => {
    const out = buildSubjects({ items: hubItems(), parameters: { scanCaseCommands: 'yes' } });
    assert.ok(!isFailure(out));
    assert.deepEqual(out.catalog, []);
    assert.deepEqual(out.warnings.map((warning) => warning.code), ['case-review.parameter_ignored']);
  });

  it('refuses input without items and never throws', () => {
    for (const input of [null, {}, { items: 'x' }, 3]) {
      const out = subjectDefault(input);
      assert.ok(isFailure(out));
      assert.equal(out.error.code, 'case-review.invalid_input');
    }
    assert.ok(!isFailure(subjectDefault({ items: [null, 1, { fields: [] }], commands: null, parameters: 'x' })));
  });
});
