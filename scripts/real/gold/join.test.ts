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
    assert.equal(normalizeId('0074001'), '74001');
    assert.equal(normalizeId('74001'), '74001');
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

  test('PLM status integration: parses data[].status, calculates closed counts, respects bugzilla exemption and unread', () => {
    const defects = [
      { bug: '71001', status: 'fixed', module: 'SSL', system: 'plm' }, // PLM closed, traced
      { bug: '71002', status: 'known', module: 'WebUI', system: 'plm' }, // PLM resolved, traced (not closed with default)
      { bug: '71003', status: 'fixed', module: 'CLI', system: 'plm' }, // PLM closed, untraced
      { bug: '71004', status: 'fixed', module: 'BZ', system: 'bugzilla' }, // Bugzilla, unqueried -> unknown
      { bug: '71005', status: 'fixed', module: 'SYS', system: 'plm' }, // PLM missing -> unread unknown
      { bug: '71006', status: 'fixed', module: 'NO_SYS' }, // unspecified system -> unknown
      { bug: '71007', status: 'fixed', module: 'EMPTY_ST', system: 'plm' }, // PLM record with no status
    ];
    const cases = [
      { document: '9001', id: 'c-1', title: '用例1', defects: ['71001'] },
      { document: '9001', id: 'c-2', title: '用例2', defects: ['71002'] },
    ];
    const plm = [
      { id: 71001, status: 'closed', title: '缺陷1' },
      { id: '71002', status: 'resolved', title: '缺陷2' },
      { id: 71003, status: 'closed', title: '缺陷3' },
      { id: 71004, status: 'closed', title: '同号Bugzilla缺陷' }, // should NOT be matched for bugzilla defect
      { id: 71007, title: '无状态记录' },
    ];

    // Default closed-statuses: ['closed']
    const goldDefault = joinGold(defects, cases, { plm });
    assert.equal(goldDefault.closed_defects, 2); // 71001 and 71003
    assert.equal(goldDefault.closed_traced, 1); // 71001
    assert.equal(goldDefault.closed_untraced, 1); // 71003
    assert.equal(goldDefault.status_unknown, 4); // 71004, 71005, 71006, 71007
    assert.equal(goldDefault.rows[0].defect_system_status, 'closed');
    assert.equal(goldDefault.rows[0].closed, true);
    assert.equal(goldDefault.rows[1].defect_system_status, 'resolved');
    assert.equal(goldDefault.rows[1].closed, false);
    assert.equal(goldDefault.rows[2].defect_system_status, 'closed');
    assert.equal(goldDefault.rows[2].closed, true);
    assert.equal(goldDefault.rows[3].defect_system_status, null);
    assert.equal(goldDefault.rows[3].defect_system_unknown_reason, '系统为 bugzilla，不从 PLM 查询');
    assert.equal(goldDefault.rows[3].closed, false);
    assert.equal(goldDefault.rows[4].defect_system_status, null);
    assert.equal(goldDefault.rows[4].defect_system_unknown_reason, '缺陷系统没有返回这个编号');
    assert.equal(goldDefault.rows[4].closed, false);
    assert.equal(goldDefault.rows[5].defect_system_status, null);
    assert.equal(goldDefault.rows[5].defect_system_unknown_reason, '缺陷系统不明，不按编号查 PLM');
    assert.equal(goldDefault.rows[5].closed, false);
    assert.equal(goldDefault.rows[6].defect_system_status, null);
    assert.equal(goldDefault.rows[6].defect_system_unknown_reason, '缺陷系统的记录里没有状态');
    assert.equal(goldDefault.rows[6].closed, false);

    // Custom closed-statuses: ['closed', 'resolved']
    const goldResolved = joinGold(defects, cases, { plm, closedStatuses: ['closed', 'resolved'] });
    assert.equal(goldResolved.closed_defects, 3); // 71001, 71002, 71003
    assert.equal(goldResolved.closed_traced, 2); // 71001, 71002
    assert.equal(goldResolved.closed_untraced, 1); // 71003
    assert.equal(goldResolved.status_unknown, 4);
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

  test('main accepts --plm and --closed-statuses and outputs closed counts', async () => {
    const out = join(dir ??= mkdtempSync(join(tmpdir(), 'gold-join-')), 'join-plm.json');
    const defects = [
      { bug: '7300', status: 'fixed', module: 'SSL', system: 'plm' },
      { bug: '7400', status: 'fixed', module: 'CLI', system: 'plm' },
    ];
    const cases = [{ document: '9001', id: 'c-1', title: '会话检查', defects: ['7300'] }];
    const plmEnvelope = {
      code: 1000,
      msg: '',
      data: [
        { id: 7300, status: 'resolved', title: '会话' },
        { id: 7400, status: 'closed', title: '命令行' },
      ],
    };
    const closedStatuses = ['closed', 'resolved'];

    const code = await main([
      '--defects', fileOf('defects-plm.json', defects),
      '--cases', fileOf('cases-plm.json', { documents: [{ document: '9001', cases }] }),
      '--plm', fileOf('plm.json', plmEnvelope),
      '--closed-statuses', fileOf('closed.json', closedStatuses),
      '--out', out,
    ]);
    assert.equal(code, 0);
    const written = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(out, 'utf8')));
    assert.equal(written.closed_defects, 2);
    assert.equal(written.closed_traced, 1);
    assert.equal(written.closed_untraced, 1);
    assert.equal(written.status_unknown, 0);
  });
});
