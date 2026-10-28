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
import { generateWorkbook, GENERATOR, type GenerationInput } from '../functions/generate.ts';
import { argumentsOf, readBytes, jsonBytes, writeNew, sha256 } from './files.ts';
function record(value: unknown, message: string): Record<string, unknown> { if (!isRecord(value)) throw new Error(message); return value; }
export function satisfiedRecipe(input: { run: unknown; result: unknown; submission: unknown; contract: Uint8Array; profile: Uint8Array; inventory: Uint8Array }): GenerationInput {
  const exportRun = record(input.run, '缺少运行导出'); const run = record(isRecord(exportRun.run) ? exportRun.run : exportRun, '缺少运行摘要');
  const exportResult = record(input.result, '缺少已受理结果'); const result = record(exportResult.result ?? exportResult, '缺少校验结果'); const submission = record(input.submission, '缺少原样提交');
  if (typeof run.run !== 'string' || submission.run !== run.run || result.run !== run.run || result.schema !== 'validation@1' || result.acceptance !== 'accepted' || !Array.isArray(result.errors)) throw new Error('运行、提交和受理结果不一致或仍有反驳；先修复计划再生成');
  const locks = record(result.locks, '结果缺少锁定身份');
  if (locks.pack !== GENERATOR) throw new Error('生成器版本与计划运行锁定的包版本不符');
  if (locks.pack_digest !== run.pack_digest || locks.root !== run.root || sha256(canonicalJson(submission)) !== result.submission) throw new Error('提交摘要或锁定输入与受理结果不符，不能拿旧结果生成');
  if (!Array.isArray(run.sources) || run.sources.some((v) => isRecord(v) && v.slot === 'workbook')) throw new Error('必须使用尚未绑定工作簿的计划运行');
  for (const slot of ['contract', 'profile', 'inventory'] as const) {
    const sources = run.sources.filter((v) => isRecord(v) && v.slot === slot);
    if (sources.length !== 1 || !isRecord(sources[0]) || sources[0].role !== 'expected' || sources[0].reference !== `src:${sha256(input[slot])}`) throw new Error(`本地 ${slot} 不是该运行绑定的原始字节，请按源引用导出原件`);
  }
  if (!Array.isArray(run.items) || run.items.length !== 1 || !Array.isArray(submission.items) || submission.items.length !== 1) throw new Error('本轮只生成一个已核验用例');
  const item = record(run.items[0], '条目不合式'); const submitted = record(submission.items[0], '提交条目不合式');
  if (submitted.item !== item.id || submitted.handling !== 'handled') throw new Error('提交条目不是已核验的目标用例');
  const partitions = record(result.partitions, '缺少结果分区'); const rows = Object.values(partitions).flatMap((v) => Array.isArray(v) ? v : []);
  const matching = rows.filter((v) => isRecord(v) && v.item === item.id); if (matching.length !== 1) throw new Error('结果没有唯一的目标条目');
  const itemResult = record(matching[0], '结果条目不合式');
  const errors=result.errors as unknown[];
  if(errors.some(error=>!isRecord(error)||error.requirement!=='workbook_verified'||error.code!=='missing_input'||error.item!==item.id))throw new Error('计划仍有工作簿缺输入以外的错误，先修复计划再生成');

  if (!Array.isArray(run.requirements) || !Array.isArray(itemResult.requirements)) throw new Error('缺少完整的计划要求项状态');
  const workbook=itemResult.requirements.find((value:unknown)=>isRecord(value)&&value.requirement==='workbook_verified');
  const onlyMissingWorkbook=isRecord(workbook)&&workbook.status==='pending'&&Array.isArray(workbook.layers)&&workbook.layers.length===1&&workbook.layers.every((layer:unknown)=>isRecord(layer)&&layer.layer==='static'&&layer.terminal==='unchecked'&&layer.reason==='missing_input'&&(layer.gaps===undefined||Array.isArray(layer.gaps)&&layer.gaps.every((gap:unknown)=>isRecord(gap)&&gap.reason==='missing_input')));
  if(errors.length&&!onlyMissingWorkbook)throw new Error('工作簿要求项不是生成前缺输入，不把未核验或反驳当成可生成');
  if(isRecord(workbook)&&Array.isArray(workbook.layers)&&workbook.layers.some((layer:unknown)=>isRecord(layer)&&(layer.terminal==='violation'||layer.terminal==='fail')))throw new Error('工作簿已有确定反驳，不能用缺输入绕过');

  const coverage = record(result.coverage, '缺少核对覆盖范围'); if (coverage.complete !== true || coverage.total !== 1 || coverage.examined !== 1) throw new Error('结果没有完整核对这个唯一用例');
  for (const template of REQUIREMENTS.requirements.filter((v) => v.required && v.key !== 'workbook_verified')) {
    if (!run.requirements.some((v) => isRecord(v) && v.key === template.key && v.accepted_producer === template.accepted_producer)) throw new Error('运行缺少当前包的必需计划要求项');
    const required = itemResult.requirements.filter((v) => isRecord(v) && v.requirement === template.key);
    if (required.length !== 1 || !isRecord(required[0]) || required[0].status !== 'satisfied') throw new Error('计划必需要求项尚未全部满足；工作簿缺输入一项不能掩盖其他未决或反驳');
  }
  const contract = parseRuntimeContract(jsonBytes(input.contract,'contract')); const inventory = parseManifest(jsonBytes(input.inventory,'inventory'));
  if (!contract.ok || !inventory.ok) throw new Error('绑定合约或台架清单无法重算');
  const profile = parseProfile(jsonBytes(input.profile,'profile'), contract.contract, inventory.beds); if (!profile.ok) throw new Error('绑定运行环境配置不合式');
  const identity = itemResult.requirements.filter((v) => isRecord(v) && v.requirement === 'contract_methods').flatMap((v) => isRecord(v) && Array.isArray(v.claims) ? v.claims : []).find((v) => isRecord(v) && isRecord(v.statement) && v.statement.verdict === 'support' && isRecord(v.statement.data) && v.statement.data.runtime_version === contract.contract.runtimeVersion && v.statement.data.contract_sha256 === contract.contract.pinned.identity);
  if (!identity) throw new Error('缺少与绑定合约匹配的支持身份回执');
  const slots = record(submitted.slots, '缺少 plan 槽'); if (!Array.isArray(slots.plan) || slots.plan.length !== 1) throw new Error('plan 槽不是唯一提交');
  const claim = record(slots.plan[0], 'plan 主张无效'); const plan = readSlots(claim.data); if (!plan.ok) throw new Error('计划槽位不符合已发布的完整形状');
  const fields = record(item.fields, '缺少条目字段');
  if (typeof fields.autoid !== 'string' || typeof fields.title !== 'string' || !Array.isArray(fields.steps) || fields.steps.some((v) => !isRecord(v) || typeof v.text !== 'string') || fields.priority !== null && typeof fields.priority !== 'string') throw new Error('条目字段没有原始文字 autoid、标题、优先级或步骤');
  if (typeof run.build !== 'string' || !run.build) throw new Error('计划运行没有锁定构建');
  const commandClaims=itemResult.requirements.filter((value:unknown)=>isRecord(value)&&value.requirement==='commands_known').flatMap((value:unknown)=>isRecord(value)&&Array.isArray(value.claims)?value.claims:[]);const command=commandClaims.find((value:unknown)=>isRecord(value)&&isRecord(value.statement)&&value.statement.verdict==='support'&&isRecord(value.statement.data)&&isRecord(value.statement.data.command_catalog));const parsedCommand=isRecord(command)&&isRecord(command.statement)&&isRecord(command.statement.data)?command.statement.data.command_catalog:undefined;if(!isRecord(parsedCommand)||parsedCommand.root!==run.root)throw new Error('缺 commands_known 的锁定目录解析回执；重新核验计划后导出，不以用例缺声明阻止计划解析');
  return { slots: plan.slots, fields: {source_atoms:fields.source_atoms,bed_services:inventory.beds.find(bed=>bed.name===profile.profile.bed)?.services,manifest_sha256:sha256(input.inventory),criteria_review:(Array.isArray(run.groups)?run.groups:[]).find((value:unknown)=>isRecord(value)&&value.kind==='case-compile')?.criteria_review??blockReviewSources(run.sources),expected_nodes:selectedExpectedNodes(fields.expected_nodes,plan.slots), command_catalog:parsedCommand,command_identities:fields.command_identities,autoid: fields.autoid, title: fields.title, priority: fields.priority, steps: fields.steps as Array<{ text: string }> }, contract: contract.contract, profile: profile.profile, plan_run: run.run, build: run.build, generator: GENERATOR };
}
export async function main(argv: string[]): Promise<number> {
  try {
    const args = argumentsOf(argv, ['run', 'result', 'submission', 'contract', 'profile', 'inventory', 'out']);
    const [run, result, submission, contract, profile, inventory] = await Promise.all([readBytes(args.run,'run'), readBytes(args.result,'result'), readBytes(args.submission,'submission'), readBytes(args.contract,'contract'), readBytes(args.profile,'profile'), readBytes(args.inventory,'inventory')]);
    const recipe = satisfiedRecipe({ run: jsonBytes(run,'run'), result: jsonBytes(result,'result'), submission: jsonBytes(submission,'submission'), contract, profile, inventory });
    const bytes = generateWorkbook(recipe); await writeNew(args.out, bytes); process.stdout.write(JSON.stringify({ sha256: sha256(bytes), generator: GENERATOR, bytes: bytes.length }) + '\n'); return 0;
  } catch (error) { process.stderr.write(`生成失败：${error instanceof Error ? error.message : '输入无效'}\n`); return 1; }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
