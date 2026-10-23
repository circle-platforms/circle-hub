// Sets up a dedicated Circle data folder for a real review run: a model endpoint taken from the owner's environment file or
// read from the owner's Circle configuration (circleEndpoint), the Hub as an ordinary MCP server, the environment file's name
// as a protected file, and a hook that lets only the Hub's tools run. The environment file and the owner's Circle folder are
// read here, at run time. Values reach only the 0600 files of the new folder; the screen shows names, presence and lengths.
// The Hub token comes from the environment variable HUB_REAL_TOKEN, never from a command line.
//   node scripts/real/circle-home.ts --env-file <file> --home <dir> --provider glm|qwen [--model <id>] [--section <text>]
//        [--hub-url http://127.0.0.1:7420/mcp] [--workdir <dir>] [--profile review|skills] [--jev-model <id>]
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pick, readEnvFile, type EnvEntry } from './lib/env-file.ts';

export interface Options {
  envFile?: string;
  home: string;
  provider?: 'glm' | 'qwen';
  model?: string;
  section?: string;
  hubUrl: string;
  workdir?: string;
  profile?: 'review' | 'skills';
  jevModel?: string;
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

/** Emitted as a self-contained Node module; it has no dependency on this checkout. */
async function skillsGuard(home: string, workspace: string, allowed: string[]): Promise<void> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  const deny = () => ({ decision: 'deny', reason: '这个目录只放行技能目录里的脚本' });
  const allow = () => ({ decision: 'allow', reason: '本目录允许的工具' });
  const under = (file: string, root: string) => { const relative = path.relative(root, file); return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
  const exists = (file: string) => { try { fs.lstatSync(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } };
  const canonical = (file: string): string => {
    const tail: string[] = []; let parent = path.resolve(file);
    while (!exists(parent)) { const next = path.dirname(parent); if (next === parent) throw new Error('path unavailable'); tail.unshift(path.basename(parent)); parent = next; }
    return path.resolve(fs.realpathSync.native(parent), ...tail);
  };
  const safeGlob = (value: unknown): boolean => {
    if (typeof value !== 'string' || !value.length || /[\0\r\n]/.test(value)) return false;
    // Inspect literal, escaped and separator spellings before the backend expands braces or globs.
    const forms = [value, value.replace(/\\([\s\S])/g, '$1'), value.replaceAll('\\', '/')];
    return forms.every(form => {
      const normalized = form.replaceAll('\\', '/');
      return !path.isAbsolute(form) && !path.win32.isAbsolute(form) && !normalized.startsWith('~')
        && !normalized.split(/[/{},()|]/).some(segment => segment === '..')
        && !/(?:^|[{,(|])(?:~|\/|[A-Za-z]:)/.test(normalized);
    });
  };
  const scriptOf = (command: string, root: string): string | null => {
    let line = command;
    if (command.includes('\n')) {
      const lines = command.split('\n'); if (lines.at(-1) === '') lines.pop();
      const head = /^(.*?)\s+<<'([A-Za-z_][A-Za-z0-9_]*)'[ \t]*$/.exec(lines.shift() ?? '');
      if (!head || lines.pop() !== head[2] || lines.some(row => !/^%[A-Z][A-Z0-9_]*%$/.test(row))) return null;
      line = head[1];
    }
    if (/[;&|`<>\r\n]/.test(line) || line.includes('$(')) return null;
    const words: string[] = []; let index = 0;
    while (index < line.length) {
      while (/[ \t]/.test(line[index] ?? '') && index < line.length) index++;
      if (index === line.length) break;
      const rest = line.slice(index); const match = /^(?:([A-Za-z0-9_./:%=@,+-]+)|'([^'\r\n]*)')/.exec(rest);
      if (!match || words.length === 0 && match[0] !== 'node') return null;
      words.push(match[1] ?? match[2]); index += match[0].length;
      if (index < line.length && !/[ \t]/.test(line[index])) return null;
    }
    const script = words[1];
    if (words[0] !== 'node' || !script || !path.isAbsolute(script) || script.split(/[\\/]/).includes('..') || script.includes('%') || !script.endsWith('.ts')) return null;
    const lexical = path.resolve(script); if (!under(lexical, path.resolve(home, 'skills')) && !under(lexical, root)) return null;
    const physical = fs.realpathSync.native(lexical); if (!under(physical, root)) return null;
    if (path.relative(root, physical) !== path.relative(path.resolve(home, 'skills'), lexical)) return null;
    return physical;
  };
  const skillDirectory = (script: string, root: string): string => {
    let dir = path.dirname(script);
    while (dir !== root) {
      if (exists(path.join(dir, 'SKILL.md'))) return dir;
      const parent = path.dirname(dir); if (parent === root) return dir;
      dir = parent;
    }
    return root;
  };
  const { spawn, execFile } = await import('node:child_process');
  let stopping = false;
  const globMatches = (file: string, pattern: string, cwd: string): boolean => {
    try {
      const normalize = (value: string) => { const normalized = path.normalize(value).replaceAll('\\', '/'); return process.platform === 'win32' ? normalized.toLowerCase() : normalized; };
      const absolute = canonical(path.resolve(cwd, file));
      let glob = pattern.trim().replaceAll('\\', '/'); let target: string;
      if (path.isAbsolute(glob)) {
        const star = glob.search(/[*?]/); const slash = star < 0 ? -1 : glob.lastIndexOf('/', star);
        glob = star < 0 ? canonical(glob) : slash >= 0 ? path.join(canonical(glob.slice(0, slash) || path.parse(glob).root), glob.slice(slash + 1)) : glob;
        target = normalize(absolute);
      } else {
        const root = canonical(cwd); if (!under(absolute, root)) return false;
        target = normalize(path.relative(root, absolute));
      }
      glob = normalize(glob); let expression = '^';
      for (let i = 0; i < glob.length; i++) {
        const char = glob[i];
        if (char === '*' && glob[i + 1] === '*') {
          if (glob[i + 2] === '/') { expression += '(?:.*/)?'; i += 2; }
          else { expression += '.*'; i++; }
        } else if (char === '*') expression += '[^/]*';
        else if (char === '?') expression += '[^/]';
        else expression += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
      return new RegExp(expression + '$').test(target);
    } catch { return false; }
  };
  const matches = (hook: Record<string, unknown>, input: Record<string, unknown>): boolean => {
    const matcher = hook.tools ?? hook.matcher;
    if (matcher !== undefined && matcher !== '' && matcher !== '*') {
      const parts = Array.isArray(matcher) ? matcher : typeof matcher === 'string' ? matcher.split(/[|,]/) : [];
      const names = parts.map(part => String(part).trim()).filter(part => part && part !== '*');
      if (names.length && !names.includes(String(input.tool_name))) return false;
    }
    const patterns = hook.paths === undefined ? [] : Array.isArray(hook.paths) ? hook.paths : [hook.paths];
    const globs = patterns.filter((part): part is string => typeof part === 'string').map(part => part.trim()).filter(Boolean);
    return !globs.length || Array.isArray(input.paths) && input.paths.some(file => typeof file === 'string' && globs.some(glob => globMatches(file, glob, String(input.cwd))));
  };
  const runHook = async (hook: Record<string, unknown>, raw: string, cwd: string): Promise<{ decision: string; reason: string }> => {
    const setting = typeof hook.timeout_ms === 'number' && Number.isFinite(hook.timeout_ms) ? hook.timeout_ms : 30000;
    const timeout = Math.max(100, Math.min(600000, Math.floor(setting)));
    return new Promise(done => {
      const child = spawn(hook.command as string, { cwd, shell: true, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', failed = false, settled = false;
      let force: ReturnType<typeof setTimeout> | undefined;
      const kill = (signal: NodeJS.Signals) => {
        if (!child.pid) return;
        if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => {});
        else try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* Already gone. */ } }
      };
      const stop = () => { if (failed) return; failed = true; kill('SIGTERM'); force = setTimeout(() => kill('SIGKILL'), 500); };
      const interrupted = () => { stopping = true; failed = true; kill('SIGKILL'); };
      process.once('SIGTERM', interrupted); process.once('SIGINT', interrupted);
      const timer = setTimeout(stop, timeout);
      const finish = (decision: { decision: string; reason: string }) => {
        if (settled) return; settled = true; clearTimeout(timer); if (force) clearTimeout(force);
        process.removeListener('SIGTERM', interrupted); process.removeListener('SIGINT', interrupted); done(decision);
      };
      child.stdout.on('data', chunk => { if (failed) return; stdout += chunk.toString('utf8'); if (stdout.length > 100000) stop(); });
      child.stderr.resume(); child.stdin.on('error', () => {}); child.stdin.end(raw);
      child.once('error', () => finish({ decision: 'deny', reason: '技能钩子启动失败' }));
      child.once('close', code => {
        if (failed || code !== 0) { finish({ decision: 'deny', reason: '技能钩子失败、超时或被停止' }); return; }
        try {
          const reply: unknown = JSON.parse(stdout.trim());
          if (!object(reply)) throw new Error('not an object');
          const word = typeof reply.decision === 'string' ? reply.decision.trim() : '';
          const decision = word === 'deny' || word === 'ask' ? word : 'allow';
          const reason = typeof reply.reason === 'string' ? reply.reason : typeof reply.context === 'string' ? reply.context : '技能钩子的决定';
          finish({ decision, reason });
        } catch { finish({ decision: 'deny', reason: '技能钩子未输出 JSON 对象' }); }
      });
    });
  };
  const delegated = async (script: string, root: string, input: Record<string, unknown>, raw: string) => {
    const skill = skillDirectory(script, root); const file = path.join(skill, 'hooks.json');
    if (!exists(file)) return allow();
    if (!under(canonical(file), skill)) return deny();
    const declaration: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!object(declaration) || declaration.version !== undefined && declaration.version !== 1 || declaration.hooks !== undefined && !object(declaration.hooks)) return deny();
    const entries = object(declaration.hooks) ? declaration.hooks.before_tool ?? [] : [];
    if (!Array.isArray(entries) || entries.length > 100 || entries.some(hook => !object(hook) || typeof hook.command !== 'string' || !hook.command.trim() || hook.command.length > 4000 || hook.command.includes('\0'))) return deny();
    let strictest = allow();
    for (const hook of entries as Record<string, unknown>[]) {
      if (stopping) return deny();
      if (!matches(hook, input)) continue;
      const decision = await runHook(hook, raw, String(input.cwd));
      if (decision.decision === 'deny' || decision.decision === 'ask' && strictest.decision === 'allow') strictest = decision;
    }
    return strictest;
  };
  let raw = ''; process.stdin.setEncoding('utf8'); for await (const chunk of process.stdin) raw += chunk;
  let result = deny();
  try {
    const input: unknown = JSON.parse(raw);
    if (!object(input) || input.event !== 'before_tool' || typeof input.tool_name !== 'string' || !object(input.tool_input)) throw new Error('invalid input');
    if (input.paths !== undefined && (!Array.isArray(input.paths) || input.paths.some(file => typeof file !== 'string'))) throw new Error('invalid paths');
    if (allowed.includes(input.tool_name)) result = allow();
    else if (['read_file', 'ls', 'glob', 'grep'].includes(input.tool_name)) {
      if(input.tool_name==='glob'&&!safeGlob(input.tool_input.pattern))throw new Error('invalid glob pattern');
      const root = canonical(workspace);
      if (typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd)) throw new Error('invalid cwd');
      if (Array.isArray(input.paths) && input.paths.length && input.paths.every(file => typeof file === 'string' && file.length > 0 && under(canonical(path.resolve(input.cwd as string, file)), root))) result = allow();
    } else if (input.tool_name === 'execute') {
      if (Object.keys(input.tool_input).some(key => !['command', 'background', 'timeout'].includes(key)) || input.tool_input.background !== undefined && typeof input.tool_input.background !== 'boolean' || input.tool_input.timeout !== undefined && (typeof input.tool_input.timeout !== 'number' || !Number.isFinite(input.tool_input.timeout))) throw new Error('invalid execute fields');
      if (typeof input.tool_input.command !== 'string' || typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd)) throw new Error('invalid execute');
      const root = path.join(canonical(home), 'skills'); if (canonical(root) !== root) throw new Error('skills root changed');
      const script = scriptOf(input.tool_input.command, root);
      if (script) {
        result = await delegated(script, root, input, raw);
      }
    }
  } catch { result = deny(); }
  process.stdout.write(JSON.stringify(result));
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
  if (profile !== 'review' && profile !== 'skills') throw new Error('--profile 只能是 review 或 skills');
  const home = resolve(options.home);
  const workdir = resolve(options.workdir ?? join(home, 'work'));
  if (existsSync(join(home, 'settings.json'))) throw new Error('目标目录里已经有 settings.json：换一个新目录，不覆盖');
  for (const dir of [home, join(home, 'hooks'), workdir, ...(profile === 'skills' ? [join(home, 'skills')] : [])]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  const hookName = profile === 'skills' ? 'skills-only.mjs' : 'hub-only.mjs';
  const hook = join(home, 'hooks', hookName);
  const hookArgument = profile === 'review' ? JSON.stringify(hook) : `'${hook.replaceAll("'", `'\\''`)}'`;
  writePrivate(hook, profile === 'review' ? HOOK : `${skillsGuard.toString()}\nawait skillsGuard(${JSON.stringify(home)}, ${JSON.stringify(workdir)}, ${JSON.stringify([...HUB_TOOLS.map(t => `${SERVER_NAME}_${t}`), ...INTERNAL_TOOLS_ALLOWED, 'skill'])});\n`);
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
        update_check: false,
        ...(profile === 'skills' ? { variables: { HUB_URL: options.hubUrl, ...(options.jevModel === undefined ? {} : { JEV_MODEL: options.jevModel }) } } : {}),
      },
      null,
      2,
    )}\n`,
  );
  writePrivate(join(home, 'credentials.json'), `${JSON.stringify({ api_key: endpoint.apiKey })}\n`);
  writePrivate(join(home, 'secrets.json'), `${JSON.stringify({ secrets: { [TOKEN_SECRET]: token } })}\n`);
  writePrivate(
    join(home, 'hooks.json'),
    `${JSON.stringify({ version: 1, hooks: { before_tool: [{ name: profile === 'skills' ? 'skills tools only' : 'hub tools only', command: `node ${hookArgument}`, timeout_ms: profile === 'skills' ? 600000 : 10000 }] } }, null, 2)}\n`,
  );
  return { files: ['settings.json', 'credentials.json', 'secrets.json', 'hooks.json', `hooks/${hookName}`], workdir };
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
  if (profile !== 'review' && profile !== 'skills') throw new Error('--profile 只能是 review 或 skills');
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
    out(options.profile === 'skills' ? `受保护文件：${basename(options.envFile)}；技能目录守卫及技能自带钩子生效；只读文件限工作目录` : `受保护文件：${basename(options.envFile)}；钩子只放行 ${HUB_TOOLS.length} 个中枢工具和待办清单；工作目录为空目录`);
    if (options.profile === 'skills') {
      out('技能目录：已建立，权限 0700；变量 HUB_URL：已配置');
      out(`变量 JEV_MODEL：${options.jevModel === undefined ? '未配置' : `已配置，长度 ${options.jevModel.length}`}`);
      out('所有者下一步：/secrets JEV_API_KEY（脚本不读取或保存该密钥）');
      if (options.jevModel === undefined) out('所有者下一步：/variables JEV_MODEL');
      out('技能装进 skills/ 后分别核对：local-tools verify --digest、pack-files.ts --verify-install');
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
