// Synthetic tests of accept/defect-to-case-compare.ts: the head-overlap ratios, the verbatim report read from the
// Hub's claims (never recomputed), and the duplicate-set comparison in both directions and the equal case.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { computeComparison, draftsOf, main, renderComparison, outsideGit, writePrivateJson, comparisonDetails, evidenceQuestions } from './defect-to-case-compare.ts';

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
    assert.match(renderComparison(comparison), /支持 2 条/);
  });

  test('a refute claim is reported with its verdict and text', () => {
    const comparison = computeComparison(docGold, submissionOf(draft('a', 'show health')), resultWith([refuteQuoteClaim]));
    assert.equal(comparison.quotes.allVerbatim, false);
    assert.equal(comparison.quotes.problems.length, 1);
    assert.match(renderComparison(comparison), /引文问题 1 条/);
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
    assert.match(text, /未识别文档行 2/);
  });

  const syntheticXml = `<?xml version="1.0" encoding="ISO-8859-1"?>
<commands>
  <scope type="global">
    <menu name="demo">
      <item name="pool">
        <arguments>
          <arg name="name" type="STRING"/>
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
    assert.match(text, /未识别草稿行 1/);
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
      assert.equal(code, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('rendered output contains no synthetic title, command or quotation', () => {
  const comparison = computeComparison(docGold, submissionOf(draft('SYNTHETIC_TITLE', 'widget health interval pool1 5', 'SYNTHETIC_QUOTE')), resultWith([refuteQuoteClaim], [dupClaim('SYNTHETIC_TITLE')]));
  const text = renderComparison(comparison);
  for (const secret of ['SYNTHETIC_TITLE', 'widget health interval', 'SYNTHETIC_QUOTE', refuteQuoteClaim.statement.text]) assert.ok(!text.includes(secret));
});

test('parameter combinations have all three categories and reverse coverage',()=>{
  const commands='<commands><menu name="widget"><item name="health interval"><arguments><arg name="name" type="STRING"/><arg name="n" type="U16"/></arguments></item><item name="new"><arguments/></item></menu></commands>';
  const report=computeComparison(docGold,submissionOf(draft('a','widget health interval pool1 5'),draft('b','widget health interval pool1 6'),draft('c','widget new')),resultWith([]),{commandTreeXml:commands});
  assert.deepEqual([report.parameters!.same,report.parameters!.different,report.parameters!.absent],[1,1,1]);
  assert.equal(report.parameters!.docRatio,1/3);
});

test('details are positional and private destinations cannot be in this worktree or its Git directory',()=>{
  assert.throws(()=>outsideGit(join(import.meta.dirname,'forbidden-details.json')));
  const detail=comparisonDetails(computeComparison(docGold,submissionOf(draft('PRIVATE_TITLE','widget health interval pool1 5')),resultWith([refuteQuoteClaim])));
  assert.ok(!JSON.stringify(detail).includes('PRIVATE_TITLE'));
});
test('private details are written only as positions and categories with restrictive permissions',()=>{
  const dir=mkdtempSync(join(tmpdir(),'d2c-private-details-'));
  try{
    const comparison=computeComparison(docGold,submissionOf(draft('PRIVATE_TITLE','widget health interval pool1 5')),resultWith([refuteQuoteClaim]));
    const path=join(dir,'details.json');writePrivateJson(path,comparisonDetails(comparison));
    assert.ok(!readFileSync(path,'utf8').includes('PRIVATE_TITLE'));
    assert.equal(statSync(path).mode&0o777,0o600);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('CLI exit codes follow known command disagreements and successful comparisons',t=>{
  const dir=mkdtempSync(join(tmpdir(),'d2c-exit-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  t.mock.method(process.stdout,'write',()=>true);
  const manual=Buffer.from('SYNTHETIC_EXPECTATION');
  const digest=createHash('sha256').update(manual).digest('hex');
  const files={gold:docGold,result:{partitions:{delivered:[{item:'74001',requirements:[{requirement:'commands',status:'satisfied'},{requirement:'grounded',status:'satisfied'}]}]}},run:{sources:[]}};
  for(const [name,value] of Object.entries(files))writeFileSync(join(dir,name),JSON.stringify(value));
  writeFileSync(join(dir,'manual'),manual);writeFileSync(join(dir,'commands'),'<commands><menu name="widget"><item name="set"><arguments><arg name="" type="U16"/></arguments></item></menu></commands>');
  for(const [value,expected] of [['5',0],['99999',1]] as const){
    writeFileSync(join(dir,'drafts'),JSON.stringify(submissionOf({steps:[{command:`widget set ${value}`}],expected:[{text:manual.toString(),quote:{text:manual.toString(),reference:`src:${digest}`}}]})));
    const args=['gold','drafts','result','commands','manual','run'].flatMap(name=>['--'+name,join(dir,name)]);
    assert.equal(main(args),expected);
  }
});
test('CLI diagnostics identify input flags and digest failures without exposing paths or bytes',t=>{
  const dir=mkdtempSync(join(tmpdir(),'d2c-diagnostic-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let errors='';t.mock.method(process.stderr,'write',(value:any)=>{errors+=String(value);return true;});t.mock.method(process.stdout,'write',()=>true);
  const args=['--gold',join(dir,'PRIVATE_ABSENT'),'--drafts',join(dir,'drafts'),'--result',join(dir,'result')];
  assert.equal(main(args),2);assert.match(errors,/--gold/);assert.doesNotMatch(errors,/PRIVATE_ABSENT/);
  writeFileSync(args[1],JSON.stringify(docGold));writeFileSync(args[3],JSON.stringify(submissionOf(draft('PRIVATE_TITLE','widget set 5'))));writeFileSync(args[5],JSON.stringify(resultWith([])));
  const sourceDir=join(dir,'sources');mkdirSync(sourceDir);writeFileSync(join(sourceDir,'a'.repeat(64)),'PRIVATE_TAMPERED_BYTES');errors='';
  assert.equal(main([...args,'--sources',sourceDir]),2);assert.match(errors,/source integrity mismatch.*--sources.*1/);assert.doesNotMatch(errors,/PRIVATE/);
});

test('follow-up reasons distinguish absent inputs from unsupported rules',()=>{
  const missing=evidenceQuestions(computeComparison(docGold,submissionOf(draft('private','widget set 5')),resultWith([])));
  assert.equal(missing.find(q=>q.missing_fact==='build_command_tree_original')?.reason,'missing_input');
  const unsupported=evidenceQuestions(computeComparison(docGold,submissionOf(draft('private','widget set 5')),resultWith([]),{commandTreeXml:'<commands><menu name="widget"><item name="set"><arguments><arg name="" type="DEPLOYMENT"/></arguments></item></menu></commands>'}));
  assert.equal(unsupported.find(q=>q.missing_fact==='declared_argument_type_rule')?.reason,'no_check');
  assert.ok(!unsupported.some(q=>q.next_action.includes('replay_submission')));
});

test('comparison delegates hard wrapped quotations to the independent decision 37 oracle', () => {
  const bytes = Buffer.from('返回\n成功 set 10 0'), digest = createHash('sha256').update(bytes).digest('hex');
  const quoted = { ...draft('synthetic', 'show health'), expected: [{ text: '返回成功', quote: { reference: `src:${digest}/text@1/l/1-2`, text: '返回成功' } }] };
  const options = { sources: new Map([[digest, bytes]]), run: { sources: [] } };
  const report = computeComparison(docGold, submissionOf(quoted), {}, options).quoteOracle;
  assert.equal(report.counts.support, 1); assert.equal(report.expectedVerbatim, 1);
  quoted.expected[0].quote.text = 'set 100';
  assert.equal(computeComparison(docGold, submissionOf(quoted), {}, options).quoteOracle.counts.refute, 1);
});
