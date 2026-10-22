// Tests of the gold join script (synthetic defects and case documents): a double loop over defects and cases,
// no index structures; the comparison is over normalised ids (a pure digit run loses its leading zeros).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { joinGold, main, normalizeId } from './join.ts';

describe('normalizeId', () => {
  test('a pure digit run loses its leading zeros; anything else stays as written', () => {
    assert.equal(normalizeId('0071009'), '71009');
    assert.equal(normalizeId('71009'), '71009');
    assert.equal(normalizeId('0'), '0');
    assert.equal(normalizeId('ALM-1'), 'ALM-1');
  });
});

describe('joinGold', () => {
  test('joins defects to cases by defect id with a double loop; a defect with no case is unknown', () => {
    const defects = [
      { bug: '7300', status: 'fixed', module: 'SSL' },
      { bug: '007301', status: 'fixed', module: 'SSL' },
      { bug: '7402', status: 'known', module: 'WebUI' },
      { bug: '7403', status: 'fixed', module: '' },
    ];
    const cases = [
      { document: '9001', id: 'c-1', title: '会话检查', defects: ['7300'] },
      { document: '9001', id: 'c-2', title: '证书查看', defects: ['007300'] },
      { document: '9002', id: 'c-9', title: '界面回归', defects: ['7301', '7402'] },
      { document: '9002', id: 'c-10', title: '无缺陷编号', defects: [] },
    ];
    const gold = joinGold(defects, cases);
    // Hand-computed with a double loop: 7300 → c-1 and c-2 (007300 normalises to it); 007301 (kept as written) →
    // c-9 (7301 normalises to it); 7402 → c-9; 7403 → no case.
    assert.deepEqual(
      gold.rows.map((r) => [r.bug, r.status, r.cases.map((c) => `${c.document}:${c.id}`)]),
      [
        ['7300', 'fixed', ['9001:c-1', '9001:c-2']],
        ['007301', 'fixed', ['9002:c-9']],
        ['7402', 'known', ['9002:c-9']],
        ['7403', 'fixed', []],
      ],
    );
    assert.equal(gold.untraced, 1);
    assert.equal(gold.traced, 3);
  });
  test('a defect id appearing in several cases and a case naming several defects both hold', () => {
    const defects = [{ bug: '8001', status: 'fixed', module: '' }, { bug: '8002', status: 'fixed', module: '' }];
    const cases = [
      { document: '9003', id: 'a', title: '甲', defects: ['8001', '8002'] },
      { document: '9003', id: 'b', title: '乙', defects: ['8001'] },
    ];
    const gold = joinGold(defects, cases);
    assert.deepEqual(gold.rows.map((r) => [r.bug, r.cases.length]), [['8001', 2], ['8002', 1]]);
  });
});

describe('main', () => {
  let dir: string | undefined;
  const fileOf = (name: string, value: unknown): string => {
    dir ??= mkdtempSync(join(tmpdir(), 'gold-join-'));
    const path = join(dir, name);
    writeFileSync(path, `${JSON.stringify(value)}\n`);
    return path;
  };
  after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
  test('reads the two inputs, writes the join JSON and exits 0; missing or malformed inputs exit 1', async () => {
    const out = join(dir ??= mkdtempSync(join(tmpdir(), 'gold-join-')), 'join.json');
    const defects = [{ bug: '7300', status: 'fixed', module: 'SSL' }];
    const cases = [{ document: '9001', id: 'c-1', title: '会话检查', defects: ['007300'] }];
    const code = await main(['--defects', fileOf('defects.json', defects), '--cases', fileOf('cases.json', { documents: [{ document: '9001', cases }] }), '--out', out]);
    assert.equal(code, 0);
    const written = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(out, 'utf8')));
    assert.deepEqual(written.rows.map((r: { bug: string; cases: unknown[] }) => [r.bug, r.cases.length]), [['7300', 1]]);
    assert.equal((await main(['--defects', join(dir, 'nope.json'), '--cases', fileOf('cases.json', { documents: [] }), '--out', out])), 1);
    assert.equal((await main(['--defects', fileOf('bad.json', '不是对象'), '--cases', fileOf('cases.json', { documents: [] }), '--out', out])), 1);
  });
});
