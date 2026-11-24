import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { type CallErrorCategory as CallErrorCode } from './generated/vocabulary.ts';
import { JevClient, httpsTransport, type JevTransport } from './generated/skills/jev-judge/jev-client/index.ts';
import { JevJudge, jevFailure, type JevAsker, type JevUnanswered } from './jev-judge.ts';
import { CallFailure, formatCallError } from './text.ts';
import {
  PlumbClient,
  PlumbHttpError,
  validatePlumbBaseUrl,
  type CallErrorCategory as PlumbErrorCategory,
  type PlumbBatchAnswer,
  type PlumbBatchQuestion,
  type PlumbClientConfig,
} from './generated/skills/plumb/plumb-client/index.ts';

const PLUMB_CATEGORY_TO_CODE: Record<PlumbErrorCategory, CallErrorCode> = {
  参数无效: 'invalid_parameters',
  无权限: 'permission_denied',
  不存在: 'not_found',
  已被占用: 'occupied',
  暂时不可用: 'temporarily_unavailable',
};

export function plumbFailure(category: PlumbErrorCategory, fact: string, nextAction: string): CallFailure {
  return new CallFailure(PLUMB_CATEGORY_TO_CODE[category], fact, nextAction);
}

export function formatPlumbCliError(error: unknown): string {
  if (error instanceof PlumbHttpError) {
    const code = PLUMB_CATEGORY_TO_CODE[error.category];
    const prefix = `${error.category}：`;
    const body = error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
    const sentences = body.split('。').map((s) => s.trim()).filter(Boolean);
    const fact = sentences[0] || `Plumb 网关返回 HTTP ${error.status}（${error.code}）`;
    const nextAction = sentences.slice(1).join('；') || '请按 Plumb 网关错误说明修正请求或联系管理员检查服务状态';
    return formatCallError(new CallFailure(code, fact, nextAction));
  }
  return formatCallError(error);
}

const MAX_STDIN_BYTES = 64 * 1024;
const FORBIDDEN_SECRET_FLAGS = new Set(['--api-key', '--token', '--claim-code']);

export interface PlumbCliOptions {
  /** plumb (the default) or jev; only the tools that the pipeline runs for a compile judged by Jev take it. */
  judge?: string;
  baseUrl?: string;
  model?: string;
  caFile?: string;
  caSha256?: string;
  allowInsecureHttp?: boolean;
  cacheDir?: string;
  noCache?: boolean;
  auditOut?: string;
  /** Jev only: the file that keeps the answers across passes (the tools name it beside their other outputs; no option of the command line sets it). */
  jevAnswers?: string;
  keyStdin?: boolean;
}

/** Builds the client of the jev-judge skill for one invocation; tests inject a scripted one. */
export type JevFactory = (config: { apiKey: string; auditPath?: string; transport?: JevTransport; timeoutMs?: number }) => JevAsker | Promise<JevAsker>;

export interface PlumbToolIo {
  stdinText?: string;
  env?: NodeJS.ProcessEnv;
  jev?: JevFactory;
  /** Stands in for the network when a test runs the embedded Jev client; the command line has no way to set it, and the address stays the module's fixed one. */
  jevTransport?: JevTransport;
}

export function parseFlagMap(
  argv: readonly string[],
  spec: {
    booleanFlags?: ReadonlySet<string>;
    valueFlags?: ReadonlySet<string>;
    usage: string;
  },
): { help: boolean; flags: Map<string, string | true> } {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { help: true, flags: new Map() };
  }
  const boolSet = spec.booleanFlags ?? new Set<string>();
  const valSet = spec.valueFlags ?? new Set<string>();
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      throw plumbFailure('参数无效', `未识别的参数 ${token}`, `用法：${spec.usage}`);
    }
    const eqIndex = token.indexOf('=');
    const name = eqIndex === -1 ? token : token.slice(0, eqIndex);
    if (FORBIDDEN_SECRET_FLAGS.has(name)) {
      throw plumbFailure(
        '参数无效',
        `禁止通过命令行参数 ${name} 传入凭据`,
        '请改用 --key-stdin（标准输入第一行）或环境变量 PLUMB_API_KEY',
      );
    }
    if (eqIndex !== -1) {
      throw plumbFailure('参数无效', `参数 ${token} 不允许使用 = 连接`, '请改用空格分隔：--选项 值');
    }
    if (boolSet.has(name)) {
      flags.set(name, true);
      continue;
    }
    if (!valSet.has(name)) {
      throw plumbFailure('参数无效', `不支持的参数 ${name}`, `用法：${spec.usage}`);
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw plumbFailure('参数无效', `参数 ${name} 缺少取值`, `用法：${spec.usage}`);
    }
    flags.set(name, next);
    i += 1;
  }
  return { help: false, flags };
}

export const SHARED_PLUMB_BOOL_FLAGS = new Set(['--allow-insecure-http', '--no-cache', '--key-stdin']);
export const SHARED_PLUMB_VALUE_FLAGS = new Set(['--base-url', '--model', '--ca-file', '--ca-sha256', '--cache-dir', '--audit-out']);

export function extractPlumbCliOptions(flags: ReadonlyMap<string, string | true>): PlumbCliOptions {
  const str = (key: string): string | undefined => {
    const v = flags.get(key);
    return typeof v === 'string' ? v : undefined;
  };
  return {
    judge: str('--judge'),
    baseUrl: str('--base-url'),
    model: str('--model'),
    caFile: str('--ca-file'),
    caSha256: str('--ca-sha256'),
    allowInsecureHttp: flags.get('--allow-insecure-http') === true,
    cacheDir: str('--cache-dir'),
    noCache: flags.get('--no-cache') === true,
    auditOut: str('--audit-out'),
    keyStdin: flags.get('--key-stdin') === true,
  };
}

async function readFirstLineStdin(io: PlumbToolIo, what = 'Plumb API Key'): Promise<string> {
  if (io.stdinText !== undefined) {
    const first = io.stdinText.split(/\r?\n/u)[0]?.trim() ?? '';
    if (!first) throw plumbFailure('无权限', '标准输入第一行为空', `请通过标准输入传入 ${what}`);
    return first;
  }
  if (process.stdin.isTTY) {
    throw plumbFailure('无权限', '已启用 --key-stdin 但未检测到管道输入', '请用 heredoc 或管道在同一步传入密钥');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_STDIN_BYTES) {
      throw plumbFailure('参数无效', '标准输入内容超过上限', `第一行仅传 ${what}`);
    }
    chunks.push(buf);
  }
  const first = Buffer.concat(chunks).toString('utf8').split(/\r?\n/u)[0]?.trim() ?? '';
  if (!first) {
    throw plumbFailure('无权限', '标准输入第一行为空', `请确保第一行为有效 ${what}`);
  }
  return first;
}

async function checkCaPathSafe(caFile: string | undefined): Promise<void> {
  if (!caFile) return;
  const fh = await open(caFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  await fh.close();
}

export async function createCasePlumbClient(
  opts: PlumbCliOptions,
  io: PlumbToolIo = {},
): Promise<PlumbClient> {
  const env = io.env ?? process.env;
  const baseUrl = (opts.baseUrl ?? env.PLUMB_BASE_URL ?? '').trim();
  if (!baseUrl) {
    throw plumbFailure('参数无效', '缺少 --base-url 或环境变量 PLUMB_BASE_URL', '请提供 Plumb 网关 HTTPS 地址');
  }
  try {
    validatePlumbBaseUrl(baseUrl, opts.allowInsecureHttp);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const cat: PlumbErrorCategory = msg.startsWith('无权限：') ? '无权限' : '参数无效';
    throw plumbFailure(cat, msg.replace(/^(?:无权限|参数无效)：/, ''), '请提供合法的 Plumb 网关 HTTPS 地址（回环调试可用 http://）');
  }
  const caFile = (opts.caFile ?? env.PLUMB_CA_FILE ?? '').trim() || undefined;
  const caSha256 = (opts.caSha256 ?? env.PLUMB_CA_SHA256 ?? '').trim() || undefined;
  await checkCaPathSafe(caFile).catch((err) => {
    throw plumbFailure(
      '无权限',
      `无法读取 CA 证书 ${caFile}: ${err instanceof Error ? err.message : String(err)}`,
      '请提供非符号链接的常规证书文件路径',
    );
  });
  const apiKey = opts.keyStdin
    ? await readFirstLineStdin(io)
    : (env.PLUMB_API_KEY ?? '').trim();
  if (!apiKey) {
    throw plumbFailure('无权限', '缺少 Plumb API 密钥', '请设置 PLUMB_API_KEY 或通过 --key-stdin 传入');
  }
  const config: PlumbClientConfig = {
    baseUrl,
    apiKey,
    model: (opts.model ?? env.PLUMB_MODEL ?? '').trim() || undefined,
    caFile,
    caSha256,
    allowInsecureHttp: opts.allowInsecureHttp,
    cacheDir: opts.cacheDir,
    noCache: opts.noCache,
    auditOut: opts.auditOut,
  };
  return new PlumbClient(config);
}

export type JudgeName = 'plumb' | 'jev';

/** What the two judge tools use of a judge: the batched question call, whoever answers. */
export interface BatchJudgeClient {
  judgeBatched(params: { task?: string; questions: Record<string, PlumbBatchQuestion> }): Promise<{ model_version: string | null; answers: Record<string, PlumbBatchAnswer>; unanswered?: Record<string, JevUnanswered> }>;
}

export interface CaseJudge {
  judge: JudgeName;
  client: BatchJudgeClient;
  /** Set when Jev judges: the adapter, which counts the requests it really sent. */
  jev?: JevJudge;
}

/** The longest a Jev request may take on the pipeline path: the client's own limit is 30 seconds, which a busy service can pass. */
export const JEV_REQUEST_TIMEOUT_MS = 60_000;
/**
 * The embedded client of the jev-judge skill: its address is fixed in the module, its key is the first line of the standard input, its request log
 * is the audit path. What it reports as sent is what left its transport: the client sends a request again once after a 429 or a 529, and that is
 * a second request for the service, and for its bill.
 */
export const DEFAULT_JEV: JevFactory = ({ apiKey, auditPath, transport, timeoutMs }) => {
  let sent = 0;
  const inner = transport ?? httpsTransport;
  const counting: JevTransport = (request) => { sent += 1; return inner(request); };
  const client = new JevClient({ apiKey, timeoutMs: timeoutMs ?? JEV_REQUEST_TIMEOUT_MS, ...(auditPath ? { auditPath } : {}), transport: counting });
  return { ask: (request) => client.ask(request), sent: () => sent };
};
const KEY_PLACEHOLDER = /^%[A-Z][A-Z0-9_]*%$/u;

export function judgeOf(opts: PlumbCliOptions): JudgeName {
  const judge = opts.judge ?? 'plumb';
  if (judge !== 'plumb' && judge !== 'jev') throw plumbFailure('参数无效', `--judge 只能写 plumb 或 jev（看到 ${judge.slice(0, 40)}）`, '这个选项由 pipeline.ts 按这次编译的判断方式带上，不手写');
  return judge;
}

/**
 * The client that answers the batched questions of one invocation: Plumb as before, or Jev. The Jev key comes only from the
 * first line of the standard input (never from the environment) and is never an unexpanded placeholder.
 */
export async function createCaseJudge(opts: PlumbCliOptions, io: PlumbToolIo = {}): Promise<CaseJudge> {
  if (judgeOf(opts) === 'plumb') return { judge: 'plumb', client: await createCasePlumbClient(opts, io) };
  if (!opts.keyStdin) throw plumbFailure('无权限', 'Jev 密钥只从标准输入第一行读入，没有带 --key-stdin', '这个选项由 pipeline.ts 带上，不手写');
  const apiKey = await readFirstLineStdin(io, 'Jev 密钥');
  if (KEY_PLACEHOLDER.test(apiKey)) throw plumbFailure('无权限', 'Jev 密钥没有展开，标准输入第一行还是占位符', '请使用者把 Jev 密钥保存为客户端密钥 JEV_API_KEY，再启动编写循环');
  let asker: JevAsker;
  try {
    asker = await (io.jev ?? DEFAULT_JEV)({ apiKey, ...(opts.auditOut ? { auditPath: opts.auditOut } : {}), ...(io.jevTransport ? { transport: io.jevTransport } : {}) });
  } catch (error) {
    throw jevFailure(error, apiKey);
  }
  const jev = new JevJudge(asker, { ...(opts.model ? { model: opts.model } : {}), secret: apiKey, ...(opts.jevAnswers ? { answersFile: opts.jevAnswers } : {}) });
  return { judge: 'jev', client: jev, jev };
}
