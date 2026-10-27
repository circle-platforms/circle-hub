import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { judgeQuote, quoteMatches, sha256, quotesReport } from './quotes.ts';
const vectors=JSON.parse(readFileSync(new URL('../../../hub/rules/quote-vectors.json',import.meta.url),'utf8')).vectors as {fragment:string;quote:string;match:boolean}[];
for(const [i,v] of vectors.entries()) test(`shared quotation vector ${i+1}`,()=>assert.equal(quoteMatches(v.fragment,v.quote),v.match));
const bytes=Buffer.from(JSON.stringify({ 'fix/说明': '执行成功 😀', other: '其他字段', numeric: 5 }));
const digest=sha256(bytes), root='b'.repeat(64);
const opts={sources:new Map([[digest,bytes]]),run:{root,sources:[{slot:'defects',reference:`src:${digest}`}]},fixField:'fix/说明'};
test('percent-encoded JSON selector segments and binding classifications are independent',()=>{
  const fix=judgeQuote(`src:${digest}/json@1/p/fix%2F说明`,'执行成功','执行成功',opts);assert.equal(fix.category,'fix'); assert.equal(fix.verdict,'support');
  assert.equal(judgeQuote(`src:${digest}/json@1/p/other`,'其他','其他',opts).category,'defect_other');
  const encoded=Buffer.from('{"space key":"内容"}'), sha=sha256(encoded);
  assert.equal(judgeQuote(`src:${sha}/json@1/p/space%20key`,'内容','内容',{sources:new Map([[sha,encoded]]),run:{sources:[]}}).verdict,'support');
  assert.equal(judgeQuote(`src:${digest}/json@1/p/numeric`,'5','5',opts).verdict,'unknown');
  assert.equal(judgeQuote(`src:${digest}/json@1/p/other`,'其他','其他',{...opts,fixField:undefined}).category,'unknown_defect_field');
  assert.equal(judgeQuote(`src:${digest}/json@1/p/other`,'其他','其他',{...opts,run:{root,sources:[]}}).category,'other');
});
test('line selectors and UTF-8 byte ranges are checked without splitting characters',()=>{
  const b=Buffer.from('first\r\n成功 😀\r\nlast'),sha=sha256(b),o={sources:new Map([[sha,b]]),run:{sources:[]}};
  assert.equal(judgeQuote(`src:${sha}/text@1/l/2`,'成功 😀','改写',o).expectedVerbatim,false);
  assert.equal(judgeQuote(`src:${sha}/text@1/l/1-2`,'first\n成功','first',o).verdict,'support');
  assert.equal(judgeQuote(`src:${sha}/text@1/l/2:0-6`,'成功','成功',o).verdict,'support');
  assert.equal(judgeQuote(`src:${sha}/text@1/l/2:1-6`,'成功','成功',o).verdict,'refute');
  assert.equal(judgeQuote(`src:${sha}/text@1/l/9`,'成功','成功',o).verdict,'refute');
});
test('a bad digest stops instead of becoming a quote verdict',()=>assert.throws(()=>judgeQuote(`src:${digest}`,'x','x',{sources:new Map([[digest,Buffer.from('changed')]]),run:{sources:[]}}),/integrity/));
test('manual roots and Markdown are necessary conditions only; missing manuals and unsupported parsers stay unknown',()=>{
  const manual=Buffer.from('手册正文'),sha=sha256(manual),o={...opts,manual:[manual]};
  assert.equal(judgeQuote(`tree:${root}/commands/widget`,'手册','手册',o).scope,'necessary');
  assert.equal(judgeQuote(`tree:${'c'.repeat(64)}/commands/widget`,'手册','手册',o).category,'other');
  assert.equal(judgeQuote(`tree:${root}/`,'手册','手册',opts).reason,'missing_input');
  assert.equal(judgeQuote(`src:${sha}/markdown@1/h/标题`,'手册','手册',o).scope,'necessary');
  assert.equal(judgeQuote(`src:${sha}/xml@1/x/a`,'手册','手册',o).verdict,'unknown');
  assert.equal(judgeQuote(`rec:${digest}`,'手册','手册',o).reason,'no_check');
});
test('both Hub disagreement directions and paraphrased expectations are counted per item',()=>{
  const submission={items:[{item:'i',slots:{cases:[{data:{expected:[{text:'改写',quote:{text:'执行成功',reference:`src:${digest}/json@1/p/fix%2F说明`}}]}}]}}]};
  const hub=(status:string)=>({partitions:{delivered:[{item:'i',requirements:[{requirement:'grounded',status}]}]}});
  assert.equal(quotesReport(submission,hub('unsatisfied'),opts).items[0].comparison,'different');
  assert.equal(quotesReport(submission,hub('satisfied'),opts).paraphrased,1);
  submission.items[0].slots.cases[0].data.expected[0].quote.text='不存在';
  assert.equal(quotesReport(submission,hub('satisfied'),opts).items[0].comparison,'different');
});
test('a missing locked root is a recoverable missing fact, not a false other-root refutation',()=>{
  const result=judgeQuote(`tree:${root}/commands/widget`,'手册','手册',{manual:[Buffer.from('手册')]});
  assert.equal(result.verdict,'unknown');assert.equal(result.gap?.fact,'locked_run_root');assert.equal(result.gap?.action,'read_run_show');
});

test('JSON selector segments preserve literal tildes and percent-decode slashes without JSON Pointer substitution',()=>{
  const b=Buffer.from(JSON.stringify({'a/b':'slash','a~1b':'literal'})),sha=sha256(b),o={sources:new Map([[sha,b]]),run:{sources:[]}};
  assert.equal(judgeQuote(`src:${sha}/json@1/p/a%2Fb`,'slash','slash',o).verdict,'support');
  assert.equal(judgeQuote(`src:${sha}/json@1/p/a~1b`,'literal','literal',o).verdict,'support');
  assert.equal(judgeQuote(`src:${sha}/json@1/p/a~1b`,'slash','slash',o).verdict,'refute');
});
test('record and entry references have an unresolved target class, not a known other-source class',()=>{
  for(const reference of [`rec:${digest}#/fix`,`entry:${digest}`]){
    const found=judgeQuote(reference,'text','text',opts);
    assert.equal(found.verdict,'unknown');assert.equal(found.category,'unknown_target');assert.equal(found.gap?.fact,'record_or_entry_original_provenance');
  }
});
test('missing original bytes remain a missing-input transition with an export action',()=>{
  const found=judgeQuote(`src:${digest}/json@1/p/fix%2F说明`,'执行成功','执行成功',{...opts,sources:new Map()});
  assert.equal(found.verdict,'unknown');assert.equal(found.reason,'missing_input');assert.equal(found.gap?.action,'export_original_and_retry');
});
test('missing quotes are refutations while missing expected results are shape findings',()=>{
  const submit=(expected:any[])=>({items:[{item:'i',slots:{cases:[{data:{expected}}]}}]});
  const result=quotesReport(submit([{text:'text'}]),{},opts);
  assert.equal(result.counts.refute,1);assert.equal(result.counts.unknown,0);assert.equal(result.details[0].category,'quote_absent');assert.equal(result.details[0].gap,undefined);
  const empty=quotesReport(submit([]),{},opts);
  assert.equal(empty.details.length,0);assert.equal(empty.counts.unknown,0);assert.deepEqual(empty.shapes,[{draft:1,category:'expected_absent'}]);
});
for(const terminator of ['\n','\r\n','\r'])test(`final terminator opens no extra text line ${JSON.stringify(terminator)}`,()=>{
  const bytes=Buffer.from(`alpha${terminator}beta${terminator}`),digest=sha256(bytes),inputs={sources:new Map([[digest,bytes]]),run:{sources:[]}};
  assert.equal(judgeQuote(`src:${digest}/text@1/l/1-2`,'alpha\nbeta','beta',inputs).verdict,'support');
  for(const selector of ['1-3','3'])assert.equal(judgeQuote(`src:${digest}/text@1/l/${selector}`,'alpha\nbeta','beta',inputs).verdict,'refute');
});

test('strict quotation flows through fragment and manual judgments and report counts', () => {
  const bytes = Buffer.from('返回\n成功 set 10 0'), digest = sha256(bytes);
  const inputs = { sources: new Map([[digest, bytes]]), manual: [bytes], run: { root, sources: [] } };
  for (const reference of [`src:${digest}/text@1/l/1-2`, `tree:${root}/manual`]) {
    const finding = judgeQuote(reference, '返回\n成功 set 10 0', '返回\n成功', inputs);
    assert.equal(finding.verdict, 'support');
    assert.equal(finding.expectedVerbatim, true);
    assert.equal(judgeQuote(reference, '返回成功', '返回成功', inputs).verdict, 'refute');
    assert.equal(judgeQuote(reference, 'set 100', 'set 100', inputs).verdict, 'refute');
    const submission = { items: [{ item: 'synthetic', slots: { cases: [{ data: { expected: [{ text: '返回\n成功', quote: { reference, text: '返回\n成功' } }] } }] } }] };
    const report = quotesReport(submission, {}, inputs);
    assert.equal(report.counts.support, 1); assert.equal(report.expectedVerbatim, 1); assert.equal(report.paraphrased, 0);
  }
});

for (const [fragment, quote, match] of [
  ['A\n中文', 'A中文', false], ['中文\tA', '中文A', false], ['Ａ\nB', 'ＡB', false],
  ['𠀀\r\nA', '𠀀A', false], ['🙂\nA', '🙂A', false],
  ['set\t10\n0', 'set 10 0', false], ['set 10 0', 'set 100', false],
  ['a + b', 'a+b', false], ['α β', 'αβ', false], ['ｱ A', 'ｱA', false],
  ['a\u0085b', 'a b', false], ['中\ufeff文', '中文', false], ['中\ufeff文', '\ufeff', true],
  ['A\n中文', 'A\n中文', true], ['中文\tA', '中文\tA', true], ['a\u00a0b', 'a\u00a0b', true], ['a\u3000b', 'a\u3000b', true],
  ['anything', '\u0085\u3000', false], ['🙂', '\ude42', false], ['é', 'e\u0301', false],
] as const) test(`strict literal boundary ${JSON.stringify([fragment, quote])}`, () => assert.equal(quoteMatches(fragment, quote), match));
