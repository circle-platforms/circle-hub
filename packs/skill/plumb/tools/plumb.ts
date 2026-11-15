// CLI wrapper for the Plumb inference gateway (models, status, wake, judge, ask, request-key, claim-key).
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  PlumbClient,
  PlumbHttpError,
  formatPlumbCallError,
  redactSecret,
  writePrivateFile,
  type PlumbBatchQuestion,
  type PlumbCandidate,
  type PlumbJudgeRequest,
  type PlumbMindmapNode,
  type PlumbSystemOneRequest,
} from '../functions/modules/plumb-client/index.ts';

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const OPTIONS: Record<string, boolean> = {
  'base-url': true,
  model: false,
  'ca-file': false,
  'ca-sha256': false,
  'cache-dir': false,
  out: false,
  'result-out': false,
  'timeout-ms': false,
  'timeout-sec': false,
  'poll-sec': false,
  file: false,
  'state-file': false,
  'node-file': false,
  'candidates-file': false,
  task: false,
  command: false,
  definition: false,
  name: false,
  purpose: false,
  contact: false,
  'request-id': false,
};
const BOOLEAN_OPTIONS = ['key-stdin', 'claim-code-stdin', 'wait', 'no-cache', 'allow-insecure-http'] as const;
const BOOLEAN_FLAGS = new Set([
  ...BOOLEAN_OPTIONS.map((name) => `--${name}`),
  '--help',
  '-h',
]);
const SECRET_VALUE_FLAGS = new Set(['--api-key', '--claim-code', '--token']);

export interface CliIo {
  stdinText?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

const HELP_TEXT = [
  '用法: node <技能目录>/tools/plumb.ts <子命令> [选项]',
  '',
  '子命令:',
  '  models                                    列出网关模型及默认模型',
  '  status                                    查看模型就绪与部署状态',
  '  wake [--wait] [--timeout-sec <秒>]        唤醒空闲后端并可选等待就绪',
  '  judge (--state-file <路径> | --file <路径>) [--task <任务>] [--candidates-file <路径>]',
  '                                            调用 /v1/judge（超过 32 题自动分批 <=32）',
  '  ask --file <路径>                         调用 /v1/systemone 结构化判断',
  '  request-key --name <名称> --purpose <用途> 发起新密钥申请（返回 request_id 与 claim_code）',
  '  claim-key --request-id <编号> --claim-code-stdin',
  '                                            凭标准输入第一行领取已审批密钥',
  '',
  '公共选项（所有带值选项均用空格分隔，禁止使用 = 连接）:',
  '  --base-url <url> --ca-file <pem> --ca-sha256 <hex> --model <id>',
  '  --key-stdin --cache-dir <dir> --no-cache --out <audit.jsonl> --result-out <json>',
].join('\n');

function parseCliArgs(argv: readonly string[]): {
  subcommand: string;
  flags: Map<string, string | true>;
} {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    return { subcommand: '--help', flags: new Map() };
  }
  const [subcommand, ...rest] = argv;
  if (subcommand.startsWith('-')) {
    throw new Error(formatPlumbCallError('参数无效', `首个参数必须是子命令，收到 ${subcommand}`, '请指定 models/status/wake/judge/ask/request-key/claim-key'));
  }
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('-')) {
      throw new Error(formatPlumbCallError('参数无效', `未识别的位置参数 ${token}`, '所有参数请使用 --选项 值 的形式传入'));
    }
    const eqIndex = token.indexOf('=');
    const flagName = eqIndex === -1 ? token : token.slice(0, eqIndex);
    if (SECRET_VALUE_FLAGS.has(flagName)) {
      throw new Error(
        formatPlumbCallError(
          '参数无效',
          `禁止通过命令行参数 ${flagName} 传入密钥或领取码`,
          '请改用 --key-stdin 或 --claim-code-stdin 从标准输入第一行传入，或设置 PLUMB_API_KEY',
        ),
      );
    }
    if (eqIndex !== -1) {
      throw new Error(formatPlumbCallError('参数无效', `选项 ${token} 不允许使用 = 连接`, '请改用空格分隔：--选项 值'));
    }
    if (BOOLEAN_FLAGS.has(token)) {
      flags.set(token, true);
      continue;
    }
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new Error(formatPlumbCallError('参数无效', `选项 ${token} 缺少取值`, '请在该选项后补充对应参数值'));
    }
    flags.set(token, next);
    i += 1;
  }
  return { subcommand, flags };
}

function stringFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const val = flags.get(name);
  return typeof val === 'string' ? val : undefined;
}

function hasFlag(flags: Map<string, string | true>, name: string): boolean {
  return flags.get(name) === true;
}

function intFlag(flags: Map<string, string | true>, name: string): number | undefined {
  const raw = stringFlag(flags, name);
  if (raw === undefined) return undefined;
  if (!/^\d+$/u.test(raw)) {
    throw new Error(formatPlumbCallError('参数无效', `选项 ${name} 需要非负整数，收到 ${raw}`, '请传入合法整数'));
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    throw new Error(formatPlumbCallError('参数无效', `选项 ${name} 整数越界`, '请传入较小整数'));
  }
  return n;
}

async function readRegularText(filePath: string, label: string): Promise<string> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new Error(formatPlumbCallError('参数无效', `${label} 不是常规文件`, '请指定真实文件路径'));
    }
    if (info.size > MAX_INPUT_BYTES) {
      throw new Error(formatPlumbCallError('参数无效', `${label} 超过 ${MAX_INPUT_BYTES} 字节上限`, '请拆分输入文件后重试'));
    }
    return await handle.readFile({ encoding: 'utf8' });
  } catch (error) {
    if (error instanceof Error && error.message.includes('：')) throw error;
    const code = (error as NodeJS.ErrnoException)?.code;
    throw new Error(
      formatPlumbCallError(
        code === 'ENOENT' ? '不存在' : code === 'EACCES' ? '无权限' : '参数无效',
        `无法读取${label}（${code ?? 'IO'}）`,
        '请确认路径存在且非符号链接',
      ),
    );
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readJsonFile(filePath: string, label: string): Promise<unknown> {
  const text = await readRegularText(filePath, label);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(formatPlumbCallError('参数无效', `${label} 不是合法 JSON`, '请核对文件内容格式后重试'));
  }
}

async function readStdinAll(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function firstLine(text: string): string {
  const line = text.replace(/\r\n?/gu, '\n').split('\n')[0] ?? '';
  return line.trim();
}

export async function runPlumbCli(argv: readonly string[], io: CliIo = {}): Promise<number> {
  const out = io.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const errOut = io.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const env = io.env ?? process.env;
  let loadedSecret: string | undefined;

  try {
    const { subcommand, flags } = parseCliArgs(argv);
    if (subcommand === '--help' || hasFlag(flags, '--help') || hasFlag(flags, '-h')) {
      out(HELP_TEXT);
      return 0;
    }

    const needsKeyStdin = hasFlag(flags, '--key-stdin');
    const needsClaimStdin = hasFlag(flags, '--claim-code-stdin');
    let stdinValue: string | undefined = io.stdinText;
    if ((needsKeyStdin || needsClaimStdin) && stdinValue === undefined) {
      stdinValue = await readStdinAll();
    }

    let apiKey: string | undefined;
    if (needsKeyStdin) {
      const line = firstLine(stdinValue ?? '');
      if (!line) {
        throw new Error(formatPlumbCallError('参数无效', '已传入 --key-stdin 但标准输入首行为空', '请将 PLUMB_API_KEY 写入标准输入第一行'));
      }
      apiKey = line;
    }
    loadedSecret = apiKey ?? env.PLUMB_API_KEY;

    const client = new PlumbClient(
      PlumbClient.configFromEnv(
        {
          baseUrl: stringFlag(flags, '--base-url'),
          apiKey,
          model: stringFlag(flags, '--model'),
          caFile: stringFlag(flags, '--ca-file'),
          caSha256: stringFlag(flags, '--ca-sha256'),
          allowInsecureHttp: hasFlag(flags, '--allow-insecure-http'),
          cacheDir: stringFlag(flags, '--cache-dir'),
          noCache: hasFlag(flags, '--no-cache'),
          auditOut: stringFlag(flags, '--out'),
          timeoutMs: intFlag(flags, '--timeout-ms'),
        },
        env,
      ),
    );

    let result: unknown;
    switch (subcommand) {
      case 'models': {
        result = await client.models();
        break;
      }
      case 'status': {
        result = await client.status(stringFlag(flags, '--model'));
        break;
      }
      case 'wake': {
        const wait = hasFlag(flags, '--wait');
        if (wait) {
          const timeoutSec = intFlag(flags, '--timeout-sec') ?? 720;
          const pollSec = intFlag(flags, '--poll-sec') ?? 5;
          result = await client.wakeAndWait({
            model: stringFlag(flags, '--model'),
            timeoutMs: timeoutSec * 1000,
            pollIntervalMs: pollSec * 1000,
          });
        } else {
          result = await client.wake(stringFlag(flags, '--model'));
        }
        break;
      }
      case 'request-key': {
        const name = stringFlag(flags, '--name') ?? '';
        const purpose = stringFlag(flags, '--purpose') ?? '';
        const contact = stringFlag(flags, '--contact');
        result = await client.requestKey({ name, purpose, contact });
        break;
      }
      case 'claim-key': {
        if (!needsClaimStdin) {
          throw new Error(formatPlumbCallError('参数无效', 'claim-key 必须传入 --claim-code-stdin', '请通过标准输入首行传入 claim code'));
        }
        const claimCode = firstLine(stdinValue ?? '');
        const requestId = stringFlag(flags, '--request-id') ?? '';
        const claimed = await client.claimKey({ requestId, claimCode });
        if (typeof claimed.api_key === 'string') loadedSecret = claimed.api_key;
        result = claimed;
        break;
      }
      case 'ask': {
        const filePath = stringFlag(flags, '--file');
        if (!filePath) {
          throw new Error(formatPlumbCallError('参数无效', 'ask 子命令缺少 --file <路径>', '请传入包含 systemone 请求体 JSON 的文件路径'));
        }
        const payload = await readJsonFile(filePath, '--file');
        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
          throw new Error(formatPlumbCallError('参数无效', 'ask 请求体必须是 JSON 对象', '请核对文件内容'));
        }
        const body: PlumbSystemOneRequest = { ...(payload as PlumbSystemOneRequest) };
        const modelOverride = stringFlag(flags, '--model');
        if (modelOverride) body.model = modelOverride;
        result = await client.ask(body);
        break;
      }
      case 'judge': {
        const filePath = stringFlag(flags, '--file');
        const stateFile = stringFlag(flags, '--state-file');
        const nodeFile = stringFlag(flags, '--node-file');
        const candidatesFile = stringFlag(flags, '--candidates-file');
        const taskOverride = stringFlag(flags, '--task');
        const modelOverride = stringFlag(flags, '--model');
        const commandOverride = stringFlag(flags, '--command');
        const definitionOverride = stringFlag(flags, '--definition');

        if (filePath) {
          const payload = await readJsonFile(filePath, '--file');
          if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
            throw new Error(formatPlumbCallError('参数无效', '--file 必须是 JSON 对象', '请传入 /v1/judge 请求结构'));
          }
          const reqObj = { ...(payload as PlumbJudgeRequest) };
          if (taskOverride) reqObj.task = taskOverride;
          if (modelOverride) reqObj.model = modelOverride;
          if (reqObj.questions && Object.keys(reqObj.questions).length > 32) {
            result = await client.judgeBatched({
              model: reqObj.model,
              task: reqObj.task,
              state: reqObj.state,
              questions: reqObj.questions as Record<string, PlumbBatchQuestion>,
            });
          } else {
            result = await client.judge(reqObj);
          }
        } else {
          if (!taskOverride) {
            throw new Error(formatPlumbCallError('参数无效', '未使用 --file 时必须传 --task', '请指定 match/choice/sequence 等任务名'));
          }
          if (!stateFile && !nodeFile) {
            throw new Error(formatPlumbCallError('参数无效', '缺少 --state-file 或 --node-file', '请二选一提供待判上下文'));
          }
          if (stateFile && nodeFile) {
            throw new Error(formatPlumbCallError('参数无效', '不能同时指定 --state-file 与 --node-file', '网关规定 state 与 node 互斥'));
          }
          const reqObj: PlumbJudgeRequest = {
            task: taskOverride,
            ...(modelOverride ? { model: modelOverride } : {}),
            ...(commandOverride !== undefined ? { command: commandOverride } : {}),
            ...(definitionOverride !== undefined ? { definition: definitionOverride } : {}),
          };
          if (stateFile) {
            const rawText = await readRegularText(stateFile, '--state-file');
            if (stateFile.endsWith('.json')) {
              try {
                reqObj.state = JSON.parse(rawText) as string | Record<string, unknown> | unknown[];
              } catch {
                throw new Error(formatPlumbCallError('参数无效', '--state-file 为 .json 但不是合法 JSON', '请修复 JSON 格式'));
              }
            } else {
              reqObj.state = rawText;
            }
          }
          if (nodeFile) {
            const rawNode = await readJsonFile(nodeFile, '--node-file');
            if (typeof rawNode !== 'object' || rawNode === null || Array.isArray(rawNode)) {
              throw new Error(formatPlumbCallError('参数无效', '--node-file 必须是 JSON 对象', '请传入 { line, module, path, title }'));
            }
            reqObj.node = rawNode as PlumbMindmapNode;
          }
          if (candidatesFile) {
            const rawCands = await readJsonFile(candidatesFile, '--candidates-file');
            if (!Array.isArray(rawCands)) {
              throw new Error(formatPlumbCallError('参数无效', '--candidates-file 必须是 JSON 数组', '请传入候选命令或选项数组'));
            }
            reqObj.candidates = rawCands as PlumbCandidate[];
          }
          result = await client.judge(reqObj);
        }
        break;
      }
      default:
        throw new Error(formatPlumbCallError('参数无效', `未知子命令 ${subcommand}`, '支持的子命令为 models、status、wake、judge、ask、request-key、claim-key'));
    }

    const resultOutPath = stringFlag(flags, '--result-out');
    const serialized = `${JSON.stringify(result, null, 2)}\n`;
    if (resultOutPath) {
      await writePrivateFile(resultOutPath, serialized);
    }
    const redactList = subcommand === 'claim-key' ? [] : [loadedSecret];
    out(redactSecret(JSON.stringify(result, null, 2), redactList));
    return 0;
  } catch (error) {
    const rawMsg = error instanceof Error ? error.message : String(error);
    const codeTag = error instanceof PlumbHttpError && error.status > 0 ? `[HTTP ${error.status}/${error.code}] ` : '';
    errOut(`${codeTag}${redactSecret(rawMsg, [loadedSecret])}`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPlumbCli(process.argv.slice(2));
}
