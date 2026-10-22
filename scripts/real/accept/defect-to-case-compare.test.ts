// Synthetic tests of accept/defect-to-case-compare.ts: the head-overlap ratios, the verbatim report read from the
// Hub's claims (never recomputed), and the duplicate-set comparison in both directions and the equal case.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { computeComparison, draftsOf, main, renderComparison } from './defect-to-case-compare.ts';

const docGold = {
  document: '24110',
  defects: ['160001'],
  cases: [
    { id: 'case-1', title: 'widget health interval pool1 5', commands: [{ head: 'widget health interval', parameters: ['pool1', '5'] }] },
    { id: 'case-2', title: 'show health detail pool1', commands: [{ head: 'show health detail', parameters: ['pool1'] }] },
    { id: 'case-3', title: 'show pools', commands: [{ head: 'show pools', parameters: [] }] },
  ],
};

const draft = (title: string, command: string, expected = '设置成功') => ({
  title,
  steps: [{ text: `执行 ${command}`, command }],
  expected: [{ text: expected }],
});

const submissionOf = (...drafts: unknown[]) => ({ run: 'run_x', items: [{ item: '74001', handling: 'handled', slots: { cases: drafts.map((d) => ({ text: (d as { title: string }).title, data: d })) } }] });

const resultWith = (groundedClaims: unknown[], duplicateClaims: unknown[] = []) => ({
  schema: 'validation@1',
  partitions: {
    satisfied: [
      {
        requirements: [
          { requirement: 'grounded', claims: groundedClaims },
          { requirement: 'not_duplicate', claims: duplicateClaims },
        ],
      },
    ],
  },
});

const supportClaim = { statement: { text: '所有期望结果均具有对应引文依据，未引入无原文依据的数字、命令或开关状态', verdict: 'support' } };
const refuteQuoteClaim = { statement: { text: '第 1 个起草用例第 1 个期望结果文字中包含数字“60”，但所附引文中未包含此数字', code: 'defect-to-case.unsupported_entity', verdict: 'refute' } };
const dupClaim = (title: string) => ({ statement: { text: `起草用例“${title}”与已索引用例重复：文档 24110 节点 case-1“widget health interval pool1 5”（tree:ref）`, code: 'defect-to-case.duplicate_case', verdict: 'refute' } });

describe('draftsOf and the head overlap (report only, no verdict)', () => {
  test('drafts come from items[].slots.cases[].data', () => {
    const drafts = draftsOf(submissionOf(draft('配置健康检查间隔', 'widget health interval pool1 5')));
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].steps[0].command, 'widget health interval pool1 5');
  });

  test('the shared heads and both ratios', () => {
    const submission = submissionOf(draft('配置健康检查间隔', 'widget health interval pool1 5'), draft('添加一个池', 'widget pool add pool2 50'));
    const comparison = computeComparison(docGold, submission, resultWith([supportClaim]));
    const h = comparison.headOverlap;
    assert.deepEqual([h.draftHeads, h.docHeads, h.shared], [2, 3, 1]);
    assert.equal(h.draftRatio, 1 / 2);
    assert.equal(h.docRatio, 1 / 3);
    assert.deepEqual(h.missingInDoc, ['widget pool add']);
    assert.deepEqual(h.missingInDrafts, ['show health detail', 'show pools']);
    const text = renderComparison(comparison);
    assert.match(text, /50\.0%/);
    assert.match(text, /33\.3%/);
    assert.match(text, /只报告，不判通过/);
  });
});

describe('the verbatim report reads the Hub’s claims, never re-judged', () => {
  test('all support: every quotation judged verbatim', () => {
    const comparison = computeComparison(docGold, submissionOf(draft('a', 'show health')), resultWith([supportClaim, supportClaim]));
    assert.equal(comparison.quotes.allVerbatim, true);
    assert.equal(comparison.quotes.support, 2);
    assert.match(renderComparison(comparison), /每条期望结果的引用都已被 Hub 判为逐字/);
  });

  test('a refute claim is reported with its verdict and text', () => {
    const comparison = computeComparison(docGold, submissionOf(draft('a', 'show health')), resultWith([refuteQuoteClaim]));
    assert.equal(comparison.quotes.allVerbatim, false);
    assert.equal(comparison.quotes.problems.length, 1);
    assert.match(renderComparison(comparison), /refute：第 1 个起草用例第 1 个期望结果/);
  });

  test('no grounded claim at all is not "all verbatim"', () => {
    const comparison = computeComparison(docGold, submissionOf(draft('a', 'show health')), resultWith([]));
    assert.equal(comparison.quotes.allVerbatim, false);
    assert.equal(comparison.quotes.claims, 0);
  });
});

describe('the duplicate sets: exact identity against the Hub’s flagged set', () => {
  test('equal when gold and the Hub flag the same draft', () => {
    const submission = submissionOf(draft('完全不同的标题', 'widget health interval pool1 5'));
    const comparison = computeComparison(docGold, submission, resultWith([supportClaim], [dupClaim('完全不同的标题')]));
    assert.deepEqual(comparison.duplicates.goldIdentical, ['完全不同的标题']);
    assert.deepEqual(comparison.duplicates.hubFlagged, ['完全不同的标题']);
    assert.equal(comparison.duplicates.equal, true);
  });

  test('gold only: identical commands but the Hub’s rule did not flag (different title and no shared expected)', () => {
    const submission = submissionOf(draft('另一个标题', 'widget health interval pool1 5', '没有共享的期望'));
    const comparison = computeComparison(docGold, submission, resultWith([supportClaim]));
    assert.deepEqual(comparison.duplicates.goldIdentical, ['另一个标题']);
    assert.deepEqual(comparison.duplicates.hubFlagged, []);
    assert.deepEqual(comparison.duplicates.onlyGold, ['另一个标题']);
    assert.equal(comparison.duplicates.equal, false);
  });

  test('Hub only: flagged but not identical (parameter values differ)', () => {
    const submission = submissionOf(draft('参数不一样的草稿', 'widget health interval pool1 60'));
    const comparison = computeComparison(docGold, submission, resultWith([supportClaim], [dupClaim('参数不一样的草稿')]));
    assert.deepEqual(comparison.duplicates.goldIdentical, []);
    assert.deepEqual(comparison.duplicates.hubFlagged, ['参数不一样的草稿']);
    assert.deepEqual(comparison.duplicates.onlyHub, ['参数不一样的草稿']);
    assert.equal(comparison.duplicates.equal, false);
  });

  test('whitespace and quotes do not break identity', () => {
    const submission = submissionOf(draft('形式不同', 'widget  health  interval  pool1  5'));
    const comparison = computeComparison(docGold, submission, resultWith([supportClaim], [dupClaim('形式不同')]));
    assert.equal(comparison.duplicates.equal, true);
  });

  test('catalog-matched gold with group labels: head overlap ignores group labels and reports unrecognized command lines', () => {
    const catalogDocGold = {
      document: '24112',
      defects: ['160003'],
      cases: [
        {
          id: 'case-1',
          title: 'widget health interval pool1 5',
          commands: [{ head: 'widget health interval', parameters: ['pool1', '5'] }],
          unrecognizedCommands: ['function', 'stress'],
        },
      ],
      unrecognizedCommands: ['function', 'stress'],
    };
    const submission = submissionOf(draft('配置健康检查间隔', 'widget health interval pool1 5'));
    const comparison = computeComparison(catalogDocGold, submission, resultWith([supportClaim]));
    const h = comparison.headOverlap;
    assert.deepEqual([h.draftHeads, h.docHeads, h.shared], [1, 1, 1]);
    assert.equal(h.draftRatio, 1);
    assert.equal(h.docRatio, 1);
    assert.deepEqual(h.unrecognizedInDoc, ['function', 'stress']);
    const text = renderComparison(comparison);
    assert.match(text, /已有文档未识别的命令行：function、stress/);
  });

  const syntheticXml = `<?xml version="1.0" encoding="ISO-8859-1"?>
<commands>
  <scope type="global">
    <menu name="demo">
      <item name="pool">
        <arguments>
          <string name="name"/>
        </arguments>
      </item>
    </menu>
    <menu name="widget">
      <menu name="health">
        <item name="interval"/>
      </menu>
    </menu>
  </scope>
</commands>`;

  test('draft with lower-case non-numeric parameter (demo pool cfg): split by catalog gives head demo pool and parameter cfg', () => {
    const docWithDemo = {
      document: '24115',
      defects: ['160005'],
      cases: [
        {
          id: 'case-demo',
          title: 'demo pool cfg',
          commands: [{ head: 'demo pool', parameters: ['cfg'] }],
        },
      ],
    };
    const submission = submissionOf(draft('配置演示池', 'demo pool cfg'));

    // Without catalog (heuristic): "demo pool cfg" is treated as head, parameter is empty -> head mismatch and not identical
    const withoutCatalog = computeComparison(docWithDemo, submission, resultWith([supportClaim]));
    assert.deepEqual(withoutCatalog.headOverlap.missingInDoc, ['demo pool cfg']);
    assert.deepEqual(withoutCatalog.headOverlap.missingInDrafts, ['demo pool']);
    assert.equal(withoutCatalog.headOverlap.shared, 0);
    assert.deepEqual(withoutCatalog.duplicates.goldIdentical, []);

    // With catalog: longest match gives head "demo pool" and parameter "cfg" -> heads match and case is duplicate
    const withCatalog = computeComparison(
      docWithDemo,
      submission,
      resultWith([supportClaim], [dupClaim('配置演示池')]),
      { commandTreeXml: syntheticXml },
    );
    const h = withCatalog.headOverlap;
    assert.deepEqual([h.draftHeads, h.docHeads, h.shared], [1, 1, 1]);
    assert.equal(h.draftRatio, 1);
    assert.equal(h.docRatio, 1);
    assert.deepEqual(h.missingInDoc, []);
    assert.deepEqual(h.missingInDrafts, []);
    assert.deepEqual(withCatalog.duplicates.goldIdentical, ['配置演示池']);
    assert.equal(withCatalog.duplicates.equal, true);
  });

  test('draft with command not in catalog: isolated as unrecognizedInDrafts and excluded from draftHeads', () => {
    const docWithWidget = {
      document: '24116',
      defects: ['160006'],
      cases: [
        {
          id: 'case-widget',
          title: 'widget health interval pool1 5',
          commands: [{ head: 'widget health interval', parameters: ['pool1', '5'] }],
        },
      ],
    };
    const submission = submissionOf(
      draft('健康检查', 'widget health interval pool1 5'),
      draft('未知指令草稿', 'custom_tool action 123'),
    );
    const comparison = computeComparison(
      docWithWidget,
      submission,
      resultWith([supportClaim]),
      { commandTreeXml: syntheticXml },
    );
    const h = comparison.headOverlap;
    // Only "widget health interval" is counted as a draft head; "custom_tool action 123" is isolated
    assert.equal(h.draftHeads, 1);
    assert.deepEqual(h.unrecognizedInDrafts, ['custom_tool action 123']);
    const text = renderComparison(comparison);
    assert.match(text, /草稿里目录找不到的命令行：custom_tool action 123/);
  });

  test('main CLI accepts --commands and outputs comparison with catalog split', () => {
    const dir = mkdtempSync(join(tmpdir(), 'd2c-compare-test-'));
    try {
      const goldFile = join(dir, 'gold.json');
      const draftsFile = join(dir, 'drafts.json');
      const resultFile = join(dir, 'result.json');
      const commandsFile = join(dir, 'commands.xml');

      writeFileSync(goldFile, JSON.stringify(docGold), 'utf8');
      writeFileSync(draftsFile, JSON.stringify(submissionOf(draft('配置健康检查间隔', 'widget health interval pool1 5'))), 'utf8');
      writeFileSync(resultFile, JSON.stringify(resultWith([supportClaim])), 'utf8');
      writeFileSync(commandsFile, syntheticXml, 'utf8');

      const code = main(['--gold', goldFile, '--drafts', draftsFile, '--result', resultFile, '--commands', commandsFile]);
      assert.equal(code, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
