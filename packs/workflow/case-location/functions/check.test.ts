import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { RunSubjectInput } from '../../../../contracts/src/pack.ts';
import { CheckOutcome } from '../../../../contracts/src/tables.ts';
import { DEFAULT_LIMITS } from '../../../../hub/rules/api.ts';
import locateCheck, { locateOutcomes } from './check.ts';
import { locateInputOf, locateItem } from './locate.ts';
import { MAX_ITEMS, projectItems } from './project.ts';
import subject, { buildSubject } from './subject.ts';
import { BOUND, UNBOUND, assertTotal, boundDocument, hostileInputs, sha256, smallMap } from './test-support.ts';
import type { BoundInput, ProjectedItem } from './types.ts';

const P0 = '030：FAMX/FAMY测试项目';
const Outcomes = z.array(CheckOutcome);

const documents: BoundInput[] = [
  boundDocument('24101', smallMap('24101', 'x'), { title: 'bug 61001 会话保持', root: 'FAMY', ancestors: [P0, '060：10.6.1', '004：10.6.1-R2-2026/7', 'SLB'] }),
  boundDocument('24102', smallMap('24102', 'x'), { title: '设备基础配置', root: 'FAMX', ancestors: ['通用用例'] }),
  boundDocument('24103', smallMap('24103', 'x'), { title: 'FAMY 10.6.2.31 升级', root: 'FAMY', ancestors: [P0, '专项'] }),
];

/** The run subject the engine hands the subject builder: the projected items with src: locations, and the run context. */
function runSubject(context: typeof BOUND | typeof UNBOUND, parameters: Record<string, unknown> = {}) {
  const projected = projectItems({ inputs: documents, parameters, context: { ...context, parameters } }) as { items: ProjectedItem[] };
  const items = projected.items.map((it) => ({ id: it.id, label: it.label, location: `src:${it.location.source}/kityminder@1/${it.location.selector}`, fields: it.fields }));
  const input = { applies: 'run' as const, items, context: { ...context, parameters } };
  assert.ok(RunSubjectInput.safeParse(input).success, 'run-subject-input@1');
  return input;
}

describe('the subject builder', () => {
  it('keeps the items and adds the run facts a check function does not receive otherwise', () => {
    const input = runSubject(BOUND, { line: '10.6' });
    const built = buildSubject(input);
    assert.deepEqual(built.context, { product: 'famx', names: ['FAMX', 'FAMY'], parameters: { line: '10.6' } });
    assert.deepEqual(
      built.items.map((i) => [i.id, i.location]),
      input.items.map((i) => [i.id, i.location]),
    );
    assert.deepEqual(built.items[0].fields, input.items[0].fields);
    for (const [k, value] of hostileInputs().entries()) assertTotal(subject, value, `hostile ${k}`);
  });
});

describe('the locate check', () => {
  it('gives one outcome per item: support with the answer, unknown with what is known, never a violation for uncertainty', () => {
    const built = buildSubject(runSubject(BOUND));
    const outcomes = locateOutcomes(built);
    assert.ok(Outcomes.safeParse(outcomes).success);
    assert.deepEqual(
      outcomes.map((o) => [o.item, o.verdict, o.reason ?? null, o.code ?? null, o.tier]),
      [
        ['24101', 'support', null, null, 'advisory'],
        ['24102', 'unknown', 'missing_input', null, 'advisory'],
        ['24103', 'unknown', 'missing_input', null, 'advisory'],
      ],
    );
    for (const [k, o] of outcomes.entries()) {
      const item = built.items[k];
      assert.deepEqual(o.grounds, [item.location]);
      // The folders are not in the cited node: the outcome points at the item's fields in the subject (the run record's items).
      assert.equal(o.pointer, `/items/${k}/fields`);
      const { answer, judgment } = locateItem(locateInputOf(item.id, item.fields, built.context));
      assert.deepEqual(o.data, answer);
      assert.equal(o.statement, judgment.statement);
    }
    assert.deepEqual(
      [outcomes[0].data?.product_line, outcomes[0].data?.version, outcomes[0].data?.module, outcomes[0].data?.unclassified],
      ['famx', '10.6.1', 'SLB', []],
    );
    // famx-id-fields@1: an identifier comes from a whole declared field, never from prose in a title or a folder label.
    assert.deepEqual(outcomes[0].data?.defects, []);
    assert.deepEqual(outcomes[0].data?.id_sources, []);
  });

  it('refutes a declaration that contradicts the tree and stays unknown for what it fills in', () => {
    const outcomes = locateOutcomes(buildSubject(runSubject(BOUND, { line: '10.7.3' })));
    assert.deepEqual(
      outcomes.map((o) => [o.item, o.verdict, o.code ?? o.reason ?? null]),
      [
        ['24101', 'refute', 'case-location.declaration_conflict'],
        ['24102', 'unknown', 'missing_input'],
        ['24103', 'unknown', 'missing_input'],
      ],
    );
    assert.deepEqual(outcomes[0].data?.conflicts, [{ field: 'line', declared: '10.7.3', tree: '10.6.1' }]);
    assert.deepEqual([outcomes[1].data?.version, outcomes[1].data?.version_source, outcomes[1].data?.declared], ['10.7.3', 'parameter', ['line', 'version']]);
  });

  it('leaves every product line undecided when the run names none', () => {
    const outcomes = locateOutcomes(buildSubject(runSubject(UNBOUND)));
    assert.deepEqual(
      outcomes.map((o) => [o.verdict, o.data?.product_line, o.data?.product_name]),
      [
        ['unknown', null, 'FAMY'],
        ['unknown', null, 'FAMX'],
        ['unknown', null, 'FAMY'],
      ],
    );
    assert.match(outcomes[0].statement, /运行没有绑定产品线/);
  });

  it('answers the largest run the projection admits within the sandbox output limit', () => {
    const cases = Array.from({ length: MAX_ITEMS }, (_, k) => ({ text: `bug ${60000 + k} ${'用例说明'.repeat(70)}`, data: { priority: 2, resource: ['Function'] }, children: [{ text: '结果' }] }));
    const big = boundDocument('24199', { text: '大文档', children: [{ text: '分组', children: cases }] }, { title: '需求20931 大文档', root: 'FAMY', ancestors: [P0, '060：10.6.1', '004：10.6.1-R2-2026/7', 'SSL'] });
    const projected = projectItems({ inputs: [big], parameters: { granularity: 'case' }, context: { ...BOUND, parameters: { granularity: 'case' } } }) as { items: ProjectedItem[] };
    assert.equal(projected.items.length, MAX_ITEMS);
    const items = projected.items.map((it) => ({ id: it.id, label: it.label, location: `src:${it.location.source}/kityminder@1/${it.location.selector}`, fields: it.fields }));
    const outcomes = locateOutcomes(buildSubject({ applies: 'run', items, context: { ...BOUND, parameters: { granularity: 'case' } } }));
    assert.equal(outcomes.length, MAX_ITEMS);
    assert.ok(Buffer.byteLength(JSON.stringify(outcomes), 'utf8') < DEFAULT_LIMITS.outputBytes, `${Buffer.byteLength(JSON.stringify(outcomes), 'utf8')} bytes`);
  });

  it('answers an empty or malformed subject with one item-less unknown, never a throw', () => {
    assert.deepEqual(
      locateOutcomes({ items: [], context: {} }).map((o) => [o.verdict, o.reason, o.item]),
      [['unknown', 'check_error', undefined]],
    );
    const odd = locateOutcomes({ items: [{ id: 'a', location: 'not a reference', fields: 'x' }, { id: '' }, null] });
    assert.deepEqual(
      odd.map((o) => [o.item, o.verdict, o.grounds]),
      [['a', 'unknown', []]],
    );
    for (const [k, input] of hostileInputs().entries()) {
      const out = assertTotal(locateCheck, input, `hostile ${k}`);
      assert.ok(Outcomes.safeParse(out).success, `hostile ${k}`);
    }
    const ground = `src:${sha256('x')}/kityminder@1/n/abc`;
    assert.deepEqual(locateOutcomes({ items: [{ id: 'a', location: ground, fields: {} }] })[0].grounds, [ground]);
  });

  it('passes every location of reference shape through as the ground, whatever its scheme, and leaves the schemes to the engine', () => {
    // The pack writes no list of reference schemes (they come from the generated vocabulary): any `<scheme>:<sha256>...`
    // location is kept, anything else is no reference at all.
    const digest = sha256('y');
    for (const location of [`src:${digest}/kityminder@1/n/abc`, `tree:${digest}/commands/x`, `rec:${digest}#/items/0`, `obs:${digest}`]) {
      assert.deepEqual(locateOutcomes({ items: [{ id: 'a', location, fields: {} }] })[0].grounds, [location], location);
    }
    for (const location of ['not a reference', `src:${digest.slice(0, 63)}`, `SRC:${digest}`, `src:${digest} x`, 5, null]) {
      assert.deepEqual(locateOutcomes({ items: [{ id: 'a', location, fields: {} }] })[0].grounds, [], String(location));
    }
  });
});
