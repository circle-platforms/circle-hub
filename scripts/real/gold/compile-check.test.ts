// Synthetic fixtures only. The pack is read through public examples, never imported/executed.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  checkContractMethod, checkBedAddress, checkCatalogCommand, checkVerbatimQuote, parseCommandTree,
  generatePlan, canonicalJson, compileCheck, compareCompileVerdicts,
  type CompileContract, type RawBedManifest, type Submission, type RunShowExport, type StepVerdict,
} from './compile-check.ts';

const example = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../../packs/workflow/case-compile/examples/${name}.json`,import.meta.url),'utf8'));
const contract = example('compile-contract') as CompileContract;
const bed = example('bed-topology') as RawBedManifest;
const commandTreeXml = `<commands><scope><menu name="widget"><menu name="health"><item name="interval"><arguments><arg name="seconds" type="U16" limit="[1 - 120]"/></arguments></item></menu><menu name="session"><item name="persistence"><arguments><arg name="mode" type="STRING" limit="{cookie|source}"/></arguments></item></menu></menu></scope></commands>`;
const expectedPlans = ["{\"bed\":\"bed-a\",\"blocks\":[\"setup\"],\"case\":\"doc-1:c-1\",\"expects\":[{\"source\":\"src:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/kityminder@1/s/c-1-s1/0\",\"text\":\"健康检查间隔设置成功\"}],\"schema\":\"exec-plan@1\",\"steps\":[{\"method\":\"listen\",\"n\":1,\"object\":\"dut\",\"params\":{\"address\":\"192.0.2.10\",\"port\":8080}},{\"method\":\"cli\",\"n\":2,\"object\":\"dut\",\"params\":{\"line\":\"widget health interval 60\"}},{\"method\":\"request\",\"n\":3,\"object\":\"client\",\"params\":{\"count\":3,\"target\":\"192.0.2.90\"}},{\"method\":\"respond\",\"n\":4,\"object\":\"server\",\"params\":{\"backend\":\"192.0.2.90\",\"status\":200}}]}", "{\"bed\":\"bed-a\",\"blocks\":[],\"case\":\"doc-1:c-2\",\"expects\":[{\"source\":\"src:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/kityminder@1/s/c-2-s1/0\",\"text\":\"会话保持生效\"}],\"schema\":\"exec-plan@1\",\"steps\":[{\"method\":\"cli\",\"n\":1,\"object\":\"dut\",\"params\":{\"line\":\"widget session persistence cookie\"}}]}"];
const digest = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
function fixture() {
  const raw = example('submit-result') as Submission & {synthetic?: boolean; note?: string};
  delete raw.synthetic; delete raw.note;
  const sources = new Map(raw.items.flatMap(i => i.slots!.plan![0].data.expects.map(e => [e.quote.reference,e.quote.text] as const)));
  const run: RunShowExport = {run:{run:raw.run,started_at:'2026-10-23T00:00:00Z',lease_context:[],items:raw.items.map(i => ({id:i.item}))},latest:{result:{run:raw.run,submission:digest(raw),partitions:{delivered:raw.items.map((i,n) => ({item:i.item,requirements:[
    'contract_methods','bed_addresses','commands_known','expected_grounded','plan_deterministic',
  ].map(requirement => ({requirement,layers:[{layer:'static',terminal:'pass'}],claims:requirement === 'plan_deterministic' ? [{statement:{text:'按合成合约核对；不证明在真实设备上跑得通',verdict:'support',data:{
    // Frozen pre-1.1.0 plan bytes, not produced by the generator under test.
    plan:expectedPlans[n],
    sha256:createHash('sha256').update(String(expectedPlans[n])).digest('hex'),
  }}}] : []}))}))}}}};
  return {submission:raw,run,contract:structuredClone(contract),bed:structuredClone(bed),commandTreeXml,sources};
}
const data = (f: ReturnType<typeof fixture>) => f.submission.items[0].slots!.plan![0].data;
const rebind = (f: ReturnType<typeof fixture>) => { f.run.latest!.result!.submission = digest(f.submission); };
const has = (f: ReturnType<typeof fixture>, type: StepVerdict['checkType'], verdict: StepVerdict['verdict']) => compileCheck(f).stepVerdicts.some(v => v.checkType === type && v.verdict === verdict);

test('public examples pass independent checks including the published plan bytes and digest', () => {
  const r = compileCheck(fixture());
  assert.equal(r.allPassed,true,JSON.stringify(r));
  assert.equal(r.plans.length,2);
  assert.deepEqual(r.notes,['按合成合约核对','不证明在真实设备上跑得通']);
});
for (const [name,object,method,params] of [
  ['unknown method','dut','missing',{}], ['forbidden pair','dut','reboot',{}],
  ['missing parameter','dut','listen',{address:'192.0.2.10'}],
  ['extra parameter','dut','save',{extra:1}], ['wrong type','dut','listen',{address:'192.0.2.10',port:'8080'}],
  ['port range','dut','listen',{address:'192.0.2.10',port:65536}], ['numeric bounds','server','respond',{backend:'192.0.2.90',status:600}],
] as const) test(`contract refuses ${name}`, () => assert.equal(checkContractMethod(contract,object,method,params).verdict,'fail'));
test('contract permits an omitted optional parameter', () => assert.equal(checkContractMethod(contract,'client','request',{target:'192.0.2.90'}).verdict,'pass'));
test('enum, keyword, string length and boolean parameters are checked', () => {
  const c: CompileContract = {schema:'compile-contract@1',synthetic:true,objects:[{name:'x',methods:[{name:'m',params:[{name:'e',type:'enum',values:['one']},{name:'k',type:'keyword',keyword:'set'},{name:'s',type:'string',maxLength:3},{name:'b',type:'boolean'}]}]}],forbidden:[]};
  const p = {e:'one',k:'set',s:'ok',b:true};
  assert.equal(checkContractMethod(c,'x','m',p).verdict,'pass');
  for (const change of [{e:'two'},{k:'unset'},{s:'long'},{b:'true'}]) assert.equal(checkContractMethod(c,'x','m',{...p,...change}).verdict,'fail');
});
for (const [ip,role,verdict] of [
  ['192.0.2.10','listen','pass'],['192.0.2.74','listen','pass'],['192.0.2.90','backend','pass'],
  ['2001:0db8:0001:0:0:0:0:10','listen','pass'],['192.0.2.130','listen','fail'],['192.0.2.130','virtual','fail'],
  ['192.0.2.250','target','fail'],['192.0.2.80','backend','fail'],['192.0.2.90','listen','fail'],['192.0.2.10/26','listen','fail'],
] as const) test(`address ${role} ${ip} -> ${verdict}`, () => assert.equal(checkBedAddress(bed.beds[0],ip,role).verdict,verdict));
test('allocated IP can be a target but never a listener or server interface', () => {
  for (const role of ['target','virtual','listen','backend']) assert.equal(checkBedAddress(bed.beds[0],'192.0.2.200',role,['192.0.2.200']).verdict,['target','virtual'].includes(role) ? 'pass' : 'fail');
});
test('a reserved address is not an allocation', () => { const b = structuredClone(bed.beds[0]); b.reserved = ['192.0.2.200']; assert.equal(checkBedAddress(b,'192.0.2.200','target').verdict,'fail'); });
test('a service declaration cannot turn a client into a backend', () => { const b = structuredClone(bed.beds[0]); b.services.push({host:'client0',ip:'192.0.2.80',proto:'tcp',port:80}); assert.equal(checkBedAddress(b,'192.0.2.80','backend').verdict,'fail'); });
test('without trigger interfaces listener addresses become blind', () => { const b = structuredClone(bed.beds[0]); b.devices = b.devices.filter(d => !['client','router'].includes(d.type)); assert.equal(checkBedAddress(b,'192.0.2.10','listen').verdict,'fail'); });
for (const [line,verdict] of [['widget health interval 60','pass'],['widget health interval 121','fail'],['widget health interval nope','fail'],['widget health interval','fail'],['widget health interval 60 extra','fail'],['widget unknown 60','fail'],['widget session persistence cookie','pass'],['widget session persistence bogus','fail']] as const) test(`catalog ${line}`, () => assert.equal(checkCatalogCommand(parseCommandTree(commandTreeXml),line).verdict,verdict));
test('all overloads and duplicate command definitions remain independent', () => {
  const catalog = parseCommandTree(`<commands><item name="select"><arguments><arg type="U16" limit="[1 - 3]"/></arguments><arguments><arg type="STRING" limit="{a|b}"/></arguments></item><item name="select"><arguments><arg type="U16" limit="[20 - 30]"/></arguments></item></commands>`);
  for (const v of ['2','a','25']) assert.equal(checkCatalogCommand(catalog,`select ${v}`).verdict,'pass');
  assert.equal(checkCatalogCommand(catalog,'select 10').verdict,'fail');
});
test('XML comments, entities, quoted strings, length and optional arguments', () => {
  const c = parseCommandTree(`<commands><!-- comment --><item name="set"><arguments><arg name="name" type="STRING" length="8"/><arg name="mode" type="STRING" limit="{a&amp;b|other}" optional="yes"/></arguments></item></commands>`);
  assert.equal(checkCatalogCommand(c,'set "two word" a&b').verdict,'pass');
  assert.equal(checkCatalogCommand(c,'set short').verdict,'pass');
  assert.equal(checkCatalogCommand(c,'set toolongtext').verdict,'fail');
  assert.equal(checkCatalogCommand(c,'set "unclosed').verdict,'fail');
});
test('malformed or unsupported XML becomes unknown, not a green empty catalog', () => {
  for (const xml of ['<commands><item name="x"></commands>','<commands>','<!DOCTYPE commands><commands/>','<commands><item name=x/></commands>']) assert.throws(() => parseCommandTree(xml));
  const f = fixture(); f.commandTreeXml = '<commands>'; assert.ok(has(f,'command','unknown'));
});
test('quote allows whitespace folding but rejects paraphrases, missing and unreadable sources', () => {
  const sources = new Map([['src:synthetic','预期：返回  200\nOK。']]);
  assert.equal(checkVerbatimQuote(sources,'src:synthetic','返回 200 OK').verdict,'pass');
  assert.equal(checkVerbatimQuote(sources,'src:synthetic','返回 500 OK').verdict,'fail');
  assert.equal(checkVerbatimQuote(sources,'src:missing','返回 200 OK').verdict,'unknown');
  assert.equal(checkVerbatimQuote(sources,'','返回 200 OK').verdict,'fail');
});
test('expected text cannot be invented beside a true quote', () => { const f = fixture(); data(f).expects[0].text = '模型自造成功'; assert.ok(has(f,'quotation','fail')); });
test('top-level quotes must include the expectations', () => { const f = fixture(); f.submission.items[0].slots!.plan![0].quotes = []; assert.ok(has(f,'quotation','fail')); });
test('empty expectations cannot vacuously pass', () => { const f = fixture(); data(f).expects = []; assert.equal(compileCheck(f).allPassed,false); });
test('missing original command tree or source stays unknown', () => {
  const f = fixture(); assert.ok(compileCheck({...f,commandTreeXml:undefined}).stepVerdicts.some(v => v.checkType === 'command' && v.verdict === 'unknown'));
  assert.ok(compileCheck({...f,sources:new Map()}).stepVerdicts.some(v => v.checkType === 'quotation' && v.verdict === 'unknown'));
});
test('malformed contract/bed and unreadable slot shape never pass', () => {
  const f = fixture();
  for (const change of [{contract:{schema:'wrong'}},{bed:{schema:'wrong'}},{submission:{...f.submission,items:[]}}]) assert.equal(compileCheck({...f,...change}).allPassed,false);
  (data(f) as unknown as Record<string,unknown>).steps = null; assert.equal(compileCheck(f).allPassed,false);
});
test('the retired plan_json input is refused', () => { const f = fixture(); (data(f) as unknown as Record<string,unknown>).plan_json = '{}'; assert.ok(has(f,'contract','fail')); });
test('canonical plan uses default strings, sorted keys/blocks and stable bytes', () => {
  const f = fixture(); const d = data(f); d.blocks = ['teardown','setup']; delete d.steps[2].params.count;
  const a = generatePlan('case:synthetic',d,f.contract), b = generatePlan('case:synthetic',d,f.contract);
  assert.deepEqual(a,b); assert.equal(a.sha256,createHash('sha256').update(a.plan).digest('hex'));
  assert.deepEqual(JSON.parse(a.plan).blocks,['setup','teardown']); assert.equal(JSON.parse(a.plan).steps[2].params.count,'1');
  assert.equal(canonicalJson({'2':2,'10':10,z:1,a:2}),'{"10":10,"2":2,"a":2,"z":1}');
});
test('tampered plan text and digest each fail independently', () => {
  for (const key of ['plan','sha256']) { const f = fixture(); f.run.latest!.result!.partitions.delivered[0].requirements[4].claims[0].statement.data![key] = 'tampered'; assert.ok(has(f,'plan','fail')); }
});
test('absent plan receipt is unknown', () => { const f = fixture(); f.run.latest!.result!.partitions.delivered[0].requirements[4].claims = []; assert.ok(has(f,'plan','unknown')); });
test('changed slots cannot reuse a previous plan conclusion', () => { const f = fixture(); data(f).steps[0].params.port = 8081; rebind(f); assert.ok(has(f,'plan','fail')); });
test('submission digest and run id bind the exported result', () => {
  const f = fixture(); f.run.latest!.result!.submission = '0'.repeat(64); assert.equal(compileCheck(f).comparison.equal,false);
  const g = fixture(); g.submission.run = 'run_'+'0'.repeat(26); assert.equal(compileCheck(g).comparison.equal,false);
});
test('duplicate/omitted items, requirements or extra result items cannot pass', () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => f.submission.items.push(f.submission.items[0]),
    (f: ReturnType<typeof fixture>) => f.submission.items.pop(),
    (f: ReturnType<typeof fixture>) => f.run.latest!.result!.partitions.delivered.push(f.run.latest!.result!.partitions.delivered[0]),
    (f: ReturnType<typeof fixture>) => f.run.latest!.result!.partitions.delivered[0].requirements.pop(),
  ]) { const f = fixture(); mutate(f); assert.equal(compileCheck(f).allPassed,false); }
});
test('negative Hub terminals compare independently, without accepting prose', () => {
  const f = fixture(); data(f).steps[0].params.address = '192.0.2.250'; rebind(f);
  const r = compileCheck(f); assert.equal(r.comparison.equal,false); assert.ok(r.stepVerdicts.some(v => v.checkType === 'address' && v.verdict === 'fail'));
});
test('step comparison compares identities and counts, not just verdict positions', () => {
  const v: StepVerdict[] = [{item:'case:1',stepIndex:1,checkType:'contract',pointer:'/x',verdict:'pass'}];
  assert.equal(compareCompileVerdicts(v,v).equal,true);
  for (const h of [[],[...v,...v],[{...v[0],item:'case:2'}],[{...v[0],checkType:'command' as const}],[{...v[0],verdict:'fail' as const}]]) assert.equal(compareCompileVerdicts(h,v).equal,false);
});
test('IPv6 shortened invalid forms are not accepted', () => {
  const f = fixture(); data(f).steps[0] = {object:'dut',method:'listen6',params:{address:'2001:db8:1:10'}}; assert.ok(has(f,'contract','fail'));
});
test('live lineage allocations are distinguished from expired or foreign leases', () => {
  for (const [mine,until,verdict] of [[true,'2026-10-24T00:00:00Z','pass'],[false,'2026-10-24T00:00:00Z','fail'],[true,'2026-10-22T00:00:00Z','fail']] as const) {
    const f = fixture(); data(f).steps[2].params.target = '192.0.2.200'; f.run.run.lease_context = [{key:'bed/bed-a/ip/192.0.2.200',mine,until}];
    const r = compileCheck(f); assert.equal(r.stepVerdicts.find(v => v.pointer.endsWith('/steps/2/params/target'))?.verdict,verdict);
  }
});
test('IP literals in command arguments cannot escape bed checks', () => {
  const f = fixture(); data(f).steps[1].params.line = 'widget address 192.0.2.250'; f.commandTreeXml += ''; assert.ok(has(f,'address','fail'));
});
test('CLI reads run/submission documents and returns a nonzero status for missing receipts', () => {
  const dir = mkdtempSync(join(tmpdir(),'compile-gold-'));
  try {
    const f = fixture(); const args: string[] = [];
    for (const [k,v] of Object.entries({run:f.run,submission:f.submission,contract:f.contract,bed:f.bed,sources:Object.fromEntries(f.sources)})) { const p = join(dir,`${k}.json`); writeFileSync(p,JSON.stringify(v)); args.push(`--${k}`,p); }
    const tree = join(dir,'tree.xml'); writeFileSync(tree,commandTreeXml);
    const ok = spawnSync(process.execPath,['scripts/real/gold/compile-check.ts',...args,'--commands',tree],{encoding:'utf8'});
    assert.equal(ok.status,0,ok.stdout+ok.stderr); assert.equal(JSON.parse(ok.stdout).allPassed,true);
    delete f.run.latest; writeFileSync(join(dir,'run.json'),JSON.stringify(f.run));
    const bad = spawnSync(process.execPath,['scripts/real/gold/compile-check.ts',...args,'--commands',tree],{encoding:'utf8'});
    assert.equal(bad.status,1); assert.equal(JSON.parse(bad.stdout).allPassed,false);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('a correctly located negative Hub outcome agrees while the plan remains invalid', () => {
  const f = fixture(); data(f).steps[0].params.address = '192.0.2.250'; rebind(f);
  const reqs = f.run.latest!.result!.partitions.delivered[0].requirements;
  reqs[1].layers[0].terminal = 'violation';
  reqs[1].claims = [{pointer:'/steps/0/params/address',statement:{text:note(),verdict:'refute'}}];
  const plan = expectedPlans[0].replace('192.0.2.10','192.0.2.250');
  reqs[4].claims[0].statement.data = {plan,sha256:createHash('sha256').update(plan).digest('hex')};
  const r = compileCheck(f);
  assert.equal(r.comparison.equal,true,JSON.stringify(r.comparison));
  assert.equal(r.allPassed,false);
  reqs[1].claims[0].pointer = '/steps/3/params/backend';
  assert.equal(compileCheck(f).comparison.equal,false);
  delete reqs[1].claims[0].pointer;
  assert.equal(compileCheck(f).comparison.equal,false);
});
function note() { return '按合成合约核对；不证明在真实设备上跑得通'; }
test('missing frozen lease context leaves an unlisted address unknown', () => {
  const f = fixture(); delete f.run.run.lease_context; data(f).steps[2].params.target = '192.0.2.200';
  assert.ok(has(f,'address','unknown'));
});
test('generator fails on missing required values, omits optional values and drops extra parameters', () => {
  const f = fixture(); const d = data(f);
  delete d.steps[0].params.port;
  assert.throws(() => generatePlan('case:synthetic',d,f.contract),/必填参数 port/);
  assert.ok(has(f,'plan','unknown'));
  d.steps[0].params.port = 0; d.steps[0].params.extra = 'ignored';
  const p = JSON.parse(generatePlan('case:synthetic',d,f.contract).plan);
  assert.equal(p.steps[0].params.port,0); assert.equal('extra' in p.steps[0].params,false);
  assert.equal(checkContractMethod(f.contract,'dut','listen',{address:'192.0.2.10',port:0}).verdict,'pass');
  const c = structuredClone(f.contract); c.objects[1].methods[0].params[1].default = undefined;
  delete d.steps[2].params.count;
  assert.equal('count' in JSON.parse(generatePlan('case:synthetic',d,c).plan).steps[2].params,false);
});
test('canonical keys use default JavaScript UTF-16 sorting and retain Chinese strings', () => {
  assert.equal(canonicalJson({'\uE000':'中文','𐀀':1}),'{"𐀀":1,"\uE000":"中文"}');
});
test('an unknown Hub conclusion carrying a fake plan cannot masquerade as support', () => {
  const f = fixture(); f.run.latest!.result!.partitions.delivered[0].requirements[4].claims[0].statement.verdict = 'unknown';
  assert.ok(has(f,'plan','unknown'));
});
