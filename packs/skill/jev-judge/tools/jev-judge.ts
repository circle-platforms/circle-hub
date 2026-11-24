import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JevClient, parseJevJson, validateJevRequest } from '../functions/modules/jev-client/index.ts';
import type { JevAnswer, JevRequest, JevResponse, JevTransport } from '../functions/modules/jev-client/index.ts';
import { MAX_KEY_LENGTH } from '../functions/modules/jev-client/client.ts';
import { writeNewPrivateFile } from '../functions/modules/jev-client/files.ts';
import { redactSecret } from '../functions/modules/jev-client/redact.ts';
import { MAX_BODY_BYTES, isPlainObject } from '../functions/modules/jev-client/validate.ts';

// What the tool reads is bounded by what the client would send: a request file is at most as large as the largest request body, and the
// key is the first line of the standard input, which is at most as long as the longest key, so nothing past that line is read.
const MAX_INPUT_BYTES = MAX_BODY_BYTES;
const MAX_STDIN_LINE_BYTES = MAX_KEY_LENGTH;
// A whole line of the form %NAME%: the client left a placeholder in instead of expanding it.
const PLACEHOLDER_SHAPE = /^%[A-Za-z0-9_]{1,64}%$/;
const MAX_TIMEOUT_MS = 600_000;
const KEY_PLACEHOLDER = '%JEV_API_KEY%';
const VALUE_FLAGS = new Set(['--input', '--out', '--model', '--timeout-ms']);
const BOOLEAN_FLAGS = new Set(['--key-stdin']);
const SECRET_FLAGS = new Set(['--api-key', '--apikey', '--key', '--token', '--secret']);
const INPUT_FIELDS = new Set(['state', 'questions', 'model']);

export interface CliIo {
  /** The standard input as text; read from the process when absent. */
  stdinText?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** Stands in for the network, for tests. The command line has no way to set it, and the address stays the fixed one. */
  transport?: JevTransport;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const HELP_TEXT = [
  '用法: node <技能目录>/tools/jev-judge.ts ask --input <请求JSON> --out <输出目录> [--model <模型>] [--timeout-ms <毫秒>] --key-stdin',
  '',
  '子命令:',
  '  ask    把 state 和几道是非、单选或评分题交给 Jev，答案写进输出目录',
  '',
  '选项（带值的选项一律写成 --选项 值，不用 = 连接）:',
  '  --input <文件>        请求 JSON：{"state": …, "questions": {…}}，可以另写 "model"；文件最大 32 MiB，和一个请求的上限一致',
  '  --out <目录>          写 answers.json（答案）和 audit.jsonl（审计记录：只有大小、摘要、状态和用量，没有内容）',
  '  --model <模型>        盖过请求文件里的 model；都不写时用 jev-latest',
  '  --timeout-ms <毫秒>   单次请求的时限，默认 30000，最大 600000；超时的请求不重发',
  '  --key-stdin           密钥只从标准输入第一行传入（最长 ' + MAX_STDIN_LINE_BYTES + ' 字节，只读这一行；命令里写占位符 ' + KEY_PLACEHOLDER + '），没有别的传法',
].join('\n');

type Category = '参数无效' | '无权限' | '暂时不可用' | '不存在' | '已被占用';

const sentence = (text: string): string => `${text.trim().replace(/[。.!！?？]+$/u, '')}。`;

/** A refusal in the call-error form of this repository: category word, the fact, the next step. */
class ToolFailure extends Error {
  constructor(category: Category, fact: string, nextAction: string) {
    super(`${category}：${sentence(fact)}${sentence(nextAction)}`);
    this.name = 'ToolFailure';
  }
}

interface Parsed {
  help: boolean;
  flags: Map<string, string | true>;
}

function parseArgs(argv: readonly string[]): Parsed {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') return { help: true, flags: new Map() };
  if (argv[0] !== 'ask') {
    throw new ToolFailure('参数无效', '首个参数必须是子命令 ask', '请写成 ask --input <请求JSON> --out <输出目录> --key-stdin');
  }
  const flags = new Map<string, string | true>();
  const rest = argv.slice(1);
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (token === '--help' || token === '-h') return { help: true, flags: new Map() };
    if (!token.startsWith('--')) {
      throw new ToolFailure('参数无效', `第 ${index + 2} 个参数不是选项`, '所有参数请写成 --选项 值 的形式');
    }
    const equals = token.indexOf('=');
    const name = equals === -1 ? token : token.slice(0, equals);
    if (SECRET_FLAGS.has(name)) {
      throw new ToolFailure('参数无效', `禁止通过命令行参数 ${name} 传入密钥`, `请改用 --key-stdin 从标准输入第一行传入，命令里写占位符 ${KEY_PLACEHOLDER}`);
    }
    if (!/^--[a-z][a-z0-9-]{0,30}$/.test(name) || (!VALUE_FLAGS.has(name) && !BOOLEAN_FLAGS.has(name))) {
      throw new ToolFailure('参数无效', /^--[a-z][a-z0-9-]{0,30}$/.test(name) ? `不支持选项 ${name}` : '有一个不认识的选项', '支持的选项见 --help');
    }
    if (equals !== -1) throw new ToolFailure('参数无效', `选项 ${name} 不允许使用 = 连接`, `请改用空格分隔：${name} 值`);
    if (flags.has(name)) throw new ToolFailure('参数无效', `选项 ${name} 写了两次`, '每个选项只写一次');
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, true);
      continue;
    }
    const next = rest[index + 1];
    if (next === undefined || next.startsWith('--')) throw new ToolFailure('参数无效', `选项 ${name} 缺少取值`, '请在该选项后补上它的值');
    flags.set(name, next);
    index += 1;
  }
  return { help: false, flags };
}

function stringFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

/**
 * The first line of a stream (or of a text given in a list), without reading past it; null when that line is longer than limit bytes.
 * Leaving the loop at the line end closes the stream, so the rest of the input is never read.
 */
export async function readFirstLine(source: AsyncIterable<Buffer | string> | Iterable<Buffer | string>, limit: number): Promise<string | null> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of source) {
    const piece = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    const end = piece.findIndex((byte) => byte === 0x0a || byte === 0x0d);
    const line = end === -1 ? piece : piece.subarray(0, end);
    size += line.length;
    if (size > limit) return null;
    parts.push(line);
    if (end !== -1) break;
  }
  return Buffer.concat(parts).toString('utf8').trim();
}

/** The standard input of the process as chunks; nothing at all when it is a terminal. */
async function* standardInput(): AsyncGenerator<Buffer | string> {
  if (process.stdin.isTTY) return;
  yield* process.stdin;
}

/**
 * Reads a file to its end, or gives null as soon as more than limit bytes have come. The size seen before reading is no bound for a
 * file that grows, so the reading itself is bounded.
 */
export async function readAtMost(handle: Pick<FileHandle, 'read'>, limit: number): Promise<Buffer | null> {
  const parts: Buffer[] = [];
  let size = 0;
  for (;;) {
    const piece = Buffer.allocUnsafe(Math.min(1024 * 1024, limit + 1 - size));
    const { bytesRead } = await handle.read(piece, 0, piece.length, null);
    if (bytesRead === 0) return Buffer.concat(parts, size);
    size += bytesRead;
    if (size > limit) return null;
    parts.push(piece.subarray(0, bytesRead));
  }
}

async function readRegularText(filePath: string, label: string): Promise<string> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) throw new ToolFailure('参数无效', `${label} 不是常规文件`, '请指定真实文件的路径');
    const tooLarge = new ToolFailure('参数无效', `${label} 超过 ${MAX_INPUT_BYTES} 字节的上限（一个请求的上限）`, '请缩小请求或拆成几个文件');
    if (info.size > MAX_INPUT_BYTES) throw tooLarge;
    const bytes = await readAtMost(handle, MAX_INPUT_BYTES);
    if (bytes === null) throw tooLarge;
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new ToolFailure('参数无效', `${label} 指的文件不是合法的 UTF-8 文本`, '请把请求 JSON 存成 UTF-8 后重试');
    }
  } catch (error) {
    if (error instanceof ToolFailure) throw error;
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    throw new ToolFailure(code === 'ENOENT' ? '不存在' : code === 'EACCES' ? '无权限' : '参数无效', `无法读取 ${label} 指的文件（${code ?? 'IO'}）`, '请确认路径存在、可读，并且不是链接');
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return false;
    throw error;
  }
}

function describe(id: string, answer: JevAnswer): string {
  if (answer.type === 'noul') return `${id}（是非题）：答“是”的概率 ${answer.noul}`;
  const spread = Object.entries(answer.probabilities).map(([option, p]) => `${option} ${p}`).join('、');
  if (answer.type === 'choice') return `${id}（单选题）：选 ${answer.choice}，概率 ${answer.probabilities[answer.choice]}；各项 ${spread}；confidence ${answer.confidence}`;
  return `${id}（评分题）：期望等级 ${answer.score}；各级概率 ${spread}；confidence ${answer.confidence}`;
}

function summary(response: JevResponse, answersPath: string, auditPath: string, written: boolean): string[] {
  const ids = Object.keys(response.answers);
  return [
    `Jev 判断完成：${ids.length} 题。`,
    `模型版本：${response.model_version}；状态：${response.status}；决定者：${response.decided_by}。`,
    ...ids.map((id) => describe(id, response.answers[id]!)),
    `用量（token，模型计费的文本单位）：输入 ${response.usage.input_tokens}、输出 ${response.usage.output_tokens}。`,
    written ? `答案写入 ${answersPath}，审计记录写入 ${auditPath}。` : `答案没能写进 ${answersPath}；审计记录在 ${auditPath}。`,
    '这是模型判断，状态未确认；没有为任何用途校准过阈值，confidence 是概率的集中度而不是答对的概率；只作核对时的参考，不当作已核准的结论。',
  ];
}

export async function runJevJudgeCli(argv: readonly string[], io: CliIo = {}): Promise<number> {
  const out = io.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const errOut = io.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  let key: string | undefined;
  try {
    const { help, flags } = parseArgs(argv);
    if (help) {
      out(HELP_TEXT);
      return 0;
    }
    const inputPath = stringFlag(flags, '--input');
    const outDir = stringFlag(flags, '--out');
    if (inputPath === undefined) throw new ToolFailure('参数无效', '缺少 --input <请求JSON>', '请传入含 state 和 questions 的 JSON 文件');
    if (outDir === undefined) throw new ToolFailure('参数无效', '缺少 --out <输出目录>', '请指定写答案和审计记录的目录');
    if (flags.get('--key-stdin') !== true) {
      throw new ToolFailure('参数无效', '缺少 --key-stdin：密钥只从标准输入第一行传入', `请加上 --key-stdin，并在命令后用 here-doc 传占位符 ${KEY_PLACEHOLDER}`);
    }
    let timeoutMs: number | undefined;
    const timeoutText = stringFlag(flags, '--timeout-ms');
    if (timeoutText !== undefined) {
      timeoutMs = /^\d{1,7}$/.test(timeoutText) ? Number(timeoutText) : 0;
      if (timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw new ToolFailure('参数无效', `--timeout-ms 必须是 1 到 ${MAX_TIMEOUT_MS} 之间的整数`, '请传入合法的毫秒数');
    }

    const line = await readFirstLine(io.stdinText === undefined ? standardInput() : [io.stdinText], MAX_STDIN_LINE_BYTES);
    // Every refusal of the key in this block is a check made here: nothing has been sent and the service has refused nothing.
    const local = '这是本地检查，没有发出任何请求';
    const fixKey = `请把 JEV_API_KEY 写进标准输入第一行（命令里写占位符 ${KEY_PLACEHOLDER}）`;
    if (line === null) throw new ToolFailure('参数无效', `标准输入第一行超过 ${MAX_STDIN_LINE_BYTES} 字节，不是密钥；${local}`, fixKey);
    if (line === '') throw new ToolFailure('参数无效', `已传入 --key-stdin 但标准输入首行为空；${local}`, fixKey);
    if (PLACEHOLDER_SHAPE.test(line)) {
      throw new ToolFailure(
        '无权限',
        `标准输入第一行还是占位符 ${line}，客户端没有把它展开成密钥；${local}`,
        line === KEY_PLACEHOLDER ? '请使用者在客户端用 /secrets JEV_API_KEY 存好密钥后重试' : `这个工具的密钥占位符是 ${KEY_PLACEHOLDER}；请改正命令后重试`,
      );
    }
    key = line;

    const parsedInput = parseJevJson(await readRegularText(inputPath, '--input'));
    if (!parsedInput.ok) {
      throw new ToolFailure('参数无效', parsedInput.problem === 'duplicate_key' ? '--input 的文件里同一个对象有重复的键（例如同一个题目标识写了两次）' : '--input 的文件不是合法 JSON', '请核对文件内容后重试');
    }
    const body = parsedInput.value;
    if (!isPlainObject(body)) throw new ToolFailure('参数无效', '--input 的文件必须是 JSON 对象', '请写成 {"state": …, "questions": {…}}');
    if (Object.keys(body).some((name) => !INPUT_FIELDS.has(name))) {
      throw new ToolFailure('参数无效', '--input 的文件有不认识的字段（只认 state、questions、model）', '请删掉多余的字段；密钥不能写进文件');
    }
    const model = stringFlag(flags, '--model') ?? body.model;
    const request = { state: body.state, questions: body.questions, ...(model === undefined ? {} : { model }) } as JevRequest;
    validateJevRequest(request);

    if (await exists(outDir)) {
      if (!(await lstat(outDir)).isDirectory()) throw new ToolFailure('参数无效', '--out 指的路径已经存在，但不是目录', '请换一个 --out 目录');
    }
    const answersPath = join(outDir, 'answers.json');
    const auditPath = join(outDir, 'audit.jsonl');
    if (await exists(answersPath)) {
      throw new ToolFailure('已被占用', '--out 目录里已经有一份 answers.json', '请换一个 --out 目录，或先把这份答案移走；审计记录总是追加在 audit.jsonl 里');
    }

    const client = new JevClient({
      apiKey: key,
      auditPath,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(io.transport === undefined ? {} : { transport: io.transport }),
      ...(io.now === undefined ? {} : { now: io.now }),
      ...(io.sleep === undefined ? {} : { sleep: io.sleep }),
    });
    const response = await client.ask(request);
    let writeFailure: unknown;
    try {
      await writeNewPrivateFile(answersPath, `${JSON.stringify(response, null, 2)}\n`);
    } catch (error) {
      writeFailure = error;
    }
    for (const line of summary(response, answersPath, auditPath, writeFailure === undefined)) out(redactSecret(line, [key]));
    if (writeFailure !== undefined) {
      const taken = (writeFailure as NodeJS.ErrnoException | undefined)?.code === 'EEXIST';
      throw new ToolFailure(taken ? '已被占用' : '暂时不可用', taken ? '写答案时 answers.json 已经出现' : '答案已经收到，但写不进 answers.json', '上面已经列出这次的答案；服务可能已经计费，请不要直接重发，先换一个 --out 目录或修好目录权限');
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errOut(redactSecret(message, [key]));
    return 1;
  }
}

if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runJevJudgeCli(process.argv.slice(2));
}
