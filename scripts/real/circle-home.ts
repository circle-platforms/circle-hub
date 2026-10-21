// Sets up a dedicated Circle data folder for a real review run: a model endpoint taken from the owner's environment file, the
// Hub as an ordinary MCP server, the environment file's name as a protected file, and a hook that lets only the Hub's tools run.
// The environment file is read here, at run time. Values reach only the 0600 files of the new folder; the screen shows names,
// presence and lengths. The Hub token comes from the environment variable HUB_REAL_TOKEN, never from a command line.
//   node scripts/real/circle-home.ts --env-file <file> --home <dir> --provider glm|qwen [--model <id>] [--section <text>]
//        [--hub-url http://127.0.0.1:7420/mcp] [--workdir <dir>]
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pick, readEnvFile, type EnvEntry } from './lib/env-file.ts';

export interface Options {
  envFile: string;
  home: string;
  provider: 'glm' | 'qwen';
  model?: string;
  section?: string;
  hubUrl: string;
  workdir?: string;
}

export const SERVER_NAME = 'hub';
export const TOKEN_SECRET = 'HUB_TOKEN';
/** The Hub's tool names as Circle shows them: <server name>_<tool>. */
export const HUB_TOOLS = ['list_task_packs', 'upload_file', 'start_run', 'get_nodes', 'resolve_reference', 'submit_result'] as const;

const SECTION_OF = { glm: 'GLM', qwen: '千问' } as const;
const MODEL_SECTION_OF = { glm: 'glm', qwen: 'qwen' } as const;

export interface Endpoint {
  protocol: 'anthropic' | 'openai';
  baseUrl: string;
  apiKey: string;
  model: string;
  /** What the screen may say about where each value came from: key names and line numbers only. */
  sources: string[];
}

/** Picks the endpoint of the provider's section: the Anthropic pair first, then the OpenAI-compatible pair. */
export function endpointFrom(entries: EnvEntry[], provider: Options['provider'], model?: string, section: string = SECTION_OF[provider]): Endpoint {
  for (const [protocol, urlKey, keyKey] of [
    ['anthropic', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY'],
    ['openai', 'OPENAI_BASE_URL', 'OPENAI_API_KEY'],
  ] as const) {
    const url = pick(entries, urlKey, { section });
    const key = pick(entries, keyKey, { section });
    if (!url || !key) continue;
    const chosen = model ?? pick(entries, 'IST_MODEL', { section: MODEL_SECTION_OF[provider] })?.value;
    if (!chosen) throw new Error(`没有模型名：用 --model 指定（${provider} 的配置里没有 IST_MODEL）`);
    return { protocol, baseUrl: url.value, apiKey: key.value, model: chosen, sources: [`${urlKey} 行 ${url.line}`, `${keyKey} 行 ${key.line}`] };
  }
  throw new Error(`环境文件的“${section}”一节里没有可用的地址和密钥对`);
}

const HOOK = `// Lets only the Hub's tools run in this Circle folder; every other tool call is denied.
const allowed = new Set(${JSON.stringify(HUB_TOOLS.map((t) => `${SERVER_NAME}_${t}`))});
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
let tool = '';
try {
  tool = String(JSON.parse(input).tool_name ?? '');
} catch {
  // Unreadable input is a deny below.
}
const decision = allowed.has(tool)
  ? { decision: 'allow', reason: 'a Hub tool' }
  : { decision: 'deny', reason: 'only the Hub tools may run in this folder' };
process.stdout.write(JSON.stringify(decision));
`;

function writePrivate(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export interface Written {
  files: string[];
  workdir: string;
}

export function writeHome(options: Options, endpoint: Endpoint, token: string): Written {
  const home = resolve(options.home);
  const workdir = resolve(options.workdir ?? join(home, 'work'));
  if (existsSync(join(home, 'settings.json'))) throw new Error('目标目录里已经有 settings.json：换一个新目录，不覆盖');
  for (const dir of [home, join(home, 'hooks'), workdir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  const hook = join(home, 'hooks', 'hub-only.mjs');
  writePrivate(hook, HOOK);
  writePrivate(
    join(home, 'settings.json'),
    `${JSON.stringify(
      {
        version: 1,
        initialized: true,
        auth: { protocol: endpoint.protocol, base_url: endpoint.baseUrl, model: endpoint.model, api_key_ref: 'api_key' },
        trusted_folders: [workdir],
        default_mode: 'auto',
        mcp_servers: [
          { name: SERVER_NAME, url: options.hubUrl, transport: 'streamable_http', headers: { Authorization: `Bearer \${secret:${TOKEN_SECRET}}` } },
        ],
        credential_files: [basename(options.envFile)],
        update_check: false,
      },
      null,
      2,
    )}\n`,
  );
  writePrivate(join(home, 'credentials.json'), `${JSON.stringify({ api_key: endpoint.apiKey })}\n`);
  writePrivate(join(home, 'secrets.json'), `${JSON.stringify({ secrets: { [TOKEN_SECRET]: token } })}\n`);
  writePrivate(
    join(home, 'hooks.json'),
    `${JSON.stringify({ version: 1, hooks: { before_tool: [{ name: 'hub tools only', command: `node ${JSON.stringify(hook)}`, timeout_ms: 10000 }] } }, null, 2)}\n`,
  );
  return { files: ['settings.json', 'credentials.json', 'secrets.json', 'hooks.json', 'hooks/hub-only.mjs'], workdir };
}

export function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`参数不对：${key ?? ''}`);
    values.set(key.slice(2), value);
  }
  const need = (name: string): string => {
    const v = values.get(name);
    if (!v) throw new Error(`缺少 --${name}`);
    return v;
  };
  const provider = need('provider');
  if (provider !== 'glm' && provider !== 'qwen') throw new Error('--provider 只能是 glm 或 qwen');
  return {
    envFile: need('env-file'),
    home: need('home'),
    provider,
    model: values.get('model'),
    section: values.get('section'),
    hubUrl: values.get('hub-url') ?? 'http://127.0.0.1:7420/mcp',
    workdir: values.get('workdir'),
  };
}

export function main(argv: string[], env: NodeJS.ProcessEnv, out: (line: string) => void): number {
  try {
    const options = parseArgs(argv);
    const token = env.HUB_REAL_TOKEN;
    if (!token) throw new Error('环境变量 HUB_REAL_TOKEN 没有设置（中枢令牌只从环境变量读，不进命令行）');
    const endpoint = endpointFrom(readEnvFile(options.envFile), options.provider, options.model, options.section);
    const written = writeHome(options, endpoint, token);
    out(`已写入专用 Circle 目录（${written.files.length} 个文件，权限 0600）`);
    out(`模型：${endpoint.model}，协议 ${endpoint.protocol}，密钥长度 ${endpoint.apiKey.length}，来源 ${endpoint.sources.join('、')}`);
    out(`中枢令牌：已存为密钥 ${TOKEN_SECRET}，长度 ${token.length}`);
    out(`受保护文件：${basename(options.envFile)}；钩子只放行 ${HUB_TOOLS.length} 个中枢工具；工作目录为空目录`);
    return 0;
  } catch (error) {
    out(`失败：${(error as Error).message}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), process.env, (line) => console.log(line));
}
