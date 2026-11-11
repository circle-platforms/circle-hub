import {blockReviewSources} from '../functions/block-review-identity.ts';
import {selectedExpectedNodes} from '../functions/expected-nodes.ts';
// Offline recipe verification and artifact generation. Every source is read from the explicitly named local file.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import REQUIREMENTS from '../requirements.json' with { type: 'json' };
import { isRecord } from '../functions/text.ts';
import { canonicalJson } from '../functions/canonical-json.ts';
import { parseRuntimeContract } from '../functions/runtime-contract.ts';
import { parseManifest } from '../functions/manifest.ts';
import { parseProfile } from '../functions/profile.ts';
import { readSlots } from '../functions/slots.ts';
import { generateWorkbookSet, GENERATOR, type GenerationInput } from '../functions/generate.ts';
import { CONFLICT_FIX, conflictText, movedText, volumeOrder, volumeProblems } from '../functions/channels.ts';
import { argumentsOf, readBytes, jsonBytes, writeNew, sha256 } from '../functions/generated/skills/run-tools/hub-client/index.ts';
function record(value: unknown, message: string): Record<string, unknown> { if (!isRecord(value)) throw new Error(message); return value; }
/** One case of the run (the run's only item). */
export function satisfiedRecipe(input: { run: unknown; result: unknown; submission: unknown; contract: Uint8Array; profile: Uint8Array; inventory: Uint8Array }): GenerationInput { const all = satisfiedRecipes(input); if (all.length !== 1) throw new Error('本次只生成一条已核对正确的自动化用例'); return all[0]; }
/** Every case of the run, in the run's item order (decision 104: one workbook for the whole document). */
export function satisfiedRecipes(input: { run: unknown; result: unknown; submission: unknown; contract: Uint8Array; profile: Uint8Array; inventory: Uint8Array }): GenerationInput[] {
  const exportRun = record(input.run, '缺少原始用例和自动化用例'); const run = record(isRecord(exportRun.run) ? exportRun.run : exportRun, '缺少原始用例');
  const exportResult = record(input.result, '缺少已确认的核对结果'); const result = record(exportResult.result ?? exportResult, '缺少核对结果'); const submission = record(input.submission, '缺少原自动化用例');
  if (typeof run.run !== 'string' || submission.run !== run.run || result.run !== run.run || result.schema !== 'validation@1' || result.acceptance !== 'accepted' || !Array.isArray(result.errors)) throw new Error('原始用例、自动化用例和核对结果不一致，或核对发现错误；请先改好自动化用例再生成');
  const locks = record(result.locks, '缺少本次核对所用的执行器规则和手册信息');
  if (locks.pack !== GENERATOR) throw new Error('自动化用例 Excel 的生成工具与脚本编写所用的工具版本不符');
  if (locks.pack_digest !== run.pack_digest || locks.root !== run.root || sha256(canonicalJson(submission)) !== result.submission) throw new Error('自动化用例或原始资料与核对结果不一致；请重新核对后生成');
  if (!Array.isArray(run.sources) || run.sources.some((v) => isRecord(v) && v.slot === 'workbook')) throw new Error('请先核对自动化用例，再生成自动化用例 Excel');
  for (const slot of ['contract', 'profile', 'inventory'] as const) {
    const sources = run.sources.filter((v) => isRecord(v) && v.slot === slot);
    if (sources.length !== 1 || !isRecord(sources[0]) || sources[0].role !== 'expected' || sources[0].reference !== `src:${sha256(input[slot])}`) throw new Error(`本地${({ contract: "执行器规则", profile: "测试环境配置", inventory: "测试环境清单" })[slot]}与脚本编写时使用的内容不一致，请重新下载`);
  }
  if (!Array.isArray(run.items) || !run.items.length || !Array.isArray(submission.items) || submission.items.length !== run.items.length) throw new Error('自动化用例没有覆盖全部原始用例；请补齐并核对正确后生成自动化用例 Excel');
  const errors=result.errors as unknown[];
  const ids=new Set(run.items.map((value)=>isRecord(value)?value.id:undefined));
  if(errors.some(error=>!isRecord(error)||error.requirement!=='workbook_verified'||error.code!=='missing_input'||!ids.has(error.item)))throw new Error('自动化用例还有错误，请先改好再生成自动化用例 Excel');
  const coverage = record(result.coverage, '缺少核对覆盖范围'); if (coverage.complete !== true || coverage.total !== run.items.length || coverage.examined !== run.items.length) throw new Error('尚未完整核对全部原始用例');
  return run.items.map((value) => {
  const item = record(value, '原始用例不完整'); const submittedRows = (submission.items as unknown[]).filter((row) => isRecord(row) && row.item === item.id); if (submittedRows.length !== 1) throw new Error(`自动化用例没有唯一对应原始用例 ${isRecord(item.fields) ? [item.fields.autoid, item.fields.title].filter(Boolean).join(" ") : "编号和标题未知"}`); const submitted = record(submittedRows[0], '自动化用例不完整');
  if (submitted.handling !== 'handled') throw new Error('自动化用例尚未核对正确');
  const partitions = record(result.partitions, '缺少原始用例的结论'); const rows = Object.values(partitions).flatMap((v) => Array.isArray(v) ? v : []);
  const matching = rows.filter((v) => isRecord(v) && v.item === item.id); if (matching.length !== 1) throw new Error('原始用例的结论缺少或重复');
  const itemResult = record(matching[0], '结果原始用例不完整');

  if (!Array.isArray(run.requirements) || !Array.isArray(itemResult.requirements)) throw new Error('缺少完整的自动化用例核对结果');
  const workbook=itemResult.requirements.find((value:unknown)=>isRecord(value)&&value.requirement==='workbook_verified');
  const onlyMissingWorkbook=isRecord(workbook)&&workbook.status==='pending'&&Array.isArray(workbook.layers)&&workbook.layers.length===1&&workbook.layers.every((layer:unknown)=>isRecord(layer)&&layer.layer==='static'&&layer.terminal==='unchecked'&&layer.reason==='missing_input'&&(layer.gaps===undefined||Array.isArray(layer.gaps)&&layer.gaps.every((gap:unknown)=>isRecord(gap)&&gap.reason==='missing_input')));
  if(errors.length&&!onlyMissingWorkbook)throw new Error('自动化用例 Excel 尚未核对正确，请先查看核对结果');
  if(isRecord(workbook)&&Array.isArray(workbook.layers)&&workbook.layers.some((layer:unknown)=>isRecord(layer)&&(layer.terminal==='violation'||layer.terminal==='fail')))throw new Error('自动化用例 Excel 已确认有错误，请先改好自动化用例');

  for (const template of REQUIREMENTS.requirements.filter((v) => v.required && v.key !== 'workbook_verified')) {
    if (!run.requirements.some((v) => isRecord(v) && v.key === template.key && v.accepted_producer === template.accepted_producer)) throw new Error('自动化用例缺少必需的核对结果');
    const required = itemResult.requirements.filter((v) => isRecord(v) && v.requirement === template.key);
    if (required.length !== 1 || !isRecord(required[0]) || required[0].status !== 'satisfied') throw new Error('自动化用例尚未全部核对正确；请改好错误或补齐资料后再生成自动化用例 Excel');
  }
  const contract = parseRuntimeContract(jsonBytes(input.contract,'contract')); const inventory = parseManifest(jsonBytes(input.inventory,'inventory'));
  if (!contract.ok || !inventory.ok) throw new Error('执行器规则或测试环境清单无法读取');
  const profile = parseProfile(jsonBytes(input.profile,'profile'), contract.contract, inventory.beds); if (!profile.ok) throw new Error('测试环境配置不完整');
  const identity = itemResult.requirements.filter((v) => isRecord(v) && v.requirement === 'contract_methods').flatMap((v) => isRecord(v) && Array.isArray(v.claims) ? v.claims : []).find((v) => isRecord(v) && isRecord(v.statement) && v.statement.verdict === 'support' && isRecord(v.statement.data) && v.statement.data.runtime_version === contract.contract.runtimeVersion && v.statement.data.contract_sha256 === contract.contract.pinned.identity);
  if (!identity) throw new Error('缺少本次执行器规则的核对结果');
  const slots = record(submitted.slots, '缺少自动化用例'); if (!Array.isArray(slots.plan) || slots.plan.length !== 1) throw new Error('自动化用例必须只交一份');
  const claim = record(slots.plan[0], '自动化用例无效'); const plan = readSlots(claim.data); if (!plan.ok) throw new Error('自动化用例不符合执行器规则');
  const fields = record(item.fields, '缺少原始用例');
  if (typeof fields.autoid !== 'string' || typeof fields.title !== 'string' || !Array.isArray(fields.steps) || fields.steps.some((v) => !isRecord(v) || typeof v.text !== 'string') || fields.priority !== null && typeof fields.priority !== 'string') throw new Error('原始用例没有编号、标题、优先级或步骤原句');
  if (typeof run.build !== 'string' || !run.build) throw new Error('脚本编写缺少构建号');
  const commandClaims=itemResult.requirements.filter((value:unknown)=>isRecord(value)&&value.requirement==='commands_known').flatMap((value:unknown)=>isRecord(value)&&Array.isArray(value.claims)?value.claims:[]);const command=commandClaims.find((value:unknown)=>isRecord(value)&&isRecord(value.statement)&&value.statement.verdict==='support'&&isRecord(value.statement.data)&&isRecord(value.statement.data.command_catalog));const parsedCommand=isRecord(command)&&isRecord(command.statement)&&isRecord(command.statement.data)?command.statement.data.command_catalog:undefined;if(!isRecord(parsedCommand)||parsedCommand.root!==run.root)throw new Error('缺少当前构建的手册和命令树核对结果；请先重新核对自动化用例再下载');
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
    const args = argumentsOf(argv, ['run', 'result', 'submission', 'contract', 'profile', 'inventory', 'out']);
    const [run, result, submission, contract, profile, inventory] = await Promise.all([readBytes(args.run,'run'), readBytes(args.result,'result'), readBytes(args.submission,'submission'), readBytes(args.contract,'contract'), readBytes(args.profile,'profile'), readBytes(args.inventory,'inventory')]);
    const recipes = satisfiedRecipes({ run: jsonBytes(run,'run'), result: jsonBytes(result,'result'), submission: jsonBytes(submission,'submission'), contract, profile, inventory });
    const forbidden = volumeProblems(recipes);
    if (forbidden.length) throw new Error(`${forbidden.map(conflictText).join('；')}。未生成自动化用例 Excel。${CONFLICT_FIX}`);
    const bytes = generateWorkbookSet(recipes); await writeNew(args.out, bytes);
    const moved = volumeOrder(recipes).moved, titles = new Map(recipes.map((recipe) => [recipe.fields.autoid, recipe.fields.title] as const));
    process.stdout.write(JSON.stringify({ sha256: sha256(bytes), generator: GENERATOR, bytes: bytes.length, ...(moved.length ? { moved_tail: moved, moved_text: movedText(moved, titles) } : {}) }) + '\n'); return 0;
  } catch (error) { process.stderr.write(`自动化用例 Excel 未生成：${error instanceof Error ? error.message : '输入无效'}\n`); return 1; }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
