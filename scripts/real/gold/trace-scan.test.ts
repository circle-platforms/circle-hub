import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseClosedStatuses } from './join.ts';
import { traceGold, loadCaseMaps, parseDocumentList, missingMapDocuments } from './trace.ts';

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
    for (const build of ['Synthetic_10_7_A', 'Synthetic_10_7_B', 'Synthetic_10_7_C']) assert.ok(!run.stdout.includes(createHash('sha256').update(build).digest('hex').slice(0, 12)));
    const report = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'));
    assert.equal(report.builds[1].closed_traced, 1);
    // An empty per-build list is not a silent filter-everything: the build says so and stays out of the ranking.
    writeFileSync(join(dir, 'docs/Synthetic_10_7_B.json'), '[]');
    assert.equal(loadCaseMaps(join(dir, 'cases'), new Set()).length, 0);
    const filtered = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(filtered.status, 0, filtered.stderr);
    assert.match(filtered.stdout, /#2 的文档清单是空的：这个构建没有列出文档，不进建议/);
    assert.match(filtered.stdout, /没有找到已追溯的已关闭缺陷/);
    // A listed document with no exported map is a missing input: refuse and name the counts (no content on screen).
    writeFileSync(join(dir, 'docs/Synthetic_10_7_B.json'), JSON.stringify(['doc-a', 'doc-b', 'doc-c']));
    const refused = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /#2 的文档清单 3 份，导出的脑图缺 2 份：用 circle-hub original export 导出后重跑/);
    assert.doesNotMatch(refused.stderr, /Synthetic_10_7_B|doc-b|91000|合成/);
    const allDocsArgs = args.filter((_, i) => i !== args.indexOf('--docs-dir') && i !== args.indexOf('--docs-dir') + 1);
    assert.equal(spawnSync(process.execPath, allDocsArgs, { encoding: 'utf8' }).status, 0);
    assert.match(JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')).document_filter, /没有按构建/);
    writeFileSync(join(dir, 'closed.json'), JSON.stringify({ statuses: ['closed'] }));
    assert.equal(spawnSync(process.execPath, [...allDocsArgs, '--closed-statuses', join(dir, 'closed.json')], { encoding: 'utf8' }).status, 0);
    writeFileSync(join(dir, 'closed.json'), '{}');
    const malformed = spawnSync(process.execPath, [...allDocsArgs, '--closed-statuses', join(dir, 'closed.json')], { encoding: 'utf8' });
    assert.equal(malformed.status, 1);
    assert.doesNotMatch(malformed.stderr, /Synthetic|91000|合成/);

  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a defect named only as "bug to case N" in the tree document title is traced (the map-side marker family)', () => {
  const treeWithTitle = [{ id: 'folder', label: '合成目录', cases: [], children: [{ id: 'doc-b', label: 'bug to case 910010 合成标题', children: [] }] }];
  const result = traceGold({ html: html('910010'), maps: [{ document: 'doc-b', map }], tree: treeWithTitle });
  assert.equal(result.defects[0]?.cases.length, 1, JSON.stringify(result.defects[0]));
  // And in a folder label too.
  const treeWithFolder = [{ id: 'folder', label: '缺陷目录 bug to case 910011', cases: [], children: [{ id: 'doc-c', label: '合成标题', children: [] }] }];
  const viaFolder = traceGold({ html: html('910011'), maps: [{ document: 'doc-c', map }], tree: treeWithFolder });
  assert.equal(viaFolder.defects[0]?.cases.length, 1);
});

test('without --plm the closed counts are unread, printed as such, and the next action names the missing input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gold-scan-noplm-'));
  try {
    for (const sub of ['fixed', 'cases']) mkdirSync(join(dir, sub));
    writeFileSync(join(dir, 'cases/doc-a.json'), JSON.stringify(map));
    writeFileSync(join(dir, 'tree.json'), JSON.stringify(tree));
    writeFileSync(join(dir, 'fixed/Bugs_Fixed_with_Synthetic_10_7_D.html'), html('910001'));
    const run = spawnSync(process.execPath, ['scripts/real/gold/trace-scan.ts', '--fixed-dir', join(dir, 'fixed'), '--cases-dir', join(dir, 'cases'), '--tree', join(dir, 'tree.json'), '--out', join(dir, 'out.json')], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /已关闭 未读（没给 --plm）；其中已追溯 未读；状态未知 未读（没给 --plm）/);
    assert.ok(!/已关闭 0/.test(run.stdout), 'unread is never printed as 0');
    assert.match(run.stdout, /没给 PLM 原件，已关闭数未知：按已追溯数建议 #1；导出 plm:bugs: 原件后加 --plm --closed-statuses 重扫/);
    assert.doesNotMatch(run.stdout, /Synthetic|91000|合成/);
    const report = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'));
    assert.equal(report.builds[0].closed, null);
    assert.equal(report.builds[0].closed_traced, null);
    assert.equal(report.builds[0].status_unknown, null);
    assert.equal(report.builds[0].traced, 1, 'the traced count is still real');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing flags are named one by one, and an empty fixed-dir is refused with its own message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gold-scan-usage-'));
  try {
    const none = spawnSync(process.execPath, ['scripts/real/gold/trace-scan.ts'], { encoding: 'utf8' });
    assert.equal(none.status, 2);
    assert.match(none.stderr, /缺 --fixed-dir、--cases-dir、--tree、--out/);
    const partial = spawnSync(process.execPath, ['scripts/real/gold/trace-scan.ts', '--fixed-dir', join(dir, 'f')], { encoding: 'utf8' });
    assert.equal(partial.status, 2);
    assert.match(partial.stderr, /缺 --cases-dir、--tree、--out/);
    assert.ok(!(partial.stderr.split('\n')[0] ?? '').includes('--fixed-dir'), 'the given flag is not named as missing');
    mkdirSync(join(dir, 'cases'));
    writeFileSync(join(dir, 'cases/doc-a.json'), JSON.stringify(map));
    writeFileSync(join(dir, 'tree.json'), JSON.stringify(tree));
    mkdirSync(join(dir, 'f'));
    const emptyFixed = spawnSync(process.execPath, ['scripts/real/gold/trace-scan.ts', '--fixed-dir', join(dir, 'f'), '--cases-dir', join(dir, 'cases'), '--tree', join(dir, 'tree.json'), '--out', join(dir, 'out.json')], { encoding: 'utf8' });
    assert.equal(emptyFixed.status, 1);
    assert.match(emptyFixed.stderr, /没有 Bugs_Fixed_with_<构建>\.html：先导出修复缺陷页/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the listed-versus-loaded document check is shared: a listed document without a map is named, never dropped', () => {
  const listed = parseDocumentList(JSON.stringify(['doc-a', 'agile:case:doc-b', 'doc-c']));
  const missing = missingMapDocuments(listed, [{ document: 'doc-b' }]);
  assert.deepEqual(missing, ['doc-a', 'doc-c'], 'doc-b matches through its agile:case: spelling');
  assert.deepEqual(missingMapDocuments(listed, [{ document: 'doc-a' }, { document: 'doc-b' }, { document: 'doc-c' }]), []);
});

test('a partly read PLM prints an at-least closed count and ends on the unread statuses with their next action', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gold-scan-partial-plm-'));
  try {
    for (const sub of ['fixed', 'cases', 'docs']) mkdirSync(join(dir, sub));
    writeFileSync(join(dir, 'cases/doc-a.json'), JSON.stringify(map));
    // One folder names both bugs, so both builds trace the case.
    const treeBoth = [{ id: 'folder', label: '缺陷 910001、910002', cases: [], children: [{ id: 'doc-a', label: '合成文档', children: [] }] }];
    writeFileSync(join(dir, 'tree.json'), JSON.stringify(treeBoth));
    // PLM covers only build #1's defect: build #2's traced defect stays status-unknown, and nothing is closed.
    writeFileSync(join(dir, 'plm.json'), JSON.stringify({ bugs: [{ id: '910001', status: 'open' }] }));
    writeFileSync(join(dir, 'fixed/Bugs_Fixed_with_Synthetic_10_7_A.html'), html('910001'));
    writeFileSync(join(dir, 'fixed/Bugs_Fixed_with_Synthetic_10_7_B.html'), html('910002'));
    writeFileSync(join(dir, 'docs/Synthetic_10_7_A.json'), JSON.stringify(['doc-a']));
    writeFileSync(join(dir, 'docs/Synthetic_10_7_B.json'), JSON.stringify(['doc-a']));
    const run = spawnSync(process.execPath, ['scripts/real/gold/trace-scan.ts', '--fixed-dir', join(dir, 'fixed'), '--cases-dir', join(dir, 'cases'), '--tree', join(dir, 'tree.json'), '--docs-dir', join(dir, 'docs'), '--plm', join(dir, 'plm.json'), '--out', join(dir, 'out.json')], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /#2：缺陷 1；已追溯 1；已关闭 ≥0（1 个状态未读），其中已追溯 0；状态未知 1/);
    assert.match(run.stdout, /#2 有 1 个已追溯缺陷状态未读：对 #2 开追溯运行，导出 plm:bugs: 原件后加 --plm 重扫/);
    assert.ok(!run.stdout.includes('没有找到已追溯的已关闭缺陷'), 'the absence line names the unread statuses instead');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without --plm and nothing traced the scan says so instead of recommending #1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gold-scan-notraced-'));
  try {
    for (const sub of ['fixed', 'cases']) mkdirSync(join(dir, sub));
    writeFileSync(join(dir, 'tree.json'), JSON.stringify(tree));
    // No mindmaps at all: every defect is untraced.
    writeFileSync(join(dir, 'fixed/Bugs_Fixed_with_Synthetic_10_7_D.html'), html('910001'));
    const run = spawnSync(process.execPath, ['scripts/real/gold/trace-scan.ts', '--fixed-dir', join(dir, 'fixed'), '--cases-dir', join(dir, 'cases'), '--tree', join(dir, 'tree.json'), '--out', join(dir, 'out.json')], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /没有已追溯的缺陷/);
    assert.doesNotMatch(run.stdout, /建议 #1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('failures name their stage and index, never a path, build name or map content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gold-scan-stages-'));
  try {
    for (const sub of ['fixed', 'cases', 'docs']) mkdirSync(join(dir, sub));
    writeFileSync(join(dir, 'tree.json'), JSON.stringify(tree));
    writeFileSync(join(dir, 'fixed/Bugs_Fixed_with_Synthetic_10_7_A.html'), html('910001'));
    const base = ['scripts/real/gold/trace-scan.ts', '--fixed-dir', join(dir, 'fixed'), '--tree', join(dir, 'tree.json'), '--out', join(dir, 'out.json')];
    // A per-build docs list that does not exist names the build's scan index, not the path.
    const noList = spawnSync(process.execPath, [...base, '--cases-dir', join(dir, 'cases'), '--docs-dir', join(dir, 'docs')], { encoding: 'utf8' });
    assert.equal(noList.status, 1);
    assert.match(noList.stderr, /#1 的文档清单不存在：先导出这个构建的文档清单/);
    assert.doesNotMatch(noList.stderr, /Synthetic|docs|91000/);
    // A malformed mindmap names its ordinal, never the JSON content.
    writeFileSync(join(dir, 'cases/broken.json'), '{合成标题');
    const badMap = spawnSync(process.execPath, [...base.slice(0, 2), ...base.slice(2), '--cases-dir', join(dir, 'cases')].filter((_, i, a) => a.indexOf('--out') !== i), { encoding: 'utf8' });
    const badMapRun = spawnSync(process.execPath, ['scripts/real/gold/trace-scan.ts', '--fixed-dir', join(dir, 'fixed'), '--cases-dir', join(dir, 'cases'), '--tree', join(dir, 'tree.json'), '--out', join(dir, 'out.json')], { encoding: 'utf8' });
    assert.equal(badMapRun.status, 1);
    assert.match(badMapRun.stderr, /第 1 份脑图不是 JSON：重新导出脑图/);
    assert.doesNotMatch(badMapRun.stderr, /合成标题|broken\.json/);
    writeFileSync(join(dir, 'cases/broken.json'), JSON.stringify(map));
    // A closed-statuses file that is not JSON is named by stage.
    writeFileSync(join(dir, 'closed.txt'), 'not json');
    const badClosed = spawnSync(process.execPath, ['scripts/real/gold/trace-scan.ts', '--fixed-dir', join(dir, 'fixed'), '--cases-dir', join(dir, 'cases'), '--tree', join(dir, 'tree.json'), '--closed-statuses', join(dir, 'closed.txt'), '--out', join(dir, 'out.json')], { encoding: 'utf8' });
    assert.equal(badClosed.status, 1);
    assert.match(badClosed.stderr, /关闭状态表不是 JSON：检查导出的关闭状态表/);
    assert.doesNotMatch(badClosed.stderr, /closed\.txt|not json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
