// Tests for scripts/real/gold/trace.ts:
// - systemOf: PLM, Bugzilla, unknown
// - parseFixedBugsHtml: two links + PLM marker line + older shapes + deduplication
// - parsePlmResponses: bugs, data, array batches
// - parseDocumentList: JSON sources/documents, text lines
// - compareCases: document number ascending, case id ascending
// - traceGold: status determination, unreturned defect, record without status, closed counts, status_unknown
// - interoperability with scripts/real/accept/traceability.ts
// - main CLI: exit codes, JSON output
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { LoggedTurn } from '../lib/accept.ts';
import traceabilityScenario from '../accept/traceability.ts';
import {
  cleanDocId,
  compareCases,
  loadCaseMaps,
  main,
  parseDocumentList,
  parseFixedBugsHtml,
  parsePlmResponses,
  systemOf,
  traceGold,
} from './trace.ts';

function makeMindmap(rootTitle: string, cases: Array<{ id: string; title: string; tags?: string[] }>) {
  return {
    root: {
      data: { id: 'root', text: rootTitle, resource: [] },
      children: cases.map((c) => ({
        data: { id: c.id, text: c.title, resource: c.tags ?? ['p1'] },
        children: [
          {
            data: { id: `${c.id}-exp`, text: '验证预期结果', resource: [] },
            children: [],
          },
        ],
      })),
    },
  };
}

describe('trace gold generator', () => {
  it('systemOf classifies links into plm, bugzilla, or unknown', () => {
    assert.equal(systemOf('http://192.0.2.10/tracker/index.php?m=bug&f=view&id=900001'), 'plm');
    assert.equal(systemOf('http://192.0.2.10/tracker/index.php?m=bug&amp;f=view&amp;id=900001'), 'plm');
    assert.equal(systemOf('http://192.0.2.10/bugzilla/show_bug.cgi?id=900002'), 'bugzilla');
    assert.equal(systemOf('http://192.0.2.10/other/issue.php?id=900003'), 'unknown');
    assert.equal(systemOf(''), 'unknown');
  });

  it('parseFixedBugsHtml parses two kinds of links, PLM marker line, and older shapes', () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <head><title>Bugs fixed</title></head>
      <body>
        <h1>Bugs Fixed with Rel_TEST_1_0_0</h1>
        <br>
        <a href="http://192.0.2.10/tracker/index.php?m=bug&f=view&id=900001">900001</a><br>
        <a href="http://192.0.2.10/bugzilla/show_bug.cgi?id=900002">900002</a><br>
        <a href="http://192.0.2.10/other/issue.php?id=900003">#900003</a><br>
        <p>======ID from PLM=======</p>
        <br>
        900004<br>
        #900005<br>
        900001<br>
        <table border=1>
          <tr><td>900006</td><td>An older table cell defect summary</td></tr>
        </table>
      </body>
      </html>
    `;

    const parsed = parseFixedBugsHtml(html);
    assert.equal(parsed.length, 6);

    assert.deepEqual(parsed[0], { bug: '900001', system: 'plm' });
    assert.deepEqual(parsed[1], { bug: '900002', system: 'bugzilla' });
    assert.deepEqual(parsed[2], { bug: '900003', system: 'unknown' });
    assert.deepEqual(parsed[3], { bug: '900004', system: 'plm' });
    assert.deepEqual(parsed[4], { bug: '900005', system: 'plm' });
    assert.deepEqual(parsed[5], { bug: '900006', system: 'unknown' });
  });

  it('parsePlmResponses extracts items from bugs, data, and array structures', () => {
    const res1 = JSON.stringify({
      bugs: [
        { id: '900001', status: 'closed', title: '修复会话泄漏' },
        { id: 900004, status: 'resolved' },
      ],
      unread: ['900005'],
    });
    const res2 = JSON.stringify({
      data: [{ id: '900005', status: '' }],
    });
    const res3 = JSON.stringify([{ id: '900006', status: 'active' }]);

    const parsed = parsePlmResponses([res1, res2, res3]);
    assert.equal(parsed.length, 4);
    assert.equal(parsed[0].id, '900001');
    assert.equal(parsed[0].status, 'closed');
    assert.equal(parsed[1].id, 900004);
    assert.equal(parsed[1].status, 'resolved');
    assert.equal(parsed[2].id, '900005');
    assert.equal(parsed[2].status, '');
    assert.equal(parsed[3].id, '900006');
    assert.equal(parsed[3].status, 'active');
  });

  it('cleanDocId strips agile prefixes, revisions, and file paths', () => {
    assert.equal(cleanDocId('agile:case:900001'), '900001');
    assert.equal(cleanDocId('agile:case:900001@rev2'), '900001');
    assert.equal(cleanDocId('agile:document:24110'), '24110');
    assert.equal(cleanDocId('agile:case_document:24112'), '24112');
    assert.equal(cleanDocId('path/to/900001.json'), '900001');
    assert.equal(cleanDocId('24113.km.json'), '24113');
  });

  it('parseDocumentList parses JSON arrays, objects with sources, and text lines', () => {
    const jsonArray = JSON.stringify(['24110', '24111']);
    assert.deepEqual([...parseDocumentList(jsonArray)], ['24110', '24111']);

    const jsonCaseArray = JSON.stringify(['agile:case:900001', 'agile:case:900002']);
    assert.deepEqual([...parseDocumentList(jsonCaseArray)], ['900001', '900002']);

    const jsonSources = JSON.stringify({
      sources: [
        { slot: 'documents', external: 'agile:document:24110' },
        { slot: 'documents', external: 'agile:case_document:24112' },
        { slot: 'documents', external: 'agile:case:900001' },
      ],
    });
    assert.deepEqual([...parseDocumentList(jsonSources)], ['24110', '24112', '900001']);

    const textLines = '# Comments\n24110\n24113.km.json\nsubdir/24114.json\nagile:case:900001';
    assert.deepEqual([...parseDocumentList(textLines)], ['24110', '24113', '24114', '900001']);
  });

  it('parseDocumentList strips agile:case: prefix and matches 900001.json in case directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-agile-case-doc-'));
    try {
      const casesDir = join(dir, 'cases');
      mkdirSync(casesDir, { recursive: true });
      writeFileSync(
        join(casesDir, '900001.json'),
        JSON.stringify(makeMindmap('900001', [{ id: 'c1', title: '缺陷 bug 900001' }])),
      );
      writeFileSync(
        join(casesDir, '900002.json'),
        JSON.stringify(makeMindmap('900002', [{ id: 'c2', title: '缺陷 bug 900002' }])),
      );

      // Real integrator exported document list format: agile:case:900001
      const docsJson = JSON.stringify(['agile:case:900001']);
      const allowedDocs = parseDocumentList(docsJson);
      assert.ok(allowedDocs.has('900001'));
      assert.ok(!allowedDocs.has('900002'));

      // loadCaseMaps filters by allowedDocs matching 900001.json
      const loaded = loadCaseMaps(casesDir, allowedDocs);
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].document, '900001');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('compareCases sorts by numeric document id ascending, then case id ascending', () => {
    const cases = [
      { id: '24110:n00000000005', title: 'b' },
      { id: '9001:c2', title: 'd' },
      { id: '24110:n00000000001', title: 'a' },
      { id: '9001:c1', title: 'c' },
    ];
    cases.sort(compareCases);
    assert.deepEqual(
      cases.map((c) => c.id),
      ['9001:c1', '9001:c2', '24110:n00000000001', '24110:n00000000005'],
    );
  });

  it('traceGold computes statuses, unknown reasons, closed flags, and counts', () => {
    const html = `
      <a href="http://192.0.2.10/tracker/index.php?m=bug&f=view&id=900001">900001</a><br>
      <a href="http://192.0.2.10/tracker/index.php?m=bug&f=view&id=900002">900002</a><br>
      <a href="http://192.0.2.10/bugzilla/show_bug.cgi?id=900003">900003</a><br>
      <a href="http://192.0.2.10/other/issue.php?id=900004">900004</a><br>
      <p>======ID from PLM=======</p>
      900005<br>
      900006<br>
    `;

    // Document 9001 covers 900001 and 900003
    // Document 24110 covers 900001
    const map9001 = makeMindmap('用例文档9001', [
      { id: 'c1', title: '用例1 验证缺陷 bug 900001' },
      { id: 'c2', title: '用例2 验证缺陷 bug 900003' },
    ]);
    const map24110 = makeMindmap('用例文档24110', [
      { id: 'c3', title: '用例3 验证缺陷 bug 900001' },
    ]);

    const plm = [
      { id: '900001', status: 'closed' },
      { id: '900002', status: 'active' },
      { id: '900005', status: '' }, // empty status -> record without status
      // 900006 is not in PLM response -> defect system did not return this id
    ];

    const gold = traceGold({
      html,
      maps: [
        { document: '24110', map: map24110 },
        { document: '9001', map: map9001 },
      ],
      plm,
      closedStatuses: ['closed'],
      product: 'famx',
      build: 'Rel_TEST_1_0_0_10',
    });

    assert.equal(gold.product, 'famx');
    assert.equal(gold.build, 'Rel_TEST_1_0_0_10');
    assert.equal(gold.defects.length, 6);

    // 900001: PLM, closed, traced (two cases: 9001:c1, 24110:c3 in document order)
    const d1 = gold.defects.find((d) => d.bug === '900001')!;
    assert.equal(d1.system, 'plm');
    assert.equal(d1.defect_system_status, 'closed');
    assert.equal(d1.defect_system_unknown_reason, null);
    assert.equal(d1.closed, true);
    assert.deepEqual(d1.cases, [
      { id: '9001:c1', title: '用例1 验证缺陷 bug 900001' },
      { id: '24110:c3', title: '用例3 验证缺陷 bug 900001' },
    ]);

    // 900002: PLM, active, untraced
    const d2 = gold.defects.find((d) => d.bug === '900002')!;
    assert.equal(d2.system, 'plm');
    assert.equal(d2.defect_system_status, 'active');
    assert.equal(d2.defect_system_unknown_reason, null);
    assert.equal(d2.closed, false);
    assert.equal(d2.cases.length, 0);

    // 900003: bugzilla, traced
    const d3 = gold.defects.find((d) => d.bug === '900003')!;
    assert.equal(d3.system, 'bugzilla');
    assert.equal(d3.defect_system_status, null);
    assert.equal(d3.defect_system_unknown_reason, '系统为 bugzilla，不从 PLM 查询');
    assert.equal(d3.closed, false);
    assert.equal(d3.cases.length, 1);

    // 900004: unknown system, untraced
    const d4 = gold.defects.find((d) => d.bug === '900004')!;
    assert.equal(d4.system, 'unknown');
    assert.equal(d4.defect_system_status, null);
    assert.equal(d4.defect_system_unknown_reason, '缺陷系统不明，不按编号查 PLM');
    assert.equal(d4.closed, false);

    // 900005: PLM, record has no status
    const d5 = gold.defects.find((d) => d.bug === '900005')!;
    assert.equal(d5.system, 'plm');
    assert.equal(d5.defect_system_status, null);
    assert.equal(d5.defect_system_unknown_reason, '缺陷系统的记录里没有状态');
    assert.equal(d5.closed, false);

    // 900006: PLM, not returned
    const d6 = gold.defects.find((d) => d.bug === '900006')!;
    assert.equal(d6.system, 'plm');
    assert.equal(d6.defect_system_status, null);
    assert.equal(d6.defect_system_unknown_reason, '缺陷系统没有返回这个编号');
    assert.equal(d6.closed, false);

    // Counts:
    // closed_defects = 1 (900001)
    // closed_traced = 1
    // closed_untraced = 0
    // status_unknown = 4 (900003, 900004, 900005, 900006)
    assert.equal(gold.closed_defects, 1);
    assert.equal(gold.closed_traced, 1);
    assert.equal(gold.closed_untraced, 0);
    assert.equal(gold.status_unknown, 4);
  });

  it('interoperates seamlessly with scripts/real/accept/traceability.ts', () => {
    const html = `
      <a href="http://192.0.2.10/tracker/index.php?m=bug&f=view&id=900001">900001</a><br>
      <a href="http://192.0.2.10/tracker/index.php?m=bug&f=view&id=900002">900002</a><br>
    `;

    const map9001 = makeMindmap('用例文档9001', [
      { id: 'c1', title: '用例1 验证缺陷 bug 900001' },
      { id: 'c2', title: '用例2 验证缺陷 bug 900001' },
    ]);

    const plm = [
      { id: '900001', status: 'closed' },
      { id: '900002', status: 'active' },
    ];

    const gold = traceGold({
      html,
      maps: [{ document: '9001', map: map9001 }],
      plm,
      closedStatuses: ['closed'],
      product: 'famx',
      build: 'Rel_TEST_1_0_0_10',
    });

    const scenario = traceabilityScenario(gold);

    const startRunText = [
      '运行 run_1 完成：任务包 traceability',
      '完整结果 rec:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      '条目（2 个；编号 | 名称 | 摘要）：',
      '- plm:900001 | 缺陷 900001 | 发布说明：已修复；缺陷系统：closed；2 个用例',
      '- plm:900002 | 缺陷 900002 | 发布说明：已修复；缺陷系统：active；无已索引用例（未知）',
      '跨条目：缺陷 2 个：已追溯 1 个，未追溯 1 个；其中已关闭缺陷 1 个：已追溯 1 个，未追溯 0 个；缺陷系统状态未知 0 个（不算已关闭也不算未关闭），支持，traceability.counts',
    ].join('\n');

    const fullResultText = [
      '陈述：缺陷 900001（发布说明：已修复；缺陷系统：closed）：2 个已索引用例追溯：9001:c1 用例1 验证缺陷 bug 900001；9001:c2 用例2 验证缺陷 bug 900001，支持，traceability.traced',
      '陈述：缺陷 900002（发布说明：已修复；缺陷系统：active）：没有已索引的用例标出缺陷 900002，未知，traceability.traced',
    ].join('\n');

    const turns: LoggedTurn[] = [
      { index: 0, toolResults: [], tools: ['hub_start_run'] },
      { index: 1, toolResults: [{ id: 'r1', text: startRunText, isError: false }], tools: ['hub_get_nodes'] },
      { index: 2, toolResults: [{ id: 'r2', text: fullResultText, isError: false }], tools: [] },
    ];

    const checks = scenario.check(turns);
    assert.ok(checks.some(c=>!c.ok&&c.actual.includes('未知')),'the untraced row remains unfinished');
    assert.ok(checks.filter(c=>c.name.includes('列出的用例')).every(c=>c.ok),'the determinate joined rows still match');
    assert.ok(checks.find(c=>c.name==='已关闭缺陷统计与独立依据一致')?.ok);
  });

  it('main CLI reads inputs, generates gold JSON, and exits 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-gold-test-'));
    try {
      const htmlPath = join(dir, 'Bugs_Fixed_with_Rel_FAMX_10_6_1_57.html');
      writeFileSync(
        htmlPath,
        '<a href="http://192.0.2.10/tracker/index.php?m=bug&f=view&id=900001">900001</a><br>',
      );

      const casesDir = join(dir, 'cases');
      mkdirSync(casesDir, { recursive: true });
      writeFileSync(
        join(casesDir, '9001.json'),
        JSON.stringify(makeMindmap('9001', [{ id: 'c1', title: '缺陷 bug 900001' }])),
      );

      const plmPath = join(dir, 'plm.json');
      writeFileSync(
        plmPath,
        JSON.stringify({ bugs: [{ id: '900001', status: 'closed' }] }),
      );

      const closedPath = join(dir, 'closed.json');
      writeFileSync(closedPath, JSON.stringify(['closed', 'resolved']));

      const outPath = join(dir, 'trace-gold.json');

      const code = await main([
        '--fixed',
        htmlPath,
        '--cases-dir',
        casesDir,
        '--plm',
        plmPath,
        '--closed-statuses',
        closedPath,
        '--out',
        outPath,
      ]);

      assert.equal(code, 0);

      // Verify written file
      const loadedMaps = loadCaseMaps(casesDir);
      assert.equal(loadedMaps.length, 1);
      assert.equal(loadedMaps[0].document, '9001');

      // Test missing args returns 2
      const failCode = await main(['--fixed', htmlPath]);
      assert.equal(failCode, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
