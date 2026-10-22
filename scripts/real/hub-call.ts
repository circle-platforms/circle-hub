// Calls the tools of a running Hub over its MCP endpoint with the official client, the way any MCP client does, and prints the
// text a model would be shown (Circle forwards only the text content of a result). For the integrator's real-system checks:
// it never prints the token. The token is read from a file (or the environment variable named by --token-env), never from
// the command line.
//   node scripts/real/hub-call.ts --token-file <file> [--url http://127.0.0.1:7420/mcp] [--session <id>] [--max <chars>]
//        <tool> '<arguments as JSON>' [<tool> '<json>' ...]
//   node scripts/real/hub-call.ts --token-file <file> list      # lists the tools the Hub offers
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface CallOptions {
  url: string;
  token: string;
  session: string;
}

export interface ToolText {
  isError: boolean;
  text: string;
  structured: unknown;
}

/** Connects once and runs the calls in order; the session id is sent on every call like Circle does (Circle-Session-Id). */
export async function callTools(options: CallOptions, calls: Array<{ tool: string; args: unknown }>): Promise<ToolText[]> {
  const transport = new StreamableHTTPClientTransport(new URL(options.url), {
    requestInit: { headers: { authorization: `Bearer ${options.token}`, 'circle-session-id': options.session } },
  });
  const client = new Client({ name: 'hub-call', version: '1' }, { capabilities: {} });
  await client.connect(transport);
  try {
    const out: ToolText[] = [];
    for (const call of calls) {
      const result = await client.callTool({ name: call.tool, arguments: call.args as Record<string, unknown> });
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content.map((block) => (block && typeof block === 'object' && 'text' in block ? String((block as { text: unknown }).text) : '')).join('\n');
      out.push({ isError: result.isError === true, text, structured: result.structuredContent });
    }
    return out;
  } finally {
    await client.close();
  }
}

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

async function main(): Promise<number> {
  const tokenFile = arg('token-file');
  const tokenEnv = arg('token-env');
  const token = tokenFile !== undefined ? readFileSync(tokenFile, 'utf8').trim() : tokenEnv !== undefined ? (process.env[tokenEnv] ?? '') : '';
  if (token === '') {
    console.error('用法：--token-file <文件>（或 --token-env <变量名>）<工具> \'<JSON 参数>\' …');
    return 2;
  }
  const flags = new Set(['--token-file', '--token-env', '--url', '--session', '--max']);
  const rest: string[] = [];
  for (let i = 2; i < process.argv.length; i++) {
    if (flags.has(process.argv[i])) i += 1;
    else rest.push(process.argv[i]);
  }
  const options: CallOptions = { url: arg('url') ?? 'http://127.0.0.1:7420/mcp', token, session: arg('session') ?? randomUUID() };
  const max = Number(arg('max') ?? 6000);
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

if (import.meta.main) process.exitCode = await main();
