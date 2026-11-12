import assert from 'node:assert/strict';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import {createHash} from 'node:crypto';
import { PackManifest, WorkflowFile, RequirementsFile, SlotsFile } from '../../../contracts/src/pack.ts';
import { computeManifest, packFiles, PACK_DIR } from './pack-files.ts';
import { parseRuntimeContract } from './functions/runtime-contract.ts';
import { parseProfile } from './functions/profile.ts';
import { parseManifest } from './functions/manifest.ts';
const read = (path: string) => readFileSync(join(PACK_DIR, path), 'utf8');
const json = (path: string): any => JSON.parse(read(path));
test('version 2.0 manifest lists exactly the published files and excludes development fixtures', async () => {
  const manifest = await computeManifest(); assert.ok(PackManifest.safeParse(manifest).success); assert.equal(manifest.version, '3.17.3'); assert.equal(json('tables/workbook-format.json').generator, `case-compile@${manifest.version}`); assert.deepEqual(json('pack.json'), manifest);
  const files = await packFiles(); assert.ok(files.includes('functions/runtime-contract.ts')); assert.ok(files.includes('tables/runtime-profile-format.json'));
  assert.ok(!files.some((path) => path.endsWith('.test.ts') || path === 'functions/test-support.ts' || path.startsWith('testing/')));
  assert.ok(!files.includes('functions/contract.ts') && !files.includes('functions/plan.ts'));
});
test('workflow binds the published profile and exposes reservation addresses under bed/', () => {
  const workflow = WorkflowFile.parse(json('workflow.json'));
  assert.deepEqual(workflow.inputs.map((v) => [v.slot, v.role, v.required]), [['subject', 'subject', true], ['contract', 'expected', true], ['inventory', 'expected', true], ['profile', 'expected', true], ['workbook', 'artifact_under_verification', false], ['plan_result', 'expected', false], ['case_index','expected',false],['criteria_review','expected',false],['criteria_review_run','expected',false],['recomposition_run','expected',false],['recomposition_result','expected',false]]);
  assert.equal(workflow.parameters.find((v) => v.name === 'autoid')?.required, false);
  assert.equal(workflow.leases?.prefix, 'bed/'); assert.deepEqual(workflow.context, ['leases']); assert.deepEqual(workflow.product.catalogs, ['commands@1']);
});
test('every check serves one requirement and repairable codes have exactly two rounds', () => {
  const checks = json('checks.json').checks as Array<{ id: string; tier: string }>;
  const requirements = RequirementsFile.parse(json('requirements.json')).requirements;
  assert.deepEqual(checks.map((v) => v.id), ['contract_shape', 'bed_addresses', 'commands_catalog', 'expected_sources', 'expected_quotes', 'scenario_fidelity', 'workbook_verified', 'dispatch_policy']);
  assert.ok(checks.every((v) => v.tier === 'blocking'));
  assert.deepEqual([...new Set(requirements.flatMap((v) => v.checks))].sort(), checks.map((v) => v.id).sort());
  assert.ok(!requirements.some((v) => v.key === 'plan_deterministic'));
  const declared = new Set(json('tables/codes.json').violations.map((v: any) => v.code));
  const repairs = requirements.flatMap((v) => v.error_handling);
  for (const code of declared) assert.ok(repairs.some((v) => v.code === code && v.action === 'repair' && v.max_rounds === 2), String(code));
});
test('complete slot schema retains legacy fields and declares B1 blocks', () => {
  SlotsFile.parse(json('slots.schema.json'));
  const shape = json('slots.schema.json').item.plan.data;
  assert.deepEqual(shape.required, ['bucket', 'blocks', 'steps', 'expects', 'replacements']); assert.equal(shape.additionalProperties, false);
  assert.ok(shape.properties.blocks.items.anyOf.length > 0); assert.equal(json('tables/block-plan.schema.json').properties.steps.maxItems,0); assert.deepEqual(shape.properties.steps.items.required, ['object', 'method', 'args', 'keywords']);
  assert.deepEqual(shape.properties.expects.items.required, ['text', 'quote', 'after']);
});
test('each runtime plan rule has paired positive and negative author samples', () => {
  const positive = readdirSync(join(PACK_DIR, 'samples/positive')).sort(); const negative = readdirSync(join(PACK_DIR, 'samples/negative')).sort();
  assert.deepEqual(positive, negative); assert.equal(positive.length, 16+json('tables/blocks-format.json').kinds.filter((kind:any)=>kind.enabled).length);
  const coverage = new Set<string>();
  for (const name of positive) {
    const yes = json(`samples/positive/${name}`); const no = json(`samples/negative/${name}`);
    assert.equal(yes.check, no.check); coverage.add(yes.check); assert.ok(yes.expect.every((v: any) => v.verdict === 'support')); assert.ok(no.expect.some((v: any) => v.verdict === 'refute' && v.code));
  }
  assert.deepEqual([...coverage].sort(), json('checks.json').checks.map((v: any) => v.id).sort());
});
test('the examples use the original synthetic contract, matching profile and final-text slots', () => {
  const contract = parseRuntimeContract(json('examples/runtime-contract-v2.json')); const manifest = parseManifest(json('examples/bed-topology.json'));
  assert.ok(contract.ok && manifest.ok); if (!contract.ok || !manifest.ok) return;
  const profile = parseProfile(json('examples/runtime-profile-v2.json'), contract.contract, manifest.beds); assert.ok(profile.ok); if (profile.ok) assert.equal(profile.profile.synthetic, true);
  assert.equal(profile.ok && profile.profile.workbook.header.length, 9);
  const start = json('examples/start-run.json').arguments; assert.equal(typeof start.parameters.autoid, 'string'); assert.ok(start.inputs.profile.external.startsWith('doc:doc:'));
  const data = json('examples/submit-result.json').items[0].slots.plan[0].data; assert.deepEqual(data.blocks, []); assert.ok(Array.isArray(data.steps[0].args)); assert.equal(typeof data.expects[0].after, 'number');
});
// Keep the client instructions within the existing skill budget.
const SKILL_BUDGET = 9630;
test('the client skill specifies verification and continuation without a Hub content generator', () => {
  const skill = read('SKILL.md'); assert.ok(skill.length <= SKILL_BUDGET, `SKILL.md is ${skill.length} chars, budget ${SKILL_BUDGET}`); for (const phrase of ['受限结构', '按合成执行器规则或发布的执行器规则核对', '不证明在真实设备上跑得通', '自动重交', '最多重交 2 次', '第二次 start_run']) assert.ok(skill.includes(phrase), phrase);
});
test('the client skill says when the user is asked and that a subagent never asks', () => {
  const skill = read('SKILL.md');
  for (const phrase of ['只在答案会改变做法、资料里又查不到时问使用者', '设备的问题还是原始用例的问题，需要使用者决定', '能查清的自己查并在报告说明', '子代理不问使用者：定不了的写进给主代理的报告']) assert.ok(skill.includes(phrase), phrase);
});
test('the client skill and the closing procedure carry the reference rules on parameter values, authored negatives and refused commands', () => {
  const skill = read('SKILL.md'), closing = read('tools/delivery.md');
  for (const phrase of [
    '手册对各参数的说明',
    '参数取值：写进命令的每个值都要在手册对该参数的说明之内',
    '原始用例要求的取值或写法被手册排除、期望却是成功时，先让使用者决定，不照写上机，也不自行改掉；原始用例本来要测非法输入时照写',
    '重组时使用者已决定的照做，不再问',
    '只有设备执行时才产生的值，要在同一条自动化用例里先取出再用',
    '不写死设备生成的名字，不从上一次上机验证的设备输出抄值，也不沿用设备上已有的东西',
    '不把这句话当设备输出去找，也不删掉这项检查；检查设备输出里没有对应记录',
    '设备上的配置和观察都用执行器规则为该设备声明的方法',
    '要跑很久的设备命令，在那一步给足读取时间，秒数不超过测试环境上限',
  ]) assert.ok(skill.includes(phrase), phrase);
  assert.ok(!skill.includes('纯描述判断'), 'the runner has no judgement by description: a sentence in text is searched for word by word');
  for (const phrase of [
    '设备输出包含执行器规则声明的执行失败原话时',
    '问题在这条自动化用例自己的命令顺序',
    '先确认上次修改已进本次自动化用例 Excel；已经改了而同一句设备输出又出现，就换解释',
    '重新编写要保住原始用例的范围和每一项期望',
    'submit-plans 会跳过本次排除的原始用例，不用复制或改写文件',
    '说明设备名字和哪些清理没做，残留没核清之前不上机验证下一份自动化用例 Excel',
    '原始用例要的取值被手册排除时，写原始用例的问题，不写设备的问题',
    '只有设备的问题有对应原句和设备输出，或原始用例与手册不一致，才可提前写结论',
    '原始用例与手册不一致且使用者尚未决定的，先排除',
    'author_conflict 仅在原始用例与手册不一致时填写',
    '{"author":"原始用例原句","manual":"手册原话","reference":"<下载文件中的手册引用>"}',
    '不论编写几轮、是否上机，均可等待作者或使用者决定，不再为它上机',
    '核原句存在不证明模型对两句话的理解正确',
    '不和 defect_candidate 同写；原始用例本来就测非法输入时不用这一项',
  ]) assert.ok(closing.includes(phrase), phrase);
});

test('the recompose skill raises an author step the manual excludes to the user before writing, through the lead agent, and records the ruling in the fields a record already has', () => {
  const recompose = read('recompose/SKILL.md');
  for (const phrase of [
    '原始用例要求的取值或写法被手册和命令树排除，期望却是成功时',
    '先让使用者决定，不自行改写，也不照写上机',
    '原始用例要测的正是非法输入、期望就是被拒绝时，不算这种问题',
    '只有主代理问使用者。子代理不问',
    '整份原始用例的这类问题攒齐了问一次',
    '只用已有字段保存决定，不另造结构',
    'states.reason 以“使用者决定：”开头，逐字写使用者的话；state=settled',
    'concretizations.decided_by="使用者"',
    '脚本编写先排除，交付时写原始用例的问题',
    '不用 conflict: 它要求两个有签发权的来源，原始用例和手册都不是',
  ]) assert.ok(recompose.includes(phrase), phrase);
});

test('the client skill makes the model adapt the bed, seed what assertions read and clean up in reverse', () => {
  const skill = read('SKILL.md');
  for (const phrase of ['按测试环境改写、前置与清理', '不得选用承载监听或触发通路的接口', '恢复原地址', '要查询的记录先在步骤前部创建', '应答状态码、应答条数', '按改动逆序排列', '查询类步骤不需要清理']) assert.ok(skill.includes(phrase), phrase);
  const plan = json('requirements.json').requirements.find((r: any) => r.key === 'plan');
  for (const phrase of ['先在前部创建', '逆序对应的逆操作', '恢复原地址']) assert.ok(plan.description.includes(phrase), phrase);
  const grounded = json('requirements.json').requirements.find((r: any) => r.key === 'expected_grounded');
  for (const phrase of ['可机械核对的输出', '先建好被查记录', '仍以 quote 逐字保留作依据']) assert.ok(grounded.description.includes(phrase), phrase);
});
test('the example plan seeds the queried record, asserts mechanically and cleans up in reverse', () => {
  const data = json('examples/submit-result.json').items[0].slots.plan[0].data;
  const texts = data.steps.map((step: any) => step.args[0] ?? '');
  // 前置：查询断言读的记录先建好（第 1 步创建，早于第 3 步的查询）。
  assert.ok(texts[0].includes('record synth-rec-01 create'), texts[0]);
  const queryAt = texts.findIndex((text: string) => text.startsWith('show health record'));
  const createAt = texts.findIndex((text: string) => text.includes('record synth-rec-01 create'));
  assert.ok(createAt > -1 && queryAt > createAt, 'the record exists before the query reads it');
  // 机械核对：一条期望保持逐字原文，一条 model_judgment 选可观察的合计行并带理由。
  const literal = data.expects.find((expect: any) => expect.basis === undefined);
  const judged = data.expects.find((expect: any) => expect.basis === 'model_judgment');
  assert.ok(literal && judged && typeof judged.rationale === 'string' && judged.rationale.length > 0);
  // 清理段：每条改配置的步骤在末尾有逆操作，逆序排列；查询步骤没有逆操作。
  const cleanups = texts.filter((text: string) => text.startsWith('no '));
  assert.deepEqual(cleanups, ['no widget health interval', 'no widget health record synth-rec-01'], 'cleanup mirrors the mutations in reverse');
  const mutating = texts.filter((text: string) => !text.startsWith('no ') && !text.startsWith('show '));
  assert.equal(cleanups.length, mutating.length, 'every mutating step has exactly one cleanup');
});

function emittedCodes():Set<string>{
 const used=new Set<string>();
 for(const name of readdirSync(join(PACK_DIR,'functions')).filter(name=>name.endsWith('.ts')&&!name.endsWith('.test.ts')&&name!=='test-support.ts')){
  const file=ts.createSourceFile(name,read('functions/'+name),ts.ScriptTarget.Latest,true);
  const addArgument=(node:ts.Node):void=>{if(ts.isStringLiteralLike(node)&&/^[a-z][a-z0-9_]*$/.test(node.text))used.add('case-compile.'+node.text);else if(ts.isConditionalExpression(node)){addArgument(node.whenTrue);addArgument(node.whenFalse);}};
  const visit=(node:ts.Node):void=>{
   if(ts.isStringLiteralLike(node)&&/^case-compile\.[a-z0-9_]+$/.test(node.text))used.add(node.text);
   // binding.issue emits pack codes; workbook.issue records internal reader rules under workbook_invalid.
   if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)){const kind=node.expression.text;if(kind==='refusal'||kind==='issue'&&name==='binding.ts'){if(node.arguments[0])addArgument(node.arguments[0]);}else if(kind==='refute'&&node.arguments[1])addArgument(node.arguments[1]);}
   ts.forEachChild(node,visit);
  };visit(file);
 }return used;
}
test('every emitted pack code and every pack repair code is declared',()=>{
 const table=json('tables/codes.json');const declared=new Set<string>([...table.violations,...table.refusals,...table.warnings].map(v=>v.code));
 const used=emittedCodes();assert.ok(used.size>20);for(const code of used)assert.ok(declared.has(code),`emitted code missing from tables/codes.json: ${code}`);
 for(const row of json('requirements.json').requirements.flatMap((r:any)=>r.error_handling))if(row.code.startsWith('case-compile.'))assert.ok(declared.has(row.code),`repair code missing from tables/codes.json: ${row.code}`);
});

test('published skill heading never advertises a stale pack version',()=>{
 // The standard Agent Skills frontmatter opens the file; the heading that follows it is what must not carry a stale version.
 const body=read('SKILL.md').replace(/^---\n[\s\S]*?\n---\n/,'');const heading=body.split('\n').find((line:string)=>line.trim()!=='') ?? '';const title='# 自动化用例';assert.ok(heading===title||heading===`${title} ${json('pack.json').version}`,heading);
});

test('repository manifest paths directly name ordinary files with their declared bytes',()=>{
  for(const file of json('pack.json').files) {
    const path=join(PACK_DIR,file.path);assert.equal(lstatSync(path).isFile(),true,file.path);
    const bytes=readFileSync(path);assert.equal(bytes.byteLength,file.size,file.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256,file.path);
  }
});
