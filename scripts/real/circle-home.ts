// Sets up a dedicated Circle data folder for a real review run: a model endpoint taken from the owner's environment file or
// read from the owner's Circle configuration (circleEndpoint), the Hub as an ordinary MCP server, the environment file's name
// as a protected file, and a hook that lets only the Hub's tools run. The environment file and the owner's Circle folder are
// read here, at run time. Values reach only the 0600 files of the new folder; the screen shows names, presence and lengths.
// The Hub token comes from the environment variable HUB_REAL_TOKEN, never from a command line.
//   node scripts/real/circle-home.ts --env-file <file> --home <dir> --provider glm|qwen [--model <id>] [--section <text>]
//        [--hub-url http://127.0.0.1:7420/mcp] [--workdir <dir>] [--profile review|skills|ops] [--jev-model <id>]
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pick, readEnvFile, type EnvEntry } from './lib/env-file.ts';
import { environment, renderAllowed, type GuardDeclaration } from './guard-lib.ts';

export type Profile = 'review' | 'skills' | 'ops';

export interface Options {
  envFile?: string;
  home: string;
  provider?: 'glm' | 'qwen';
  model?: string;
  section?: string;
  hubUrl: string;
  workdir?: string;
  profile?: Profile;
  jevModel?: string;
  /** Written into settings.json as models.<model>.context_window: Circle compacts the conversation at 85% of the
   * window (its src/context_middleware.ts), and a scripted model cannot write the summary compaction asks for. Only
   * accept-circle.ts passes this. */
  contextWindow?: number;
}

export const SERVER_NAME = 'hub';
export const TOKEN_SECRET = 'HUB_TOKEN';
/** The Hub's tool names as Circle shows them: <server name>_<tool>. */
export const HUB_TOOLS = ['list_task_packs', 'upload_file', 'start_run', 'get_nodes', 'resolve_reference', 'submit_result'] as const;
/** Circle's own planning tool has no effect outside the conversation; every other built-in tool stays denied. */
export const INTERNAL_TOOLS_ALLOWED = ['write_todos'] as const;

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
export function endpointFrom(entries: EnvEntry[], provider: 'glm' | 'qwen', model?: string, section: string = SECTION_OF[provider]): Endpoint {
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

/** The references settings.json auth.api_key_ref may name in credentials.json: the member it names holds the key. */
const KNOWN_API_KEY_REFS = { api_key: 'api_key' } as const;

/**
 * The model endpoint of a Circle data directory (the owner's configured endpoint; default ~/.circle, tests use a temp
 * dir): settings.json's `auth` (protocol, base_url, model, api_key_ref) and the member api_key_ref names in
 * credentials.json. Read-only: nothing is written, nothing is sent. An unreadable file, a missing field or an unknown
 * reference is an error naming the file and the key only; a credentials file looser than 0600 is warned about, not refused.
 */
export function circleEndpoint(dir: string, options: { model?: string; warn?: (line: string) => void } = {}): Endpoint {
  const readJson = (name: string): Record<string, unknown> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      throw new Error(`Circle 目录的 ${name} 读不到或不是 JSON`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Circle 目录的 ${name} 不是一个对象`);
    return parsed as Record<string, unknown>;
  };
  const settings = readJson('settings.json');
  const auth = settings.auth;
  if (auth === null || typeof auth !== 'object' || Array.isArray(auth)) throw new Error('settings.json 里没有 auth（协议、地址、模型名、密钥引用）');
  const record = auth as Record<string, unknown>;
  const protocol = record.protocol;
  if (protocol !== 'anthropic' && protocol !== 'openai') throw new Error('settings.json 的 auth.protocol 不是认识的协议（只认 anthropic、openai）');
  const baseUrl = record.base_url;
  if (typeof baseUrl !== 'string' || baseUrl === '' || !/^https?:\/\//.test(baseUrl)) throw new Error('settings.json 的 auth.base_url 不是可用的地址');
  const model = options.model ?? record.model;
  if (typeof model !== 'string' || model === '') throw new Error('settings.json 的 auth 里没有模型名');
  const ref = record.api_key_ref;
  if (typeof ref !== 'string' || !(ref in KNOWN_API_KEY_REFS)) throw new Error(`settings.json 的 auth.api_key_ref 不是认识的引用（只认 ${Object.keys(KNOWN_API_KEY_REFS).join('、')}）`);
  const credentials = readJson('credentials.json');
  const apiKey = credentials[KNOWN_API_KEY_REFS[ref as keyof typeof KNOWN_API_KEY_REFS]];
  if (typeof apiKey !== 'string' || apiKey === '') throw new Error(`credentials.json 里没有 ${KNOWN_API_KEY_REFS[ref as keyof typeof KNOWN_API_KEY_REFS]}`);
  if ((statSync(join(dir, 'credentials.json')).mode & 0o777) !== 0o600) options.warn?.('credentials.json 的权限不是 0600（密钥文件应只有所有者可读；继续读取）');
  return {
    protocol,
    baseUrl,
    model,
    apiKey,
    sources: ['settings.json 的 auth（protocol、base_url、model、api_key_ref）', `credentials.json 的 ${ref}`],
  };
}

const HOOK = `// Lets only the Hub's tools (and Circle's own todo list) run in this Circle folder; every other tool call is denied.
const allowed = new Set(${JSON.stringify([...HUB_TOOLS.map((t) => `${SERVER_NAME}_${t}`), ...INTERNAL_TOOLS_ALLOWED])});
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

const HUB_PREFIXED_TOOLS = HUB_TOOLS.map((t) => `${SERVER_NAME}_${t}`);

const BOOKING_STAYS_RULE = {
  id: 'booking-stays',
  tool: 'hub_start_run',
  match: [
    { path: 'pack', equalsBefore: '@', normalize: 'lower' as const, value: 'test-bed' },
    { path: 'parameters.action', normalize: 'lower' as const, in: ['release', 'force_release', 'unregister', 'register'] },
  ],
  what: '不允许：这次释放或变更测试环境的预订登记（release / force_release / unregister / register）。预订由负责人持有，跨运行保留。',
  how: '这次可以这样做：作业都有终态后直接报告结果，预订保持原样，不调用释放或注销动作。',
};

const SUBAGENT_ASKS_NOBODY_RULE = {
  id: 'subagent-asks-nobody',
  tool: 'question',
  session: 'subagent' as const,
  what: '不允许：子代理不向使用者提问，这类问题使用者答不了，要自己按资料定。',
  how: '这次可以这样做：能在锁定的命令树、手册、执行器规则、条目和编写简报里查到的，查了就定，并在给主代理的报告里写明定了什么、依据在哪一行；资料里确实没有的，把缺的事实和建议的处理写进报告，交回派给你任务的主代理。',
};

/** Builds the unified guard declaration data for `skills` (strict read-only sandbox) or `ops` (full workflow orchestration). */
export function profileDeclaration(profile: 'skills' | 'ops'): GuardDeclaration {
  const isOps = profile === 'ops';
  return {
    version: 1,
    about:
      'Data for the Circle home before_tool guard (powered by ./guard-lib.ts). Choices live here; local skill tool options are read from each tool source and skill docs under the single-quote grammar.',
    allowReply: isOps ? 'silent' : 'explicit',
    allowLocalTools: isOps,
    hub: {
      server: SERVER_NAME,
      urlVariable: 'HUB_URL',
      tokenPlaceholder: `%${TOKEN_SECRET}%`,
      allowedPlaceholders: [`%${TOKEN_SECRET}%`, '%JEV_API_KEY%'],
    },
    workFolders: {
      settingsKey: 'trusted_folders',
      ...(isOps ? { siblingsOfHome: '^work-ops' } : {}),
    },
    allow: isOps
      ? {
          'Hub 的六个工具': HUB_PREFIXED_TOOLS,
          '问使用者、任务清单、子代理': ['question', 'write_todos', 'todo', 'task', 'list_jobs', 'wait_jobs', 'stop_job', 'send_to_job'],
          只读本地资料: ['terminal_sessions', 'knowledge_search', 'knowledge_read'],
          '浏览器（网页界面测试）': [
            'browser_navigate',
            'browser_snapshot',
            'browser_screenshot',
            'browser_click',
            'browser_click_at',
            'browser_type',
            'browser_select',
            'browser_press',
            'browser_tabs',
            'browser_dialog',
          ],
        }
      : {
          'Hub 的六个工具': HUB_PREFIXED_TOOLS,
          任务清单: [...INTERNAL_TOOLS_ALLOWED],
        },
    files: {
      read: ['read_file', 'ls', 'glob', 'grep'],
      write: isOps ? ['write_file', 'edit_file'] : [],
      readRoots: ['work', 'skills'],
      writeRoots: ['work'],
      virtualReadOnly: ['^/large_tool_results/[0-9a-f]{24}\\.txt$', '^/background_jobs/[A-Za-z0-9._-]{1,80}/run-[0-9]{1,6}\\.log$'],
      virtualReadOnlyTools: ['read_file', 'grep'],
      readableFiles: ['hooks/ALLOWED.md'],
    },
    skillTool: 'skill',
    skillRequiresInstalled: true,
    executeTool: 'execute',
    denyPrefix: {
      terminal_: '设备上的操作只经 Hub，终端工具不放行',
    },
    equalsForm: 'fix',
    interpreters: ['node'],
    commands: isOps
      ? [
          {
            name: 'sleep',
            args: ['int'],
            max: 600,
            note: '短等待，最多 600 秒；等上机结果不要 sleep，用 download-returns.ts 加 --wait 作后台命令（execute 的 background: true）',
          },
        ]
      : [],
    scripts: [
      {
        path: 'jev/jev.ts',
        subcommands: ['ask', 'calibrate', 'place', 'lock', 'submit'],
        subcommandStdin: {
          ask: ['%JEV_API_KEY%', `%${TOKEN_SECRET}%`],
          calibrate: ['%JEV_API_KEY%', `%${TOKEN_SECRET}%`],
          place: ['%JEV_API_KEY%', `%${TOKEN_SECRET}%`],
          lock: [`%${TOKEN_SECRET}%`],
          submit: [`%${TOKEN_SECRET}%`],
        },
      },
      {
        path: 'operation-capture/operation.ts',
        subcommands: ['list', 'read', 'status', 'verify', 'flush', 'submit'],
      },
    ],
    optionTypes: {
      hub: 'hub',
      wait: 'int',
      round: 'int',
      limit: 'int',
      'timeout-ms': 'int',
      model: 'text',
      role: 'text',
      case: 'text',
      note: 'text',
      name: 'text',
      product: 'text',
      build: 'text',
      root: 'text',
      under: 'text',
      send: 'text',
      skip: 'text',
      'base-url': 'text',
      sha: 'text',
      session: 'text',
    },
    placeholderTypes: [
      { match: '^%HUB_URL%$|Hub', type: 'hub' },
      { match: '秒数|seconds', type: 'int' },
      { match: '编号|run id|run-id', type: 'run' },
      { match: '.', type: 'path' },
    ],
    shellAlternatives: {
      cat: 'read_file',
      head: 'read_file',
      tail: 'read_file',
      less: 'read_file',
      more: 'read_file',
      ls: 'ls',
      find: 'glob',
      grep: 'grep',
      rg: 'grep',
      echo: 'write_file',
      tee: 'write_file',
      touch: 'write_file',
      mkdir: 'write_file',
      cp: 'write_file',
      mv: 'write_file',
      sed: 'edit_file',
    },
    rules: isOps ? [BOOKING_STAYS_RULE, SUBAGENT_ASKS_NOBODY_RULE] : [BOOKING_STAYS_RULE],
  };
}

function renderGuardEntry(declarationFile: string): string {
  return `// Unified Circle home guard entrypoint (generated by scripts/real/circle-home.ts).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideRaw, environment } from './guard-lib.ts';

const HOOKS = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.resolve(HOOKS, '..');

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;

let cwd = process.cwd();
try {
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed === 'object' && typeof parsed.cwd === 'string' && parsed.cwd !== '') cwd = parsed.cwd;
} catch {
  // Handled fail-closed inside decideRaw.
}

const decision = await decideRaw(environment(HOME, cwd, ${JSON.stringify(declarationFile)}), raw);
process.stdout.write(JSON.stringify(decision));
`;
}

function renderGuardGen(declarationFile: string, genScriptName: string): string {
  return `// Regenerates hooks/ALLOWED.md (or prints tool JSON schemas with --schemas) from ${declarationFile}.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildToolSchemas, environment, renderAllowed } from './guard-lib.ts';

const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = environment(HOME, process.cwd(), ${JSON.stringify(declarationFile)});

if (process.argv.includes('--schemas')) {
  process.stdout.write(\`\${JSON.stringify(buildToolSchemas(env), null, 2)}\\n\`);
} else {
  fs.writeFileSync(env.allowedFile, renderAllowed(env, 'node hooks/${genScriptName}'), { mode: 0o600 });
  process.stdout.write(\`\${env.allowedFile}\\n\`);
}
`;
}

function writePrivate(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export interface Written {
  files: string[];
  workdir: string;
}

export function writeHome(options: Options, endpoint: Endpoint, token: string): Written {
  const profile = options.profile ?? 'review';
  if (profile !== 'review' && profile !== 'skills' && profile !== 'ops') throw new Error('--profile 只能是 review、skills 或 ops');
  const home = resolve(options.home);
  const workdir = resolve(options.workdir ?? join(home, 'work'));
  if (existsSync(join(home, 'settings.json'))) throw new Error('目标目录里已经有 settings.json：换一个新目录，不覆盖');
  const isGuarded = profile === 'skills' || profile === 'ops';
  for (const dir of [home, join(home, 'hooks'), workdir, ...(isGuarded ? [join(home, 'skills')] : [])]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  const hookName = profile === 'ops' ? 'ops-allow.mjs' : profile === 'skills' ? 'skills-only.mjs' : 'hub-only.mjs';
  const hook = join(home, 'hooks', hookName);
  const hookArgument = profile === 'review' ? JSON.stringify(hook) : `'${hook.replaceAll("'", `'\\''`)}'`;

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
        ...(options.envFile === undefined ? {} : { credential_files: [basename(options.envFile)] }),
        ...(options.contextWindow === undefined ? {} : { models: { [endpoint.model]: { context_window: options.contextWindow } } }),
        update_check: false,
        ...(isGuarded ? { variables: { HUB_URL: options.hubUrl, ...(options.jevModel === undefined ? {} : { JEV_MODEL: options.jevModel }) } } : {}),
      },
      null,
      2,
    )}\n`,
  );
  writePrivate(join(home, 'credentials.json'), `${JSON.stringify({ api_key: endpoint.apiKey })}\n`);
  writePrivate(join(home, 'secrets.json'), `${JSON.stringify({ secrets: { [TOKEN_SECRET]: token } })}\n`);
  writePrivate(
    join(home, 'hooks.json'),
    `${JSON.stringify({ version: 1, hooks: { before_tool: [{ name: profile === 'review' ? 'hub tools only' : `${profile} tools guard`, command: `node ${hookArgument}`, timeout_ms: isGuarded ? 600000 : 10000 }] } }, null, 2)}\n`,
  );

  if (!isGuarded) {
    writePrivate(hook, HOOK);
    return { files: ['settings.json', 'credentials.json', 'secrets.json', 'hooks.json', `hooks/${hookName}`], workdir };
  }

  const declName = profile === 'ops' ? 'ops-allow.declaration.json' : 'guard.declaration.json';
  const genName = profile === 'ops' ? 'ops-allow-gen.mjs' : 'guard-gen.mjs';
  const guardLibSource = readFileSync(new URL('./guard-lib.ts', import.meta.url), 'utf8');
  writePrivate(hook, renderGuardEntry(declName));
  writePrivate(join(home, 'hooks', 'guard-lib.ts'), guardLibSource);
  writePrivate(join(home, 'hooks', declName), `${JSON.stringify(profileDeclaration(profile), null, 2)}\n`);
  writePrivate(join(home, 'hooks', genName), renderGuardGen(declName, genName));
  const allowedText = renderAllowed(environment(home, workdir, declName), `node hooks/${genName}`);
  writePrivate(join(home, 'hooks', 'ALLOWED.md'), allowedText);

  return {
    files: [
      'settings.json',
      'credentials.json',
      'secrets.json',
      'hooks.json',
      `hooks/${hookName}`,
      'hooks/guard-lib.ts',
      `hooks/${declName}`,
      `hooks/${genName}`,
      'hooks/ALLOWED.md',
    ],
    workdir,
  };
}

export function parseArgs(argv: string[]): Options & { envFile: string; provider: 'glm' | 'qwen' } {
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
  const profile = values.get('profile') ?? 'review';
  if (profile !== 'review' && profile !== 'skills' && profile !== 'ops') throw new Error('--profile 只能是 review、skills 或 ops');
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
    profile,
    jevModel: values.get('jev-model'),
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
    const guarded = options.profile === 'skills' || options.profile === 'ops';
    out(
      guarded
        ? `受保护文件：${basename(options.envFile)}；统一声明守卫（${options.profile}）及技能自带钩子生效；工作目录外写操作与高风险动作受限`
        : `受保护文件：${basename(options.envFile)}；钩子只放行 ${HUB_TOOLS.length} 个中枢工具和待办清单；工作目录为空目录`,
    );
    if (guarded) {
      out('技能目录：已建立，权限 0700；变量 HUB_URL：已配置');
      out(`变量 JEV_MODEL：${options.jevModel === undefined ? '未配置' : `已配置，长度 ${options.jevModel.length}`}`);
      out('所有者下一步：/secrets JEV_API_KEY（脚本不读取或保存该密钥）');
      if (options.jevModel === undefined) out('所有者下一步：/variables JEV_MODEL');
      const genScript = options.profile === 'ops' ? 'hooks/ops-allow-gen.mjs' : 'hooks/guard-gen.mjs';
      out(`技能装进 skills/ 后分别核对：local-tools verify --digest、pack-files.ts --verify-install、node ${genScript}`);
    }
    return 0;
  } catch (error) {
    out(`失败：${(error as Error).message}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), process.env, (line) => console.log(line));
}
