// Frozen synthetic v1 fixtures only; no Hub or pack implementation is imported/executed.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  checkContractMethod, checkBedAddress, checkCatalogCommand, checkVerbatimQuote, parseCommandTree,
  generatePlan, canonicalJson, compileCheck, compareCompileVerdicts, commandCatalogDeclaration,
  type CompileContract, type RawBedManifest, type Submission, type RunShowExport, type StepVerdict,
} from './compile-check.ts';

export const example = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/compile-contract-v1/${name}.json`,import.meta.url),'utf8'));
const contract = example('compile-contract') as CompileContract;
const bed = example('bed-topology') as RawBedManifest;
const commandTreeXml = `<commands><scope><menu name="widget"><menu name="health"><item name="interval"><arguments><arg name="seconds" type="U16" limit="[1 - 120]"/></arguments></item></menu><menu name="session"><item name="persistence"><arguments><arg name="mode" type="STRING" limit="{cookie|source}"/></arguments></item></menu></menu></scope></commands>`;
const expectedPlans = ["{\"bed\":\"bed-a\",\"blocks\":[\"setup\"],\"case\":\"doc-1:c-1\",\"expects\":[{\"source\":\"src:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/kityminder@1/s/c-1-s1/0\",\"text\":\"健康检查间隔设置成功\"}],\"schema\":\"exec-plan@1\",\"steps\":[{\"method\":\"listen\",\"n\":1,\"object\":\"dut\",\"params\":{\"address\":\"192.0.2.10\",\"port\":8080}},{\"method\":\"cli\",\"n\":2,\"object\":\"dut\",\"params\":{\"line\":\"widget health interval 60\"}},{\"method\":\"request\",\"n\":3,\"object\":\"client\",\"params\":{\"count\":3,\"target\":\"192.0.2.90\"}},{\"method\":\"respond\",\"n\":4,\"object\":\"server\",\"params\":{\"backend\":\"192.0.2.90\",\"status\":200}}]}", "{\"bed\":\"bed-a\",\"blocks\":[],\"case\":\"doc-1:c-2\",\"expects\":[{\"source\":\"src:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/kityminder@1/s/c-2-s1/0\",\"text\":\"会话保持生效\"}],\"schema\":\"exec-plan@1\",\"steps\":[{\"method\":\"cli\",\"n\":1,\"object\":\"dut\",\"params\":{\"line\":\"widget session persistence cookie\"}}]}"];
const commandCatalog = {complete:true,case_sensitive:false};
const checkCompleteCommand = (catalog: Parameters<typeof checkCatalogCommand>[0], line: string) => checkCatalogCommand(catalog,line,commandCatalog);
export const digest = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
export function fixture() {
  const raw = example('submit-result') as Submission & {synthetic?: boolean; note?: string};
  delete raw.synthetic; delete raw.note;
  const sources = new Map(raw.items.flatMap(i => i.slots!.plan![0].data.expects.map(e => [e.quote.reference,e.quote.text] as const)));
  const run: RunShowExport = {run:{run:raw.run,started_at:'2026-10-23T00:00:00Z',lease_context:[],items:raw.items.map(i => ({id:i.item}))},latest:{result:{run:raw.run,submission:digest(raw),partitions:{delivered:raw.items.map((i,n) => ({item:i.item,requirements:[
    'contract_methods','bed_addresses','commands_known','expected_grounded','plan_deterministic',
  ].map(requirement => ({requirement,layers:[{layer:'static',terminal:'pass'}],status:'satisfied' as const,claims:requirement === 'plan_deterministic' ? [{statement:{text:'按合成合约核对；不证明在真实设备上跑得通',verdict:'support',data:{
    // Frozen pre-1.1.0 plan bytes, not produced by the generator under test.
    plan:expectedPlans[n],
    sha256:createHash('sha256').update(String(expectedPlans[n])).digest('hex'),
  }}}] : []}))}))}}}};
  return {submission:raw,run,contract:structuredClone(contract),bed:structuredClone(bed),commandTreeXml,commandCatalog,sources};
}
export const data = (f: ReturnType<typeof fixture>) => f.submission.items[0].slots!.plan![0].data;
export const rebind = (f: ReturnType<typeof fixture>) => { f.run.latest!.result!.submission = digest(f.submission); };
const has = (f: ReturnType<typeof fixture>, type: StepVerdict['checkType'], verdict: StepVerdict['verdict']) => compileCheck(f).stepVerdicts.some(v => v.checkType === type && v.verdict === verdict);

test('frozen synthetic v1 inputs pass independent checks including fixed plan bytes and digest', () => {
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
for (const [line,verdict] of [['widget health interval 60','pass'],['widget health interval 121','fail'],['widget health interval nope','fail'],['widget health interval','fail'],['widget health interval 60 extra','fail'],['widget unknown 60','fail'],['widget session persistence cookie','pass'],['widget session persistence bogus','fail']] as const) test(`catalog ${line}`, () => assert.equal(checkCompleteCommand(parseCommandTree(commandTreeXml),line).verdict,verdict));
test('all overloads and duplicate command definitions remain independent', () => {
  const catalog = parseCommandTree(`<commands><item name="select"><arguments><arg type="U16" limit="[1 - 3]"/></arguments><arguments><arg type="STRING" limit="{a|b}"/></arguments></item><item name="select"><arguments><arg type="U16" limit="[20 - 30]"/></arguments></item></commands>`);
  for (const v of ['2','a','25']) assert.equal(checkCompleteCommand(catalog,`select ${v}`).verdict,'pass');
  assert.equal(checkCompleteCommand(catalog,'select 10').verdict,'fail');
});
test('XML comments, entities, quoted strings, length and optional arguments', () => {
  const c = parseCommandTree(`<commands><!-- comment --><item name="set"><arguments><arg name="name" type="STRING" length="8"/><arg name="mode" type="STRING" limit="{a&amp;b|other}" optional="yes"/></arguments></item></commands>`);
  assert.equal(checkCompleteCommand(c,'set "two word" a&b').verdict,'pass');
  assert.equal(checkCompleteCommand(c,'set short').verdict,'pass');
  assert.equal(checkCompleteCommand(c,'set toolongtext').verdict,'fail');
  assert.equal(checkCompleteCommand(c,'set "unclosed').verdict,'fail');
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
test('top-level quotes are not a prerequisite for independently grounded expectations', () => {
  for (const quotes of [undefined,[]]) {
    const f = fixture();
    if (quotes === undefined) delete f.submission.items[0].slots!.plan![0].quotes;
    else f.submission.items[0].slots!.plan![0].quotes = quotes;
    rebind(f);
    assert.equal(compileCheck(f).allPassed,true);
  }
  const f = fixture(); f.submission.items[0].slots!.plan![0].quotes = []; f.sources.clear();
  assert.ok(has(f,'quotation','unknown'));
});
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
test('plan_json refutes only plan_deterministic with plan_in_slots', () => {
  const f = fixture(); (data(f) as unknown as Record<string,unknown>).plan_json = '{}'; rebind(f);
  const r = compileCheck(f);
  const plans = r.stepVerdicts.filter(v => v.checkType === 'plan' && v.item === f.submission.items[0].item);
  assert.equal(plans.length,1); assert.equal(plans[0].verdict,'fail'); assert.equal(plans[0].code,'case-compile.plan_in_slots');
  assert.ok(r.stepVerdicts.filter(v => v.checkType !== 'plan').every(v => v.verdict === 'pass'));
});
test('canonical plan uses default strings, sorted keys/blocks and stable bytes', () => {
  const f = fixture(); const d = data(f); d.blocks = ['teardown','setup']; delete d.steps[2].params.count;
  const a = generatePlan('case:synthetic',d,f.contract), b = generatePlan('case:synthetic',d,f.contract);
  assert.deepEqual(a,b); assert.equal(a.sha256,createHash('sha256').update(a.plan).digest('hex'));
  assert.deepEqual(JSON.parse(a.plan).blocks,['setup','teardown']); assert.equal(JSON.parse(a.plan).steps[2].params.count,'1');
  assert.equal(canonicalJson({'2':2,'10':10,z:1,a:2}),'{"10":10,"2":2,"a":2,"z":1}');
});
test('tampered plan text and digest each fail independently', () => {
  for (const key of ['plan','sha256']) { const f = fixture(); f.run.latest!.result!.partitions.delivered![0].requirements[4].claims[0].statement.data![key] = 'tampered'; assert.ok(has(f,'plan','fail')); }
});
test('absent plan receipt is unknown', () => { const f = fixture(); f.run.latest!.result!.partitions.delivered![0].requirements[4].claims = []; assert.ok(has(f,'plan','unknown')); });
test('changed slots cannot reuse a previous plan conclusion', () => { const f = fixture(); data(f).steps[0].params.port = 8081; rebind(f); assert.ok(has(f,'plan','fail')); });
test('submission digest and run id bind the exported result', () => {
  const f = fixture(); f.run.latest!.result!.submission = '0'.repeat(64); assert.equal(compileCheck(f).comparison.equal,false);
  const g = fixture(); g.submission.run = 'run_'+'0'.repeat(26); assert.equal(compileCheck(g).comparison.equal,false);
});
test('duplicate/omitted items, requirements or extra result items cannot pass', () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => f.submission.items.push(f.submission.items[0]),
    (f: ReturnType<typeof fixture>) => f.submission.items.pop(),
    (f: ReturnType<typeof fixture>) => f.run.latest!.result!.partitions.delivered!.push(f.run.latest!.result!.partitions.delivered![0]),
    (f: ReturnType<typeof fixture>) => f.run.latest!.result!.partitions.delivered![0].requirements.pop(),
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
test('unannotated command words and IP parameters are not bed addresses', () => {
  const f = fixture(); data(f).steps[1].params.line = 'widget route 192.0.2.192 255.255.255.0';
  f.contract.objects[0].methods.push({name:'route',params:[{name:'destination',type:'ipv4'}]});
  data(f).steps.push({object:'dut',method:'route',params:{destination:'192.0.2.250'}});
  const addresses = compileCheck(f).stepVerdicts.filter(v => v.checkType === 'address');
  assert.ok(addresses.every(v => v.verdict === 'pass'));
  assert.equal(addresses.some(v => v.pointer.endsWith('/params/line') || v.pointer.endsWith('/params/destination')),false);
  data(f).steps[0].params.address = '192.0.2.250'; assert.ok(has(f,'address','fail'));
});
test('CLI reads run/submission documents and returns a nonzero status for missing receipts', () => {
  const dir = mkdtempSync(join(tmpdir(),'compile-gold-'));
  try {
    const f = fixture(); const args: string[] = [];
    for (const [k,v] of Object.entries({run:f.run,submission:f.submission,contract:f.contract,bed:f.bed,product:{schema:'product@1',catalogs:[{id:'commands@1',...commandCatalog}]},sources:Object.fromEntries(f.sources)})) { const p = join(dir,`${k}.json`); writeFileSync(p,JSON.stringify(v)); args.push(`--${k}`,p); }
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
  const reqs = f.run.latest!.result!.partitions.delivered![0].requirements;
  reqs[1].layers[0].terminal = 'violation';
  reqs[1].status = 'unsatisfied';
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
  const f = fixture(); f.run.latest!.result!.partitions.delivered![0].requirements[4].claims[0].statement.verdict = 'unknown';
  assert.ok(has(f,'plan','unknown'));
});
test('command parameter text is trimmed and empty text is skipped', () => {
  const f = fixture(); data(f).steps[1].params.line = ' \t widget health interval 60 \n ';
  assert.ok(compileCheck(f).stepVerdicts.filter(v => v.checkType === 'command').every(v => v.verdict === 'pass'));
  for (const line of ['', ' \t\n ']) {
    data(f).steps[1].params.line = line;
    const r = compileCheck({...f,commandTreeXml:undefined});
    assert.equal(r.stepVerdicts.some(v => v.checkType === 'command' && v.pointer.includes('/steps/1/')),false);
  }
  data(f).steps[1].params.line = 60;
  assert.ok(has(f,'command','fail'));
});
test('missing commands fail only for a declared complete catalog', () => {
  const c = parseCommandTree(commandTreeXml);
  assert.equal(checkCatalogCommand(c,'widget missing',{complete:true,case_sensitive:false}).verdict,'fail');
  assert.equal(checkCatalogCommand(c,'widget missing',{complete:false,case_sensitive:false}).verdict,'unknown');
  assert.equal(checkCatalogCommand(c,'widget health interval 60',{complete:false,case_sensitive:false}).verdict,'pass');
  assert.equal(checkCatalogCommand(c,'widget health interval 121',{complete:false,case_sensitive:false}).verdict,'fail');
  assert.equal(checkCatalogCommand(c,'widget missing').verdict,'unknown');
  const f = fixture(); data(f).steps[1].params.line = 'widget missing';
  assert.ok(compileCheck({...f,commandCatalog:{complete:false,case_sensitive:false}}).stepVerdicts.some(v => v.checkType === 'command' && v.verdict === 'unknown'));
});
test('command matching follows the declared case sensitivity without merging distinct definitions', () => {
  const c = parseCommandTree('<commands><item name="Select"><arguments><arg type="U16" limit="[1 - 3]"/></arguments></item><item name="select"><arguments><arg type="U16" limit="[20 - 30]"/></arguments></item></commands>');
  const sensitive = {complete:true,case_sensitive:true}, insensitive = {...sensitive,case_sensitive:false};
  assert.equal(checkCatalogCommand(c,'Select 2',sensitive).verdict,'pass');
  assert.equal(checkCatalogCommand(c,'select 2',sensitive).verdict,'fail');
  assert.equal(checkCatalogCommand(c,'SELECT 2',sensitive).verdict,'fail');
  assert.equal(checkCatalogCommand(c,'SELECT 2',insensitive).verdict,'pass');
  assert.equal(checkCatalogCommand(c,'SELECT 25',insensitive).verdict,'pass');
});
test('public product declarations supply commands@1 metadata without importing functions', () => {
  const product: unknown = JSON.parse(readFileSync(new URL('../../../packs/product/famx/product.json',import.meta.url),'utf8'));
  // 已发布的 FAMX 命令目录声明 case_sensitive 为 true。这里只核对公开声明，不改产品包。
  assert.deepEqual(commandCatalogDeclaration(product),{complete:true,case_sensitive:true});
  for (const v of [{}, {schema:'product@1',catalogs:[]}, {schema:'product@1',catalogs:[{id:'commands@1',complete:true}]}]) assert.throws(() => commandCatalogDeclaration(v));
});
// Pointer comparisons use synthetic exports, public subject ordering and independently chosen failures.
function pointerCheck(f:ReturnType<typeof fixture>) {
  const result=compileCheck(f);
  assert.ok(result.position_comparisons.length,'the target refutation positions were compared');
  return {...result,comparison:{...result.comparison,equal:result.position_comparisons.every(row=>row.equal)}};
}
function pointerFixture() {
  const f = fixture();
  for (const row of f.run.latest!.result!.partitions.delivered!) {
    row.requirements[4].layers[0].terminal = 'unchecked'; row.requirements[4].layers[0].reason = '缺少计划回执'; row.requirements[4].status = 'pending'; row.requirements[4].claims = [];
  }
  return f;
}
function refutes(f: ReturnType<typeof fixture>, requirement: number, pointers: string[]) {
  const r = f.run.latest!.result!.partitions.delivered![0].requirements[requirement]!;
  r.layers[0].terminal = 'violation';
  r.status = 'unsatisfied';
  r.claims = pointers.map(pointer => ({pointer,statement:{text:'合成驳回',verdict:'refute'}}));
  rebind(f);
}
test('function parameter pointers compare at the judged step and distinguish a different step', () => {
  const f = pointerFixture(); data(f).steps[0].params.address = '192.0.2.250';
  refutes(f,1,['/data/steps/0/params/address']);
  assert.equal(pointerCheck(f).comparison.equal,true);
  refutes(f,1,['/data/steps/0']); assert.equal(pointerCheck(f).comparison.equal,true);
  refutes(f,1,['/data/steps/3/params/backend']); assert.equal(pointerCheck(f).comparison.equal,false);
});
test('catalog phrase indices follow step and parameter declaration order, skipping empty values and using defaults', () => {
  const f = pointerFixture();
  f.contract.objects[0].methods.push({name:'commands',params:[{name:'first',type:'string',command:true},{name:'skip',type:'string',command:true},{name:'last',type:'string',command:true,default:'missing two'}]});
  data(f).steps = [{object:'dut',method:'save',params:{}},{object:'dut',method:'commands',params:{skip:'  ',first:' missing one '}},{object:'dut',method:'cli',params:{line:'missing three'}}];
  refutes(f,2,['/phrases/0','/phrases/1','/phrases/2']);
  assert.equal(pointerCheck(f).comparison.equal,true,JSON.stringify(pointerCheck(f).comparison));
  refutes(f,2,['/phrases/0','/phrases/1','/phrases/3']);
  assert.equal(pointerCheck(f).comparison.equal,false);
});
test('quote indices skip empty reference/text and function/quote checks have separate positions', () => {
  const f = pointerFixture();
  const refs = [...f.sources.keys()];
  data(f).expects = [{text:'missing',quote:{reference:'',text:''}},{text:'invented one',quote:{reference:refs[0],text:'invented one'}},{text:'invented two',quote:{reference:refs[1],text:'invented two'}}];
  refutes(f,3,['/data/expects/0','/quotes/0/text','/quotes/1/text']);
  assert.equal(pointerCheck(f).comparison.equal,true,JSON.stringify(pointerCheck(f).comparison));
  refutes(f,3,['/data/expects/0','/quotes/1/text','/quotes/0/text']);
  assert.equal(pointerCheck(f).comparison.equal,false);
});
test('only the first ten refutations of each check are compared, in order', () => {
  const f = pointerFixture();
  data(f).steps = Array.from({length:15},(_,i) => ({object:'dut',method:'save',params:{extra:i}}));
  const pointers = data(f).steps.map((_,i) => `/data/steps/${i}/params/extra`);
  refutes(f,0,pointers);
  assert.equal(pointerCheck(f).comparison.equal,true);
  pointers[14] = '/data/steps/999'; refutes(f,0,pointers);
  assert.equal(pointerCheck(f).comparison.equal,true);
  [pointers[0],pointers[1]] = [pointers[1],pointers[0]]; refutes(f,0,pointers);
  assert.equal(pointerCheck(f).comparison.equal,false);
});
test('the ten-diagnostic cap is applied before merging several parameter failures on a step', () => {
  const f = pointerFixture();
  f.contract.objects[0].methods.push({name:'two',params:[{name:'a',type:'int'},{name:'b',type:'int'}]});
  data(f).steps = Array.from({length:7},() => ({object:'dut',method:'two',params:{a:'wrong',b:'wrong'}}));
  refutes(f,0,Array.from({length:5},(_,i) => [`/data/steps/${i}/params/a`,`/data/steps/${i}/params/b`]).flat());
  assert.equal(pointerCheck(f).comparison.equal,true,JSON.stringify(pointerCheck(f).comparison));
});
test('block, bucket, model-written plan and whole-plan pointers normalize to their judged units', () => {
  const blocks = pointerFixture(); data(blocks).blocks = ['setup','invalid'];
  refutes(blocks,0,['/data/blocks/1']); assert.equal(pointerCheck(blocks).comparison.equal,true);
  const bucket = pointerFixture(); data(bucket).bucket = 'missing';
  refutes(bucket,1,['/data/bucket']); const bucketResult=pointerCheck(bucket);assert.equal(bucketResult.comparison.equal,false);
  const bucketPosition=bucketResult.position_comparisons.find(p=>p.requirement==='bed_addresses'&&p.check==='function')!;assert.deepEqual(bucketPosition.gold,['/bucket']);assert.deepEqual(bucketPosition.hub,['/bucket']);assert.equal(bucketPosition.unknown,true);
  const plan = pointerFixture(); (data(plan) as unknown as Record<string,unknown>).plan_json = '{}';
  refutes(plan,4,['/data/plan_json']); assert.equal(pointerCheck(plan).comparison.equal,true);
  const shape = pointerFixture(); (data(shape) as unknown as Record<string,unknown>).steps = null;
  const rows = shape.run.latest!.result!.partitions.delivered![0].requirements;
  for (const r of rows.slice(1)) { r.layers[0].terminal = 'unchecked'; r.layers[0].reason = '形状不可读'; r.status = 'pending'; }
  refutes(shape,0,['/data/steps']); assert.equal(pointerCheck(shape).comparison.equal,true);
});
test('unknown conclusions remain differences with their missing fact', () => {
  const f = pointerFixture(); delete f.run.run.lease_context; data(f).steps[2].params.target = '192.0.2.250';
  const r = f.run.latest!.result!.partitions.delivered![0].requirements[1];
  r.layers[0].terminal = 'unchecked'; r.layers[0].reason = '缺少冻结的租约视图'; r.status = 'pending'; r.claims = [{pointer:'/data/steps/999',statement:{text:'未知',verdict:'unknown'}}]; rebind(f);
  assert.equal(compileCheck(f).comparison.equal,false);
});
test('expectation and backend violations use the public 1.2.0 codes', () => {
  const f = fixture(); data(f).expects[0].text = 'invented';
  assert.ok(compileCheck(f).stepVerdicts.some(v => v.code === 'case-compile.expect_not_in_quote'));
  assert.equal(checkBedAddress(f.bed.beds[0],'192.0.2.80','backend').code,'case-compile.backend_not_server');
});
test('unknown interpreter evidence cannot erase a known positional comparison', () => {
  const f = pointerFixture(); data(f).expects[0].text = 'invented expectation'; data(f).expects[0].quote.text = 'invented quote';
  refutes(f,3,['/data/expects/0']);
  f.run.latest!.result!.partitions.delivered![0].requirements[3].claims.push({pointer:'/quotes/999/text',statement:{text:'未知',verdict:'unknown'}});
  assert.equal(compileCheck(f).comparison.equal,false);
});

test('expected-text containment and source quotation both align Chinese hard wraps under decision 37', () => {
  const f = fixture();
  const e = data(f).expects[0];
  e.text = '健康检查间隔设置成功'; e.quote.text = '健康检查间隔\n设置成功';
  f.sources.set(e.quote.reference, '健康检查间隔\r\n设置成功');
  const judgments = compileCheck(f).stepVerdicts.filter(v => v.checkType === 'quotation');
  assert.ok(judgments.length > 0);
  assert.ok(judgments.every(v => v.verdict === 'pass'), JSON.stringify(judgments));
  assert.equal(checkVerbatimQuote(f.sources, e.quote.reference, e.text).verdict, 'pass');
});

for (const [quote, expected, verdict] of [
  ['返回\n成功', '返回成功', 'pass'], ['A\n中文', 'A中文', 'pass'], ['中文\nA', '中文A', 'pass'],
  ['Ａ\nB', 'ＡB', 'pass'], ['𠀀\nA', '𠀀A', 'pass'], ['🙂\nA', '🙂A', 'pass'],
  ['set\t10\n0', 'set 10 0', 'pass'], ['a\u0085b', 'a b', 'pass'],
  ['set 10 0', 'set 100', 'fail'], ['a + b', 'a+b', 'fail'], ['α β', 'αβ', 'fail'],
  ['ｱ A', 'ｱA', 'fail'], ['中\ufeff文', '中文', 'fail'], ['é', 'e\u0301', 'fail'],
] as const) test(`decision 37 expected containment ${JSON.stringify([quote, expected])}`, () => {
  const f = fixture(), e = data(f).expects[0]; e.text = expected; e.quote.text = quote;
  f.sources.set(e.quote.reference, quote);
  const rows = compileCheck(f).stepVerdicts.filter(v => v.checkType === 'quotation' && v.stepIndex === 1 && v.item === f.submission.items[0].item);
  assert.equal(rows.length, 2);
  assert.equal(rows.find(v => v.check !== 'quote')!.verdict, verdict);
  assert.equal(rows.find(v => v.check === 'quote')!.verdict, 'pass');
});

test('pack findings missing requirement status is a difference rather than an implicit match',()=>{
 const f=fixture();delete (f.run.latest!.result!.partitions.delivered![0].requirements[0] as {status?:string}).status;
 assert.ok(!compileCheck(f).comparison.equal);
});

test('pack findings two identical unknown per-position verdicts are still unresolved',()=>{
 const row:StepVerdict={item:'synthetic',stepIndex:1,pointer:'/steps/0',checkType:'contract',verdict:'unknown',reason:'缺合成输入'};
 const result=compareCompileVerdicts([row],[row]);assert.equal(result.equal,false);assert.match(result.differences.join(' '),/缺合成输入/);
});
