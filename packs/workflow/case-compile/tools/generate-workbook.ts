import { CallFailure } from '../functions/text.ts';
import { readSourceBytes } from '../functions/source-materials.ts';
import { planStateOf } from '../functions/plan-state.ts';
import {blockReviewSources} from '../functions/block-review-identity.ts';
import {selectedExpectedNodes} from '../functions/expected-nodes.ts';
// Offline recipe verification and artifact generation. Every source is read from the explicitly named local file.
import { realpathSync } from 'node:fs';
import { lstat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import REQUIREMENTS from '../requirements.json' with { type: 'json' };
import { formatCallError, isRecord, parseCliOptions } from '../functions/text.ts';
import { canonicalJson } from '../functions/canonical-json.ts';
import { parseRuntimeContract } from '../functions/runtime-contract.ts';
import { parseManifest } from '../functions/manifest.ts';
import { parseProfile } from '../functions/profile.ts';
import { readSlots } from '../functions/slots.ts';
import { generateWorkbookSet, GENERATOR, type GenerationInput } from '../functions/generate.ts';
import { CONFLICT_FIX, conflictText, movedText, volumeOrder, volumeProblems } from '../functions/channels.ts';
import { readBytes, jsonBytes, sha256 } from '../functions/generated/skills/run-tools/hub-client/index.ts';
function record(value: unknown, message: string): Record<string, unknown> { if (!isRecord(value)) throw new CallFailure('invalid_parameters', message, "请根据本次核验中的条目、要求项和错误位置修正计划，再重新核验和生成工作簿"); return value; }
/** One case of the run (the run's only item). */
export function satisfiedRecipe(input: { run: unknown; result: unknown; submission: unknown; contract: Uint8Array; profile: Uint8Array; inventory: Uint8Array }): GenerationInput { const all = satisfiedRecipes(input); if (all.length !== 1) throw new CallFailure('invalid_parameters', '本次只生成一条已核对正确的自动化用例', "请根据本次核验中的条目、要求项和错误位置修正计划，再重新核验和生成工作簿"); return all[0]; }
/** Every case of the run, in the run's item order (decision 104: one workbook for the whole document). */
export function satisfiedRecipes(input: { run: unknown; result: unknown; submission: unknown; contract: Uint8Array; profile: Uint8Array; inventory: Uint8Array }): GenerationInput[] {
  const exportRun = record(input.run, '缺少原始用例和自动化用例'); const run = record(isRecord(exportRun.run) ? exportRun.run : exportRun, '缺少原始用例');
  const exportResult = record(input.result, '缺少已确认的核对结果'); const result = record(exportResult.result ?? exportResult, '缺少核对结果'); const submission = record(input.submission, '缺少原自动化用例');
  if (typeof run.run !== 'string' || submission.run !== run.run || result.run !== run.run || result.schema !== 'validation@1' || result.acceptance !== 'accepted' || !Array.isArray(result.errors)) throw new CallFailure('invalid_parameters', '原始用例、自动化用例和核对结果不一致，或核对发现错误；请先改好自动化用例再生成', "请根据本次核验中的条目、要求项和错误位置修正计划，再重新核验和生成工作簿");
  const locks = record(result.locks, '缺少本次核对所用的执行器规则和手册信息');
  if (locks.pack !== GENERATOR) throw new CallFailure('invalid_parameters', '自动化用例 Excel 的生成工具与脚本编写所用的工具版本不符', "请根据本次核验中的条目、要求项和错误位置修正计划，再重新核验和生成工作簿");
  if (locks.pack_digest !== run.pack_digest || locks.root !== run.root || sha256(canonicalJson(submission)) !== result.submission) throw new CallFailure('invalid_parameters', '自动化用例或原始资料与核对结果不一致；请重新核对后生成', "请根据本次核验中的条目、要求项和错误位置修正计划，再重新核验和生成工作簿");
  if (!Array.isArray(run.sources) || run.sources.some((v) => isRecord(v) && v.slot === 'workbook')) throw new CallFailure('invalid_parameters', '请先核对自动化用例，再生成自动化用例 Excel', "请根据本次核验中的条目、要求项和错误位置修正计划，再重新核验和生成工作簿");
  for (const slot of ['contract', 'profile', 'inventory'] as const) {
    const sources = run.sources.filter((v) => isRecord(v) && v.slot === slot);
    if (sources.length !== 1 || !isRecord(sources[0]) || sources[0].role !== 'expected' || sources[0].reference !== `src:${sha256(input[slot])}`) throw new CallFailure('invalid_parameters', `本地${({ contract: "执行器规则", profile: "测试环境配置", inventory: "测试环境清单" })[slot]}与脚本编写时使用的内容不一致，请重新下载`, "请根据本次核验中的条目、要求项和错误位置修正计划，再重新核验和生成工作簿");
  }
  if (!Array.isArray(run.items) || !run.items.length || !Array.isArray(submission.items) || submission.items.length !== run.items.length) throw new CallFailure('invalid_parameters', '自动化用例没有覆盖全部原始用例；请补齐并核对正确后生成自动化用例 Excel', "请根据本次核验中的条目、要求项和错误位置修正计划，再重新核验和生成工作簿");
  const errors=result.errors as unknown[];
  const inactive = new Set(run.items.filter(value => {
    const id = isRecord(value) ? value.id : null;
    const rows = (submission.items as unknown[]).filter(row => isRecord(row) && row.item === id);
    if (rows.length !== 1) return false;
    const state = planStateOf(rows[0], undefined, run);
    return state.excluded || state.skipped;
  }).map(value => isRecord(value) ? value.id : undefined));
  const ids=new Set(run.items.map((value)=>isRecord(value)?value.id:undefined));
  const blocking = errors.filter(error => !isRecord(error) || !inactive.has(error.item));
  if(blocking.some(error=>!isRecord(error)||error.requirement!=='workbook_verified'||error.code!=='missing_input'||!ids.has(error.item)))throw new CallFailure('invalid_parameters', `自动化用例仍有 ${blocking.length} 条阻断错误：${blocking.filter(isRecord).map(error => [error.item, error.requirement, error.code, error.path].filter(value => typeof value === 'string').join(' / ')).join('；')}`, "请根据本次核验中的条目、要求项和错误位置修正计划，再重新核验和生成工作簿");
  const coverage = record(result.coverage, '缺少核对覆盖范围'); if (coverage.complete !== true || coverage.total !== run.items.length || coverage.examined !== run.items.length) throw new CallFailure('invalid_parameters', '尚未完整核对全部原始用例', "请根据本次核验中的条目、要求项和错误位置修正计划，再重新核验和生成工作簿");
  return run.items.filter(value => { const id = isRecord(value) ? value.id : null; const rows = (submission.items as unknown[]).filter(row => isRecord(row) && row.item === id); if (rows.length !== 1) return true; const state = planStateOf(rows[0], undefined, run); return !state.excluded && !state.skipped; }).map((value) => {
  const item = record(value, '原始用例不完整'); const submittedRows = (submission.items as unknown[]).filter((row) => isRecord(row) && row.item === item.id); if (submittedRows.length !== 1) throw new CallFailure('invalid_parameters', `自动化用例没有唯一对应原始用例 ${isRecord(item.fields) ? [item.fields.autoid, item.fields.title].filter(Boolean).join(" ") : "编号和标题未知"}`, "请根据本次核验中的条目、要求项和错误位置修正计划，再重新核验和生成工作簿"); const submitted = record(submittedRows[0], '自动化用例不完整');
  if (!planStateOf(submitted).process || submitted.handling !== 'handled') throw new CallFailure('invalid_parameters', '自动化用例尚未核对正确', "请根据本次核验中的条目、要求项和错误位置修正计划，再重新核验和生成工作簿");
  const partitions = record(result.partitions, '缺少原始用例的结论'); const rows = Object.values(partitions).flatMap((v) => Array.isArray(v) ? v : []);
  const matching = rows.filter((v) => isRecord(v) && v.item === item.id); if (matching.length !== 1) throw new CallFailure('invalid_parameters', '原始用例的结论缺少或重复', "请根据本次核验中的条目、要求项和错误位置修正计划，再重新核验和生成工作簿");
  const itemResult = record(matching[0], '结果原始用例不完整');

  if (!Array.isArray(run.requirements) || !Array.isArray(itemResult.requirements)) throw new CallFailure('invalid_parameters', '缺少完整的自动化用例核对结果', "请根据本次核验中的条目、要求项和错误位置修正计划，再重新核验和生成工作簿");
  const workbook=itemResult.requirements.find((value:unknown)=>isRecord(value)&&value.requirement==='workbook_verified');
  const onlyMissingWorkbook=isRecord(workbook)&&workbook.status==='pending'&&Array.isArray(workbook.layers)&&workbook.layers.length===1&&workbook.layers.every((layer:unknown)=>isRecord(layer)&&layer.layer==='static'&&layer.terminal==='unchecked'&&layer.reason==='missing_input'&&(layer.gaps===undefined||Array.isArray(layer.gaps)&&layer.gaps.every((gap:unknown)=>isRecord(gap)&&gap.reason==='missing_input')));
  if(blocking.some(error=>isRecord(error)&&error.item===item.id)&&!onlyMissingWorkbook)throw new CallFailure('invalid_parameters', '自动化用例 Excel 尚未核对正确，请先查看核对结果', "请根据本次核验中的条目、要求项和错误位置修正计划，再重新核验和生成工作簿");
  if(isRecord(workbook)&&Array.isArray(workbook.layers)&&workbook.layers.some((layer:unknown)=>isRecord(layer)&&(layer.terminal==='violation'||layer.terminal==='fail')))throw new CallFailure('invalid_parameters', '自动化用例 Excel 已确认有错误，请先改好自动化用例', "请根据本次核验中的条目、要求项和错误位置修正计划，再重新核验和生成工作簿");

  for (const template of REQUIREMENTS.requirements.filter((v) => v.required && v.key !== 'workbook_verified')) {
    if (!run.requirements.some((v) => isRecord(v) && v.key === template.key && v.accepted_producer === template.accepted_producer)) throw new CallFailure('invalid_parameters', '自动化用例缺少必需的核对结果', "请根据本次核验中的条目、要求项和错误位置修正计划，再重新核验和生成工作簿");
    const required = itemResult.requirements.filter((v) => isRecord(v) && v.requirement === template.key);
    if (required.length !== 1 || !isRecord(required[0]) || required[0].status !== 'satisfied') throw new CallFailure('invalid_parameters', '自动化用例尚未全部核对正确；请改好错误或补齐资料后再生成自动化用例 Excel', "请根据本次核验中的条目、要求项和错误位置修正计划，再重新核验和生成工作簿");
  }
  const contract = parseRuntimeContract(jsonBytes(input.contract,'contract')); const inventory = parseManifest(jsonBytes(input.inventory,'inventory'));
  if (!contract.ok || !inventory.ok) throw new CallFailure('invalid_parameters', '执行器规则或测试环境清单无法读取', "请根据本次核验中的条目、要求项和错误位置修正计划，再重新核验和生成工作簿");
  const profile = parseProfile(jsonBytes(input.profile,'profile'), contract.contract, inventory.beds); if (!profile.ok) throw new CallFailure('invalid_parameters', '测试环境配置不完整', "请根据本次核验中的条目、要求项和错误位置修正计划，再重新核验和生成工作簿");
  const identity = itemResult.requirements.filter((v) => isRecord(v) && v.requirement === 'contract_methods').flatMap((v) => isRecord(v) && Array.isArray(v.claims) ? v.claims : []).find((v) => isRecord(v) && isRecord(v.statement) && v.statement.verdict === 'support' && isRecord(v.statement.data) && v.statement.data.runtime_version === contract.contract.runtimeVersion && v.statement.data.contract_sha256 === contract.contract.pinned.identity);
  if (!identity) throw new CallFailure('invalid_parameters', '缺少本次执行器规则的核对结果', "请根据本次核验中的条目、要求项和错误位置修正计划，再重新核验和生成工作簿");
  const slots = record(submitted.slots, '缺少自动化用例'); if (!Array.isArray(slots.plan) || slots.plan.length !== 1) throw new CallFailure('invalid_parameters', '自动化用例必须只交一份', "请根据本次核验中的条目、要求项和错误位置修正计划，再重新核验和生成工作簿");
  const claim = record(slots.plan[0], '自动化用例无效'); const plan = readSlots(claim.data); if (!plan.ok) throw new CallFailure('invalid_parameters', '自动化用例不符合执行器规则', "请根据本次核验中的条目、要求项和错误位置修正计划，再重新核验和生成工作簿");
  const fields = record(item.fields, '缺少原始用例');
  if (typeof fields.autoid !== 'string' || typeof fields.title !== 'string' || !Array.isArray(fields.steps) || fields.steps.some((v) => !isRecord(v) || typeof v.text !== 'string') || fields.priority !== null && typeof fields.priority !== 'string') throw new CallFailure('invalid_parameters', '原始用例没有编号、标题、优先级或步骤原句', "请根据本次核验中的条目、要求项和错误位置修正计划，再重新核验和生成工作簿");
  if (typeof run.build !== 'string' || !run.build) throw new CallFailure('invalid_parameters', '脚本编写缺少构建号', "请根据本次核验中的条目、要求项和错误位置修正计划，再重新核验和生成工作簿");
  const commandClaims=itemResult.requirements.filter((value:unknown)=>isRecord(value)&&value.requirement==='commands_known').flatMap((value:unknown)=>isRecord(value)&&Array.isArray(value.claims)?value.claims:[]);const command=commandClaims.find((value:unknown)=>isRecord(value)&&isRecord(value.statement)&&value.statement.verdict==='support'&&isRecord(value.statement.data)&&isRecord(value.statement.data.command_catalog));const parsedCommand=isRecord(command)&&isRecord(command.statement)&&isRecord(command.statement.data)?command.statement.data.command_catalog:undefined;if(!isRecord(parsedCommand)||parsedCommand.root!==run.root)throw new CallFailure('invalid_parameters', '缺少当前构建的手册和命令树核对结果；请先重新核对自动化用例再下载', "请根据本次核验中的条目、要求项和错误位置修正计划，再重新核验和生成工作簿");
  return { slots: plan.slots, fields: {source_atoms:fields.source_atoms,bed_services:inventory.beds.find(bed=>bed.name===profile.profile.bed)?.services,manifest_sha256:sha256(input.inventory),criteria_review:(Array.isArray(run.groups)?run.groups:[]).find((value:unknown)=>isRecord(value)&&value.kind==='case-compile')?.criteria_review??blockReviewSources(run.sources),expected_nodes:selectedExpectedNodes(fields.expected_nodes,plan.slots), command_catalog:parsedCommand,command_identities:fields.command_identities,autoid: fields.autoid, title: fields.title, ...(Array.isArray(fields.path) ? { path: fields.path as string[] } : {}), priority: fields.priority, steps: fields.steps as Array<{ text: string }> }, contract: contract.contract, profile: profile.profile, plan_run: run.run as string, build: run.build as string, generator: GENERATOR };
  });
}
/**
 * What the reference engine's pass review reads of a plan run (functions/delivery.ts failureLine): the execution-failure lines
 * its bound contract declares, and each case's own assertion texts by autoid. One reading for the two tools that apply the
 * review, when the returns are read and when the delivery is assembled. No markers when the contract declares none.
 */
export function passReviewInputs(input: Parameters<typeof satisfiedRecipes>[0]): { markers: string[]; assertions: Map<string, string[]> } {
  let markers: string[] = [];
  try { const parsed = parseRuntimeContract(jsonBytes(input.contract, 'contract')); if (parsed.ok && parsed.contract.failureMarkers) markers = parsed.contract.failureMarkers.lines; } catch { /* a contract that does not parse declares no markers */ }
  if (!markers.length) return { markers, assertions: new Map() };
  return { markers, assertions: new Map(satisfiedRecipes(input).map((recipe) => [String(recipe.fields.autoid), recipe.slots.expects.map((expect) => expect.text).filter((text): text is string => typeof text === 'string' && text.length > 0)])) };
}
export async function main(argv: string[]): Promise<number> {
  try {
    const args = parseCliOptions(argv, { run: true, result: true, submission: true, out: true, contract: false, profile: false, inventory: false }, 'node <技能目录>/tools/generate-workbook.ts --run <运行目录>/run.json --result <运行目录>/result.json --submission <运行目录>/submission.json --out <目标.xlsx>');
    // The CLI parser enforces the four required options above.
    const runPath = args.run!, resultPath = args.result!, submissionPath = args.submission!, outputPath = args.out!;
    const directory = dirname(runPath);
    const hasManifest = await lstat(join(directory, 'sources.json')).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });
    if (hasManifest && (['contract', 'profile', 'inventory'] as const).some(slot => args[slot] !== undefined)) throw new CallFailure('invalid_parameters', '本次下载已有来源清单，不能另指三份来源文件', '去掉 --contract、--profile、--inventory，按 sources.json 的已核验指针读取本次来源');
    const sourceBytes = (slot: 'contract' | 'profile' | 'inventory') => { const path = args[slot]; return !hasManifest && path !== undefined ? readBytes(path, slot) : readSourceBytes(directory, slot); };
    const [run, result, submission, contract, profile, inventory] = await Promise.all([readBytes(runPath,'run'), readBytes(resultPath,'result'), readBytes(submissionPath,'submission'), sourceBytes('contract'), sourceBytes('profile'), sourceBytes('inventory')]);
    const recipes = satisfiedRecipes({ run: jsonBytes(run,'run'), result: jsonBytes(result,'result'), submission: jsonBytes(submission,'submission'), contract, profile, inventory });
    const forbidden = volumeProblems(recipes);
    if (forbidden.length) throw new CallFailure('invalid_parameters', `${forbidden.map(conflictText).join('；')}。未生成自动化用例 Excel。${CONFLICT_FIX}`, "请根据本次核验中的条目、要求项和错误位置修正计划，再重新核验和生成工作簿");
    const bytes = generateWorkbookSet(recipes); await writeFile(outputPath, bytes, { flag: 'wx', mode: 0o600 });
    const moved = volumeOrder(recipes).moved, titles = new Map(recipes.map((recipe) => [recipe.fields.autoid, recipe.fields.title] as const));
    process.stdout.write(JSON.stringify({ sha256: sha256(bytes), generator: GENERATOR, bytes: bytes.length, ...(moved.length ? { moved_tail: moved, moved_text: movedText(moved, titles) } : {}) }) + '\n'); return 0;
  } catch (error) { process.stderr.write(formatCallError(error) + '\n'); return 1; }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
