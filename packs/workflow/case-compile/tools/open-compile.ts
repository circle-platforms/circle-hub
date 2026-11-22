import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUN_ID } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import { requireBearerToken } from '../functions/hub-retry.ts';
import { parseHubOrigin } from '../functions/client-cli.ts';
import { isRecord, parseCliOptions } from '../functions/text.ts';

const CALL_TIMEOUT_MS = 180_000;
const DEFAULT_DOCS = { contract: 'doc:doc:runner-contract', inventory: 'doc:doc:bed-topology', profile: 'doc:doc:runtime-profile' } as const;
const USAGE = "open-compile.ts --hub <MCP地址> [--plumb <Plumb地址>] --subject <脑图外部标识或 src: 引用> --product <产品> --build <构建> --booking <test-bed 预订号> --out <新文件> [--version <版本线>] [--scope <范围文件>] [--exclude <autoid,...>] [--contract <doc:doc:名字>] [--inventory <doc:doc:名字>] [--profile <doc:doc:名字>] [--recompose-run <重组运行编号> --recompose-record <rec:引用>] [--judge plumb|model]";

export class NotReady extends Error {}

export interface ToolAnswer { failed: boolean; text: string; envelope: Record<string, unknown> | null }
export type CallTool = (name: string, args: Record<string, unknown>) => Promise<ToolAnswer>;

export function envelopeOf(text: string): Record<string, unknown> | null {
  const marker = text.lastIndexOf('供模型引用');
  const start = text.indexOf('{', marker < 0 ? 0 : marker);
  if (start < 0) return null;
  try { const value = JSON.parse(text.slice(start)); return isRecord(value) ? value : null; } catch { return null; }
}

export function hubTools(origin: string, bearer: string, timeoutMs = CALL_TIMEOUT_MS): CallTool {
  return async (name, args) => {
    let reply: Response, body: string;
    try {
      reply = await fetch(`${origin}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      body = await reply.text();
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') throw new NotReady(`Hub ${timeoutMs / 1000} 秒内没有答复 ${name}；读运行列表确认有没有开出运行，再重跑本工具`);
      throw new NotReady(`Hub 不可达（${error instanceof Error ? error.message.slice(0, 120) : '未知原因'}）；核对 --hub 和网络后重跑本工具`);
    }
    if (!reply.ok) throw new NotReady(`Hub 答复 ${reply.status}：${body.trim().slice(0, 300)}`);
    let answer: unknown; try { answer = JSON.parse(body); } catch { throw new NotReady('Hub 的答复不是 JSON'); }
    if (isRecord(answer) && isRecord(answer.error)) throw new NotReady(`Hub 拒绝了 ${name} 调用：${String(answer.error.message).slice(0, 500)}`);
    const result = isRecord(answer) && isRecord(answer.result) ? answer.result : null;
    const text = (Array.isArray(result?.content) ? result.content : []).flatMap((part) => (isRecord(part) && typeof part.text === 'string' ? [part.text] : [])).join('\n');
    if (result === null || !text) throw new NotReady(`Hub 对 ${name} 的答复没有文字内容`);
    return { failed: result.isError === true, text, envelope: envelopeOf(text) };
  };
}

export function refusalWords(answer: ToolAnswer): string {
  const errors = Array.isArray(answer.envelope?.errors) ? answer.envelope.errors.filter(isRecord) : [];
  if (!errors.length) return answer.text.split('\n')[0]!.slice(0, 600);
  return errors.map((error) => {
    const where = typeof error.path === 'string' && error.path ? `（位置 ${error.path}）` : '';
    const next = typeof error.fix === 'string' && error.fix ? `；下一步：${error.fix}` : '';
    return `${String(error.message ?? error.code ?? '未说明')}${where}${next}`;
  }).join('；另：');
}

export async function readStdinLines(): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export type PlumbStatus = (url: string, key: string) => Promise<unknown>;
export function plumbStatusVia(skillsRoot: string): PlumbStatus {
  return (url, key) => new Promise((done, fail) => {
    const tool = join(skillsRoot, 'plumb', 'tools', 'plumb.ts');
    if (!existsSync(tool)) { fail(new NotReady(`本机没有装 plumb 技能（${tool}）；下一步：装上 plumb 技能再开编译`)); return; }
    const child = spawn(process.execPath, [tool, 'status', '--base-url', url, '--key-stdin'], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000 });
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { err += c; });
    child.on('error', (error) => fail(new NotReady(`问不到 Plumb 状态（${error.message.slice(0, 120)}）`)));
    child.on('close', (code) => {
      if (code !== 0) { fail(new NotReady(`问不到 Plumb 状态：${(err || out).trim().split('\n')[0]!.slice(0, 300)}；下一步：核对 Plumb 地址和密钥，或请管理员唤醒 Plumb 后重跑`)); return; }
      try { done(JSON.parse(out)); } catch { fail(new NotReady('Plumb 状态答复不是 JSON')); }
    });
    child.stdin.end(`${key}\n`);
  });
}

// Where the Plumb skill's script is expected. plumbStatusVia asks for the same path inside its executor, which is a reviewed
// call site whose bytes are pinned outside this pack, so that executor stays as it is and this is the check made first.
export const plumbToolPath = (skillsRoot: string): string => join(skillsRoot, 'plumb', 'tools', 'plumb.ts');
export interface PlumbJudge { url: string; key: string; status: PlumbStatus }
const PLUMB_KEY_PLACEHOLDER = /^%[A-Z][A-Z0-9_]*%$/;

export function plumbProblem(status: unknown): string | null {
  if (!isRecord(status)) return 'Plumb 状态答复不是对象';
  const models = isRecord(status.models_status) ? Object.values(status.models_status).filter(isRecord) : [];
  const notReady = models.filter((m) => m.step !== 'ready' || m.self_check_passed !== true);
  if (status.status === 'ready' && models.length && !notReady.length) return null;
  const seen = `status=${String(status.status)}，phase=${String(status.phase ?? '')}${notReady.length ? `，未就绪模型 ${notReady.map((m) => `${String(m.model)}（${String(m.step ?? m.state)}）`).join('、')}` : models.length ? '' : '，没有已加载的模型'}`;
  return `Plumb 判定服务没有就绪（${seen}）；下一步：唤醒 Plumb，等状态为 ready 后重跑`;
}

function installedVersion(skillsRoot: string, pack: string): string | null {
  const file = join(skillsRoot, pack, 'pack.json');
  if (!existsSync(file)) return null;
  try { const value = JSON.parse(readFileSync(file, 'utf8')); return isRecord(value) && typeof value.version === 'string' ? value.version : null; } catch { return null; }
}

export interface OpenOptions {
  subject: string; product: string; build: string; booking: string; version?: string;
  scope?: { words: string; cases: string[] }; exclude?: string[];
  contract?: string; inventory?: string; profile?: string;
  reuse?: { run: string; record: string };
}
export interface Opened { recomposeRun: string; recomposeRecord: string; planRun: string; planRecord: string | null; items: number }

const subjectInput = (subject: string) => subject.startsWith('src:') ? { reference: subject } : { external: subject };
const runOf = (answer: ToolAnswer) => isRecord(answer.envelope?.run) && typeof answer.envelope.run.run === 'string' ? answer.envelope.run as Record<string, unknown> : null;

// What the Hub publishes against what is installed here, for the two workflows a compile needs. A workflow the Hub does not
// publish to this account has no version to compare, so it is the only thing said about it.
function workflowProblems(packs: Array<Record<string, unknown>>, skillsRoot: string): string[] {
  const problems: string[] = [];
  for (const pack of ['recompose', 'case-compile']) {
    const published = packs.find((row) => row.id === pack);
    if (!published) { problems.push(`当前账户没有分配 ${pack} 工作流；下一步：请管理员为该账户或所在团队分配 ${pack}（Hub 上还没有发布时先发布）`); continue; }
    const version = String(published.version), local = installedVersion(skillsRoot, pack);
    if (local === null) problems.push(`本机没有装 ${pack} 技能（${join(skillsRoot, pack)}）；下一步：使用者用客户端的技能安装从 Hub 装上 ${pack} 技能 ${version}（Hub 发布的版本），再开编译`);
    else if (local !== published.version) problems.push(`本机 ${pack} 技能是 ${local}，Hub 发布的是 ${version}；下一步：重装 ${version} 再开编译`);
  }
  return problems;
}

// The Plumb checks in the order the skill, the key and the service. The service cannot be asked without the skill that asks
// it or without the key it is asked with, so then it is not said to be a problem of its own.
async function plumbProblems(plumb: PlumbJudge, skillsRoot: string): Promise<string[]> {
  const problems: string[] = [], tool = plumbToolPath(skillsRoot);
  const installed = existsSync(tool), keyed = plumb.key !== '' && !PLUMB_KEY_PLACEHOLDER.test(plumb.key);
  if (!installed) problems.push(`本机没有装 plumb 技能（${tool}），它是 Hub 发布的通用技能；下一步：使用者用客户端的技能安装从 Hub 装上 plumb 技能再开编译；Hub 上没有它时，请管理员先在 Hub 上执行 circle-hub pack install plumb@<版本>`);
  if (!keyed) problems.push("标准输入第二行没有 Plumb 密钥；命令末尾写 <<'EOF'，下一行 %HUB_TOKEN%，再一行 %PLUMB_API_KEY%，最后一行 EOF；还没有 Plumb 密钥时向管理员申请，保存为客户端密钥 PLUMB_API_KEY 后重跑");
  if (installed && keyed) {
    try { const problem = plumbProblem(await plumb.status(plumb.url, plumb.key)); if (problem) problems.push(problem); }
    catch (error) { if (!(error instanceof NotReady)) throw error; problems.push(error.message); }
  }
  return problems;
}

export async function openCompile(call: CallTool, options: OpenOptions, skillsRoot: string, plumb?: PlumbJudge): Promise<Opened> {
  const listed = await call('list_task_packs', {});
  if (listed.failed) throw new NotReady(`读不到 Hub 的任务包：${refusalWords(listed)}`);
  const packs = Array.isArray(listed.envelope?.packs) ? listed.envelope.packs.filter(isRecord) : [];
  // Every unmet precondition is said in one answer and nothing is opened while there is one.
  const problems = [...workflowProblems(packs, skillsRoot), ...(plumb ? await plumbProblems(plumb, skillsRoot) : [])];
  if (problems.length) throw new NotReady(problems.join('；另：'));
  const top = { product: options.product, build: options.build, ...(options.version ? { version: options.version } : {}) };
  const parameters = { ...(options.scope ? { scope: options.scope } : {}) };
  let recomposeRun: Record<string, unknown>, recomposeRecord: string;
  if (options.reuse) { recomposeRun = { run: options.reuse.run }; recomposeRecord = options.reuse.record; }
  else {
    const recompose = await call('start_run', { pack: 'recompose', ...top, inputs: { subject: subjectInput(options.subject) }, ...(Object.keys(parameters).length ? { parameters } : {}) });
    const opened = runOf(recompose);
    if (recompose.failed || !opened || typeof recompose.envelope?.record !== 'string') throw new NotReady(`用例重组运行开不起来：${refusalWords(recompose)}`);
    recomposeRun = opened; recomposeRecord = recompose.envelope.record;
  }
  const plan = await call('start_run', {
    pack: 'case-compile', ...top, predecessor: options.booking,
    inputs: {
      subject: subjectInput(options.subject),
      contract: { external: options.contract ?? DEFAULT_DOCS.contract },
      inventory: { external: options.inventory ?? DEFAULT_DOCS.inventory },
      profile: { external: options.profile ?? DEFAULT_DOCS.profile },
      recomposition_run: { reference: recomposeRecord },
      recomposition_result: { run: recomposeRun.run },
    },
    parameters: { ...parameters, ...(options.exclude?.length ? { exclude: options.exclude } : {}) },
  });
  const planRun = runOf(plan);
  if (plan.failed || !planRun) throw new NotReady(`${refusalWords(plan)}${options.reuse ? '' : `。已开的用例重组运行 ${String(recomposeRun.run)} 没有用到，不影响下一次`}`);
  const items = Array.isArray(planRun.items) ? planRun.items.length : typeof planRun.item_count === 'number' ? planRun.item_count : 0;
  return { recomposeRun: String(recomposeRun.run), recomposeRecord, planRun: String(planRun.run), planRecord: typeof plan.envelope?.record === 'string' ? plan.envelope.record : null, items };
}

function scopeFrom(path: string | undefined): OpenOptions['scope'] {
  if (path === undefined) return undefined;
  let value: unknown;
  try { value = JSON.parse(readFileSync(resolve(path), 'utf8')); } catch { throw new NotReady(`--scope 文件 ${path} 读不出 JSON；写成 {"words":"<范围原话>","cases":["<autoid>",...]}`); }
  if (!isRecord(value) || typeof value.words !== 'string' || !Array.isArray(value.cases) || value.cases.some((v) => typeof v !== 'string')) throw new NotReady(`--scope 文件 ${path} 的形状不对；写成 {"words":"<范围原话>","cases":["<autoid>",...]}`);
  return { words: value.words, cases: value.cases as string[] };
}

export async function main(argv: string[], readStdin: () => Promise<string[]> = readStdinLines, connect: (origin: string, bearer: string) => CallTool = hubTools, skillsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), plumbStatus: PlumbStatus = plumbStatusVia(skillsRoot)): Promise<number> {
  let args: Record<string, string>;
  try {
    args = parseCliOptions(argv, { hub: true, plumb: false, judge: false, subject: true, product: true, build: true, booking: true, out: true, version: false, scope: false, exclude: false, contract: false, inventory: false, profile: false, 'recompose-run': false, 'recompose-record': false }, USAGE) as Record<string, string>;
  } catch (error) {
    process.stdout.write(`无法编译：开运行工具的参数不对（${error instanceof Error ? error.message : String(error)}）；写法：${USAGE}\n`);
    return 1;
  }
  try {
    const judge = args.judge ?? 'plumb';
    if (judge !== 'plumb' && judge !== 'model') throw new NotReady('--judge 只能写 plumb 或 model；不写就是 plumb');
    if (judge === 'plumb' && !args.plumb) throw new NotReady('缺 --plumb <Plumb地址>；只有使用者明确说这次不经 Plumb 时才写 --judge model');
    if (!RUN_ID.test(args.booking)) throw new NotReady('--booking 不是运行编号；写 test-bed 预订运行的编号（run_ 开头）');
    for (const slot of ['contract', 'inventory', 'profile'] as const) if (args[slot] !== undefined && !/^doc:doc:[a-z][a-z0-9-]{0,63}(@[0-9a-f]{64})?$/.test(args[slot])) throw new NotReady(`--${slot} 不是命名文档；写 doc:doc:<名字>`);
    if ((args['recompose-run'] === undefined) !== (args['recompose-record'] === undefined)) throw new NotReady('--recompose-run 和 --recompose-record 要一起写（沿用已有重组时），或都不写');
    if (args['recompose-run'] !== undefined && !RUN_ID.test(args['recompose-run'])) throw new NotReady('--recompose-run 不是运行编号');
    if (args['recompose-record'] !== undefined && !/^rec:[0-9a-f]{64}$/.test(args['recompose-record'])) throw new NotReady('--recompose-record 写重组运行记录的 rec: 引用（下载目录 references.json 的 run_reference）');
    if (existsSync(resolve(args.out))) throw new NotReady(`--out ${args.out} 已经存在，不覆盖；另给一个新文件名`);
    const origin = parseHubOrigin(args.hub);
    const lines = await readStdin();
    const bearer = await requireBearerToken(async () => lines[0] ?? '');
    const key = lines[1] ?? '';
    const exclude = args.exclude ? args.exclude.split(',').map((v) => v.trim()).filter(Boolean) : undefined;
    const scope = args.scope ? scopeFrom(args.scope) : undefined;
    const opened = await openCompile(connect(origin, bearer), { subject: args.subject, product: args.product, build: args.build, booking: args.booking, ...(args.version ? { version: args.version } : {}), ...(scope ? { scope } : {}), ...(exclude ? { exclude } : {}), ...(args.contract ? { contract: args.contract } : {}), ...(args.inventory ? { inventory: args.inventory } : {}), ...(args.profile ? { profile: args.profile } : {}), ...(args['recompose-run'] ? { reuse: { run: args['recompose-run'], record: args['recompose-record']! } } : {}) }, skillsRoot, judge === 'plumb' ? { url: args.plumb, key, status: plumbStatus } : undefined);
    const record = { schema: 'open-compile@1', ready: true, subject: args.subject, product: args.product, build: args.build, booking: args.booking, recompose_run: opened.recomposeRun, recompose_record: opened.recomposeRecord, plan_run: opened.planRun, plan_record: opened.planRecord, items: opened.items, ...(args.version ? { version: args.version } : {}), ...(args.contract ? { contract: args.contract } : {}), ...(args.inventory ? { inventory: args.inventory } : {}), ...(args.profile ? { profile: args.profile } : {}), ...(scope ? { scope } : {}), ...(exclude?.length ? { exclude } : {}), ...(judge === 'model' ? { judge } : {}) };
    await writeFile(resolve(args.out), JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    process.stdout.write(`就绪：用例重组运行 ${opened.recomposeRun}、脚本编写运行 ${opened.planRun}，共 ${opened.items} 条用例${judge === 'model' ? '；判断方式 model：这次不经 Plumb，命令核验只做命令树的程序核对，场景保真由独立盲审判断，结论都要在最后报告里照实写' : ''}。下一步下载两个运行（download-run.ts），再按编排开始编译。\n${JSON.stringify(record)}\n`);
    return 0;
  } catch (error) {
    const words = error instanceof NotReady ? error.message : `开运行工具出错：${error instanceof Error ? error.message : String(error)}`;
    process.stdout.write(`无法编译：${words}\n`);
    return 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
