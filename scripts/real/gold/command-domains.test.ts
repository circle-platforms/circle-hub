import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandDomains, judgeCommand, domainReport, compareStatus } from './command-domains.ts';
const xml = (args: string) => `<commands><scope type="global"><menu name="widget"><item name="set"><arguments>${args}</arguments></item></menu></scope></commands>`;
const judge = (type: string, value: string, attrs = '', help = '') => judgeCommand({ head: 'widget set', parameters: [value] }, commandDomains(xml(`<arg name="value" type="${type}" ${attrs}>${help}</arg>`)));
for (const [type, good, bad, verdict] of [
  ['STRING','abc','toolong','refute'], ['XSTRING','甲乙','甲乙丙丁','refute'], ['U16','65535','65536','refute'], ['U32','4294967295','4294967296','refute'],
  ['DOTTEDIP','192.0.2.1','hostname','unknown'], ['IPADDR','2001:db8::1','host','refute'], ['IPMASK','255.255.255.0','255.0.255.0','refute'],
]) test(`type ${type}: valid and invalid`, () => {
  const attrs = ['STRING','XSTRING'].includes(type) ? 'length="3"' : '';
  assert.equal(judge(type, good, attrs).verdict, 'support'); assert.equal(judge(type, bad, attrs).verdict, verdict);
});
for (const constraint of ['[2 - 4]', '2~4', '2..4', '2 to 4', '(2-4)', '4']) test(`numeric limit ${constraint}`, () => {
  assert.equal(judge('U16', '3', `limit="${constraint}"`).verdict,'support'); assert.equal(judge('U16','5',`limit="${constraint}"`).category,'range');
});
for (const constraint of ['{on|off}', '(on,off)', '[on|off]', 'on,off']) test(`enum limit ${constraint}`, () => {
  assert.equal(judge('STRING','on',`limit="${constraint}"`).verdict,'support'); assert.equal(judge('STRING','bad',`limit="${constraint}"`).category,'enum');
});
for (const key of ['length','limit']) test(`string ${key} range uses Unicode code points`, () => {
  assert.equal(judge('STRING','😀a',`${key}="[2-3]"`).verdict,'support'); assert.equal(judge('STRING','a',`${key}="[2-3]"`).category,'range');
});
test('optional arguments may be skipped and arity mismatches remain refutations', () => {
  const domains=commandDomains(xml('<arg name="optional" type="STRING" optional="yes"/><arg name="value" type="U16"/>'));
  assert.equal(judgeCommand({head:'widget set',parameters:['5']},domains).verdict,'support');
  for(const parameters of [[],['a','5','extra']]) assert.equal(judgeCommand({head:'widget set',parameters},domains).category,'count');
  assert.equal(judge('U16','a').category,'type');
  assert.equal(judge('IPMASK','129').category,'range'); assert.equal(judge('IPADDR','192.0.2.1').verdict,'support');
});
test('unsupported types, constraints, alternative DOTTEDIP forms and excessive unions are unknown', () => {
  for(const r of [judge('DEPLOYMENT','x'),judge('STRING','x','limit="unsupported"'),judge('DOTTEDIP','192.0.2.1','','IP address or host name')]) assert.equal(r.verdict,'unknown');
  const args=Array.from({length:6},(_,i)=>`<arg name="arg${i}" type="IPADDR"/>`).join('');
  assert.equal(judgeCommand({head:'widget set',parameters:Array(6).fill('192.0.2.1')},commandDomains(xml(args))).verdict,'unknown');
});
test('an item the Hub satisfied is a disagreement when the independent domain is exceeded',()=>{
  const submission={items:[{item:'synthetic-item',slots:{cases:[{data:{expects_refutation:false,negative:false,steps:[{command:'widget set 99999'}]}}]}}]};
  const hub={partitions:{delivered:[{item:'synthetic-item',requirements:[{requirement:'commands',status:'satisfied'}]}]}};
  assert.equal(domainReport(submission,hub,xml('<arg name="value" type="U16"/>')).items[0].comparison,'different');
});
test('a valid negative case needs a refutation and unmapped argument domains are disclosed separately',()=>{
  const submission={items:[{item:'i',slots:{cases:[{data:{negative:true,expects_refutation:true,steps:[{command:'widget set 70000\nwidget custom cfg'}]}}]}}]};
  const hub={partitions:{delivered:[{item:'i',requirements:[{requirement:'commands',status:'satisfied'}]}]}};
  const tree=xml('<arg name="value" type="U16"/>').replace('</menu>', '<item name="custom"><arguments><arg name="value" type="UNMAPPED"/></arguments></item></menu>');
  const report=domainReport(submission,hub,tree);
  assert.equal(report.items[0].verdict,'support');assert.equal(report.items[0].hasUnknown,true);assert.equal(report.counts.unknown,1);
});
test('catalog non-members refute and missing expects_refutation defaults to false',()=>{
  const submit=(command:string)=>({items:[{item:'i',slots:{cases:[{data:{negative:false,steps:[{command}]}}]}}]});
  const hub={partitions:{delivered:[{item:'i',requirements:[{requirement:'commands',status:'satisfied'}]}]}};
  const tree=xml('<arg name="value" type="U16"/>');
  const good=domainReport(submit('widget set 5'),hub,tree);assert.equal(good.items[0].comparison,'equal');
  const bad=domainReport(submit('widget absent 5'),hub,tree);assert.equal(bad.counts.refute,1);assert.equal(bad.counts.unknown,0);assert.equal(bad.notMember,1);assert.equal(bad.items[0].comparison,'different');
});
test('a legal preparation step plus an invalid negative step is reported as the package step-rule difference',()=>{
  const submission={items:[{item:'i',slots:{cases:[{data:{negative:true,expects_refutation:true,steps:[{command:'widget set 5'},{command:'widget set 70000'}]}}]}}]};
  const hub={partitions:{delivered:[{item:'i',requirements:[{requirement:'commands',status:'unsatisfied'}]}]}};
  const report=domainReport(submission,hub,xml('<arg name="value" type="U16"/>'));
  assert.equal(report.items[0].verdict,'support');assert.equal(report.items[0].comparison,'different');
  assert.deepEqual(report.differences.map(d=>d.category),['negative_step_rule']);assert.equal(report.differences[0].draft,1);
});
test('a noninteger parameter ignored by simplified refutation matching gets its own diagnostic group',()=>{
  const submission={items:[{item:'i',slots:{cases:[{data:{negative:true,expects_refutation:true,steps:[{command:'widget set host-name'}]}}]}}]};
  const hub={partitions:{delivered:[{item:'i',requirements:[{requirement:'commands',status:'unsatisfied'}]}]}};
  const report=domainReport(submission,hub,xml('<arg name="address" type="IPADDR"/>'));
  assert.equal(report.items[0].verdict,'support');assert.deepEqual(report.differences.map(d=>d.category),['simplified_refutation_match']);
});

test('known gold verdicts disagree with missing, pending and duplicated Hub requirements',()=>{
  for(const status of [null,'pending'] as const)for(const verdict of ['support','refute'] as const)assert.equal(compareStatus(verdict,status),'different');
  const submission={items:[{item:'i',slots:{cases:[{data:{steps:[{command:'widget set 5'}]}}]}}]};
  for(const requirements of [[],[{requirement:'commands',status:'pending'}],[{requirement:'commands',status:'satisfied'},{requirement:'commands',status:'satisfied'}]]){
    const report=domainReport(submission,{partitions:{delivered:[{item:'i',requirements}]}},xml('<arg name="" type="U16"/>'));
    assert.equal(report.items[0].comparison,'different');assert.ok(report.differences.some(d=>d.category==='hub_output_missing'));
  }
});
