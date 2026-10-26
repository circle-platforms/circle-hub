// Calls the tools of a running Hub over its MCP endpoint with the official client, the way any MCP client does, and prints the
// text a model would be shown (Circle forwards only the text content of a result). For the integrator's real-system checks:
// it never prints the token. The token is read from a file (or the environment variable named by --token-env), never from
// the command line.
//   node scripts/real/hub-call.ts --token-file <file> [--url http://127.0.0.1:7420/mcp] [--session <id>] [--max <chars>] [--structured <file>]
//        <tool> '<arguments as JSON>' [<tool> '<json>' ...]
//   node scripts/real/hub-call.ts --token-file <file> list      # lists the tools the Hub offers
import { appendFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface CallOptions {
  url: string;
  token: string;
  session: string;
  /** Optional timeout of each tool request; omitted preserves the SDK default. */
  timeoutMs?: number;
  /** Appends each call's structured result as a JSON line to this file in order. */
  structuredFile?: string;
}

export interface ToolText {
  isError: boolean;
  text: string;
  structured: unknown;
}

/** Formats one call result for the structured JSON line output. */
export function formatStructured(item: { isError: boolean; structured: unknown; text?: string }): unknown {
  if (item.isError) {
    if (item.structured && typeof item.structured === 'object' && !Array.isArray(item.structured)) {
      const obj = item.structured as Record<string, unknown>;
      if ('isError' in obj || obj.call_result === 'error') {
        return obj;
      }
      return { isError: true, ...obj };
    }
    return {
      isError: true,
      error: item.text || 'error',
      ...(item.structured !== undefined ? { structured: item.structured } : {}),
    };
  }
  return item.structured ?? {};
}

/** Connects once and runs the calls in order; the session id is sent on every call like Circle does (Circle-Session-Id). */
export async function callTools(options: CallOptions, calls: Array<{ tool: string; args: unknown }>): Promise<ToolText[]> {
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)) throw new Error('单次超时参数无效');
  const transport = new StreamableHTTPClientTransport(new URL(options.url), {
    requestInit: { headers: { authorization: `Bearer ${options.token}`, 'circle-session-id': options.session } },
  });
  const client = new Client({ name: 'hub-call', version: '1' }, { capabilities: {} });
  await client.connect(transport);
  try {
    const out: ToolText[] = [];
    for (const call of calls) {
      let isError = false;
      let text = '';
      let structured: unknown = undefined;
      try {
        const result = await client.callTool({ name: call.tool, arguments: call.args as Record<string, unknown> }, undefined, options.timeoutMs === undefined ? undefined : { timeout: options.timeoutMs });
        isError = result.isError === true;
        const content = Array.isArray(result.content) ? result.content : [];
        text = content.map((block) => (block && typeof block === 'object' && 'text' in block ? String((block as { text: unknown }).text) : '')).join('\n');
        structured = result.structuredContent;
      } catch (error) {
        isError = true;
        text = (error as Error).message;
        structured = { isError: true, error: text };
      }
      const item: ToolText = { isError, text, structured };
      out.push(item);
      if (options.structuredFile) {
        appendFileSync(resolve(options.structuredFile), `${JSON.stringify(formatStructured(item))}\n`, 'utf8');
      }
    }
    return out;
  } finally {
    await client.close();
  }
}

function arg(name: string, argv: readonly string[]): string | undefined {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const tokenFile = arg('token-file', argv);
  const tokenEnv = arg('token-env', argv);
  const token = tokenFile !== undefined ? readFileSync(tokenFile, 'utf8').trim() : tokenEnv !== undefined ? (process.env[tokenEnv] ?? '') : '';
  if (token === '') {
    console.error('用法：--token-file <文件>（或 --token-env <变量名>）<工具> \'<JSON 参数>\' …');
    return 2;
  }
  const flags = new Set(['--token-file', '--token-env', '--url', '--session', '--max', '--structured', '--timeout-ms']);
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (flags.has(argv[i])) i += 1;
    else rest.push(argv[i]);
  }
  const structuredFile = arg('structured', argv);
  const options: CallOptions = {
    url: arg('url', argv) ?? 'http://127.0.0.1:7420/mcp',
    token,
    session: arg('session', argv) ?? randomUUID(),
    structuredFile,
    ...(arg('timeout-ms', argv) === undefined ? {} : { timeoutMs: Number(arg('timeout-ms', argv)) }),
  };
  const max = Number(arg('max', argv) ?? 6000);
  if (rest[0] === 'list') {
    const transport = new StreamableHTTPClientTransport(new URL(options.url), { requestInit: { headers: { authorization: `Bearer ${token}`, 'circle-session-id': options.session } } });
    const client = new Client({ name: 'hub-call', version: '1' }, { capabilities: {} });
    await client.connect(transport);
    try {
      for (const tool of (await client.listTools()).tools) console.log(`${tool.name}\t${JSON.stringify(tool.annotations ?? {})}`);
    } finally {
      await client.close();
    }
    return 0;
  }
  if (rest.length === 0 || rest.length % 2 !== 0) {
    console.error('每次调用要给工具名和 JSON 参数两项');
    return 2;
  }
  const calls: Array<{ tool: string; args: unknown }> = [];
  for (let i = 0; i < rest.length; i += 2) calls.push({ tool: rest[i], args: JSON.parse(rest[i + 1]) as unknown });
  const results = await callTools(options, calls);
  results.forEach((result, i) => {
    console.log(`== ${calls[i].tool} ${result.isError ? '（出错）' : ''} ${result.text.length} 个字符`);
    console.log(result.text.length > max ? `${result.text.slice(0, max)}\n……（还有 ${result.text.length - max} 个字符没有显示）` : result.text);
  });
  return results.some((r) => r.isError) ? 1 : 0;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('scripts/real/hub-call.ts')) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
