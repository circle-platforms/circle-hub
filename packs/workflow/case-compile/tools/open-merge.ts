import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUN_ID } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import { requireBearerToken } from '../functions/hub-retry.ts';
import { parseHubOrigin } from '../functions/client-cli.ts';
import { isRecord, parseCliOptions } from '../functions/text.ts';
import { hubTools, readStdinLines, refusalWords, type CallTool, type ToolAnswer } from './open-compile.ts';
import { hubAnswer, spawnTool, words, type RunTool } from './pipeline.ts';
import { mergePassed, mergeRefused, plansMissing, retryNamed } from '../functions/next-step.ts';

const USAGE = "open-merge.ts --hub <MCP地址> --open <open-compile.json> --plans <收拢的计划目录> --model <模型> --out <新目录>";
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SUBMIT_SECONDS = 1200;
const WORKBOOK = 'workbook_verified';

export class MergeRefused extends Error {
  readonly cases: Array<{ item: string; requirement: string; words: string }>;
  constructor(message: string, cases: Array<{ item: string; requirement: string; words: string }> = []) { super(message); this.cases = cases; }
}
export interface Merged { planRun: string; mergeRun: string; workbook: string; xlsx: string; items: number }

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function unsatisfied(envelope: Record<string, unknown>, except: string[] = []): { items: number; rows: Array<{ item: string; requirement: string; words: string }> } {
  const result = isRecord(envelope.result) ? envelope.result : {};
  const partitions = isRecord(result.partitions) ? result.partitions : {};
  const rows: Array<{ item: string; requirement: string; words: string }> = [];
  let items = 0;
  for (const list of Object.values(partitions)) {
    for (const row of Array.isArray(list) ? list.filter(isRecord) : []) {
      items++;
      for (const requirement of Array.isArray(row.requirements) ? row.requirements.filter(isRecord) : []) {
        if (requirement.status === 'satisfied' || except.includes(String(requirement.requirement))) continue;
        const said = (Array.isArray(requirement.claims) ? requirement.claims.filter(isRecord) : []).flatMap((claim) => isRecord(claim.statement) && typeof claim.statement.text === 'string' && claim.statement.verdict !== 'support' ? [claim.statement.text] : []);
        rows.push({ item: String(row.item), requirement: String(requirement.requirement), words: [...new Set(said)].slice(0, 3).join('；').slice(0, 900) || `状态 ${String(requirement.status ?? '没有结论')}` });
      }
    }
  }
  return { items, rows };
}

async function submit(tools: RunTool, hub: string, run: string, model: string, plans: string, token: string, what: string): Promise<Record<string, unknown>> {
  const sent = await tools('case-compile', 'submit-plans.ts', ['--hub', hub, '--run', run, '--model', model, '--plans', plans, '--timeout-sec', String(SUBMIT_SECONDS)], `${token}\n`);
  const answer = await hubAnswer(sent);
  if (!answer) throw new MergeRefused(`${what}没有交上去：${words(sent) || '没有输出'}`);
  if (answer.acceptance !== 'accepted') {
    const errors = Array.isArray(answer.errors) ? answer.errors.filter(isRecord) : [];
    throw new MergeRefused(`${what}整份没有被 Hub 受理：${errors.map((e) => `${String(e.message ?? e.code)}${e.path ? `（位置 ${String(e.path)}）` : ''}${e.fix ? `；下一步：${String(e.fix)}` : ''}`).slice(0, 6).join('；另：') || '没有说明'}`);
  }
  return answer;
}

const runOf = (answer: ToolAnswer) => isRecord(answer.envelope?.run) && typeof answer.envelope.run.run === 'string' ? answer.envelope.run.run : null;
function inputOf(sources: Array<Record<string, unknown>>, slot: string): Record<string, string> {
  const source = sources.find((row) => row.slot === slot);
  if (!source) throw new MergeRefused(`脚本编写运行没有输入槽 ${slot}，开不了脚本合并运行；重新下载这个运行核对`);
  if (typeof source.external === 'string' && source.external) return { external: source.external.replace(/@[0-9a-f]{64}$/, '') };
  if (typeof source.reference === 'string' && source.reference) return { reference: source.reference };
  throw new MergeRefused(`脚本编写运行的输入槽 ${slot} 没有外部名字也没有引用`);
}

export async function openMerge(call: CallTool, tools: RunTool, options: { hub: string; open: Record<string, unknown>; openFile: string; plans: string; model: string; out: string; token: string }): Promise<Merged> {
  const { open } = options;
  const planRun = String(open.plan_run ?? ''), recomposeRun = String(open.recompose_run ?? '');
  if (!RUN_ID.test(planRun) || !RUN_ID.test(recomposeRun) || typeof open.product !== 'string' || typeof open.build !== 'string') throw new MergeRefused('--open 不是 open-compile.ts 写的文件（缺 plan_run、recompose_run、product 或 build）');
  const held = (await readdir(options.plans)).filter((name) => name.endsWith('.json')).length;
  if (typeof open.items === 'number' && held !== open.items) throw new MergeRefused(`${options.plans} 里有 ${held} 份计划，这次编译有 ${open.items} 条，没有提交。${plansMissing(open.items)}`);
  const planned = unsatisfied(await submit(tools, options.hub, planRun, options.model, options.plans, options.token, '计划'), [WORKBOOK]);
  if (planned.rows.length) throw new MergeRefused(`Hub 没有判正确的计划有 ${new Set(planned.rows.map((row) => row.item)).size} 条，不能合并；${retryNamed}`, planned.rows);
  const fetched = join(options.out, 'plan-run'), xlsx = join(options.out, 'case.xlsx');
  await mkdir(options.out, { recursive: true });
  const got = await tools('case-compile', 'fetch-run.ts', ['--hub', options.hub, '--run', planRun, '--out', fetched], `${options.token}\n`);
  if (got.code !== 0) throw new MergeRefused(`取不到脚本编写运行的受理结果：${words(got)}`);
  const made = await tools('case-compile', 'generate-workbook.ts', ['--run', fetched, '--result', join(fetched, 'result.json'), '--submission', join(fetched, 'submission.json'), '--out', xlsx]);
  if (made.code !== 0 || !existsSync(xlsx)) throw new MergeRefused(`自动化用例 Excel 没有生成：${words(made)}`);
  const bytes = await readFile(xlsx), digest = sha256(bytes);
  const uploaded = await call('upload_file', { file_path: bytes.toString('base64'), name: 'case.xlsx', media_type: XLSX, provenance_type: 'declared' });
  const reference = typeof uploaded.envelope?.reference === 'string' ? uploaded.envelope.reference : '';
  if (uploaded.failed || reference !== `src:${digest}`) throw new MergeRefused(`自动化用例 Excel 没有传上去：${uploaded.failed ? refusalWords(uploaded) : `Hub 记下的是 ${reference || '（没有引用）'}，本地生成的是 src:${digest}`}`);
  const frozen = JSON.parse(await readFile(join(fetched, 'run.json'), 'utf8')) as Record<string, unknown>;
  const sources = Array.isArray(frozen.sources) ? frozen.sources.filter(isRecord) : [];
  const record = sources.find((row) => row.slot === 'recomposition_run');
  if (typeof record?.reference !== 'string') throw new MergeRefused('脚本编写运行没有绑定用例重组运行的记录，开不了脚本合并运行');
  const started = await call('start_run', {
    pack: 'case-compile', product: open.product, build: open.build, predecessor: planRun,
    parameters: { ...(isRecord(frozen.parameters) ? frozen.parameters : {}), plan_run: planRun },
    inputs: {
      subject: inputOf(sources, 'subject'), contract: inputOf(sources, 'contract'), inventory: inputOf(sources, 'inventory'), profile: inputOf(sources, 'profile'),
      recomposition_run: { reference: record.reference }, recomposition_result: { run: recomposeRun },
      plan_result: { run: planRun }, workbook: { reference },
    },
  });
  const mergeRun = runOf(started);
  if (started.failed || !mergeRun) throw new MergeRefused(`脚本合并运行开不起来：${refusalWords(started)}`);
  const merged = unsatisfied(await submit(tools, options.hub, mergeRun, options.model, options.plans, options.token, `脚本合并运行 ${mergeRun} 的计划`));
  if (merged.rows.length) {
    const refused = join(options.out, 'refused.json');
    await writeFile(refused, JSON.stringify({ schema: 'merge-refused@1', plan_run: planRun, merge_run: mergeRun, cases: merged.rows }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    throw new MergeRefused(`脚本合并运行 ${mergeRun} 里 Hub 没有判正确的有 ${new Set(merged.rows.map((row) => row.item)).size} 条；${mergeRefused(planRun, options.openFile, refused)}`, merged.rows);
  }
  return { planRun, mergeRun, workbook: reference, xlsx, items: merged.items };
}

export async function main(argv: string[], readStdin: () => Promise<string[]> = readStdinLines, connect: (origin: string, bearer: string) => CallTool = hubTools, tools?: RunTool, skillsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')): Promise<number> {
  try {
    const args = parseCliOptions(argv, { hub: true, open: true, plans: true, model: true, out: true }, USAGE) as Record<string, string>;
    if (existsSync(resolve(args.out))) throw new MergeRefused(`--out ${args.out} 已经存在，不覆盖；另给一个新目录名`);
    if (!existsSync(resolve(args.plans))) throw new MergeRefused(`--plans ${args.plans} 不存在；先跑 pipeline.ts collect 收拢就绪的计划`);
    let open: unknown;
    try { open = JSON.parse(readFileSync(resolve(args.open), 'utf8')); } catch { throw new MergeRefused(`--open ${args.open} 读不出 JSON；写 open-compile.ts 写出的那个文件`); }
    if (!isRecord(open)) throw new MergeRefused(`--open ${args.open} 不是 open-compile.ts 写的文件`);
    const origin = parseHubOrigin(args.hub);
    const lines = await readStdin();
    const token = await requireBearerToken(async () => lines[0] ?? '');
    const merged = await openMerge(connect(origin, token), tools ?? spawnTool(skillsRoot), { hub: args.hub, open, openFile: args.open, plans: args.plans, model: args.model, out: args.out, token });
    const record = { schema: 'open-merge@1', plan_run: merged.planRun, merge_run: merged.mergeRun, workbook: merged.workbook, xlsx: merged.xlsx, items: merged.items };
    await writeFile(join(args.out, 'open-merge.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    process.stdout.write(`合并通过：脚本合并运行 ${merged.mergeRun}，${merged.items} 条全部正确，Excel 在 ${merged.xlsx}（${merged.workbook}）。${mergePassed(merged.mergeRun)}\n${JSON.stringify(record)}\n`);
    return 0;
  } catch (error) {
    const refused = error instanceof MergeRefused ? error : null;
    process.stdout.write(`合并不了：${refused ? refused.message : `合并工具出错：${error instanceof Error ? error.message : String(error)}`}\n${refused?.cases.length ? JSON.stringify({ cases: refused.cases }) + '\n' : ''}`);
    return 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
