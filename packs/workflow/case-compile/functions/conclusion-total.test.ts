import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assemble, auditKey, auditPasses, caseBasisOf, closeFailed, closeUnrun, caseConclusion, deliveryReport, type Dispatch, type CaseOutcome, type ReportInput } from './delivery.ts';
const dispatch=(run:string,item:string):Dispatch=>({run,job:run,plan_run:run,sha256:'a'.repeat(64),items:[item],rows:[{item,dynamic_terminal:'pass',qualifier:{nature:'judgment',marks:['target_reported']},accepted_as_fact:false}]});
test('a correct observation outside the verified volume only leaves that case pending',()=>{
  const a=assemble(['a','b'],[dispatch('first','a'),dispatch('last','b')]);
  assert.deepEqual(a.pass?.items,['b']);assert.equal(a.cases[0].history.at(-1)?.terminal,'pass');assert.ok(a.cases[0].pending?.length);assert.equal(a.cases[1].status,'delivered');
});
test('every unwritten case gets a pending result without a fabricated closing credential',()=>{
  const cases:CaseOutcome[]=[{autoid:'a',status:'unrun',history:[]},{autoid:'b',status:'unrun',history:[]}];
  const result=closeUnrun(cases,{});assert.deepEqual(result.problems,[]);assert.equal(result.cases.length,2);assert.ok(result.cases.every(c=>c.pending?.length&&!c.closing));
});
test('failed cases preserve unverified attribution and invalid candidates as case-local missing evidence',()=>{
  const cases:CaseOutcome[]=[{autoid:'a',status:'failed',history:[]}];
  const notes={cases:{a:{judged:'model claim',remedy:'model remedy',defect_candidate:{repro:'repro',expected:'not authored',actual:'not observed'}}}};
  const result=closeFailed(cases,notes,{a:1},{a:['actual author']},{a:['actual output']});assert.deepEqual(result.problems,[]);assert.ok(result.cases[0].pending?.length);assert.equal(result.cases[0].closing,undefined);
});
test('device pass remains an unconfirmed report and output names match the generated volumes',()=>{
  const assembly=assemble(['a'],[dispatch('first','a')]);const input={name:'synthetic',generatedAt:'synthetic',assembly,notes:{cases:{}},originals:{a:{title:'synthetic',lines:[]}},excluded:[],files:{pass:{sha256:'a'.repeat(64)},unsuccessful:null},logs:{}} as unknown as ReportInput;
  const text=caseConclusion(input,assembly.cases[0]);assert.equal(text,'原始用例 a synthetic：上机验证通过。');const report=deliveryReport(input);
  assert.match(report,/^# 交付报告 — synthetic\n> 生成 synthetic\n\n原始脑图共 1 条用例：生成成功 1 条，失败 0 条。\n/);assert.doesNotMatch(text+report,/已确认|已核实|Hub|运行器/);assert.ok(!report.split('交付物：').at(-1)!.includes('unsuccessful_cases.xlsx'));
});

test('all structural gaps, attributions and named exits survive even alongside a satisfied requirement',()=>{
  const run='run_'+'a'.repeat(26);
  const exported={schema:'run-export@1',run:{run},result:{run,partitions:{pending:[{item:'a',requirements:[
    {requirement:'first',status:'satisfied',layers:[{attribution:'data_gap',gaps:[{reason:'missing_input',missing:'first missing',exit:{action:'reevaluate',audience:{hub:true},due:'2026-11-16T00:00:00.000Z'}}]}]},
    {requirement:'second',status:'pending',layers:[{attribution:'producer_error',missing:'second missing',exit:{action:'request',request_kind:'clarification',audience:{user:'usr_'+'1'.repeat(26)},due:'2026-11-17T00:00:00.000Z'}}]},
  ]}]}}};
  const basis=caseBasisOf(exported,run,'a')!;
  assert.deepEqual(basis.attributions,['data_gap','producer_error']);
  assert.deepEqual(basis.gaps.filter(gap=>gap.missing).map(gap=>gap.missing),['first missing','second missing']);
  const outcome:CaseOutcome={autoid:'a',status:'unrun',history:[],basis,pending:['missing case evidence']};
  const input={originals:{a:{title:'synthetic'}},assembly:{cases:[outcome]}} as unknown as ReportInput;
  const text=caseConclusion(input,outcome);
  assert.match(text,/原因：缺资料、生产者错误/);
  assert.match(text,/first missing；second missing/);
  assert.match(text,/由Hub重评，期限 2026-11-16 09:00；由使用者处理具名请求，期限 2026-11-17 09:00/);
  assert.equal(caseBasisOf({...exported,result:{...exported.result,partitions:{pending:[...exported.result.partitions.pending,...exported.result.partitions.pending]}}},run,'a'),null);
});

test('free text and an unconfirmed model attribution cannot overwrite the engine attribution',()=>{
  const outcome:CaseOutcome={autoid:'a',status:'failed',history:[],pending:['设备问题、模型问题、用户问题都只是自述'],basis:{plan_run:'synthetic',attributions:[],gaps:[]}};
  const input={originals:{a:{title:'synthetic'}},notes:{cases:{a:{judged:'设备问题',remedy:'retry',attribution:'producer_error'}}}} as unknown as ReportInput;
  assert.match(caseConclusion(input,outcome),/原因（模型的分析）：设备问题。缺少：/);assert.doesNotMatch(caseConclusion(input,outcome),/原因：设备问题/);
  assert.doesNotMatch(caseConclusion(input,outcome),/原因：生产者错误|原因（生产者错误）/);
});

test('an audited device pass preserves its original observation and remains unknown at the recorded budget',()=>{
  const d=dispatch('first','a');
  const audited=auditPasses([d],new Map([[auditKey('first','a'),{where:'log',line:'declared failure'}]]));
  const assembly=assemble(['a'],audited);
  const closed=closeFailed(assembly.cases,{cases:{a:{judged:'model',remedy:'retry'}}},{a:3},{},{}).cases[0];
  assert.equal(closed.history[0].terminal,'no_verdict');
  assert.equal(closed.history[0].reported_terminal,'pass');
  assert.equal(closed.history[0].accepted_as_fact,false);
  const input={originals:{a:{title:'synthetic'}}} as unknown as ReportInput;
  assert.match(caseConclusion(input,closed),/上机 1 次、写过 3 版自动化用例，没有得到可采用的通过结论。/);
  assert.doesNotMatch(caseConclusion(input,closed),/都没有通过|已确认|原因：编写模型/);
});


test('missing or inconsistent named exits remain disclosed rather than acquiring a recipient or deadline',()=>{
  const outcome:CaseOutcome={autoid:'a',status:'unrun',history:[],pending:['need evidence'],basis:{plan_run:'synthetic',attributions:[],gaps:[{requirement:'plan',missing:'synthetic fact',exit:{action:'request',audience:{hub:true},due:'2026-11-16T00:00:00.000Z'}}]}};
  const input={originals:{a:{title:'synthetic'}}} as unknown as ReportInput;
  const text=caseConclusion(input,outcome);
  assert.match(text,/由模型将本条计划交给 Hub 取得具名缺失事实/);assert.doesNotMatch(text,/由Hub发请求/);
  assert.deepEqual(outcome.basis!.gaps[0].exit,{action:'request',audience:{hub:true},due:'2026-11-16T00:00:00.000Z'},'raw repair evidence is retained');
});


test('workbook verification gaps stay in the reported evidence without becoming a claim that authoring is impossible',()=>{
  const run='run_'+'a'.repeat(26);
  const basis=caseBasisOf({schema:'run-export@1',run:{run},result:{run,partitions:{pending:[{item:'a',requirements:[{requirement:'workbook_verified',layers:[{reason:'missing_input',attribution:'data_gap',missing:'the generated workbook has not been verified',exit:{action:'rerun',audience:{hub:true},due:'2026-11-16T00:00:00.000Z'}}]}]}]}}},run,'a');
  assert.equal(basis?.gaps[0].requirement,'workbook_verified');
  assert.equal(basis?.gaps[0].missing,'the generated workbook has not been verified');
});
