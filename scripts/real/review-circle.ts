// Drives the REAL Circle client in an Otty tab with a REAL model (the owner's configured endpoint) against the deployed Hub:
// one prompt, the turn is awaited, and the evidence is the Hub's own call log for the time of the run (every tool call with
// its result code, acceptance and run id) plus the final screen. The model endpoint comes either from the owner's environment
// file (--env-file --provider [--section]) or, with --endpoint-from circle, from the owner's Circle configuration
// (settings.json auth and credentials.json; --circle-dir, default ~/.circle). It is read at run time into the 0600 files of a
// dedicated Circle folder and never shown; the screen carries the protocol, the host, the model and the key length. The Hub
// token comes from HUB_REAL_TOKEN.
//
//   HUB_REAL_TOKEN=<token> node scripts/real/review-circle.ts --env-file <file> --provider qwen --model <id> [--section <text>]
//        --prompt <text> --out <dir> --name <label> [--hub-url ...] [--circle-cli <dist/cli.js>] [--timeout-ms 1800000]
//   HUB_REAL_TOKEN=<token> node scripts/real/review-circle.ts --endpoint-from circle [--circle-dir <dir>] [--model <id>]
//        --prompt <text> --out <dir> --name <label> ...
//        [--home <dir>]   (reuse a folder written by an earlier run, to continue the same conversation context in a new session)
// The evidence holds real content (test cases, documents): it is written to --out only, never into the repository.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { circleEndpoint, endpointFrom, writeHome, type Endpoint } from './circle-home.ts';
import { readEnvFile } from './lib/env-file.ts';
import { createOtty } from './lib/otty.ts';
import { startCircle } from './lib/circle-session.ts';

export interface CallLine {
  at: string;
  tool: string;
  run: string | null;
  call_result: string;
  acceptance: string | null;
  error_code: string | null;
  duration_ms: number;
  args_size: number;
  session: string | null;
}

/** The lines of `circle-hub logs export` (JSON lines), unreadable lines left out. */
export function parseCallLog(text: string): CallLine[] {
  const out: CallLine[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      out.push(JSON.parse(line) as CallLine);
    } catch {
      // not a log line
    }
  }
  return out;
}

/** One line per tool: how many calls, how many ended in an error, and the codes. */
export function summarize(lines: readonly CallLine[]): string[] {
  const tools = [...new Set(lines.map((l) => l.tool))];
  return tools.map((tool) => {
    const own = lines.filter((l) => l.tool === tool);
    const codes = [...new Set(own.flatMap((l) => (l.error_code === null ? [] : [l.error_code])))];
    const acceptance = own.map((l) => l.acceptance).filter((a): a is string => a !== null);
    return `${tool}：${own.length} 次，出错 ${own.filter((l) => l.call_result !== 'ok').length} 次${codes.length > 0 ? `（${codes.join('、')}）` : ''}${acceptance.length > 0 ? `；回执 ${acceptance.join('、')}` : ''}`;
  });
}

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

/** Where the endpoint of this run comes from: the owner's environment file, or the owner's Circle configuration. */
export interface EndpointSource {
  endpoint: Endpoint;
  /** The environment file that was read, to be named as a protected file; absent for --endpoint-from circle. */
  envFile?: string;
  provider?: 'glm' | 'qwen';
  section?: string;
}

/**
 * The endpoint of a review run from its arguments: `--endpoint-from circle` reads the owner's Circle configuration
 * (`--circle-dir`, default `.circle` under the environment's HOME; the model may be overridden with `--model`), the
 * arguments of the environment file (`--env-file --provider --model [--section]`) read it as before. The two sources are
 * mutually exclusive. Warnings (a credentials file looser than 0600) go to `warn`; errors never carry a value.
 */
export function endpointSource(argv: string[], env: NodeJS.ProcessEnv, warn: (line: string) => void = () => {}): EndpointSource {
  const value = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const from = value('endpoint-from');
  if (from !== undefined) {
    if (from !== 'circle') throw new Error('--endpoint-from 只认 circle');
    for (const other of ['env-file', 'provider', 'section'] as const) {
      if (value(other) !== undefined) throw new Error(`--endpoint-from circle 和 --${other} 二选一`);
    }
    const dir = value('circle-dir') ?? join(env.HOME ?? '', '.circle');
    return { endpoint: circleEndpoint(dir, { model: value('model'), warn }) };
  }
  const envFile = value('env-file');
  const provider = value('provider');
  const model = value('model');
  if (!envFile) throw new Error('缺少 --env-file（或用 --endpoint-from circle）');
  if (provider !== 'qwen' && provider !== 'glm') throw new Error('缺少 --provider（或用 --endpoint-from circle）');
  if (!model) throw new Error('缺少 --model（或用 --endpoint-from circle，端点自带模型名）');
  const section = value('section');
  return { endpoint: endpointFrom(readEnvFile(envFile), provider, model, section), envFile, provider, section };
}

/** What the screen may say about the endpoint: the protocol, the host, the model and the key length, nothing else. */
export function endpointLine(endpoint: Endpoint): string {
  const host = new URL(endpoint.baseUrl).host;
  return `模型 ${endpoint.model}，协议 ${endpoint.protocol}，主机 ${host}，密钥长度 ${endpoint.apiKey.length}`;
}

async function main(): Promise<number> {
  const [prompt, out, name] = [arg('prompt'), arg('out'), arg('name')];
  const token = process.env.HUB_REAL_TOKEN;
  if (!prompt || !out || !name || !token) {
    console.error('用法：HUB_REAL_TOKEN=… node scripts/real/review-circle.ts (--env-file <文件> --provider qwen|glm --model <模型> | --endpoint-from circle [--circle-dir <目录>]) --prompt <文字> --out <目录> --name <标签>');
    return 2;
  }
  let source: EndpointSource;
  try {
    source = endpointSource(process.argv.slice(2), process.env, (line) => console.error(`[review] ${line}`));
  } catch (error) {
    console.error(`失败：${(error as Error).message}`);
    return 2;
  }
  const hubUrl = arg('hub-url') ?? 'http://127.0.0.1:7420/mcp';
  const circleCli = arg('circle-cli') ?? resolve(process.env.HOME ?? '', 'Public/circle-mcp-client/dist/cli.js');
  const timeoutMs = Number(arg('timeout-ms') ?? 1_800_000);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync(join(tmpdir(), 'chub-review-'));
  const home = join(scratch, 'home');
  const written = writeHome({ envFile: source.envFile, home, provider: source.provider, hubUrl }, source.endpoint, token);
  console.error(`[review] 专用 Circle 目录已写好；${endpointLine(source.endpoint)}`);
  const started = new Date();
  const otty = createOtty();
  let screen = '';
  let done = false;
  try {
    const session = await startCircle({ otty, home, cwd: written.workdir, cli: circleCli, title: `hub-review-${name}` });
    console.error('[review] Circle 已启动，发送提示');
    const result = await session.ask(prompt, { timeoutMs, pollMs: 2000 });
    done = result.done;
    screen = session.screen({ scrollback: true });
    console.error(`[review] 这轮结束：done=${done}`);
    await session.exit();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  writeFileSync(join(out, `${name}.screen.txt`), screen);
  const exported = spawnSync('node', ['bin/circle-hub', 'logs', 'export', '--from', started.toISOString()], { cwd: resolve(import.meta.dirname, '../..'), encoding: 'utf8' });
  writeFileSync(join(out, `${name}.calls.jsonl`), exported.stdout);
  const lines = parseCallLog(exported.stdout);
  const summary = [`开始 ${started.toISOString()}，客户端${done ? '把这轮走完了' : '超时仍在处理'}`, `中枢收到 ${lines.length} 次工具调用`, ...summarize(lines)];
  writeFileSync(join(out, `${name}.summary.txt`), `${summary.join('\n')}\n`);
  console.log(summary.join('\n'));
  return done ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main();
