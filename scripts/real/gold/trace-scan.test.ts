import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseClosedStatuses } from './join.ts';
import { traceGold, loadCaseMaps } from './trace.ts';

const map = { root: { data: { text: '合成标题' }, children: [{ data: { id: 'case-a', text: '合成用例', resource: ['Functional'] } }] } };
const tree = [{ id: 'folder', label: '缺陷 910001', cases: [], children: [{ id: 'doc-a', label: '合成文档', children: [] }] }];
const html = (id: string, system = 'plm') => `<a href="${system === 'plm' ? '?m=bug&f=view&id=' : 'show_bug.cgi?id='}${id}">${id}</a>`;

test('closed status declarations accept arrays and tables, and reject every other shape', () => {
  assert.deepEqual(parseClosedStatuses(['closed']), ['closed']);
  assert.deepEqual(parseClosedStatuses({ statuses: ['closed', 'resolved'] }), ['closed', 'resolved']);
  for (const bad of [null, {}, ['closed', 3], { statuses: 'closed' }]) assert.throws(() => parseClosedStatuses(bad));
});
test('tree-only association joins, leading zeros normalize, missing PLM and bugzilla never close', () => {
  const result = traceGold({ html: html('00910001') + html('910002') + html('910003', 'bugzilla'), maps: [{ document: 'doc-a', map }], tree,
    plm: [{ id: 910001, status: 'closed' }, { id: 910003, status: 'closed' }] });
  assert.equal(result.closed_traced, 1);
  assert.equal(result.status_unknown, 2);
  assert.equal(result.defects[0].cases.length, 1);
});
test('scan recommends the sole closed traced build and prints only hashes and counts; docs filter includes empty lists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gold-scan-'));
  try {
    for (const sub of ['fixed', 'cases', 'docs']) mkdirSync(join(dir, sub));
    writeFileSync(join(dir, 'cases/doc-a.json'), JSON.stringify(map));
    writeFileSync(join(dir, 'tree.json'), JSON.stringify(tree));
    writeFileSync(join(dir, 'plm.json'), JSON.stringify({ bugs: [{ id: '910001', status: 'closed' }] }));
    for (const [build, id] of [['Synthetic_10_7_A', '910002'], ['Synthetic_10_7_B', '910001'], ['Synthetic_10_7_C', '910003']]) {
      writeFileSync(join(dir, `fixed/Bugs_Fixed_with_${build}.html`), html(id));
      writeFileSync(join(dir, `docs/${build}.json`), JSON.stringify(['doc-a']));
    }
    const args = ['scripts/real/gold/trace-scan.ts', '--fixed-dir', join(dir, 'fixed'), '--cases-dir', join(dir, 'cases'), '--tree', join(dir, 'tree.json'), '--docs-dir', join(dir, 'docs'), '--plm', join(dir, 'plm.json'), '--out', join(dir, 'out.json')];
    const run = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /建议用 #2/);
    assert.doesNotMatch(run.stdout, /Synthetic|91000|合成/);
    const report = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'));
    assert.equal(report.builds[1].closed_traced, 1);
    writeFileSync(join(dir, 'docs/Synthetic_10_7_B.json'), '[]');
    assert.equal(loadCaseMaps(join(dir, 'cases'), new Set()).length, 0);
    const filtered = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(filtered.status, 0, filtered.stderr);
    assert.match(filtered.stdout, /没有找到已追溯的已关闭缺陷/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
