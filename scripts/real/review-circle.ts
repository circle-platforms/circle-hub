// Drives the REAL Circle client in an Otty tab with a REAL model (the owner's configured endpoint) against the deployed Hub:
// one prompt, the turn is awaited, and the evidence is the Hub's own call log for the time of the run (every tool call with
// its result code, acceptance and run id) plus the final screen. The model key is read from the owner's environment file at run
// time into the 0600 files of a dedicated Circle folder and never shown; the Hub token comes from HUB_REAL_TOKEN.
//
//   HUB_REAL_TOKEN=<token> node scripts/real/review-circle.ts --env-file <file> --provider qwen --model <id> [--section <text>]
//        --prompt <text> --out <dir> --name <label> [--hub-url ...] [--circle-cli <dist/cli.js>] [--timeout-ms 1800000]
//        [--home <dir>]   (reuse a folder written by an earlier run, to continue the same conversation context in a new session)
// The evidence holds real content (test cases, documents): it is written to --out only, never into the repository.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { endpointFrom, writeHome } from './circle-home.ts';
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

async function main(): Promise<number> {
  const [envFile, provider, model, prompt, out, name] = [arg('env-file'), arg('provider'), arg('model'), arg('prompt'), arg('out'), arg('name')];
  const token = process.env.HUB_REAL_TOKEN;
  if (!envFile || (provider !== 'qwen' && provider !== 'glm') || !model || !prompt || !out || !name || !token) {
    console.error('用法：HUB_REAL_TOKEN=… node scripts/real/review-circle.ts --env-file <文件> --provider qwen|glm --model <模型> --prompt <文字> --out <目录> --name <标签>');
    return 2;
  }
  const hubUrl = arg('hub-url') ?? 'http://127.0.0.1:7420/mcp';
  const circleCli = arg('circle-cli') ?? resolve(process.env.HOME ?? '', 'Public/circle-mcp-client/dist/cli.js');
  const timeoutMs = Number(arg('timeout-ms') ?? 1_800_000);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync(join(tmpdir(), 'chub-review-'));
  const home = join(scratch, 'home');
  const endpoint = endpointFrom(readEnvFile(envFile), provider, model, arg('section'));
  const written = writeHome({ envFile, home, provider, hubUrl }, endpoint, token);
  console.error(`[review] 专用 Circle 目录已写好；模型 ${endpoint.model}，协议 ${endpoint.protocol}，密钥长度 ${endpoint.apiKey.length}`);
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
