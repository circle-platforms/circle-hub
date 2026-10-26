// Every interpreter against its positive and negative samples, and totality on hostile subjects and tables.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { CORE_VIOLATION_CODES, PROTOCOL_CODES } from '../../../contracts/generated/protocol.ts';
import { CheckOutcome } from '../../../contracts/src/tables.ts';
import { buildCatalog } from '../catalog/view.ts';
import { support } from '../outcome.ts';
import { loadSamples, runSamples } from '../samples.ts';
import type { CheckContext, Interpreter } from '../types.ts';
import { defineInterpreter } from './define.ts';
import { INTERPRETERS } from './registry.ts';

const interpreter = (id: string): Interpreter => {
  const found = INTERPRETERS.get(id);
  assert.ok(found, id);
  return found;
};
const runOn = (id: string, table: unknown, subject: unknown, context: CheckContext = {}) => interpreter(id).run({ interpreter: id, table, subject, context });
const verdicts = (outcomes: CheckOutcome[]) => outcomes.map((o) => [o.verdict, o.code ?? o.reason ?? null]);

describe('samples', () => {
  for (const id of INTERPRETERS.keys()) {
    it(`${id}: every positive sample is supported, every negative sample refuted as expected`, () => {
      const file = loadSamples(id);
      assert.equal(file.interpreter, id);
      assert.ok(file.positive.length > 0, 'positive samples');
      assert.ok(file.negative.length > 0, 'negative samples');
      for (const result of runSamples(id)) {
        assert.deepEqual(result.problems, [], `${result.kind}: ${result.name}`);
        for (const outcome of result.outcomes) assert.ok(CheckOutcome.safeParse(outcome).success, JSON.stringify(outcome));
      }
    });
  }

  it('every code an interpreter declares is registered for it', () => {
    for (const interpreter of INTERPRETERS.values()) {
      const name = interpreter.id.split('@')[0];
      for (const code of interpreter.codes) {
        const core = (CORE_VIOLATION_CODES as Record<string, { interpreter: string }>)[code];
        assert.ok(core ? core.interpreter === name : Object.hasOwn(PROTOCOL_CODES, code), `${interpreter.id} ${code}`);
      }
      assert.ok(interpreter.codes.length > 0, interpreter.id);
    }
  });

  it('refutations carry only the interpreter’s own codes, and every statement is Chinese', () => {
    for (const result of runSamples()) {
      const codes = INTERPRETERS.get(result.interpreter)?.codes ?? [];
      for (const o of result.outcomes) {
        if (o.verdict === 'refute') assert.ok(codes.includes(o.code ?? ''), `${result.name}: ${o.code}`);
        assert.match(o.statement, /[一-鿿]/, o.statement);
      }
    }
  });
});

describe('totality', () => {
  const deep = (() => {
    let v: unknown = 'leaf';
    for (let i = 0; i < 20_000; i++) v = { children: [v], fields: { title: v } };
    return v;
  })();
  const wide = Array.from({ length: 20_000 }, (_, i) => ({ id: `n${i}`, fields: { title: 't', priority: 1, tags: ['a'], expected: ['b'], commands: ['lab show build'] } }));
  const subjects: unknown[] = [undefined, null, 0, Number.NaN, 'text', true, [], {}, [[[]]], { fields: null }, { fields: { commands: [1, null, {}] } }, deep, wide];
  const catalog = buildCatalog({ root: '4'.repeat(64), entries: [{ head: 'lab show build' }] });

  for (const interpreter of INTERPRETERS.values()) {
    it(`${interpreter.id} never throws and always answers`, () => {
      const file = loadSamples(interpreter.id);
      const tables = [...Object.values(file.tables ?? {}), ...[...file.positive, ...file.negative].map((s) => s.table).filter((t) => typeof t !== 'string')];
      for (const table of tables) {
        for (const subject of subjects) {
          const outcomes = interpreter.run({ interpreter: interpreter.id, table, subject, catalog, sources: { text: () => undefined }, context: {} });
          assert.ok(outcomes.length > 0);
          for (const o of outcomes) assert.ok(CheckOutcome.safeParse(o).success, JSON.stringify(o).slice(0, 300));
          // A tree walk cut short by the depth limit is unknown, never silently partial.
          if (interpreter.id === 'structure@1' && subject === deep && (table as { children?: unknown }).children !== undefined) {
            assert.ok(outcomes.some((o) => o.verdict === 'unknown' && o.reason === 'budget_exhausted'), 'a truncated walk is unknown');
          }
        }
      }
    });

    it(`${interpreter.id} turns an invalid table into unknown (check error) and reports why`, () => {
      for (const table of [undefined, null, 'x', {}, { schema: interpreter.id }, { schema: 'other@1', origin: 'x' }]) {
        const outcomes = interpreter.run({ interpreter: interpreter.id, table, subject: {}, context: {} });
        assert.equal(outcomes.length, 1);
        assert.equal(outcomes[0].verdict, 'unknown');
        assert.equal(outcomes[0].reason, 'check_error');
        assert.ok(interpreter.validateTable(table).length > 0);
      }
      const valid = Object.values(loadSamples(interpreter.id).tables ?? {})[0] as Record<string, unknown>;
      const issues = interpreter.validateTable({ ...valid, unexpected: true });
      assert.ok(issues.length > 0, 'closed schema');
      assert.match(issues[0].message, /[一-鿿]/);
      const withoutOrigin = { ...valid };
      delete withoutOrigin.origin;
      assert.ok(interpreter.validateTable(withoutOrigin).some((i) => i.path === '/origin'), 'origin is required (C04 R[0])');
    });
  }
});

describe('semantic table checks', () => {
  it('structure@1: inverted bounds, a group rule without fields, child bounds without a children pointer', () => {
    const structure = INTERPRETERS.get('structure@1');
    assert.ok(structure);
    const issues = structure.validateTable({
      schema: 'structure@1',
      origin: 'x',
      rules: [{ fields: [{ path: '/a', minimum: 3, maximum: 1 }], unique: [{ key: ['/a'], within: 'group' }], children: { min: 1 } }],
    });
    assert.deepEqual(issues.map((i) => i.path).sort(), ['/rules/0/children', '/rules/0/fields/0', '/rules/0/unique/0/group'].sort());
  });

  it('pattern@1: a sample that contradicts the pattern, and an unsupported construct', () => {
    const pattern = INTERPRETERS.get('pattern@1');
    assert.ok(pattern);
    const table = (p: string, match: string[], reject: string[]) => ({
      schema: 'pattern@1',
      origin: 'x',
      language: 'regexp',
      rules: [{ values: '$.a', pattern: p, samples: { match, reject } }],
    });
    assert.deepEqual(pattern.validateTable(table('[0-9]+', ['12'], ['x'])), []);
    assert.deepEqual(pattern.validateTable(table('[0-9]+', ['x'], ['y'])).map((i) => i.path), ['/rules/0/samples/match/0']);
    assert.deepEqual(pattern.validateTable(table('(a)\\1', ['aa'], ['ab'])).map((i) => i.path), ['/rules/0/pattern']);
    assert.deepEqual(pattern.validateTable(table('(?=a)a', ['a'], ['b'])).map((i) => i.path), ['/rules/0/pattern']);
  });

  it('catalog@1: an expected code the interpreter cannot produce, and a table with nothing to check', () => {
    const catalog = INTERPRETERS.get('catalog@1');
    assert.ok(catalog);
    const issues = catalog.validateTable({ schema: 'catalog@1', origin: 'x', catalog: 'c', commands: ['$.c'], negative: { flag: '/n', expect: ['core.pattern.no_match'] } });
    assert.deepEqual(issues.map((i) => i.path), ['/negative/expect/0']);
    assert.deepEqual(catalog.validateTable({ schema: 'catalog@1', origin: 'x', catalog: 'c' }).map((i) => i.path), ['']);
  });

  it('range@1: a range without bounds, inverted threshold bounds', () => {
    const range = INTERPRETERS.get('range@1');
    assert.ok(range);
    const issues = range.validateTable({
      schema: 'range@1',
      origin: 'x',
      checks: [
        { values: '$.a', range: {} },
        { values: '$.b', threshold: { measure: 'count', minimum: 5, maximum: 1 } },
      ],
    });
    assert.deepEqual(issues.map((i) => i.path), ['/checks/0/range', '/checks/1/threshold']);
  });

  it('every kind: a blocking tier needs the contract clause it relies on (C05 R[1]); without a clause the default tier is advisory', () => {
    const membership = { schema: 'membership@1', origin: 'x', values: ['$.v'], set: { values: ['A'] } };
    assert.deepEqual(interpreter('membership@1').validateTable({ ...membership, tier: 'blocking' }).map((i) => i.path), ['/tier']);
    assert.deepEqual(interpreter('membership@1').validateTable({ ...membership, tier: 'blocking', basis: '条款' }), []);
    assert.deepEqual(interpreter('membership@1').validateTable({ ...membership, basis: '' }).map((i) => i.path), ['/basis']);
    assert.equal(runOn('membership@1', membership, { v: 'B' })[0].tier, 'advisory');
    assert.equal(runOn('membership@1', { ...membership, basis: '条款' }, { v: 'B' })[0].tier, 'blocking');
    const catalog = { schema: 'catalog@1', origin: 'x', catalog: 'c', commands: ['$.c'], tier: 'advisory', negative: { flag: '/n', expect: ['core.catalog.arity_mismatch'], tier: 'blocking' } };
    assert.deepEqual(interpreter('catalog@1').validateTable(catalog).map((i) => i.path), ['/negative/tier']);
  });
});

describe('pattern@1 limits', () => {
  const table = (rule: Record<string, unknown>, rules = 1) => ({ schema: 'pattern@1', origin: 'x', language: 'regexp', rules: Array.from({ length: rules }, () => ({ values: '$.v', ...rule })) });

  it('samples that are too long or too many are refused by the schema, quickly', () => {
    const started = Date.now();
    const long = interpreter('pattern@1').validateTable(table({ pattern: '(?:[a-z]|[a-y]){0,99}z', mode: 'search', samples: { match: ['z'], reject: ['a'.repeat(1_000_000)] } }));
    assert.ok(long.some((i) => i.path === '/rules/0/samples/reject/0'), JSON.stringify(long));
    const many = interpreter('pattern@1').validateTable(table({ pattern: 'z', samples: { match: Array(100).fill('z'), reject: ['a'] } }));
    assert.ok(many.some((i) => i.path === '/rules/0/samples/match'), JSON.stringify(many));
    assert.ok(interpreter('pattern@1').validateTable(table({ pattern: 'z', samples: { match: ['z'], reject: ['a'] } }, 200)).some((i) => i.path === '/rules'));
    assert.ok(Date.now() - started < 1000, `validation took ${Date.now() - started} ms`);
  });

  it('samples within the size limits whose matching work exceeds the budget are refused', () => {
    const started = Date.now();
    const issues = interpreter('pattern@1').validateTable(
      table({ pattern: '(?:[a-z]|[a-y]){0,99}z', mode: 'search', samples: { match: ['z'], reject: Array(32).fill('a'.repeat(1000)) } }, 8),
    );
    assert.ok(issues.some((i) => /工作量/.test(i.message)), JSON.stringify(issues));
    assert.ok(Date.now() - started < 1500, `validation took ${Date.now() - started} ms`);
  });

  it('flags i, required, over-long values and the work budget', () => {
    const rule = { pattern: '[a-z]+-[0-9]+', flags: 'i', samples: { match: ['AB-1'], reject: ['AB'] } };
    assert.deepEqual(verdicts(runOn('pattern@1', table(rule), { v: 'Qa-7' })), [['support', null]]);
    assert.deepEqual(verdicts(runOn('pattern@1', { ...table(rule), required: true }, {})), [['unknown', 'missing_input']]);
    assert.deepEqual(verdicts(runOn('pattern@1', { ...table(rule), required: true }, { v: [] })), [['support', null]]);
    assert.deepEqual(runOn('pattern@1', table(rule), {})[0].data?.missing, ['$.v']);
    assert.deepEqual(verdicts(runOn('pattern@1', table(rule), { v: `${'a'.repeat(20_001)}-1` })), [['unknown', 'check_error']]);
    const values = Array.from({ length: 400 }, () => `${'a'.repeat(19_990)}-1`);
    const budget = runOn('pattern@1', table(rule), { v: values });
    assert.ok(budget.some((o) => o.reason === 'budget_exhausted'));
    assert.ok(budget.some((o) => o.verdict === 'support'));
  });
});

describe('table validation is cached by content', () => {
  it('a table is validated once per content, not on every run', () => {
    let checks = 0;
    const probe = defineInterpreter({
      id: 'probe@1',
      codes: ['core.membership.not_in_set'],
      schema: z.strictObject({ schema: z.literal('probe@1'), origin: z.string(), n: z.number(), note: z.string().optional() }),
      check: () => {
        checks += 1;
        return [];
      },
      run: () => [support({ tier: 'advisory', grounds: [] }, '探针')],
    });
    const table = { schema: 'probe@1', origin: 'x', n: 1 };
    assert.deepEqual(probe.validateTable(table), []);
    probe.run({ interpreter: 'probe@1', table, subject: {}, context: {} });
    probe.run({ interpreter: 'probe@1', table: { origin: 'x', n: 1, schema: 'probe@1' }, subject: {}, context: {} });
    assert.equal(checks, 1, 'equal content shares one validation');
    probe.run({ interpreter: 'probe@1', table: { ...table, n: 2 }, subject: {}, context: {} });
    assert.equal(checks, 2);
    // An undefined member and a null member are different tables.
    assert.deepEqual(probe.validateTable({ ...table, note: undefined }), []);
    assert.ok(probe.validateTable({ ...table, note: null }).length > 0);
  });
});

describe('structure@1 limits', () => {
  const tree = { schema: 'structure@1', origin: 'x', kind: '/kind', children: '/children', rules: [{ kinds: ['case'], fields: [{ path: '/text', required: true }] }] };

  it('a walk stopped at the depth limit is unknown (budget exhausted) at the place it stopped', () => {
    let node: unknown = { kind: 'case' };
    for (let i = 0; i < 70; i++) node = { kind: 'case', text: 't', children: [node] };
    const outcomes = runOn('structure@1', tree, node);
    const stop = outcomes.filter((o) => o.verdict === 'unknown');
    assert.deepEqual(verdicts(stop), [['unknown', 'budget_exhausted']]);
    assert.equal(stop[0].pointer, '/children/0'.repeat(65));
    assert.equal(stop[0].data?.not_examined, 1);
  });

  it('a list longer than the node limit is unknown for the rest; the deepest empty node alone is not a plain support', () => {
    const list = Array.from({ length: 100_001 }, (_, i) => (i === 100_000 ? {} : { text: 't' }));
    const outcomes = runOn('structure@1', { schema: 'structure@1', origin: 'x', nodes: '$[*]', rules: [{ fields: [{ path: '/text', required: true }] }] }, list);
    const stop = outcomes.filter((o) => o.verdict !== 'support');
    assert.deepEqual(verdicts(stop), [['unknown', 'budget_exhausted']]);
    assert.equal(stop[0].pointer, '/100000');
    let only: unknown = { kind: 'case' };
    for (let i = 0; i < 70; i++) only = { kind: 'group', children: [only] };
    const groups = runOn('structure@1', tree, only);
    assert.deepEqual(verdicts(groups), [['unknown', 'budget_exhausted']]);
  });

  it('an empty node list is nothing to check; a missing one is unknown (missing input)', () => {
    const items = { schema: 'structure@1', origin: 'x', nodes: '$.items[*]', rules: [{ fields: [{ path: '/text', required: true }] }] };
    assert.deepEqual(verdicts(runOn('structure@1', items, { items: [] })), [['support', null]]);
    assert.deepEqual(verdicts(runOn('structure@1', items, {})), [['unknown', 'missing_input']]);
  });
});

describe('missing is not empty (C04 R[4])', () => {
  it('coverage@1: a missing required selection is unknown; an empty one is nothing to cover', () => {
    const table = { schema: 'coverage@1', origin: 'x', required: { select: '$.required' }, covered: ['$.covered'] };
    assert.deepEqual(verdicts(runOn('coverage@1', table, { covered: [] })), [['unknown', 'missing_input']]);
    assert.deepEqual(verdicts(runOn('coverage@1', table, { covered: [], required: [] })), [['support', null]]);
    const defect = { schema: 'coverage@1', origin: 'x', required: { select: '$.defect.parameters[*]' }, covered: ['$.cases[*].parameter'] };
    assert.deepEqual(verdicts(runOn('coverage@1', defect, { cases: [] })), [['unknown', 'missing_input']]);
    assert.deepEqual(verdicts(runOn('coverage@1', defect, { defect: { parameters: ['p'] }, cases: [{}] })), [['refute', 'core.coverage.shortfall']]);
    assert.deepEqual(verdicts(runOn('coverage@1', defect, { defect: { parameters: ['p'] } })), [['unknown', 'missing_input']]);
    assert.deepEqual(verdicts(runOn('coverage@1', defect, { defect: { parameters: ['p'] }, cases: [{ parameter: 'p' }] })), [['support', null]]);
  });

  it('coverage@1: sets by reference and by name, and what makes them unknown', () => {
    const ref = `src:${'c'.repeat(64)}`;
    const byRef = { schema: 'coverage@1', origin: 'x', required: { reference: ref }, covered: ['$.covered'] };
    const sources = (text: string | undefined) => ({ text: (r: string) => (r === ref ? text : undefined) });
    const run = (table: unknown, subject: unknown, text?: string, context: CheckContext = {}) =>
      interpreter('coverage@1').run({ interpreter: 'coverage@1', table, subject, sources: sources(text), context });
    assert.deepEqual(verdicts(run(byRef, { covered: ['a'] }, undefined)), [['unknown', 'missing_input']]);
    assert.deepEqual(verdicts(run(byRef, { covered: ['a'] }, 'not json')), [['unknown', 'check_error']]);
    assert.deepEqual(verdicts(run(byRef, { covered: ['a'] }, '[{"x":1}]')), [['unknown', 'check_error']]);
    assert.deepEqual(verdicts(run(byRef, { covered: ['a'] }, '{"a":1}')), [['unknown', 'check_error']]);
    const byName = { schema: 'coverage@1', origin: 'x', required: { name: 'modules' }, covered: ['$.covered'] };
    assert.deepEqual(verdicts(run(byName, { covered: ['a'] })), [['unknown', 'missing_input']]);
  });

  it('membership@1, pattern@1 and range@1 with required: a missing location is unknown, an empty list is nothing to check', () => {
    const membership = { schema: 'membership@1', origin: 'x', values: ['$.codes'], set: { values: ['A'] } };
    assert.deepEqual(verdicts(runOn('membership@1', { ...membership, required: true }, {})), [['unknown', 'missing_input']]);
    assert.deepEqual(verdicts(runOn('membership@1', { ...membership, required: true }, { codes: [] })), [['support', null]]);
    const optional = runOn('membership@1', membership, {});
    assert.deepEqual(verdicts(optional), [['support', null]]);
    assert.deepEqual(optional[0].data?.missing, ['$.codes']);
    const range = { schema: 'range@1', origin: 'x', required: true, checks: [{ values: '$.p', range: { minimum: 1 } }, { values: '$.tags', threshold: { measure: 'count', minimum: 1 } }] };
    assert.deepEqual(verdicts(runOn('range@1', range, {})), [
      ['unknown', 'missing_input'],
      ['unknown', 'missing_input'],
    ]);
    assert.deepEqual(verdicts(runOn('range@1', range, { p: [], tags: [] })), [['refute', 'core.range.out_of_bounds']]);
    const optionalRange = runOn('range@1', { ...range, required: undefined }, {});
    assert.deepEqual(verdicts(optionalRange), [['support', null]]);
    assert.deepEqual(optionalRange[0].data?.missing, ['$.p', '$.tags']);
  });

  it('membership@1: the reasons a set is unknown', () => {
    const named = { schema: 'membership@1', origin: 'x', values: ['$.v'], set: { name: 'codes' } };
    assert.deepEqual(verdicts(runOn('membership@1', named, { v: 'a' })), [['unknown', 'missing_input']]);
    assert.deepEqual(verdicts(runOn('membership@1', named, { v: 'a' }, { sets: { codes: ['a'] } })), [['support', null]]);
    assert.deepEqual(verdicts(runOn('membership@1', named, { v: { nested: true } }, { sets: { codes: ['a'] } })), [['unknown', 'check_error']]);
  });

  it('pattern@1 and range@1 prefixes: a value that is not a string or number is unknown (check error)', () => {
    const pattern = { schema: 'pattern@1', origin: 'x', language: 'regexp', rules: [{ values: '$.v', pattern: 'a', samples: { match: ['a'], reject: ['b'] } }] };
    assert.deepEqual(verdicts(runOn('pattern@1', pattern, { v: { a: 1 } })), [['unknown', 'check_error']]);
    const prefix = { schema: 'range@1', origin: 'x', checks: [{ values: '$.v', prefix: { values: ['a'] } }] };
    assert.deepEqual(verdicts(runOn('range@1', prefix, { v: [null] })), [['unknown', 'check_error']]);
  });

  it('an interpreter that throws, or answers nothing, is unknown (check error) and never throws', () => {
    const shape = z.strictObject({ schema: z.literal('broken@1'), origin: z.string() });
    const throws = defineInterpreter({
      id: 'broken@1',
      codes: ['core.membership.not_in_set'],
      schema: shape,
      run: () => {
        throw new Error('internal');
      },
    });
    const silent = defineInterpreter({ id: 'broken@1', codes: ['core.membership.not_in_set'], schema: shape, run: () => [] });
    for (const broken of [throws, silent]) {
      assert.deepEqual(verdicts(broken.run({ interpreter: 'broken@1', table: { schema: 'broken@1', origin: 'x' }, subject: {}, context: {} })), [['unknown', 'check_error']]);
    }
  });

  it('quote@1: a quotation without a bound source or without a reference is unknown (missing input)', () => {
    const table = { schema: 'quote@1', origin: 'x', quotes: [{ select: '$.q[*]', text: '/t', reference: '/r' }] };
    const ref = `src:${'d'.repeat(64)}`;
    assert.deepEqual(verdicts(runOn('quote@1', table, { q: [{ t: '片段', r: ref }] })), [['unknown', 'missing_input']]);
    assert.deepEqual(verdicts(runOn('quote@1', table, { q: [{ t: '片段' }] })), [['unknown', 'missing_input']]);
  });
});

describe('range@1 numbers', () => {
  const range = (bounds: Record<string, unknown>) => ({ schema: 'range@1', origin: 'x', checks: [{ values: '$.v', range: bounds }] });

  it('decimal strings are compared exactly, also beyond 2^53 and with hundreds of digits', () => {
    assert.deepEqual(verdicts(runOn('range@1', range({ maximum: 9007199254740992 }), { v: '9007199254740993' })), [['refute', 'core.range.out_of_bounds']]);
    assert.deepEqual(verdicts(runOn('range@1', range({ maximum: 9007199254740992 }), { v: '9007199254740992' })), [['support', null]]);
    assert.deepEqual(verdicts(runOn('range@1', range({ minimum: 0, integer: true }), { v: '1'.repeat(400) })), [['support', null]]);
    assert.deepEqual(verdicts(runOn('range@1', range({ maximum: 1e300 }), { v: `1${'0'.repeat(300)}1` })), [['refute', 'core.range.out_of_bounds']]);
    assert.deepEqual(verdicts(runOn('range@1', range({ minimum: 0, integer: true }), { v: '2.50' })), [['refute', 'core.range.out_of_bounds']]);
    assert.deepEqual(verdicts(runOn('range@1', range({ minimum: 0, integer: true }), { v: '2.00' })), [['support', null]]);
    assert.deepEqual(verdicts(runOn('range@1', range({ minimum: 0 }), { v: `1${'0'.repeat(2000)}` })), [['unknown', 'check_error']]);
  });

  it('exclusive bounds, and thresholds on sum, min and max of decimal values', () => {
    assert.deepEqual(verdicts(runOn('range@1', range({ exclusiveMinimum: -0.5, exclusiveMaximum: 2 }), { v: ['-0.5', -0.4, '1.99', 2] })), [
      ['refute', 'core.range.out_of_bounds'],
      ['support', null],
      ['support', null],
      ['refute', 'core.range.out_of_bounds'],
    ]);
    const threshold = (measure: string, bounds: Record<string, unknown>) => ({ schema: 'range@1', origin: 'x', checks: [{ values: '$.v', threshold: { measure, ...bounds } }] });
    assert.deepEqual(verdicts(runOn('range@1', threshold('sum', { maximum: 0.3 }), { v: [0.1, 0.2] })), [['support', null]]);
    assert.deepEqual(verdicts(runOn('range@1', threshold('sum', { maximum: 9007199254740992 }), { v: ['9007199254740992', '1'] })), [['refute', 'core.range.out_of_bounds']]);
    assert.deepEqual(verdicts(runOn('range@1', threshold('min', { minimum: 1 }), { v: ['3', 1, '0.5'] })), [['refute', 'core.range.out_of_bounds']]);
    assert.deepEqual(verdicts(runOn('range@1', threshold('max', { maximum: 3 }), { v: ['3', 1, '0.5'] })), [['support', null]]);
    assert.deepEqual(verdicts(runOn('range@1', threshold('min', { minimum: 1 }), { v: [] })), [['refute', 'core.range.out_of_bounds']]);
    assert.deepEqual(verdicts(runOn('range@1', threshold('sum', { maximum: 3 }), { v: ['x'] })), [['unknown', 'check_error']]);
  });
});
