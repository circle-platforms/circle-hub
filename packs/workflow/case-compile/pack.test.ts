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
import { renderAgentDefinition, renderTaskBrief, SUBAGENT_ROLES } from './functions/subagent-roles.ts';
import { RUN_DIRECTORY_FORM } from './tools/workspace-path.ts';
import { foreignCommands, shownCommands } from './testing/shown-commands.ts';
import { ATTRIBUTION, PRODUCER_KIND, labelOf } from './functions/generated/vocabulary.ts';
const read = (path: string) => readFileSync(join(PACK_DIR, path), 'utf8');
const json = (path: string): any => JSON.parse(read(path));
test('version 2.0 manifest lists exactly the published files and excludes development fixtures', async () => {
  const manifest = await computeManifest();
  assert.equal(PackManifest.safeParse(manifest).success, true);
  assert.equal(manifest.version, '3.26.5');
  assert.equal(json('tables/workbook-format.json').generator, `case-compile@${manifest.version}`);
  assert.deepEqual(json('pack.json'), manifest);
  const files = await packFiles();
  assert.ok(files.includes('functions/runtime-contract.ts'));
  assert.ok(files.includes('functions/subagent-roles.ts'));
  assert.ok(files.includes('tables/runtime-profile-format.json'));
  assert.ok(files.includes('tools/task-brief.ts'));
  assert.ok(!files.includes('tools/install-agents.ts'));
  assert.ok(files.includes('tools/workspace-path.ts'));
  for (const agent of ['compile-recomposer.md', 'compile-writer.md', 'compile-fidelity.md', 'compile-attributor.md']) {
    assert.ok(files.includes(`agents/${agent}`), agent);
  }
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
  assert.deepEqual(checks.map((v) => v.id), ['contract_shape', 'bed_addresses', 'commands_catalog', 'expected_sources', 'expected_quotes', 'author_step_coverage', 'scenario_fidelity', 'workbook_verified', 'dispatch_policy']);
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
  assert.deepEqual(positive, negative); assert.equal(positive.length, 17+json('tables/blocks-format.json').kinds.filter((kind:any)=>kind.enabled).length);
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
const SKILL_BUDGET = 9630;
test('the client skill specifies verification and continuation without a Hub content generator', () => {
  const skill = read('SKILL.md'); assert.ok(skill.length <= SKILL_BUDGET, `SKILL.md is ${skill.length} chars, budget ${SKILL_BUDGET}`); for (const phrase of ['受限结构', '按合成执行器规则或发布的执行器规则核对', '不证明在真实设备上跑得通', '自动重交', '最多重交 2 次', '后台**跑合并工具', "open-merge.ts' --hub %HUB_URL% --open 'open-compile.json' --plans 'plans'", '脚本合并运行只由合并工具开，不手写 `start_run`', 'predecessor', '有失败不停在报告、不问使用者，直接按下节返工', '返工（只改失败案）']) assert.ok(skill.includes(phrase), phrase);
});
test('--run is the run id or the run directory in every declaration, and nothing taught or printed passes the run.json file as --run', () => {
  const declared = [
    ...readdirSync(join(PACK_DIR, 'tools')).filter((name) => name.endsWith('.cli.json')).map((name) => `tools/${name}`),
    ...readdirSync(join(PACK_DIR, 'recompose', 'tools')).filter((name) => name.endsWith('.cli.json')).map((name) => `recompose/tools/${name}`),
  ];
  const directories: string[] = [], ids: string[] = [];
  for (const file of declared) {
    const declaration = json(file), run = declaration.options.find((option: any) => option.name === 'run');
    if (run === undefined) continue;
    if (run.type === 'run') { ids.push(file); continue; }
    directories.push(file);
    assert.equal(run.type, 'path', file);
    const placeholders = [run.placeholder, ...declaration.forms.flatMap((form: any) => form.pairs.filter((pair: any) => pair.name === 'run').map((pair: any) => pair.placeholder))].filter((value) => value !== null);
    for (const placeholder of placeholders) assert.ok(placeholder === '<运行目录>' || placeholder === '<run directory>', `${file}: ${placeholder}`);
    assert.equal(run.placeholder, '<运行目录>', file);
  }
  assert.deepEqual(directories.sort(), ['recompose/tools/check-record.cli.json', 'tools/check-plan.cli.json', 'tools/cmd-lookup.cli.json', 'tools/cmd-select-plumb.cli.json', 'tools/cmd-verify-plumb.cli.json', 'tools/fidelity-apply.cli.json', 'tools/fidelity-brief.cli.json', 'tools/fidelity-plumb.cli.json', 'tools/generate-workbook.cli.json', 'tools/seal-recompose.cli.json', 'tools/task-brief.cli.json']);
  assert.deepEqual(ids.sort(), ['recompose/tools/download-run.cli.json', 'recompose/tools/submit-records.cli.json', 'tools/download-returns.cli.json', 'tools/download-run.cli.json', 'tools/fetch-run.cli.json', 'tools/refresh-late.cli.json', 'tools/submit-plans.cli.json']);
  const texts = [
    'SKILL.md', 'recompose/SKILL.md', ...readdirSync(join(PACK_DIR, 'tools')).filter((name) => name.endsWith('.md')).map((name) => `tools/${name}`),
    ...readdirSync(join(PACK_DIR, 'agents')).map((name) => `agents/${name}`),
    ...readdirSync(join(PACK_DIR, 'tools')).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts')).map((name) => `tools/${name}`),
    ...readdirSync(join(PACK_DIR, 'recompose', 'tools')).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts')).map((name) => `recompose/tools/${name}`),
    'functions/subagent-roles.ts', 'functions/plan-boundary.ts', 'functions/authoring-brief.ts', 'functions/fidelity.ts', 'functions/cmd-lookup.ts',
    '../../../docs/member-guide.md',
  ];
  for (const file of texts) assert.doesNotMatch(read(file), /--run\s+['"]?[<\w./\-\u4e00-\u9fff>]*run\.json/, file);
  assert.ok(read('recompose/tools/check-record.ts').includes(`"${RUN_DIRECTORY_FORM}"`));
});
test('the writer is told to write one Chinese line per block, and the skill says the command tree decides what Plumb only advises', () => {
  const skill = read('SKILL.md'), writer = read('agents/compile-writer.md'), role = SUBAGENT_ROLES.find((r) => r.key === 'plan')!;
  const rule = '每个块写一行中文 description，说明这一块做什么（不是抄作者步骤）';
  assert.ok(role.body.includes(rule) && writer.includes(rule), 'role text and the bundled agent file say it, identically');
  assert.ok(skill.length <= SKILL_BUDGET, `SKILL.md is ${skill.length} chars, budget ${SKILL_BUDGET}`);
  for (const phrase of ['命令核验以命令树为准', '命令树核对不过的必改', '只标需人工复核，不阻断']) assert.ok(skill.includes(phrase), phrase);
  const block = json('slots.schema.json').item.plan.data.properties.blocks.items.anyOf[0].properties.description;
  assert.equal(block.type, 'string'); assert.match(block.description, /不是抄作者步骤/);
});
test('the writer text and the block declarations teach no usage derived from one feature or case, and the runner contract for a cell value is one generic sentence', () => {
  const writer = read('agents/compile-writer.md'), role = SUBAGENT_ROLES.find((r) => r.key === 'plan')!;
  const caseDerived = [
    '取名字的一段', '设备生成的往往只是名字的一段', '只取这一段', '逐列钉死', '长度、后缀各一列',
    '设备上可能残留同名配置时', '先用产品声明的逆操作清掉再配置', '本身不需要再配清理，被它清掉的配置命令自己的清理照旧',
  ];
  for (const [file, text] of [['subagent-roles.ts body', role.body], ['agents/compile-writer.md', writer]] as Array<[string, string]>)
    for (const phrase of caseDerived) assert.ok(!text.includes(phrase), `${file}: ${phrase}`);
  const table = json('tables/blocks-format.json');
  for (const name of ['input_register', 'column', 'select']) assert.equal(table.fields[name].description, undefined, name);
  for (const file of ['tables/blocks-format.json', 'tables/block-plan.schema.json', 'slots.schema.json'])
    for (const phrase of ['取名字的一段', 'between known words']) assert.ok(!read(file).includes(phrase), `${file}: ${phrase}`);
  const contract = '只有设备执行时才产生的值，要在同一条自动化用例里先取出再用，取出的单格写进后面命令的 `{}`，运行器把它整个替换进去，`{}` 可以在引号里；手册允许指定名字时，由生成器指定';
  assert.ok(role.body.includes(contract) && writer.includes(contract), 'the one sentence of the runner contract');
  for (const phrase of ['写进命令的每个值都要在手册对该参数的说明之内，包括长度、允许的字符、范围和可选值', '不写死设备生成的名字，不从上一次上机验证的设备输出抄值，也不沿用设备上已有的东西']) assert.ok(role.body.includes(phrase) && writer.includes(phrase), phrase);
});
test('every device command the roles, the skills, the tool documents, the declarations, the samples and the examples show is a command of the synthetic command trees of these tests, and the cleanup rules are stated by the contract', () => {
  const writer = read('agents/compile-writer.md'), role = SUBAGENT_ROLES.find((r) => r.key === 'plan')!;
  const files = [
    'SKILL.md', 'recompose/SKILL.md', ...readdirSync(join(PACK_DIR, 'tools')).filter((name) => name.endsWith('.md')).map((name) => `tools/${name}`),
    ...readdirSync(join(PACK_DIR, 'agents')).map((name) => `agents/${name}`),
    'tables/blocks-format.json', 'tables/block-plan.schema.json', 'slots.schema.json',
    ...['positive', 'negative'].flatMap((kind) => readdirSync(join(PACK_DIR, 'samples', kind)).map((name) => `samples/${kind}/${name}`)),
    ...readdirSync(join(PACK_DIR, 'examples')).map((name) => `examples/${name}`),
  ];
  const texts: Array<[string, string]> = [...SUBAGENT_ROLES.map((spec) => [`${spec.key} role`, spec.body] as [string, string]), ...files.map((file) => [file, read(file)] as [string, string])];
  assert.ok(texts.reduce((count, [, text]) => count + shownCommands(text).length, 0) > 0, 'the files show device commands');
  for (const [file, text] of texts) assert.deepEqual(foreignCommands(text), [], file);
  assert.deepEqual(foreignCommands('先配 `gizmo mode on` 再查看'), ['gizmo mode on'], 'a command in prose that no synthetic tree has is found');
  assert.deepEqual(foreignCommands(JSON.stringify({ blocks: [{ call: { object: 'ORBIT_0', method: 'command', args: ['gizmo mode on'] } }] })), ['gizmo mode on'], 'and one in a block call');
  for (const phrase of [
    '产品声明了互逆取值的开关（`command_policy`）：按声明在同设备的 `cleanup:true` 配对写出逆操作，完成关闭后才交运行器的整体清除，不能只依赖整体清除',
    '运行器自动清理（对 `contract.cleanup` 声明的清配对象发出、命中其前缀规则的配置命令，收尾命令也由合约声明）',
    '存盘等运行器收尾命令禁写 cleanup:true',
    '命中 `contract.cleanup` 声明的自动清理或收尾命令时禁写 `cleanup: true`',
  ]) assert.ok(role.body.includes(phrase) && writer.includes(phrase), phrase);
  for (const file of ['tables/blocks-format.json', 'tables/block-plan.schema.json', 'slots.schema.json']) assert.ok(read(file).includes('存盘等由执行器在收尾时做的命令禁止标为 cleanup:true'), file);
});
test('the writer is told that the documentation address the recomposition record put into its adapted commands is no replacement source, and what to write instead (round 37)', () => {
  const writer = read('agents/compile-writer.md'), role = SUBAGENT_ROLES.find((r) => r.key === 'plan')!;
  const line = '- 重组记录的改写命令里按规则暂用的文档保留地址（RFC 5737/3849，记在它的 unknowns 里）不是作者写的地址：不进 replacements，用到它的位置在步骤命令里直接写测试环境清单里的地址；replacements 只放作者原文命令里的地址，没有就写 []。';
  assert.ok(role.body.includes(line) && writer.includes(line), 'role text and the bundled agent file carry the line, identically');
  assert.equal(writer.split('\n').filter((row) => row.includes('文档保留地址')).length, 1, 'one line');
});
test('the writer is told that every authored action of the record must be named by some step\'s author_step_refs, and that a step it cannot realize is reported, not forced (round 36, a2)', () => {
  const writer = read('agents/compile-writer.md'), role = SUBAGENT_ROLES.find((r) => r.key === 'plan')!;
  for (const phrase of [
    'author_step_refs 必须覆盖作者步骤：本条重组记录 atoms 里每条 kind 为 action 的 id（items/<n>.json，如 a2，不是序号）都要写进至少一步的 author_step_refs:["a2"]（blocks 模式写在块上）',
    '没有任何一步写它，check-plan 拒绝并点名；实现不了的不要硬凑，在最终回复向主代理报告原因',
  ]) assert.ok(role.body.includes(phrase) && writer.includes(phrase), phrase);
  assert.ok(!writer.includes('可选 author_step_refs'), 'author_step_refs is no longer taught as optional');
});
test('the client skill says that nobody asks the user and in which order a choice is made', () => {
  const skill = read('SKILL.md');
  for (const phrase of ['全程不问使用者（不调用 `question`）', '有多种做法时依次取：合同构建手册和命令树、保住作者步骤与边界、执行器能判定、改动最小', '`states.reason` 以“模型决定：”开头', '主代理和子代理都不问使用者：能查清的自己查，定不了的按第 1 节的次序自行决定并在报告说明']) assert.ok(skill.includes(phrase), phrase);
  assert.ok(!/问使用者（设备的问题|先让使用者决定|攒齐问一次/.test(skill), 'the skill no longer sends a choice to the user');
});
test('the client skill and the closing procedure carry the reference rules on parameter values, authored negatives and refused commands', () => {
  const skill = read('SKILL.md'), writer = read('agents/compile-writer.md'), closing = read('tools/delivery.md');
  const writerRole = SUBAGENT_ROLES.find((role) => role.key === 'plan')!;
  const renderedBrief = renderTaskBrief({
    role: writerRole,
    caseRef: 'case-1',
    briefPath: 'briefs/1.md',
    outPath: 'plans/1.json',
    skillDir: '/synthetic/skills/case-compile',
    scopeText: '全部用例',
  });
  for (const phrase of [
    '原始用例要求的取值或写法被手册排除、期望却是成功时，按手册做最小改写，保住被测对象、动作和边界；原始用例本就测非法输入时照写',
    '`scope.md` 里使用者已有决定的照做',
  ]) assert.ok(skill.includes(phrase), phrase);
  for (const phrase of [
    '手册对各参数的说明',
    '参数取值：写进命令的每个值都要在手册对该参数的说明之内',
    '只有设备执行时才产生的值，要在同一条自动化用例里先取出再用',
    '不写死设备生成的名字，不从上一次上机验证的设备输出抄值，也不沿用设备上已有的东西',
    '不把这句话当设备输出去找，也不删掉这项检查；检查设备输出里没有对应记录',
    '设备上的配置和观察都用执行器规则为该设备声明的方法',
    '要跑很久的设备命令，在那一步给足读取时间，秒数不超过测试环境上限',
  ]) {
    assert.ok(writer.includes(phrase), phrase);
    assert.ok(writerRole.body.includes(phrase), phrase);
    assert.ok(closing.includes(phrase), phrase);
  }
  assert.ok(renderedBrief.includes('compile-writer'));
  assert.ok(renderedBrief.includes("--file 'plans/1.json'"));
  assert.ok(!renderedBrief.includes(writerRole.body), 'named role rules are installed once, while task inputs carry the current identity');
  assert.ok(!skill.includes('纯描述判断') && !writer.includes('纯描述判断'), 'the runner has no judgement by description: a sentence in text is searched for word by word');
  for (const phrase of [
    '设备输出包含执行器规则声明的执行失败原话时',
    '不单凭它判定原因属于模型或设备',
    '先确认上次修改已进本次自动化用例 Excel；已经改了而同一句设备输出又出现，就换解释',
    '重新编写要保住原始用例的范围和每一项期望',
    '它排除没通过的条目、新开一次脚本编写运行（禁止往已锁定的上一轮运行提交变更）、把通过的自动化用例连同已有的保真判断原样结转',
    '说明设备名字和哪些清理没做，残留没核清之前不上机验证下一份自动化用例 Excel',
    '原始用例要的取值被手册排除时，写原始用例的问题，不写设备的问题',
    '报告存在不意味着未知条目必须提前停止编写',
    'parameters.exclude 排除尚未决定的原始用例',
    'author_conflict 仅在原始用例与手册不一致时填写',
    '{"author":"原始用例原句","manual":"手册原话","reference":"<下载文件中的手册引用>"}',
    '不论编写几轮、是否上机，均可等待作者或使用者决定，不再为它上机',
    '核原句存在不证明模型对两句话的理解正确',
    '不和 defect_candidate 同写；原始用例本来就测非法输入时不用这一项',
  ]) assert.ok(closing.includes(phrase), phrase);
});

test('the recompose skill rewrites an author step the manual excludes by the manual without asking, and records the decision in the fields a record already has', () => {
  const recompose = read('recompose/SKILL.md');
  for (const phrase of [
    '原始用例要求的取值或写法被手册和命令树排除，期望却是成功时',
    '不问使用者，也不照写上机：按手册和命令树做最小改写，保住被测对象、被测动作和边界',
    '原始用例要测的正是非法输入、期望就是被拒绝时，不算这种问题',
    '主代理和子代理都不问使用者',
    '有多种改法时依次取：与同构建手册和命令树一致、保住作者步骤与边界、已声明执行器能判定、改动最小',
    'states.reason 以“模型决定：”开头，写原句、手册原话和改法；state=settled',
    '只用已有字段保存决定，不另造结构',
    'states.reason 以“使用者决定：”开头，逐字写使用者的话；state=settled',
    'concretizations.decided_by="模型"',
    '不用 conflict: 它要求两个有签发权的来源，原始用例和手册都不是',
  ]) assert.ok(recompose.includes(phrase), phrase);
});

test('the recompose skill and the attributor name conclusions, causes and deciders by the labels of the generated vocabulary', () => {
  const recompose = read('recompose/SKILL.md'), attributor = read('agents/compile-attributor.md');
  const conclusions = (['pass', 'fail', 'no_verdict'] as const).map((code) => labelOf('dynamic_terminal', code));
  assert.ok(recompose.includes(`结论只用${conclusions.join('、')}`), 'recompose conclusions');
  assert.ok(recompose.includes(`原因只用生成词表的归因标签：${ATTRIBUTION.map((code) => labelOf('attribution', code)).join('、')}`), 'recompose causes');
  assert.ok(recompose.includes(`决定者用${PRODUCER_KIND.map((code) => labelOf('producer_kind', code)).join('、')}`), 'recompose deciders');
  assert.ok(attributor.includes(`写出结论（只用${conclusions[0]}、${conclusions[1]}或${conclusions[2]}）`), 'attributor conclusions');
  for (const text of [recompose, attributor]) assert.ok(!text.includes('正确/错误') && !text.includes('判断只用正确或错误'));
});

test('the recompose skill leaves opening, checking and submitting to the case-compile tools, and submits a self-check whose remaining problems are all unknown, as the pipeline does', () => {
  const recompose = read('recompose/SKILL.md');
  assert.ok(recompose.includes('在 case-compile 里，开运行由 `open-compile.ts` 做，每条用例的重组任务、自检和提交由 `pipeline.ts` 派发和执行'));
  assert.ok(recompose.includes('输出 `ok=true`，或剩下的问题全是 `"verdict":"unknown"`（本地读不到的引用，交 Hub 判定）时才提交'));
  assert.ok(!recompose.includes('inputs.recomposition_run') && !recompose.includes('inputs.recomposition_result'), 'case-compile runs are opened by open-compile.ts only');
  assert.match(recompose, /^---\nname: recompose\ndescription: [^\n]*时使用/);
});

test('the client skill dispatches case-compile:compile-* subagents via task-brief and scope.md while role specs keep writer rules', () => {
  const skill = read('SKILL.md'), writer = read('agents/compile-writer.md');
  assert.ok(skill.includes('scope.md'));
  assert.ok(skill.includes('task-brief.ts'));
  assert.ok(skill.includes('case-compile:compile-writer'));
  assert.ok(!skill.includes('general-purpose'));
  assert.ok(skill.includes('装进当前主目录的 `skills` 目录'));
  assert.ok(skill.includes("tools/open-compile.ts' --hub %HUB_URL% --plumb %PLUMB_URL%"));
  assert.ok(skill.includes('“无法编译：…”时把这一行原样告诉使用者，然后停止'));
  assert.ok(skill.includes('workflow({"script_path":"<技能目录>/workflows/compile-loop.js","args":{"pipeline":"<技能目录>/tools/pipeline.ts","state":"pipeline.json"}})'));
  assert.ok(skill.includes('子代理由编写循环派发，主代理不逐个派 `task`'));
  assert.ok(skill.includes('同时在跑的子代理在 6 个以内，结束一个补一个'));
  assert.ok(skill.includes('照第 0 节启动循环'));
  for (const hand of ['--finished', '交标签', '派一个 `task`']) assert.ok(!skill.includes(hand), `the lead is no longer told: ${hand}`);
  assert.ok(!skill.includes('每批最多 6 个'));
  assert.ok(!skill.includes('严禁用 `background`'));
  assert.ok(!skill.includes('前台方式并列多个 `task`'));
  assert.ok(!skill.includes('install-agents.ts'));
  assert.ok(!skill.includes('.circle/agents'));
  for (const phrase of ['按测试环境改写、前置与清理', '不得选用承载监听或触发通路的接口', '恢复原地址', '要查询的记录先在步骤前部创建', '应答状态码、应答条数', '按改动逆序排列', '查询类步骤不需要清理']) assert.ok(writer.includes(phrase), phrase);
  const plan = json('requirements.json').requirements.find((r: any) => r.key === 'plan');
  for (const phrase of ['先在前部创建', '逆序对应的逆操作', '恢复原地址']) assert.ok(plan.description.includes(phrase), phrase);
  const grounded = json('requirements.json').requirements.find((r: any) => r.key === 'expected_grounded');
  for (const phrase of ['可机械核对的输出', '先建好被查记录', '仍以 quote 逐字保留作依据']) assert.ok(grounded.description.includes(phrase), phrase);
});
test('bundled subagent definitions match single-source role specs and exclude model/question/task', () => {
  const expected: Record<string, string[]> = {
    'compile-recomposer': ['read_file', 'write_file', 'edit_file', 'ls', 'glob', 'grep', 'execute'],
    'compile-writer': ['read_file', 'write_file', 'edit_file', 'ls', 'glob', 'grep', 'execute'],
    'compile-fidelity': ['read_file', 'write_file', 'edit_file', 'ls', 'glob', 'execute'],
    'compile-attributor': ['read_file', 'write_file', 'ls', 'glob', 'grep'],
  };
  assert.deepEqual(SUBAGENT_ROLES.map((r) => r.agentName).sort(), Object.keys(expected).sort());
  for (const role of SUBAGENT_ROLES) {
    const raw = read(`agents/${role.agentName}.md`);
    assert.equal(raw, renderAgentDefinition(role), role.agentName);
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/.exec(raw);
    assert.ok(match, role.agentName);
    const meta = new Map<string, string>();
    for (const line of match[1].split('\n')) {
      const idx = line.indexOf(':');
      assert.ok(idx > 0, `${role.agentName}: ${line}`);
      meta.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
    }
    assert.deepEqual([...meta.keys()].sort(), ['description', 'maxTurns', 'name', 'sessionPrompt', 'tools'], role.agentName);
    assert.equal(meta.get('sessionPrompt'), 'false', role.agentName);
    assert.equal(meta.get('maxTurns'), String(role.maxTurns), role.agentName);
    assert.equal(meta.get('name'), role.agentName);
    assert.ok((meta.get('description') ?? '').length > 0, role.agentName);
    assert.deepEqual(meta.get('tools')?.split(',').map((v) => v.trim()), expected[role.agentName], role.agentName);
    assert.ok(!role.tools.includes('question') && !role.tools.includes('task'), role.agentName);
    assert.ok(match[2].includes('本子代理只承担'), role.agentName);
    assert.ok(!raw.includes('<技能目录>'), `${role.agentName}: bundled agent must not contain <技能目录>`);
  }
});
test('the preserved undeclared example still seeds the queried record, asserts mechanically and cleans up in reverse', () => {
  const data = JSON.parse(json('testing/undeclared-example.json').submission).items[0].slots.plan[0].data;
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
test('SKILL.md and delivery.md distinguish same-run resubmit from the three start_run rework boundaries', () => {
  const skill = read('SKILL.md');
  const delivery = read('tools/delivery.md');
  assert.ok(skill.includes('open-compile.ts') && skill.includes('--recompose-run'));
  assert.ok(skill.includes('同一 `plan_run` 尚未进入 `merge_run`'), 'must allow same-run resubmit before merge_run');
  assert.ok(skill.includes('rounds_left=0'), 'must name repair_exhausted boundary');
  assert.ok(skill.includes('scope`/`exclude`/`inputs` 变化'), 'must name scope/exclude/inputs change boundary');
  assert.ok(skill.includes('禁止把改过的计划直接交进 `merge_run`'), 'must forbid direct plan edits into merge_run');
  assert.ok(skill.includes('carry-plans.ts'), 'SKILL.md must reference carry-plans.ts on new-run restarts');
  assert.ok(delivery.includes('open-compile.ts` 新开一次脚本编写运行'));
  assert.ok(delivery.includes('tools/carry-plans.ts'), 'delivery.md must show carry-plans.ts command');
});

test('H1/H4/Effort-AB: SKILL.md, recompose/SKILL.md, delivery.md and compile-recomposer enforce single lite shape, same-line heredoc, no direct terminal connection, 3-round stop and ls before dispatch', () => {
  const skill = read('SKILL.md');
  const recomposeSkill = read('recompose/SKILL.md');
  const delivery = read('tools/delivery.md');
  const recomposer = read('agents/compile-recomposer.md');

  assert.ok(!recomposer.includes('recompose-record.schema.json'), 'compile-recomposer must not reference full recompose-record.schema.json');
  assert.ok(recomposeSkill.includes("<<'EOF'"), 'recompose SKILL commands show same-line heredoc');
  assert.ok(skill.includes("<<'EOF'"), 'case-compile SKILL commands show same-line heredoc');
  assert.ok(delivery.includes("<<'EOF'"), 'delivery.md commands show same-line heredoc');
  for (const line of [...skill.split('\n'), ...recomposeSkill.split('\n'), ...delivery.split('\n')]) {
    if (/(?:download-run|submit-records|submit-plans|fetch-run|download-returns|assemble-delivery)\.ts\b/.test(line) && line.includes('%HUB_URL%')) {
      assert.ok(line.includes("<<'EOF'"), `same-line <<'EOF' missing on: ${line}`);
    }
  }
  assert.match(skill, /切勿在 <<'EOF' 前换行|同一行/);
  assert.match(skill, /不要用终端工具直连|严禁.*终端工具.*直连/);
  assert.match(delivery, /tools\/download-returns\.ts/);
  assert.doesNotMatch(delivery, /(?:^|\n)(?:ssh|telnet|nc)\s/m, 'delivery must consume downloaded returns instead of teaching direct terminal connections');
  assert.match(skill, /第 3 轮.*严禁第 4 轮|最多.*3 轮.*严禁第 4 轮/);
  assert.match(skill, /pipeline\.ts' init --recompose-run/);
  assert.match(skill, /"action":\s*"release"/);
  assert.match(skill, /"booking":/);
  assert.ok(skill.includes('--task-file') && skill.includes('短派发提示') && !skill.includes('标准输出全文'), 'SKILL.md uses --task-file short dispatch notice');
  assert.ok(skill.includes('--wait 3600') && delivery.includes('--wait 3600') && !skill.includes('--wait 600'), 'SKILL.md and delivery.md unify --wait 3600 with background');
  assert.ok(!skill.includes('管道或重定向') && !skill.includes('管道重定向'), 'SKILL.md drops unenforceable pipe/redirection ban');
  assert.ok(recomposeSkill.includes('check-record.ts'), 'recompose/SKILL.md runs check-record.ts before submit-records.ts');
});

test('P1.3 & P2: role specs enforce exact tool schemas/execute boundaries, fidelity.md uses task-brief, and recomposer teaches concrete CLI syntax', () => {
  const recomposer = read('agents/compile-recomposer.md');
  const writer = read('agents/compile-writer.md');
  const fidelityAgent = read('agents/compile-fidelity.md');
  const attributor = read('agents/compile-attributor.md');
  const recomposeSkill = read('recompose/SKILL.md');
  const fidelityDoc = read('tools/fidelity.md');

  for (const [name, content] of [
    ['compile-recomposer', recomposer],
    ['compile-writer', writer],
    ['compile-fidelity', fidelityAgent],
    ['compile-attributor', attributor],
  ] as const) {
    assert.ok(content.includes('file_path'), `${name} must state file_path parameter`);
    assert.ok(content.includes('write_file('), `${name} must state write_file parameter schema`);
    assert.ok(content.includes('ls({'), `${name} must state ls({ "path": ... }) parameter schema`);
  }
  for (const [name, content] of [
    ['compile-recomposer', recomposer],
    ['compile-writer', writer],
    ['compile-fidelity', fidelityAgent],
  ] as const) {
    assert.ok(content.includes('edit_file(') && content.includes('read_file'), `${name} must require read_file before edit_file`);
  }
  assert.ok(attributor.includes('无 `edit_file`') || attributor.includes('没有 edit_file'), 'attributor must note lack of edit_file');
  assert.ok(!attributor.includes('调 `edit_file`'), 'attributor must not instruct calling edit_file');
  for (const [name, content] of [
    ['compile-recomposer', recomposer],
    ['compile-writer', writer],
    ['compile-attributor', attributor],
  ] as const) {
    assert.ok(content.includes('<字面文字>') && !content.includes('<正则>'), `${name} must describe grep pattern as literal text`);
  }

  assert.ok(!recomposer.includes('严禁调用 execute') && recomposer.includes('check-record.ts --file'), 'recomposer runs only the check of its own record');
  assert.ok(attributor.includes('严禁调用'), 'attributor must ban execute even if exposed');
  assert.ok(!writer.includes('严禁调用 execute'), 'writer must keep check-plan.ts execute permission');
  assert.ok(!fidelityAgent.includes('严禁调用 execute'), 'fidelity must keep check-plan.ts execute permission');
  assert.ok(writer.includes('check-plan.ts --file'));
  assert.ok(fidelityAgent.includes('check-plan.ts --file'));
  assert.ok(!writer.includes('<技能目录>') && !fidelityAgent.includes('<技能目录>'));

  assert.ok(!fidelityDoc.includes('核对这些自动化用例是否改掉原始用例的场景：<文件路径，逐个列出>'));
  assert.ok(fidelityDoc.includes("task-brief.ts' --role '保真核对'"));

  assert.ok(!recomposer.includes('保持命令树可解析原值'));
  assert.ok(!recomposeSkill.includes('保持 command_tree 可解析的原值'));
  assert.ok(!recomposeSkill.includes('<名字> <IP>'));
  for (const doc of [recomposer, recomposeSkill]) {
    assert.ok(doc.includes('192.0.2.10'), 'must demonstrate RFC 5737 test IP');
    assert.ok(doc.includes('widget service ip "web1" 192.0.2.10'), 'must include positive CLI example');
    assert.ok(doc.includes('widget listener <arg1:ipv4/ipv6>'), 'must include negative template placeholder example');
  }
  assert.ok(!recomposer.includes('recompose-record.schema.json'));
});

test('start examples delegate version selection to Hub and skill forbids memory-pinned versions',()=>{
 const example=JSON.parse(read('examples/start-run.json'));assert.equal(example.arguments.pack,'case-compile');
 assert.match(read('SKILL.md'),/不要从记忆填写旧版本/);
});
