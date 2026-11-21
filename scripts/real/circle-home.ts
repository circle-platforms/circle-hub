import { CALL_ERROR_CATEGORY, labelOf } from '../../contracts/generated/vocabulary.ts';
// Sets up a dedicated Circle data folder for a real review run: a model endpoint taken from the owner's environment file or
// read from the owner's Circle configuration (circleEndpoint), the Hub as an ordinary MCP server, the environment file's name
// as a protected file, and a hook that lets only the Hub's tools run. The environment file and the owner's Circle folder are
// read here, at run time. Values reach only the 0600 files of the new folder; the screen shows names, presence and lengths.
// The Hub token comes from the environment variable HUB_REAL_TOKEN, never from a command line.
//   node scripts/real/circle-home.ts --env-file <file> --home <dir> --provider glm|qwen [--model <id>] [--section <text>]
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pick, readEnvFile, type EnvEntry } from './lib/env-file.ts';
import { formatPreflightReport, resolveInstalledGuard, runPreflight } from './guard-preflight.ts';
import { recordInstallation, maintainInstallation, assertInstallationBaseline, type GuardBundle } from './guard-installation.ts';
import { environment, renderAllowed, discoverTools, type GuardDeclaration } from './guard-lib.ts';

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
  plumbUrl?: string;
  plumbModel?: string;
  plumbCaFile?: string;
  plumbKeyStdin?: boolean;
  /** Written into settings.json as models.<model>.context_window: Circle compacts the conversation at 85% of the
   * window (its src/context_middleware.ts), and a scripted model cannot write the summary compaction asks for. Only
   * accept-circle.ts passes this. */
  contextWindow?: number;
}

export const SERVER_NAME = 'hub';
export const TOKEN_SECRET = 'HUB_TOKEN';
export const PLUMB_KEY_SECRET = 'PLUMB_API_KEY';
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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HUB_TOOLS = new Set(${JSON.stringify([...HUB_TOOLS])});
const INTERNAL_TOOLS = new Set(${JSON.stringify([...INTERNAL_TOOLS_ALLOWED])});
const DEFAULT_SERVER = ${JSON.stringify(SERVER_NAME)};
const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function configuredHubServers() {
  const servers = new Set([DEFAULT_SERVER.toLowerCase()]);
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(HOME, 'settings.json'), 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.mcpServers && typeof raw.mcpServers === 'object' && !Array.isArray(raw.mcpServers)) {
      for (const [key, entry] of Object.entries(raw.mcpServers)) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        if (key.toLowerCase() === DEFAULT_SERVER.toLowerCase() || entry.placeholders?.url === 'HUB_URL') {
          servers.add(key.replace(/[^A-Za-z0-9_-]/g, '_').toLowerCase());
        }
      }
    }
  } catch {
    // Keep the default server key when settings.json cannot be read.
  }
  return servers;
}

function isAllowedTool(tool, servers) {
  if (INTERNAL_TOOLS.has(tool)) return true;
  if (!tool.startsWith('mcp__')) return false;
  const rest = tool.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  if (sep <= 0) return false;
  const server = rest.slice(0, sep).toLowerCase();
  const name = rest.slice(sep + 2);
  return servers.has(server) && HUB_TOOLS.has(name);
}

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
let tool = '';
try {
  const parsed = JSON.parse(input);
  if (parsed?.hook_event_name === 'PreToolUse') tool = String(parsed.tool_name ?? '');
} catch {
  // Unreadable input is a deny below.
}
const ok = isAllowedTool(tool, configuredHubServers());
const decision = ok ? 'allow' : 'deny';
const reason = ok ? 'a Hub tool' : 'only the Hub tools may run in this folder';
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } }));
`;

const HUB_PREFIXED_TOOLS = HUB_TOOLS.map((t) => `mcp__${SERVER_NAME}__${t}`);

const BOOKING_STAYS_RULE = {
  id: 'booking-stays',
  tool: `mcp__${SERVER_NAME}__start_run`,
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

const LEAD_ASKS_NOBODY_RULE = {
  id: 'lead-asks-nobody',
  tool: 'question',
  what: '不允许：这个主目录跑的是无人值守的编译，全程不向使用者提问。',
  how: '这次可以这样做：按技能第 1 节的次序自行决定（与同构建手册和命令树一致、保住作者步骤与边界、已声明执行器能判定、改动最小），把决定记为“模型决定：”并写进最终报告，然后继续往下做。',
};

const OPEN_COMPILE_HOW = "这次可以这样做：跑 node '<case-compile 技能目录>/tools/open-compile.ts' --hub %HUB_URL% --plumb %PLUMB_URL% --subject … --product … --build … --booking … --out 'open-compile.json'（标准输入两行 %HUB_TOKEN%、%PLUMB_API_KEY%；返工加 --recompose-run 与 --recompose-record）；它输出“无法编译：…”时把这一行原样告诉使用者并停止。";
const RECOMPOSE_OPENS_BY_TOOL_RULE = {
  id: 'recompose-opens-by-tool',
  tool: `mcp__${SERVER_NAME}__start_run`,
  match: [{ path: 'pack', equalsBefore: '@', normalize: 'lower' as const, value: 'recompose' }],
  what: '不允许：直接用 start_run 开用例重组运行。开编译前要由代码核对文档和环境，用例重组运行只经开运行工具开。',
  how: OPEN_COMPILE_HOW,
};
const PLAN_OPENS_BY_TOOL_RULE = {
  id: 'plan-run-opens-by-tool',
  tool: `mcp__${SERVER_NAME}__start_run`,
  match: [
    { path: 'pack', equalsBefore: '@', normalize: 'lower' as const, value: 'case-compile' },
    { path: 'parameters.plan_run', value: '' },
  ],
  what: '不允许：直接用 start_run 开脚本编写运行（没有 parameters.plan_run 的 case-compile）。开编译前要由代码核对文档和环境，脚本编写运行只经开运行工具开；脚本合并运行（带 parameters.plan_run）照常用 start_run。',
  how: OPEN_COMPILE_HOW,
};

export function profileDeclaration(profile: 'skills' | 'ops'): GuardDeclaration {
  const isOps = profile === 'ops';
  return {
    version: 1,
    errorLabels: Object.fromEntries(CALL_ERROR_CATEGORY.map(code => [code, labelOf('call_error_category', code)])) as Record<(typeof CALL_ERROR_CATEGORY)[number], string>,
    about:
      'Data for the Circle home PreToolUse guard (powered by ./guard-lib.ts). Choices live here; local CLI options and stdin come from explicit manifests. Literal double-quoted words are allowed without dollar, backtick or backslash characters.',
    allowReply: isOps ? 'silent' : 'explicit',
    allowLocalTools: isOps,
    hub: {
      server: SERVER_NAME,
      urlVariable: 'HUB_URL',
      tokenPlaceholder: `%${TOKEN_SECRET}%`,
      allowedPlaceholders: [`%${TOKEN_SECRET}%`, '%JEV_API_KEY%', '%PLUMB_API_KEY%'],
    },
    plumb: {
      urlVariable: 'PLUMB_URL',
      urlPlaceholder: '%PLUMB_URL%',
    },
    workFolders: {
      settingsKey: 'trusted_folders',
      ...(isOps ? { siblingsOfHome: '^work-ops' } : {}),
    },
    allow: isOps
      ? {
          'Hub 的六个工具': HUB_PREFIXED_TOOLS,
          '问使用者、任务清单、子代理': ['question', 'write_todos', 'todo', 'task', 'list_jobs', 'wait_jobs', 'stop_job', 'send_to_job', 'compact_conversation'],
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
      write: isOps ? ['write_file', 'edit_file', 'delete'] : ['delete'],
      readRoots: ['work', 'skills'],
      writeRoots: ['work'],
      virtualReadOnly: ['^/large_tool_results/[0-9a-f]{24}\\.txt$', '^/background_jobs/[A-Za-z0-9._-]{1,80}/run-[0-9]{1,6}\\.log$'],
      virtualReadOnlyTools: ['read_file', 'grep'],
      readableFiles: ['hooks/ALLOWED.md'],
    },
    skillTool: 'skill',
    skillRequiresInstalled: true,
    ...(isOps ? { workflowTool: 'workflow' } : {}),
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
            stdin: [],
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
        subcommandStdin: {
          list: [],
          read: [],
          status: [],
          verify: [],
          flush: [],
          submit: [],
        },
      },
      {
        path: 'plumb/tools/plumb.ts',
        subcommands: ['models', 'status', 'wake', 'judge', 'ask'],
        subcommandStdin: {
          models: ['%PLUMB_API_KEY%'],
          status: ['%PLUMB_API_KEY%'],
          wake: ['%PLUMB_API_KEY%'],
          judge: ['%PLUMB_API_KEY%'],
          ask: ['%PLUMB_API_KEY%'],
        },
      },
      {
        path: 'case-compile/tools/cmd-select-plumb.ts',
        stdin: ['%PLUMB_API_KEY%'],
      },
      {
        path: 'case-compile/tools/cmd-verify-plumb.ts',
        stdin: ['%PLUMB_API_KEY%'],
      },
      {
        path: 'case-compile/tools/fidelity-plumb.ts',
        stdin: ['%PLUMB_API_KEY%'],
      },
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
    },
    rules: isOps ? [BOOKING_STAYS_RULE, SUBAGENT_ASKS_NOBODY_RULE, LEAD_ASKS_NOBODY_RULE, RECOMPOSE_OPENS_BY_TOOL_RULE, PLAN_OPENS_BY_TOOL_RULE] : [BOOKING_STAYS_RULE, RECOMPOSE_OPENS_BY_TOOL_RULE, PLAN_OPENS_BY_TOOL_RULE],
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

export function guardBundle(_home: string, profile: 'skills' | 'ops'): GuardBundle {
  const decl = profile === 'ops' ? 'ops-allow.declaration.json' : 'guard.declaration.json';
  const gen = profile === 'ops' ? 'ops-allow-gen.mjs' : 'guard-gen.mjs';
  const entry = profile === 'ops' ? 'ops-allow.mjs' : 'skills-only.mjs';
  return {
    [`hooks/${entry}`]: renderGuardEntry(decl),
    'hooks/guard-lib.ts': readFileSync(new URL('./guard-lib.ts', import.meta.url), 'utf8'),
    [`hooks/${decl}`]: `${JSON.stringify(profileDeclaration(profile), null, 2)}\n`,
    [`hooks/${gen}`]: renderGuardGen(decl, gen),
  };
}

export function guardMain(argv: string[], out: (line: string) => void): number {
  try {
    const [mode, ...rest] = argv;
    if (mode !== 'verify' && mode !== 'update') throw new Error('guard 子命令只能是 verify 或 update');
    const values = new Map<string, string>();
    for (let i = 0; i < rest.length; i += 2) {
      if (!['--home', '--profile', '--workdir', '--baseline'].includes(rest[i]) || !rest[i + 1] || values.has(rest[i])) throw new Error('guard 参数无效或重复');
      values.set(rest[i], rest[i + 1]);
    }
    const home = values.get('--home');
    const profile = values.get('--profile');
    const workdir = values.get('--workdir');
    if (!home || !workdir || (profile !== 'skills' && profile !== 'ops')) throw new Error('需要 --home、--workdir 和 --profile skills|ops');
    const decl = profile === 'ops' ? 'ops-allow.declaration.json' : 'guard.declaration.json';
    const env = environment(home, workdir, decl);
    if (env.declarationError || !env.work) throw new Error('守卫声明或工作目录无效');
    const nextEnv = { ...env, declaration: profileDeclaration(profile) };
    let undeclared = 0;
    for (const tool of discoverTools(nextEnv)) {
      const missing = tool.subcommands?.length
        ? tool.subcommands.some(sub => !Object.hasOwn(tool.subcommandStdin ?? {}, sub))
        : tool.stdinLines === null;
      if (missing && existsSync(tool.file.replace(/\.ts$/, '.cli.json'))) throw new Error(`工具的标准输入声明无效或不完整：${tool.id}`);
      if (missing) undeclared += 1;
    }
    const gen = profile === 'ops' ? 'ops-allow-gen.mjs' : 'guard-gen.mjs';
    maintainInstallation(resolve(home), profile, guardBundle(home, profile), renderAllowed(nextEnv, `node hooks/${gen}`), mode, values.get('--baseline'));
    out(mode === 'verify' ? '守卫、规则全文与本地技能字节快照一致；此校验不证明发布包摘要已核验' : '守卫已更新并记录本地技能字节快照；此记录不证明发布包摘要已核验，请重新加载会话 Hook 配置');
    if (undeclared) out(`${undeclared} 个工具未声明标准输入；其标准输入协议仍未知，带 here-doc 调用将被拒绝，请补齐声明后使用标准输入`);
    return 0;
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    out(missing ? '校验失败：缺少安装文件或回执；旧 Home 需要集成者提供已审查的原版本回执 --baseline' : `校验失败：${(error as Error).message}`);
    return 1;
  }
}

function writePrivate(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function restoreHooksFromBackup(home: string, backup: string): void {
  const live = join(home, 'hooks');
  const staging = join(home, `hooks.restore.${process.pid}`);
  const outgoing = join(home, `hooks.outgoing.${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  rmSync(outgoing, { recursive: true, force: true });
  cpSync(backup, staging, { recursive: true });
  if (existsSync(live)) renameSync(live, outgoing);
  renameSync(staging, live);
  rmSync(outgoing, { recursive: true, force: true });
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function guardedHookNames(profile: 'skills' | 'ops'): { hookName: string; declName: string; genName: string } {
  return profile === 'ops'
    ? { hookName: 'ops-allow.mjs', declName: 'ops-allow.declaration.json', genName: 'ops-allow-gen.mjs' }
    : { hookName: 'skills-only.mjs', declName: 'guard.declaration.json', genName: 'guard-gen.mjs' };
}

export function planGuardFiles(profile: 'skills' | 'ops'): Array<{ relative: string; content: string }> {
  return Object.entries(guardBundle('', profile)).map(([relative, content]) => ({ relative, content }));
}

export function writeGuardFiles(homeRaw: string, workdirRaw: string, profile: 'skills' | 'ops'): string[] {
  const home = resolve(homeRaw);
  const workdir = resolve(workdirRaw);
  mkdirSync(join(home, 'hooks'), { recursive: true, mode: 0o700 });
  chmodSync(join(home, 'hooks'), 0o700);
  const { declName, genName } = guardedHookNames(profile);
  const written: string[] = [];
  for (const file of planGuardFiles(profile)) {
    writePrivate(join(home, file.relative), file.content);
    written.push(file.relative);
  }
  const allowedText = renderAllowed(environment(home, workdir, declName), `node hooks/${genName}`);
  writePrivate(join(home, 'hooks', 'ALLOWED.md'), allowedText);
  written.push('hooks/ALLOWED.md');
  return written;
}

export function materializeGuardFiles(home: string, workdir: string, profile: 'skills' | 'ops'): Array<{ relative: string; content: string }> {
  const {declName, genName} = guardedHookNames(profile);
  const env = environment(home, workdir, declName);
  return [...planGuardFiles(profile), {relative: 'hooks/ALLOWED.md', content: renderAllowed({...env, declaration: profileDeclaration(profile)}, `node hooks/${genName}`)}];
}

export interface RefreshGuardsResult {
  home: string;
  profile: 'skills' | 'ops';
  workdir: string;
  apply: boolean;
  changes: Array<{ relative: string; status: 'add' | 'change' | 'same' }>;
  backup?: string;
  preflightOk?: boolean;
  restored?: boolean;
  lines: string[];
}

export function refreshGuards(homeRaw: string, options: { apply?: boolean; baseline?: string; out?: (line: string) => void } = {}): RefreshGuardsResult {
  const apply = options.apply === true;
  const installed = resolveInstalledGuard(homeRaw);
  const { home, workdir, profile } = installed;
  const { hookName } = guardedHookNames(profile);
  const planned = materializeGuardFiles(home, workdir, profile);

  const changes = planned.map((file) => {
    const path = join(home, file.relative);
    if (!existsSync(path)) return { relative: file.relative, status: 'add' as const };
    const current = readFileSync(path, 'utf8');
    return { relative: file.relative, status: (sha256Text(current) === sha256Text(file.content) ? 'same' : 'change') as 'same' | 'change' };
  });

  const lines: string[] = [];
  const emit = (line: string) => {
    lines.push(line);
    options.out?.(line);
  };
  emit(`只更新守卫：${home}（${profile}）`);
  emit(`工作目录：${workdir}`);
  emit(`入口保持：hooks/${hookName}（不改 settings / credentials / secrets / skills）`);
  for (const change of changes) {
    emit(`- ${change.status === 'same' ? '不变' : change.status === 'add' ? '新增' : '将改'} ${change.relative}`);
  }

  if (!apply) {
    emit('演练结束：未改任何文件。真改请加 --apply（会先备份 hooks/，装完自动核对，不过则恢复）。');
    return { home, profile, workdir, apply: false, changes, lines };
  }

  const marker = join(home, 'hooks.apply-in-progress');
  if (existsSync(marker)) {
    const priorBackup = readFileSync(marker, 'utf8').trim();
    emit(`上次刷新未完成（存在 ${basename(marker)}）。请先用上一份完整备份恢复后再重试 --apply，不要继续覆盖。`);
    if (priorBackup.length > 0) {
      emit(`上一份完整备份：${priorBackup}`);
      emit(`恢复命令：rm -rf "${join(home, 'hooks')}" && mv "${priorBackup}" "${join(home, 'hooks')}" && rm -f "${marker}"`);
    } else {
      emit(`标记文件没有记下备份路径；若主目录里仍有 hooks.bak.*，把它的内容换回 hooks/ 后删除 ${basename(marker)}，再重试。`);
    }
    return { home, profile, workdir, apply: true, changes, preflightOk: false, restored: false, lines };
  }

  const bundle = guardBundle(home, profile);
  assertInstallationBaseline(home, profile, bundle, options.baseline);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = join(home, `hooks.bak.${stamp}`);
  emit(`步骤：备份 hooks/ → ${basename(backup)}`);
  cpSync(join(home, 'hooks'), backup, { recursive: true });
  emit(`已备份 hooks/ → ${basename(backup)}`);
  writePrivate(marker, `${backup}\n`);

  const clearMarker = () => {
    try {
      if (existsSync(marker)) unlinkSync(marker);
    } catch {
    }
  };

  try {
    emit('步骤：写入守卫文件（逐文件先写临时再改名）');
    writeGuardFiles(home, workdir, profile);
    emit('步骤：核对装着的守卫');
    const report = runPreflight(home);
    for (const line of formatPreflightReport(report)) emit(line);
    if (!report.ok) {
      emit('步骤：核对未过，从备份恢复 hooks/');
      restoreHooksFromBackup(home, backup);
      clearMarker();
      emit('核对未过：已从备份恢复 hooks/，主目录其余文件未动。');
      return { home, profile, workdir, apply: true, changes, backup, preflightOk: false, restored: true, lines };
    }
    recordInstallation(home, profile, bundle);
    clearMarker();
    emit('核对通过：守卫已更新。');
    return { home, profile, workdir, apply: true, changes, backup, preflightOk: true, restored: false, lines };
  } catch (error) {
    emit(`步骤：失败，尝试从备份恢复 hooks/（${(error as Error).message}）`);
    if (existsSync(backup)) {
      try {
        restoreHooksFromBackup(home, backup);
        clearMarker();
        emit(`失败并已从备份恢复：${(error as Error).message}`);
      } catch (restoreError) {
        emit(`失败且恢复也出错：${(error as Error).message}；恢复错误：${(restoreError as Error).message}；备份在 ${basename(backup)}；标记仍在 ${basename(marker)}`);
      }
    } else {
      emit(`失败且没有可用备份：${(error as Error).message}`);
    }
    return { home, profile, workdir, apply: true, changes, backup, preflightOk: false, restored: true, lines };
  }
}

export interface Written {
  files: string[];
  workdir: string;
}

export interface WriteHomeSecrets {
  plumbApiKey?: string;
}

export function writeHome(options: Options, endpoint: Endpoint, token: string, extraSecrets?: WriteHomeSecrets): Written {
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
        mcpServers: {
          [SERVER_NAME]: {
            type: 'http',
            url: options.hubUrl,
            headers: { Authorization: `Bearer \${secret:${TOKEN_SECRET}}` },
            placeholders: { url: 'HUB_URL', token: TOKEN_SECRET },
          },
        },
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: 'command',
                  name: profile === 'review' ? 'hub tools only' : `${profile} tools guard`,
                  command: `node ${hookArgument}`,
                  timeout: isGuarded ? 600 : 10,
                  onFailure: 'block',
                },
              ],
            },
          ],
        },
        ...(options.envFile === undefined ? {} : { credential_files: [basename(options.envFile)] }),
        ...(options.contextWindow === undefined ? {} : { models: { [endpoint.model]: { context_window: options.contextWindow } } }),
        ...(options.plumbCaFile === undefined ? {} : { trust_cert_files: [options.plumbCaFile] }),
        update_check: false,
        ...(isGuarded
          ? {
              variables: {
                HUB_URL: options.hubUrl,
                ...(options.jevModel === undefined ? {} : { JEV_MODEL: options.jevModel }),
                ...(options.plumbUrl === undefined ? {} : { PLUMB_URL: options.plumbUrl }),
                ...(options.plumbModel === undefined ? {} : { PLUMB_MODEL: options.plumbModel }),
              },
            }
          : {}),
      },
      null,
      2,
    )}\n`,
  );
  writePrivate(join(home, 'credentials.json'), `${JSON.stringify({ api_key: endpoint.apiKey })}\n`);
  const secrets: Record<string, string> = {
    [TOKEN_SECRET]: token,
    ...(extraSecrets?.plumbApiKey === undefined ? {} : { [PLUMB_KEY_SECRET]: extraSecrets.plumbApiKey }),
  };
  writePrivate(join(home, 'secrets.json'), `${JSON.stringify({ secrets })}\n`);

  if (!isGuarded) {
    writePrivate(hook, HOOK);
    return { files: ['settings.json', 'credentials.json', 'secrets.json', `hooks/${hookName}`], workdir };
  }

  const guardFiles = writeGuardFiles(home, workdir, profile);
  recordInstallation(home, profile, guardBundle(home, profile));
  guardFiles.push('hooks/guard-installation.json');
  return {
    files: ['settings.json', 'credentials.json', 'secrets.json', ...guardFiles],
    workdir,
  };
}

export function parseArgs(argv: string[]): Options & { envFile: string; provider: 'glm' | 'qwen' } {
  const values = new Map<string, string>();
  let plumbKeyStdin = false;
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--plumb-key-stdin') {
      plumbKeyStdin = true;
      continue;
    }
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`参数不对：${key ?? ''}`);
    values.set(key.slice(2), value);
    i += 1;
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
    plumbUrl: values.get('plumb-url'),
    plumbModel: values.get('plumb-model'),
    plumbCaFile: values.get('plumb-ca-file'),
    ...(plumbKeyStdin ? { plumbKeyStdin } : {}),
  };
}

export function parseRefreshGuardsArgs(argv: string[]): { home: string; apply: boolean; baseline?: string } {
  let home: string | undefined;
  let apply = false;
  let baseline: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--apply') {
      apply = true;
      continue;
    }
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`参数不对：${key ?? ''}`);
    if (key === '--home') home = value;
    else if (key === '--baseline') baseline = value;
    else throw new Error(`参数不对：${key}`);
    i += 1;
  }
  if (!home) throw new Error('缺少 --home');
  return { home, apply, ...(baseline ? {baseline} : {}) };
}

export function firstLineOf(raw: string): string {
  return raw.split(/\r?\n/, 1)[0] ?? '';
}

export function main(
  argv: string[],
  env: NodeJS.ProcessEnv,
  out: (line: string) => void,
  readStdin: () => string = () => readFileSync(0, 'utf8'),
): number {
  if (argv[0] === 'guard') return guardMain(argv.slice(1), out);
  try {
    if (argv[0] === 'refresh-guards') {
      const options = parseRefreshGuardsArgs(argv.slice(1));
      const result = refreshGuards(options.home, { apply: options.apply, baseline: options.baseline, out });
      if (result.apply && result.preflightOk === false) return 1;
      return 0;
    }
    const options = parseArgs(argv);
    const token = env.HUB_REAL_TOKEN;
    if (!token) throw new Error('环境变量 HUB_REAL_TOKEN 没有设置（中枢令牌只从环境变量读，不进命令行）');
    const plumbApiKey = options.plumbKeyStdin ? firstLineOf(readStdin()) : undefined;
    const endpoint = endpointFrom(readEnvFile(options.envFile), options.provider, options.model, options.section);
    const written = writeHome(options, endpoint, token, plumbApiKey === undefined ? undefined : { plumbApiKey });
    out(`已写入专用 Circle 目录（${written.files.length} 个文件，权限 0600）`);
    out(`模型：${endpoint.model}，协议 ${endpoint.protocol}，密钥长度 ${endpoint.apiKey.length}，来源 ${endpoint.sources.join('、')}`);
    out(`中枢令牌：已存为密钥 ${TOKEN_SECRET}，长度 ${token.length}`);
    if (plumbApiKey !== undefined) {
      out(`Plumb 密钥：${PLUMB_KEY_SECRET} 已写入，长度为 0：${plumbApiKey.length === 0 ? '是' : '否'}`);
    }
    const guarded = options.profile === 'skills' || options.profile === 'ops';
    out(
      guarded
        ? `受保护文件：${basename(options.envFile)}；统一声明守卫（${options.profile}）及技能自带钩子生效；工作目录外写操作与高风险动作受限`
        : `受保护文件：${basename(options.envFile)}；钩子只放行 ${HUB_TOOLS.length} 个中枢工具和待办清单；工作目录为空目录`,
    );
    if (guarded) {
      out('技能目录：已建立，权限 0700；变量 HUB_URL：已配置');
      out(`变量 JEV_MODEL：${options.jevModel === undefined ? '未配置' : `已配置，长度 ${options.jevModel.length}`}`);
      out(`变量 PLUMB_URL：${options.plumbUrl === undefined ? '未配置' : `已配置，长度 ${options.plumbUrl.length}`}`);
      out(`变量 PLUMB_MODEL：${options.plumbModel === undefined ? '未配置' : `已配置，长度 ${options.plumbModel.length}`}`);
      out(`证书 trust_cert_files：${options.plumbCaFile === undefined ? '未配置' : `已配置，长度 ${options.plumbCaFile.length}`}`);
      out('所有者下一步：/secrets JEV_API_KEY（脚本不读取或保存该密钥）');
      if (plumbApiKey === undefined) out('所有者下一步：/secrets PLUMB_API_KEY（脚本不读取或保存该密钥）');
      if (options.jevModel === undefined) out('所有者下一步：/variables JEV_MODEL');
      if (options.plumbUrl === undefined) out('所有者下一步：/variables PLUMB_URL');
      if (options.plumbModel === undefined) out('所有者下一步：/variables PLUMB_MODEL');
      const genScript = options.profile === 'ops' ? 'hooks/ops-allow-gen.mjs' : 'hooks/guard-gen.mjs';
      out(`技能装进 skills/ 后分别核对：local-tools verify --digest、pack-files.ts --verify-install、node ${genScript}`);
      out('再运行 circle-home.ts guard update / verify（显式传 --home、--workdir 和 --profile）；这两个入口不读取凭据。更新前停止会话，更新后重新加载 Hook 配置。');
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
