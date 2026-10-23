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

/** Emitted as a self-contained Node module; it has no dependency on this checkout. */
async function skillsGuard(home: string, workspace: string, allowed: string[]): Promise<void> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  class GuardRefusal extends Error {}
  const refuse: (reason: string) => never = (reason) => { throw new GuardRefusal(reason); };
  const deny = (reason = '这个目录只放行技能目录里的脚本；请按实际安装的绝对路径使用 node 脚本命令后重试') => ({ decision: 'deny', reason });
  const allow = () => ({ decision: 'allow', reason: '本目录允许的工具' });
  const under = (file: string, root: string) => { const relative = path.relative(root, file); return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
  const exists = (file: string) => { try { fs.lstatSync(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; refuse(`路径 ${JSON.stringify(file)} 元数据不可读；请核对读取权限后重试`); } };
  const canonical = (file: string): string => {
    const tail: string[] = []; let parent = path.resolve(file);
    while (!exists(parent)) { const next = path.dirname(parent); if (next === parent) refuse(`路径 ${JSON.stringify(file)} 缺少可核验的父目录；请补齐目标路径后重试`); tail.unshift(path.basename(parent)); parent = next; }
    try { return path.resolve(fs.realpathSync.native(parent), ...tail); } catch { refuse(`路径 ${JSON.stringify(file)} 无法规范化；请核对权限和软链接后重试`); }
  };
  const safeGlob = (value: unknown): boolean => {
    // Circle uses glob 13.0.6 with dot:true, follow:false. In this subset, only *
    // and whole-segment ** expand; their matches cannot name . or .. entries.
    // No braces, character classes, escapes or extglobs can synthesize a parent.
    if (typeof value !== 'string' || !value.length || /[^A-Za-z0-9_.*\/-]/.test(value)) return false;
    return value.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..'
      && (!segment.includes('**') || segment === '**'));
  };
  const globWithin = (base: string, pattern: string, root: string): void => {
    // Walk the accepted grammar's directory states without following links. A
    // literal or single-star segment may cross a link even with glob follow:false.
    // Only a leading globstar skips links in glob 13. A later globstar may
    // follow one link even with follow:false. The zero-directory branch also
    // checks the next segment, so **/linked/* cannot hide a literal traversal.
    const segments = pattern.split('/');
    const stack = [{ directory: base, index: 0 }]; const seen = new Set<string>();
    const matchers = segments.map(segment => new RegExp('^' + [...segment].map(char => char === '*' ? '[^/]*' : char === '.' ? '\\.' : char).join('') + '$', process.platform === 'darwin' || process.platform === 'win32' ? 'i' : ''));
    const inspect = (file: string) => {
      try { return fs.lstatSync(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return null; refuse('glob 缺少可核验的路径元数据；请核对工作目录的读取权限后重试'); }
    };
    const noLink = (file: string) => refuse(`glob 模式经过软链接段 ${JSON.stringify(path.relative(root, file))}；请改用工作目录内的真实目录或不经过该链接的模式后重试`);
    while (stack.length) {
      const current = stack.pop()!; const key = current.directory + '\0' + current.index;
      if (seen.has(key)) continue; seen.add(key);
      if (seen.size > 10000) refuse('glob 的目录核对超过上限，尚不能证明全部路径在工作目录内；请缩小真实目录前缀后重试');
      const info = inspect(current.directory); if (!info) continue;
      if (info.isSymbolicLink()) noLink(current.directory);
      if (!info.isDirectory()) continue;
      if (!under(canonical(current.directory), root)) refuse('glob 的真实目录已越过工作目录；请恢复目录并改用工作目录内的真实路径后重试');
      const segment = segments[current.index]; const last = current.index === segments.length - 1;
      if (segment === '**' && !last) stack.push({ directory: current.directory, index: current.index + 1 });
      let names: string[];
      try { names = segment.includes('*') ? fs.readdirSync(current.directory) : [segment]; }
      catch { refuse('glob 缺少可核验的目录列表；请核对工作目录的读取权限或缩小真实目录前缀后重试'); }
      for (const name of names) {
        if (!matchers[current.index].test(name)) continue;
        const file = path.join(current.directory, name); const entry = inspect(file); if (!entry) continue;
        if (entry.isSymbolicLink()) { if (segment === '**' && current.index === 0 && !last) continue; noLink(file); }
        if (!under(canonical(file), root)) refuse('glob 的匹配真实路径已越过工作目录；请恢复目录并改用工作目录内的真实路径后重试');
        if (entry.isDirectory() && (segment === '**' || !last)) stack.push({ directory: file, index: segment === '**' ? current.index : current.index + 1 });
      }
    }
  };
  const scriptOf = (command: string, root: string): string | null => {
    let line = command;
    if (command.includes('\n')) {
      const lines = command.split('\n'); if (lines.at(-1) === '') lines.pop();
      const head = /^(.*?)[ \t]+<<'([A-Za-z_][A-Za-z0-9_]*)'[ \t]*$/.exec(lines.shift() ?? '');
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
    let physical: string; try { physical = fs.realpathSync.native(lexical); } catch { refuse('缺少已安装技能脚本的实际路径；请集成者安装并运行 local-tools verify --digest 或 pack-files.ts --verify-install 后按真实路径重试'); }
    if (!under(physical, root)) return null;
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
    } catch (error) { if (error instanceof GuardRefusal) throw error; refuse('技能钩子的路径匹配配置无法核验；请修复 hooks.json 并核对安装后重试'); }
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
      let stdout = '', failureReason: string | null = null, settled = false;
      let force: ReturnType<typeof setTimeout> | undefined;
      const kill = (signal: NodeJS.Signals) => {
        if (!child.pid) return;
        if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => {});
        else try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* Already gone. */ } }
      };
      const stop = (reason: string) => { if (failureReason !== null) return; failureReason = reason; kill('SIGTERM'); force = setTimeout(() => kill('SIGKILL'), 500); };
      const interrupted = () => { stopping = true; failureReason = '技能钩子被宿主停止，缺少完整决定；请重新发起调用'; kill('SIGKILL'); };
      process.once('SIGTERM', interrupted); process.once('SIGINT', interrupted);
      const timer = setTimeout(() => stop('技能钩子超过配置时限，缺少完整决定；请修复耗时并运行 verify 核对安装后重试'), timeout);
      const finish = (decision: { decision: string; reason: string }) => {
        if (settled) return; settled = true; clearTimeout(timer); if (force) clearTimeout(force);
        process.removeListener('SIGTERM', interrupted); process.removeListener('SIGINT', interrupted); done(decision);
      };
      child.stdout.on('data', chunk => { if (failureReason !== null) return; stdout += chunk.toString('utf8'); if (stdout.length > 100000) stop('技能钩子输出超过上限，缺少完整 JSON；请修复输出并运行 verify 后重试'); });
      child.stderr.resume(); child.stdin.on('error', () => {}); child.stdin.end(raw);
      child.once('error', () => finish({ decision: 'deny', reason: '技能钩子启动失败；请核对工作目录和安装并运行 verify 后重试' }));
      child.once('close', code => {
        if (failureReason !== null) { finish(deny(failureReason)); return; }
        if (code !== 0) { finish(deny(`技能钩子退出码 ${code ?? '未知'}，缺少允许决定；请修正参数或钩子安装并运行 verify 后重试`)); return; }
        try {
          const reply: unknown = JSON.parse(stdout.trim());
          if (!object(reply)) throw new Error('not an object');
          const word = typeof reply.decision === 'string' ? reply.decision.trim() : '';
          const decision = word === 'deny' || word === 'ask' ? word : 'allow';
          const reason = (typeof reply.reason === 'string' ? reply.reason.trim() : typeof reply.context === 'string' ? reply.context.trim() : '') || (decision === 'ask' ? '需要确认；请核对本次工具调用后明确允许或拒绝' : decision === 'deny' ? '拒绝本次调用；请按技能约束修正参数后重试' : '允许本次调用');
          finish({ decision, reason });
        } catch { finish({ decision: 'deny', reason: '技能钩子未输出 JSON 对象；请修复脚本输出并运行 verify 后重试' }); }
      });
    });
  };
  const delegated = async (script: string, root: string, input: Record<string, unknown>, raw: string) => {
    const skill = skillDirectory(script, root); const file = path.join(skill, 'hooks.json');
    const who = `技能 ${JSON.stringify(path.relative(root, skill) || '.')}`;
    const recover = '请重新安装技能，并运行 local-tools verify --digest 或 pack-files.ts --verify-install 后重试';
    let present: boolean;
    try { present = exists(file); } catch { refuse(`${who} 的 hooks.json 元数据不可读；${recover}`); }
    if (!present) return allow();
    let real: string;
    try { real = canonical(file); } catch { refuse(`${who} 的 hooks.json 路径无法核验；${recover}`); }
    if (!under(real, skill)) refuse(`${who} 的 hooks.json 指向技能目录之外；${recover}`);
    let contents: string;
    try { contents = fs.readFileSync(file, 'utf8'); } catch { refuse(`${who} 的 hooks.json 不可读；${recover}`); }
    let declaration: unknown;
    try { declaration = JSON.parse(contents); } catch { refuse(`${who} 的 hooks.json JSON 语法无效；${recover}`); }
    if (!object(declaration) || declaration.version !== undefined && declaration.version !== 1 || declaration.hooks !== undefined && !object(declaration.hooks)) refuse(`${who} 的 hooks.json 对象或版本不受支持；${recover}`);
    const entries = object(declaration.hooks) ? declaration.hooks.before_tool ?? [] : [];
    if (!Array.isArray(entries) || entries.length > 100 || entries.some(hook => !object(hook) || typeof hook.command !== 'string' || !hook.command.trim() || hook.command.length > 4000 || hook.command.includes('\0'))) refuse(`${who} 的 hooks.json.before_tool 缺少可执行的命令列表或超过上限；${recover}`);
    let strictest = allow(); let matched = false;
    for (const [index, hook] of (entries as Record<string, unknown>[]).entries()) {
      const named = typeof hook.name === 'string' && hook.name.trim() ? hook.name.trim() : `before_tool[${index + 1}]`;
      const identity = `${who} / 钩子 ${JSON.stringify(named.length > 80 ? named.slice(0, 80) + '…' : named)}（第 ${index + 1} 项）`;
      if (stopping) refuse(`${identity} 被宿主停止，缺少完整决定；请重新发起调用以重新核对`);
      let selected: boolean;
      try { selected = matches(hook, input); } catch (error) { refuse(`${identity} 的匹配检查未完成；${error instanceof GuardRefusal ? error.message : recover}`); }
      if (!selected) continue;
      const decision = await runHook(hook, raw, String(input.cwd));
      decision.reason = `${identity}：${decision.reason}`;
      if (!matched || decision.decision === 'deny' && strictest.decision !== 'deny' || decision.decision === 'ask' && strictest.decision === 'allow') strictest = decision;
      else if (decision.decision === strictest.decision && decision.decision !== 'allow') strictest = {...strictest, reason: strictest.reason + '；' + decision.reason};
      matched = true;
    }
    return strictest;
  };
  let raw = ''; process.stdin.setEncoding('utf8'); for await (const chunk of process.stdin) raw += chunk;
  let result = deny();
  try {
    let input: unknown;
    try { input = JSON.parse(raw); } catch { refuse('钩子输入不是完整 JSON；请宿主用完整的 before_tool 对象重新发起调用'); }
    if (!object(input) || input.event !== 'before_tool' || typeof input.tool_name !== 'string' || !object(input.tool_input)) refuse('钩子缺少 before_tool、tool_name 或 tool_input 对象；请宿主补齐输入后重试');
    if (input.paths !== undefined && (!Array.isArray(input.paths) || input.paths.some(file => typeof file !== 'string'))) refuse('工具 paths 不是文字路径列表；请用工作目录内的完整路径重新发起调用');
    if (allowed.includes(input.tool_name)) result = allow();
    else if (['read_file', 'ls', 'glob', 'grep'].includes(input.tool_name)) {
      if (input.tool_name === 'glob' && !safeGlob(input.tool_input.pattern)) refuse('glob 的 pattern 不符合本主目录的窄文法；请改用 / 分隔的非空相对段，每段只含英文字母、数字、_、-、.、*，** 须独占一段；不许 .、..、括号类、花括号、extglob 或转义，请拆成多次简单查询后重试');
      const root = canonical(workspace);
      if (typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd)) refuse('文件工具缺少绝对 cwd；请在专用工作目录重新发起调用');
      if (!Array.isArray(input.paths) || !input.paths.length) refuse(`${input.tool_name} 缺少路径；请填写工作目录内的 path 或 file_path 后重试`);
      for (const file of input.paths) {
        if (typeof file !== 'string' || !file.length) refuse(`${input.tool_name} 含空路径；请补齐工作目录内的路径后重试`);
        const target = canonical(path.resolve(input.cwd, file));
        if (!under(target, root)) refuse(`只读目标 ${JSON.stringify(file)} 不在工作目录 ${JSON.stringify(root)} 内；请改用工作目录内路径，其他目录由集成者另行设置专用主目录`);
        if (input.tool_name === 'glob') globWithin(target, input.tool_input.pattern as string, root);
      }
      result = allow();
    } else if (input.tool_name === 'execute') {
      if (Object.keys(input.tool_input).some(key => !['command', 'background', 'timeout'].includes(key)) || input.tool_input.background !== undefined && typeof input.tool_input.background !== 'boolean' || input.tool_input.timeout !== undefined && (typeof input.tool_input.timeout !== 'number' || !Number.isFinite(input.tool_input.timeout))) refuse('execute 参数形状无效；请只用 command、background 和 timeout 的正确类型重新调用');
      if (typeof input.tool_input.command !== 'string' || typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd)) refuse('execute 缺少 command 文字或绝对 cwd；请宿主补齐工具调用后重试');
      const root = path.join(canonical(home), 'skills');
      if (!exists(root) || !fs.lstatSync(root).isDirectory() || canonical(root) !== root) refuse('skills 目录根已改变或缺失；请集成者恢复专用主目录的真实 skills 目录并核对安装后重试');
      const script = scriptOf(input.tool_input.command, root);
      if (script) result = await delegated(script, root, input, raw);
      else result = deny();
    } else result = deny('该工具不在本主目录授权范围；请使用 Hub、skill 或工作目录内只读工具，写操作交给集成者处理');
  } catch (error) {
    result = deny(error instanceof GuardRefusal ? error.message : '本主目录守卫未完成检查，缺少可信决定；请集成者核对守卫安装后重新发起调用');
  }
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
        ...(options.contextWindow === undefined ? {} : { models: { [endpoint.model]: { context_window: options.contextWindow } } }),
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
