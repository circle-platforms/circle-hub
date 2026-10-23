import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { judgeQuote, quoteMatches, sha256, quotesReport } from './quotes.ts';
const vectors=JSON.parse(readFileSync(new URL('../../../hub/rules/quote-vectors.json',import.meta.url),'utf8')).vectors as {fragment:string;quote:string;match:boolean}[];
for(const [i,v] of vectors.entries()) test(`shared quotation vector ${i+1}`,()=>assert.equal(quoteMatches(v.fragment,v.quote),v.match));
const bytes=Buffer.from(JSON.stringify({ 'fix/说明': '执行成功 😀', other: '其他字段', numeric: 5 }));
const digest=sha256(bytes), root='b'.repeat(64);
const opts={sources:new Map([[digest,bytes]]),run:{root,sources:[{slot:'defects',reference:`src:${digest}`}]},fixField:'fix/说明'};
test('percent-encoded JSON pointer tokens and binding classifications are independent',()=>{
  const fix=judgeQuote(`src:${digest}/json@1/p/fix~1说明`,'执行成功','执行成功',opts);assert.equal(fix.category,'fix'); assert.equal(fix.verdict,'support');
  assert.equal(judgeQuote(`src:${digest}/json@1/p/other`,'其他','其他',opts).category,'defect_other');
  const encoded=Buffer.from('{"space key":"内容"}'), sha=sha256(encoded);
  assert.equal(judgeQuote(`src:${sha}/json@1/p/space%20key`,'内容','内容',{sources:new Map([[sha,encoded]])}).verdict,'support');
  assert.equal(judgeQuote(`src:${digest}/json@1/p/numeric`,'5','5',opts).verdict,'unknown');
  assert.equal(judgeQuote(`src:${digest}/json@1/p/other`,'其他','其他',{...opts,fixField:undefined}).category,'unknown_defect_field');
  assert.equal(judgeQuote(`src:${digest}/json@1/p/other`,'其他','其他',{...opts,run:{root,sources:[]}}).category,'other');
});
test('line selectors and UTF-8 byte ranges are checked without splitting characters',()=>{
  const b=Buffer.from('first\r\n成功 😀\r\nlast'),sha=sha256(b),o={sources:new Map([[sha,b]])};
  assert.equal(judgeQuote(`src:${sha}/text@1/l/2`,'成功 😀','改写',o).expectedVerbatim,false);
  assert.equal(judgeQuote(`src:${sha}/text@1/l/1-2`,'first 成功','first',o).verdict,'support');
  assert.equal(judgeQuote(`src:${sha}/text@1/l/2:0-6`,'成功','成功',o).verdict,'support');
  assert.equal(judgeQuote(`src:${sha}/text@1/l/2:1-6`,'成功','成功',o).verdict,'refute');
  assert.equal(judgeQuote(`src:${sha}/text@1/l/9`,'成功','成功',o).verdict,'refute');
});
test('a bad digest stops instead of becoming a quote verdict',()=>assert.throws(()=>judgeQuote(`src:${digest}`,'x','x',{sources:new Map([[digest,Buffer.from('changed')]])}),/integrity/));
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
  const submission={items:[{item:'i',slots:{cases:[{data:{expected:[{text:'改写',quote:{text:'执行成功',reference:`src:${digest}/json@1/p/fix~1说明`}}]}}]}}]};
  const hub=(status:string)=>({partitions:{delivered:[{item:'i',requirements:[{requirement:'grounded',status}]}]}});
  assert.equal(quotesReport(submission,hub('unsatisfied'),opts).items[0].comparison,'different');
  assert.equal(quotesReport(submission,hub('satisfied'),opts).paraphrased,1);
  submission.items[0].slots.cases[0].data.expected[0].quote.text='不存在';
  assert.equal(quotesReport(submission,hub('satisfied'),opts).items[0].comparison,'different');
});
