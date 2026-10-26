// The join of the traceability matrix: defects of the build (the release-note defect index) against the case index keyed
// by the defect ids the case documents carry. Semantics first, on hand-built views: one case, many, none, a case carrying
// two defects, a known defect, leading zeros, a story id equal to a bug id; then order independence, an independent
// double-loop join on a random corpus of 2,000 defects, and the scale of the spec (5,000 defects, 60,000 cases).
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { describe, it } from 'node:test';
import { buildMatrix, summaryOf } from './matrix.ts';
import { boundPair, caseEntry, defectEntry, indexViewOf, randomOf, reversed, type ViewEntrySpec } from './test-support.ts';
import { readIndexView } from './views.ts';

/** Reads the two views and joins them the way the projection does. */
function matrixOf(defects: ViewEntrySpec[], cases: ViewEntrySpec[], options: { statuses?: string[]; defectsView?: Parameters<typeof indexViewOf>[3]; casesView?: Parameters<typeof indexViewOf>[3] } = {}, slimCases = true) {
  const pair = boundPair(defects, cases, { ...options, slimCases });
  const dv = readIndexView(pair.inputs[0], 'defects', { kind: 'defect', key: 'bug' });
  const cv = readIndexView(pair.inputs[1], 'cases', { kind: 'case', key: 'defects' });
  assert.ok(dv.ok, 'the defects view reads');
  assert.ok(cv.ok, 'the cases view reads');
  return buildMatrix(dv.view, cv.view, options.statuses ?? ['fixed', 'known']);
}

const caseIds = (rows: ReturnType<typeof matrixOf>, bug: string): string[] => rows.find((r) => r.bug === bug)?.cases.map((c) => `${c.case}@${c.entry.slice(0, 8)}`) ?? [];

describe('buildMatrix on hand-built views', () => {
  it('a defect with one case is traced by that case', () => {
    const defect = defectEntry({ bug: '7001' });
    const kase = caseEntry({ defects: ['7001'], case: 'C-1', title: '校验参数生效' });
    const rows = matrixOf([defect], [kase]);
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.deepEqual([row.bug, row.ids, row.statuses, row.conflict], ['7001', ['7001'], ['fixed'], false]);
    assert.equal(row.statement, defect.statement);
    assert.deepEqual(row.references, [defect.reference]);
    assert.equal(row.cases.length, 1);
    assert.deepEqual(
      row.cases.map((c) => [c.case, c.title, c.document, c.reference, c.defects]),
      // The slim cases view (fields=document,node,title) does not carry the raw defect ids.
      [['C-1', '校验参数生效', '24001', kase.reference, []]],
    );
  });

  it('a defect with many cases lists them sorted by case id', () => {
    const defect = defectEntry({ bug: '7002' });
    const b = caseEntry({ defects: ['7002'], case: 'C-b' });
    const a = caseEntry({ defects: ['7002'], case: 'C-a' });
    const c = caseEntry({ defects: ['7002'], case: 'C-c' });
    const rows = matrixOf([defect], [b, c, a]);
    assert.deepEqual(rows[0].cases.map((x) => x.case), ['C-a', 'C-b', 'C-c']);
  });

  it('a defect no indexed case names has an empty case list', () => {
    const rows = matrixOf([defectEntry({ bug: '7003' })], [caseEntry({ defects: ['7999'], case: 'C-x' })]);
    assert.deepEqual([rows.length, rows[0].cases.length], [1, 0]);
  });

  it('same numbers in two named systems remain separate and do not borrow unqualified cases', () => {
    const rows = matrixOf([defectEntry({bug:'7020',system:'plm'}),defectEntry({bug:'7020',system:'bugzilla'})],[caseEntry({defects:['7020'],case:'C-9'})]);
    assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>r.identity).sort(),['bugzilla:7020','plm:7020']);
    for(const row of rows){assert.equal(row.cases.length,0);assert.deepEqual(row.collision_systems,['bugzilla','plm']);assert.equal(row.ambiguous_cases?.length,1);assert.match(summaryOf(row),/撞号/);}
  });
  it('explicit case systems join only their own defect system',()=>{
    const plm=caseEntry({defects:['7021'],case:'PLM-case'});plm.data.system='plm';
    const rows=matrixOf([defectEntry({bug:'7021',system:'plm'}),defectEntry({bug:'7021',system:'bugzilla'})],[plm],{},false);
    assert.deepEqual(rows.find(r=>r.identity==='plm:7021')?.cases.map(c=>c.case),['PLM-case']);assert.equal(rows.find(r=>r.identity==='bugzilla:7021')?.cases.length,0);
  });

  it('a case carrying two defects traces both', () => {
    const shared = caseEntry({ defects: ['7006', '7007'], case: 'C-2' });
    const rows = matrixOf([defectEntry({ bug: '7006' }), defectEntry({ bug: '7007', status: 'known' })], [shared]);
    assert.deepEqual(rows.map((r) => r.bug), ['7006', '7007']);
    for (const row of rows) assert.deepEqual(row.cases.map((c) => c.case), ['C-2'], row.bug);
    assert.deepEqual(rows.find((r) => r.bug === '7007')!.statuses, ['known']);
  });

  it('an id written with leading zeros on one side joins the plain id on the other', () => {
    const defect = defectEntry({ bug: '007005' });
    const kase = caseEntry({ defects: ['7005'], case: 'C-z' });
    const rows = matrixOf([defect], [kase]);
    assert.deepEqual([rows.length, rows[0].bug, rows[0].ids], [1, '7005', ['007005']]);
    assert.deepEqual(rows[0].cases.map((c) => c.case), ['C-z']);
  });

  it('a case listed under both spellings of one id is listed once', () => {
    const kase = caseEntry({ defects: ['0071', '71'], case: 'C-dup' });
    const rows = matrixOf([defectEntry({ bug: '71' })], [kase]);
    assert.equal(rows[0].cases.length, 1);
  });

  it('a story id that equals a bug id is not a trace: the case index only keys the defects field', () => {
    // The case names story 8001 (in stories) and bug 8002 (in defects); only the defect id is an index key.
    const kase = caseEntry({ defects: ['8002'], stories: ['8001'], case: 'C-s' });
    const rows = matrixOf([defectEntry({ bug: '8001' }), defectEntry({ bug: '8002' })], [kase]);
    assert.deepEqual(caseIds(rows, '8001'), []);
    assert.deepEqual(caseIds(rows, '8002').length, 1);
  });

  it('the statuses parameter selects the defect entries; a bug with no entry left is no item', () => {
    const rows = matrixOf([defectEntry({ bug: '7008' }), defectEntry({ bug: '7009', status: 'known' })], [], { statuses: ['fixed'] });
    assert.deepEqual(rows.map((r) => [r.bug, r.statuses]), [['7008', ['fixed']]]);
  });

  it('a bug listed as fixed in one entry and known in another is one item marked as a conflict', () => {
    const fixed = defectEntry({ bug: '7010', status: 'fixed', statement: '7010 已修复' });
    const known = defectEntry({ bug: '7010', status: 'known', statement: '7010 遗留' });
    const rows = matrixOf([fixed, known], [caseEntry({ defects: ['7010'], case: 'C-k' })]);
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.deepEqual([row.statuses, row.conflict], [['fixed', 'known'], true]);
    assert.deepEqual(row.references.sort(), [fixed.reference, known.reference].sort());
    assert.equal(row.cases.length, 1);
  });

  it('two entries of the same status are one item citing both, without a conflict', () => {
    const one = defectEntry({ bug: '7011', statement: '甲' });
    const two = defectEntry({ bug: '7011', statement: '乙' });
    const rows = matrixOf([one, two], []);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].conflict, rows[0].references.length], [false, 2]);
    // The statement is the one of the entry with the smaller digest, deterministically.
    const first = [one, two].sort((a, b) => (a.digest < b.digest ? -1 : 1))[0];
    assert.equal(rows[0].statement, first.statement);
  });

  it('a case id falls back to the entry digest when the entry names none, the title to the statement', () => {
    const bare = caseEntry({ defects: ['7012'] });
    delete bare.data.node;
    delete bare.data.case;
    delete bare.data.title;
    const rows = matrixOf([defectEntry({ bug: '7012' })], [bare], {}, false);
    const [ref] = rows[0].cases;
    assert.equal(ref.case, bare.digest);
    assert.equal(ref.title, bare.statement);
  });

  it('does not depend on the order of keys, entries or defects lists', () => {
    const defects = [defectEntry({ bug: '7101' }), defectEntry({ bug: '07102' }), defectEntry({ bug: '7103', status: 'known' })];
    const cases = [caseEntry({ defects: ['7101', '7102'], case: 'C-1' }), caseEntry({ defects: ['7102'], case: 'C-2' }), caseEntry({ defects: ['9999'], case: 'C-9' })];
    const one = matrixOf(defects, cases);
    const pair = boundPair(defects, cases);
    const two = (() => {
      const dv = readIndexView({ ...pair.inputs[0], model: reversed(pair.defects) }, 'defects', { kind: 'defect', key: 'bug' });
      const cv = readIndexView({ ...pair.inputs[1], model: reversed(pair.cases) }, 'cases', { kind: 'case', key: 'defects' });
      assert.ok(dv.ok && cv.ok);
      return buildMatrix(dv.view, cv.view, ['fixed', 'known']);
    })();
    assert.deepEqual(two, one);
  });
});

describe('buildMatrix against an independent join', () => {
  it('equals a plain double loop on a random corpus of 2,000 defects', () => {
    const random = randomOf(20261022);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
    // 2,000 defects: some with leading zeros, about a tenth known, a few conflicts.
    const defects: ViewEntrySpec[] = [];
    for (let i = 0; i < 2000; i++) {
      const bug = random() < 0.05 ? `0${71000 + i}` : `${71000 + i}`;
      defects.push(defectEntry({ bug, status: random() < 0.1 ? 'known' : 'fixed' }));
      if (random() < 0.03) defects.push(defectEntry({ bug, status: pick(['fixed', 'known']) }));
    }
    const bugKeys = [...new Set(defects.map((d) => String(d.data.bug)))];
    // 12,000 cases, each carrying up to 3 ids: mostly corpus bugs, some unknown ids, some story-only near-misses.
    const cases: ViewEntrySpec[] = [];
    for (let i = 0; i < 12000; i++) {
      const defectsOf = new Set<string>();
      const n = 1 + Math.floor(random() * 3);
      for (let k = 0; k < n; k++) defectsOf.add(random() < 0.9 ? pick(bugKeys) : `${99000 + Math.floor(random() * 500)}`);
      cases.push(caseEntry({ defects: [...defectsOf], case: `C-${i}`, document: `24${String(100 + Math.floor(random() * 50))}` }));
    }
    const rows = buildMatrix(
      (() => {
        const dv = readIndexView(boundPair(defects, []).inputs[0], 'defects', { kind: 'defect', key: 'bug' });
        assert.ok(dv.ok);
        return dv.view;
      })(),
      (() => {
        const cv = readIndexView(boundPair([], cases).inputs[1], 'cases', { kind: 'case', key: 'defects' });
        assert.ok(cv.ok);
        return cv.view;
      })(),
      ['fixed', 'known'],
    );

    // The independent join: normalise each case's defect ids once, then a plain loop over the defect entries.
    const caseKeys = cases.map((c) => ({ digest: c.digest, keys: new Set((c.data.defects as string[]).map((raw) => raw.replace(/^0+/, '') || '0')) }));
    const expected = new Map<string, Set<string>>();
    for (const d of defects) {
      if (d.data.status !== 'fixed' && d.data.status !== 'known') continue;
      const norm = (d.data.bug as string).replace(/^0+/, '') || '0';
      const set = expected.get(norm) ?? new Set<string>();
      for (const c of caseKeys) if (c.keys.has(norm)) set.add(c.digest);
      expected.set(norm, set);
    }
    assert.equal(rows.length, expected.size, 'one row per normalised bug');
    for (const row of rows) {
      const want = expected.get(row.bug);
      assert.ok(want !== undefined, `unexpected defect ${row.bug}`);
      assert.deepEqual(
        row.cases.map((c) => c.entry).sort(),
        [...want].sort(),
        `cases of ${row.bug}`,
      );
      // Sorted by (case, document, entry) as the pack promises: every adjacent pair non-decreasing, field by field.
      for (let k = 1; k < row.cases.length; k++) {
        const [prev, cur] = [row.cases[k - 1], row.cases[k]];
        const byCase = prev.case === cur.case;
        const byDocument = (prev.document ?? '') === (cur.document ?? '');
        assert.ok(prev.case < cur.case || (byCase && ((prev.document ?? '') < (cur.document ?? '') || (byDocument && prev.entry <= cur.entry))), `order of ${row.bug}: ${prev.case} then ${cur.case}`);
      }
      expected.delete(row.bug);
    }
    assert.equal(expected.size, 0);
  });

  it('computes a matrix of 5,000 defects and 60,000 cases in a few seconds', () => {
    const random = randomOf(7);
    const defects: ViewEntrySpec[] = [];
    for (let i = 0; i < 5000; i++) defects.push(defectEntry({ bug: `${60000 + i}`, status: i % 11 === 0 ? 'known' : 'fixed' }));
    const cases: ViewEntrySpec[] = [];
    for (let i = 0; i < 60000; i++) {
      const defectsOf = [`${60000 + Math.floor(random() * 5000)}`];
      if (random() < 0.2) defectsOf.push(`${60000 + Math.floor(random() * 5000)}`);
      cases.push(caseEntry({ defects: defectsOf, case: `C-${i}` }));
    }
    const pair = boundPair(defects, cases);
    const dv = readIndexView(pair.inputs[0], 'defects', { kind: 'defect', key: 'bug' });
    const cv = readIndexView(pair.inputs[1], 'cases', { kind: 'case', key: 'defects' });
    assert.ok(dv.ok && cv.ok);
    const started = performance.now();
    const rows = buildMatrix(dv.view, cv.view, ['fixed', 'known']);
    const elapsed = performance.now() - started;
    assert.equal(rows.length, 5000);
    assert.ok(elapsed < 5000, `the join took ${elapsed.toFixed(0)} ms`);
  });
});

it('an explicitly unknown system is not promoted to a named tracker',()=>{
 const rows=matrixOf([defectEntry({bug:'7091',system:'unknown'})],[caseEntry({defects:['7091'],case:'C-unknown-system'})]);
 assert.equal(rows[0].identity,'7091');assert.equal(rows[0].cases.length,1);assert.equal(rows[0].collision_systems,undefined);
});
