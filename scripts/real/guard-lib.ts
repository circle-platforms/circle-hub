// Unified declaration-driven before_tool guard engine for Circle homes (skills & ops profiles).
// Self-contained standalone Node 24 TypeScript module (copied into `<home>/hooks/guard-lib.ts` with no checkout dependency).
// Enforces one single command & quoting grammar across docs, ALLOWED.md, and runtime checks: bare `[A-Za-z0-9_./:%=@,+-]+` or single-quoted `'...'`.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface RuleMatch {
  path: string;
  equalsBefore?: string;
  normalize?: 'lower';
  value?: string;
  in?: string[];
}

export interface GuardRule {
  id: string;
  tool: string;
  session?: 'subagent';
  match?: RuleMatch[];
  what: string;
  how: string;
}

export interface ScriptDeclaration {
  path: string;
  subcommands?: string[];
  subcommandStdin?: Record<string, string[]>;
}

export interface GuardDeclaration {
  version: 1;
  about?: string;
  allowReply?: 'explicit' | 'silent';
  allowLocalTools?: boolean;
  hub?: {
    server?: string;
    urlVariable?: string;
    tokenPlaceholder?: string;
    allowedPlaceholders?: string[];
  };
  workFolders?: {
    settingsKey?: string;
    siblingsOfHome?: string;
  };
  allow?: Record<string, string[]>;
  files?: {
    read?: string[];
    write?: string[];
    readRoots?: ('work' | 'skills')[];
    writeRoots?: ('work')[];
    virtualReadOnly?: string[];
    virtualReadOnlyTools?: string[];
    readableFiles?: string[];
  };
  skillTool?: string;
  skillRequiresInstalled?: boolean;
  executeTool?: string;
  denyPrefix?: Record<string, string>;
  equalsForm?: 'fix' | 'accept';
  interpreters?: string[];
  commands?: Array<{ name: string; args?: string[]; max?: number; note?: string }>;
  scripts?: ScriptDeclaration[];
  optionTypes?: Record<string, 'hub' | 'run' | 'int' | 'text' | 'path'>;
  placeholderTypes?: Array<{ match: string; type: 'hub' | 'run' | 'int' | 'text' | 'path' }>;
  shellAlternatives?: Record<string, string>;
  rules?: GuardRule[];
}

export interface GuardEnvironment {
  home: string;
  homeRaw: string;
  settings: Record<string, unknown>;
  declaration: GuardDeclaration;
  declarationError: string | null;
  hubs: string[];
  hub: string;
  cwd: string;
  work: string | null;
  skills: string;
  skillsRaw: string;
  skillsRootValid: boolean;
  allowedFile: string;
  urlPlaceholder: string;
  tokenPlaceholder: string;
  allowedPlaceholders: string[];
}

export interface HookDecision {
  decision?: 'allow' | 'deny' | 'ask';
  reason?: string;
}

export interface ToolOption {
  name: string;
  required: boolean;
  kind: 'string' | 'boolean';
  multiple: boolean;
  placeholder: string | null;
  type: 'hub' | 'run' | 'int' | 'text' | 'path';
}

export interface ToolForm {
  positional: string | null;
  pairs: Array<{ name: string; placeholder: string | null; optional: boolean }>;
}

export interface DiscoveredTool {
  id: string;
  file: string;
  skill: string | null;
  subcommands: string[] | null;
  subcommandStdin: Record<string, string[]> | null;
  options: ToolOption[];
  restricted: boolean;
  stdinMode: 'none' | 'single' | 'keys';
  forms: ToolForm[];
}

export interface ParsedCommand {
  words: string[];
  heredoc: { delimiter: string; body: string[]; closed: boolean; after?: string } | null;
  lines: number;
  problem: string | null;
}

class GuardRefusal extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const asList = <T>(value: readonly T[] | undefined): T[] => (Array.isArray(value) ? [...value] : []);
const unknownList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const readText = (file: string): string => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

const readJson = <T>(file: string, fallback: T): T => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
};

const listNames = (dir: string, predicate: (name: string) => boolean): string[] => {
  try {
    return fs.readdirSync(dir).filter(predicate).sort();
  } catch {
    return [];
  }
};

const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const clip = (value: unknown, max = 60): string => {
  const text = String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

/** Lexical child containment check (no trailing '..' or outside paths). */
export const inside = (candidate: string, root: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

const existsLstat = (file: string): boolean => {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new GuardRefusal(`路径 ${JSON.stringify(file)} 元数据不可读；请核对读取权限后重试`);
  }
};

/** Fail-closed canonical resolver: resolves deepest existing ancestor via realpathSync.native; existing symlinks whose target fails realpath (dangling links) throw GuardRefusal. */
export const canonical = (file: string): string => {
  const tail: string[] = [];
  let cursor = path.resolve(file);
  while (!existsLstat(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new GuardRefusal(`路径 ${JSON.stringify(file)} 缺少可核验的父目录；请补齐目标路径后重试`);
    }
    tail.unshift(path.basename(cursor));
    cursor = parent;
  }
  try {
    return path.resolve(fs.realpathSync.native(cursor), ...tail);
  } catch {
    throw new GuardRefusal(`路径 ${JSON.stringify(file)} 无法规范化；请核对权限和软链接后重试`);
  }
};

const bestEffortReal = (file: string): string => {
  try {
    return canonical(file);
  } catch {
    return path.resolve(file);
  }
};

/** Loads session environment, declaration JSON, trusted work folder, and canonical skills root. */
export function environment(home: string, cwd: string, declarationName = 'guard.declaration.json'): GuardEnvironment {
  const homeRaw = path.resolve(home);
  const homeReal = bestEffortReal(homeRaw);
  const settings = readJson<Record<string, unknown>>(path.join(homeReal, 'settings.json'), {});
  const hooksDir = path.join(homeReal, 'hooks');
  const declarationPath = path.join(hooksDir, declarationName);

  let declaration: GuardDeclaration = { version: 1 };
  let declarationError: string | null = null;
  try {
    const realDecl = canonical(declarationPath);
    if (!inside(realDecl, hooksDir)) throw new Error('声明文件越出 hooks 目录');
    const parsed: unknown = JSON.parse(fs.readFileSync(realDecl, 'utf8'));
    if (!isRecord(parsed) || parsed.version !== 1) throw new Error('version 不是 1');
    declaration = parsed as unknown as GuardDeclaration;
  } catch (error) {
    declarationError = error instanceof Error ? error.message : String(error);
  }

  const hubCfg = declaration.hub ?? {};
  const urlVar = hubCfg.urlVariable ?? 'HUB_URL';
  const serverName = hubCfg.server ?? 'hub';
  const hubs: string[] = [];
  const vars = isRecord(settings.variables) ? settings.variables : {};
  const variable = vars[urlVar];
  if (typeof variable === 'string' && variable !== '') hubs.push(variable);
  const server = unknownList(settings.mcp_servers).find(
    (entry): entry is Record<string, unknown> => isRecord(entry) && entry.name === serverName,
  );
  if (typeof server?.url === 'string' && server.url !== '' && !hubs.includes(server.url)) hubs.push(server.url);

  const cwdReal = bestEffortReal(cwd);
  const foldersKey = declaration.workFolders?.settingsKey ?? 'trusted_folders';
  let work: string | null = null;
  for (const folder of unknownList(settings[foldersKey])) {
    if (typeof folder === 'string' && bestEffortReal(folder) === cwdReal) {
      work = cwdReal;
      break;
    }
  }
  const siblingPattern = declaration.workFolders?.siblingsOfHome;
  if (work === null && siblingPattern && path.dirname(cwdReal) === path.dirname(homeReal)) {
    try {
      if (new RegExp(siblingPattern).test(path.basename(cwdReal))) work = cwdReal;
    } catch {
      // Malformed regex stays untrusted.
    }
  }

  const skillsCanonPath = path.join(homeReal, 'skills');
  const skillsLexicalPath = path.join(homeRaw, 'skills');
  let skills = path.resolve(skillsCanonPath);
  let skillsRaw = skills;
  let skillsRootValid = false;
  try {
    const stat = fs.lstatSync(skillsCanonPath);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      const realSkills = fs.realpathSync.native(skillsCanonPath);
      if (realSkills === skillsCanonPath) {
        skills = realSkills;
        skillsRaw = realSkills;
        if (skillsLexicalPath !== realSkills) {
          const lexStat = fs.lstatSync(skillsLexicalPath);
          if (lexStat.isDirectory() && !lexStat.isSymbolicLink() && fs.realpathSync.native(skillsLexicalPath) === realSkills) {
            skillsRaw = skillsLexicalPath;
          }
        }
        skillsRootValid = true;
      }
    }
  } catch {
    skillsRootValid = false;
  }

  const tokenPlaceholder = hubCfg.tokenPlaceholder ?? '%HUB_TOKEN%';
  const allowedPlaceholders = asList(hubCfg.allowedPlaceholders).filter((p) => typeof p === 'string' && /^%[A-Z][A-Z0-9_]*%$/.test(p));
  if (!allowedPlaceholders.length) allowedPlaceholders.push(tokenPlaceholder);

  return {
    home: homeReal,
    homeRaw,
    settings,
    declaration,
    declarationError,
    hubs,
    hub: hubs[0] ?? '',
    cwd: cwdReal,
    work,
    skills,
    skillsRaw,
    skillsRootValid,
    allowedFile: path.join(homeReal, 'hooks', 'ALLOWED.md'),
    urlPlaceholder: `%${urlVar}%`,
    tokenPlaceholder,
    allowedPlaceholders,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Single command tokenizer: enforces ONE grammar across docs, ALLOWED.md, and runtime guard.
// Allowed on line 1: ASCII space/tab separators, bare `[A-Za-z0-9_./:%=@,+-]+`, single-quoted `'[^'\r\n]*'`, and optional trailing
// single-quoted heredoc `<<'EOF'`. Rejected: double quotes, backslash escapes/continuations, unquoted non-ASCII/spaces, `\r`,
// Unicode whitespace, shell chaining/redirection/expansion/glob metacharacters, or concatenated quotes (`'a'b`).

const META_WORDS = new Map<string, string>([
  [';', '“;”（连接多条命令）'],
  ['&', '“&”（后台或连接命令）'],
  ['|', '“|”（管道）'],
  ['`', '反引号（命令替换）'],
  ['$', '“$”（变量或命令替换）'],
  ['<', '“<”（重定向）'],
  ['>', '“>”（重定向）'],
  ['(', '“(”（子 shell）'],
  [')', '“)”（子 shell）'],
  ['{', '“{”（花括号展开）'],
  ['}', '“}”（花括号展开）'],
  ['*', '“*”（通配符）'],
  ['?', '“?”（通配符）'],
  ['[', '“[”（通配符）'],
  [']', '“]”（通配符）'],
]);

const BARE_TOKEN_CHAR = /^[A-Za-z0-9_./:%=@,+-]$/;

/** Parses a CLI execute command under the unified single-quote grammar. */
export function parseCommand(command: string): ParsedCommand {
  const out: ParsedCommand = { words: [], heredoc: null, lines: 1, problem: null };
  const text = String(command);
  const fail = (message: string) => {
    out.problem ??= message;
  };

  let header = text;
  if (text.includes('\n')) {
    const rawLines = text.split('\n');
    out.lines = text.endsWith('\n') ? rawLines.length - 1 : rawLines.length;
    if (rawLines.at(-1) === '') rawLines.pop();
    const firstLine = rawLines.shift() ?? '';
    const tail = rawLines;
    // Check explicit here-doc head: `<cmd> <space/tab> <<'DELIM'<optional space/tab>`.
    const unquotedDelim = /^(.*?)[ \t]+<<([A-Za-z_][A-Za-z0-9_.%-]*)[ \t]*$/.exec(firstLine);
    const quotedDelim = /^(.*?)[ \t]+<<'([A-Za-z_][A-Za-z0-9_]*)'[ \t]*$/.exec(firstLine);
    const badPlaceholderDelim = /^(.*?)[ \t]+<<(%[A-Za-z0-9_]+%)[ \t]*$/.exec(firstLine);
    const badHeredoc = /(?:^|[ \t])<<<?/.exec(firstLine);
    if (quotedDelim) {
      header = quotedDelim[1];
      const delimiter = quotedDelim[2];
      const closeIndex = tail.indexOf(delimiter);
      if (closeIndex < 0) {
        out.heredoc = { delimiter, body: tail, closed: false };
      } else {
        const after = tail.slice(closeIndex + 1).join('\n');
        out.heredoc = {
          delimiter,
          body: tail.slice(0, closeIndex),
          closed: true,
          ...(after.length ? { after } : {}),
        };
      }
    } else if (badPlaceholderDelim) {
      header = badPlaceholderDelim[1];
      fail(`here-doc 的结束标记写成了 ${badPlaceholderDelim[2]}，结束标记要写成 <<'EOF'`);
    } else if (unquotedDelim) {
      header = unquotedDelim[1];
      fail(`here-doc 结束标记必须加英文单引号写成 <<'${unquotedDelim[2]}'`);
    } else if (badHeredoc) {
      header = firstLine;
      fail('多行命令只认结尾的 `<<\'EOF\'` 令牌 here-doc，不支持 `<<<` 或未带单引号的标记');
    } else {
      header = firstLine;
      fail('命令有多行，而多行只有“结尾接 `<<\'EOF\'` 的令牌 here-doc”这一种写法');
    }
  } else {
    const trailingDelim = /^(.*?)[ \t]+<<(?:'([A-Za-z_][A-Za-z0-9_]*)'|(\S+))[ \t]*$/.exec(text);
    if (text.includes('<<<')) {
      fail('命令里有“<<<”（here-string）；令牌要用 `<<\'EOF\'` here-doc 给');
    } else if (trailingDelim) {
      header = trailingDelim[1];
      out.heredoc = { delimiter: trailingDelim[2] ?? trailingDelim[3] ?? 'EOF', body: [], closed: false };
    }
  }

  let i = 0;
  while (i < header.length) {
    while (i < header.length && (header[i] === ' ' || header[i] === '\t')) i++;
    if (i >= header.length) break;
    const ch = header[i];
    if (ch === '\r') {
      fail('命令行含回车符 `\\r`，只允许单行空格或制表符分隔');
      break;
    }
    if (/\s/.test(ch)) {
      fail('命令只认 ASCII 空格或制表符分隔参数，不认全角/不换行空白字符');
      i++;
      continue;
    }
    if (ch === "'") {
      const end = header.indexOf("'", i + 1);
      if (end < 0) {
        fail('英文单引号没有配对');
        break;
      }
      const piece = header.slice(i + 1, end);
      if (/[\r\n]/.test(piece)) fail('单引号里不能有换行');
      out.words.push(piece);
      i = end + 1;
      if (i < header.length && header[i] !== ' ' && header[i] !== '\t') {
        fail('单引号结束后面必须接空格或换行，不许紧连引号内外文字');
        while (i < header.length && header[i] !== ' ' && header[i] !== '\t') i++;
      }
      continue;
    }
    if (ch === '"') {
      fail('不支持英文双引号 `"`，含空格或中文的值请统一改用英文单引号 `\'…\'`');
      const end = header.indexOf('"', i + 1);
      if (end < 0) break;
      out.words.push(header.slice(i + 1, end));
      i = end + 1;
      while (i < header.length && header[i] !== ' ' && header[i] !== '\t') i++;
      continue;
    }
    if (ch === '\\') {
      fail('不支持反斜杠转义或续行，含空格的值请改用英文单引号 `\'…\'`');
      i += header[i + 1] ? 2 : 1;
      continue;
    }
    if (META_WORDS.has(ch)) {
      fail(`命令里有 ${META_WORDS.get(ch)}`);
      i++;
      continue;
    }
    if (ch === '#' || ch === '~') {
      fail(ch === '#' ? '命令里有注释符 `#`' : '命令里有 `~`（家目录展开）');
      i++;
      continue;
    }
    // Scan bare word cleanly so we give exact feedback if unquoted non-ASCII or embedded quotes appear.
    let word = '';
    let badBare = false;
    while (i < header.length && header[i] !== ' ' && header[i] !== '\t') {
      const c = header[i];
      if (c === '\r' || /\s/.test(c)) {
        fail('命令只认 ASCII 空格或制表符分隔参数');
        break;
      }
      if (c === "'" || c === '"') {
        fail(c === '"' ? '不支持英文双引号 `"`，请改用英文单引号 `\'…\'`' : '单引号必须包住整段参数且与前后空格隔开');
        badBare = true;
        break;
      }
      if (c === '\\') {
        fail('不支持反斜杠转义');
        badBare = true;
        i++;
        continue;
      }
      if (META_WORDS.has(c)) {
        fail(`命令里有 ${META_WORDS.get(c)}`);
        badBare = true;
        i++;
        continue;
      }
      if (!BARE_TOKEN_CHAR.test(c)) {
        fail('含空格、中文或特殊字符的脚本路径与参数值必须用英文单引号 `\'…\'` 包住');
        badBare = true;
      }
      word += c;
      i++;
    }
    if (word !== '' || !badBare) out.words.push(word);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Local tool discovery: reads options, required flags, booleans, multiple flags, and stdin mode directly from each tool's source & docs.

const PAIR = /(\[)?--([a-z][a-z0-9-]*)(?:\s+(?:'([^'\r\n]*)'|"([^"\r\n]*)"|(<[^>]*>[^\s\]]*|%[A-Za-z_]+%|[^\s\]<'">][^\s\]]*)))?(\])?/g;

function usageOf(line: string, base: string, subcommands?: string[]): { positional: string | null; pairs: Array<{ name: string; placeholder: string | null; optional: boolean }> } | null {
  const clean = line.replace(/`/g, '');
  const match = new RegExp(`(?:^|[\\s:：'"])(?:node\\s+)?['"]?(?:<[^>]*>/)?(?:tools/)?${escapeRe(base)}['"]?(?=\\s|$)(.*)$`).exec(clean);
  if (!match) return null;
  const rest = match[1];
  const pairs: Array<{ name: string; placeholder: string | null; optional: boolean }> = [];
  for (const m of rest.matchAll(PAIR)) {
    const placeholder = m[3] ?? m[4] ?? m[5] ?? null;
    pairs.push({ name: m[2], placeholder, optional: m[1] === '[' });
  }
  let positional: string | null = null;
  if (subcommands) {
    const first = rest.trim().split(/\s+/)[0];
    if (first && !first.startsWith('-') && !first.startsWith('<') && !first.startsWith('[')) positional = first;
  }
  if (!pairs.length && !positional) return null;
  return { positional, pairs };
}

function typeOfOption(env: GuardEnvironment, name: string, placeholder: string | null): 'hub' | 'run' | 'int' | 'text' | 'path' {
  const declared = env.declaration.optionTypes?.[name];
  if (declared) return declared;
  for (const rule of asList(env.declaration.placeholderTypes)) {
    if (placeholder && new RegExp(rule.match, 'i').test(placeholder)) return rule.type;
  }
  return 'path';
}

function isInternalHelperModule(source: string): boolean {
  // Helper libraries under tools/ export symbols without a CLI entrypoint (`process.argv` / `import.meta.main`).
  return /\bexport\b/.test(source) && !/(?:process\.argv|import\.meta\.main)/.test(source);
}

function describeTool(env: GuardEnvironment, base: { id: string; file: string; skill: string | null; docText: string; subcommands?: string[]; subcommandStdin?: Record<string, string[]> }): DiscoveredTool {
  const source = readText(base.file);
  const name = path.basename(base.file);
  const header = source.split('\n').slice(0, 40).filter((line) => line.startsWith('//')).map((line) => line.replace(/^\/\/\s?/, ''));
  const usages = [...base.docText.split('\n'), ...header]
    .map((line) => usageOf(line, name, base.subcommands))
    .filter((u): u is NonNullable<typeof u> => u !== null);

  const meta = new Map<string, { required: boolean; kind: 'string' | 'boolean'; multiple: boolean }>();
  const ensure = (optName: string, defaults: { required: boolean; kind?: 'string' | 'boolean'; multiple?: boolean }) => {
    const existing = meta.get(optName);
    if (!existing) meta.set(optName, { required: defaults.required, kind: defaults.kind ?? 'string', multiple: defaults.multiple ?? false });
    else {
      if (defaults.required) existing.required = true;
      if (defaults.kind) existing.kind = defaults.kind;
      if (defaults.multiple) existing.multiple = true;
    }
  };

  // 1. argumentsOf(argv, ['hub', 'run', ...])
  const argMatch = /argumentsOf\(\s*argv\s*,\s*\[([^\]]*)\]/.exec(source);
  if (argMatch) {
    for (const m of argMatch[1].matchAll(/['"]([a-z][a-z0-9-]*)['"]/g)) ensure(m[1], { required: true });
  }

  // 2. const OPTIONS [: Record<string, boolean>] = { ... } (supports single-quoted keys like `'task-file': true`)
  const optTable = /(?:const|let)\s+OPTIONS(?:\s*:[^=]+)?\s*=\s*\{([^}]*)\}/.exec(source);
  if (optTable) {
    for (const m of optTable[1].matchAll(/['"]?([a-z][a-z0-9-]*)['"]?\s*:\s*(true|false)/g)) {
      ensure(m[1], { required: m[2] === 'true' });
    }
  }

  // 3. node:util parseArgs({ ..., options: { ... } })
  const parseMatch = /parseArgs\(\s*\{[\s\S]*?\boptions\s*:\s*\{([\s\S]*?)\}\s*\}/.exec(source);
  if (parseMatch) {
    for (const m of parseMatch[1].matchAll(/['"]?([a-z][a-z0-9-]*)['"]?\s*:\s*\{([^}]*)\}/g)) {
      const attrs = m[2];
      const kind = /type\s*:\s*['"]boolean['"]/.test(attrs) ? 'boolean' : 'string';
      const multiple = /multiple\s*:\s*true/.test(attrs);
      ensure(m[1], { required: false, kind, multiple });
    }
  }

  // 4. Explicit usage lines
  const declared = meta.size > 0;
  for (const usage of usages) {
    for (const pair of usage.pairs) {
      if (!meta.has(pair.name)) ensure(pair.name, { required: !pair.optional && !declared && !base.subcommands });
    }
  }

  const placeholders = new Map<string, string>();
  for (const usage of usages) {
    for (const pair of usage.pairs) {
      if (pair.placeholder && !placeholders.has(pair.name)) placeholders.set(pair.name, pair.placeholder);
    }
  }

  const options: ToolOption[] = [...meta.entries()].map(([optionName, info]) => {
    const placeholder = placeholders.get(optionName) ?? null;
    return {
      name: optionName,
      required: info.required,
      kind: info.kind,
      multiple: info.multiple,
      placeholder,
      type: typeOfOption(env, optionName, placeholder),
    };
  });

  const order = [...new Set(usages.flatMap((usage) => usage.pairs.map((pair) => pair.name)))];
  options.sort((a, b) => {
    const x = order.indexOf(a.name);
    const y = order.indexOf(b.name);
    return (x < 0 ? 99 : x) - (y < 0 ? 99 : y);
  });

  const tokenReads = source.match(/\b(?:tokenFromStdin|readTokenFromStdin)\b/g) ?? [];
  const keyReads = source.match(/\breadKeys\b/g) ?? [];
  const stdinMode: 'none' | 'single' | 'keys' =
    keyReads.length >= 2 || /await\s+readKeys\(/.test(source)
      ? 'keys'
      : tokenReads.length >= 2 || /=\s*(?:tokenFromStdin|readTokenFromStdin)\b/.test(source)
        ? 'single'
        : 'none';

  return {
    id: base.id,
    file: base.file,
    skill: base.skill,
    subcommands: base.subcommands ?? null,
    subcommandStdin: base.subcommandStdin ?? null,
    options,
    restricted: declared || usages.length > 0 || base.subcommands !== undefined,
    stdinMode,
    forms: usages.map((usage) => ({ positional: usage.positional, pairs: usage.pairs })),
  };
}

/** Discovers executable local tools inside installed skills (plus declared scripts / optional workdir local-tools), rejecting symlinked files. */
export function discoverTools(env: GuardEnvironment): DiscoveredTool[] {
  const tools: DiscoveredTool[] = [];
  const add = (tool: DiscoveredTool) => {
    if (!tools.some((known) => known.file === tool.file)) tools.push(tool);
  };
  const trySafeFile = (lexical: string, rootReal: string, rootLexical: string): string | null => {
    try {
      const stat = fs.lstatSync(lexical);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      const real = fs.realpathSync.native(lexical);
      if (!inside(real, rootReal)) return null;
      if (path.relative(rootReal, real) !== path.relative(rootLexical, lexical)) return null;
      return real;
    } catch {
      return null;
    }
  };

  if (env.skillsRootValid) {
    const skillNames = listNames(env.skills, (name) => fs.existsSync(path.join(env.skills, name, 'SKILL.md')));
    for (const skill of skillNames) {
      const dir = path.join(env.skills, skill);
      const docText = [
        path.join(dir, 'SKILL.md'),
        ...listNames(path.join(dir, 'tools'), (name) => name.endsWith('.md')).map((name) => path.join(dir, 'tools', name)),
      ]
        .map(readText)
        .join('\n');

      const walkToolsDir = (subDir: string, relPrefix: string) => {
        for (const entry of listNames(subDir, () => true)) {
          const full = path.join(subDir, entry);
          const rel = `${relPrefix}/${entry}`;
          let stat: fs.Stats;
          try {
            stat = fs.lstatSync(full);
          } catch {
            continue;
          }
          if (stat.isSymbolicLink()) continue;
          if (stat.isDirectory()) {
            // Preserve nested <subpath>/tools/*.ts support (e.g. deep/nested/tools/t.ts), avoiding test/node_modules or sub-skills.
            if (entry !== 'node_modules' && entry !== 'lib' && !fs.existsSync(path.join(full, 'SKILL.md'))) {
              walkToolsDir(full, rel);
            }
            continue;
          }
          if (!stat.isFile() || !entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
          if (path.basename(subDir) !== 'tools') continue;
          const real = trySafeFile(full, env.skills, env.skillsRaw);
          if (!real) continue;
          const source = readText(real);
          if (isInternalHelperModule(source)) continue;
          add(describeTool(env, { id: `${skill}/${rel}`, file: real, skill, docText }));
        }
      };

      const topEntries = listNames(dir, () => true);
      for (const entry of topEntries) {
        const full = path.join(dir, entry);
        let stat: fs.Stats;
        try {
          stat = fs.lstatSync(full);
        } catch {
          continue;
        }
        if (stat.isSymbolicLink() || !stat.isDirectory() || entry === 'node_modules') continue;
        if (entry === 'tools') walkToolsDir(full, 'tools');
        else walkToolsDir(full, entry);
      }

      for (const script of asList(env.declaration.scripts)) {
        if (!script.path.startsWith(`${skill}/`)) continue;
        const lexical = path.join(env.skills, script.path);
        const real = trySafeFile(lexical, env.skills, env.skillsRaw);
        if (real) {
          add(
            describeTool(env, {
              id: script.path,
              file: real,
              skill,
              docText,
              subcommands: script.subcommands,
              subcommandStdin: script.subcommandStdin,
            }),
          );
        }
      }
    }
  }

  if (env.work && env.declaration.allowLocalTools) {
    const root = path.join(env.work, 'local-tools');
    for (const pack of listNames(root, () => true)) {
      for (const file of listNames(path.join(root, pack, 'tools'), (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))) {
        const lexical = path.join(root, pack, 'tools', file);
        const real = trySafeFile(lexical, env.work, env.work);
        if (!real) continue;
        const source = readText(real);
        if (isInternalHelperModule(source)) continue;
        add(describeTool(env, { id: `local-tools/${pack}/tools/${file}`, file: real, skill: null, docText: '' }));
      }
    }
  }

  return tools;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Writing canonical commands using the single unified quoting rule (`'...'` single quotes for values/paths with spaces/non-ASCII).

/** Formats a single command word using bare safe ASCII or single quotes `'...'` (never double quotes or backslashes). */
export const quote = (value: string): string => {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  const cleaned = value.replace(/[\r\n\0']/g, '');
  return `'${cleaned}'`;
};

export function scriptLabel(env: GuardEnvironment, tool: DiscoveredTool): string {
  if (tool.skill) return `<技能目录>/${path.relative(path.join(env.skills, tool.skill), tool.file)}`;
  return env.work ? path.relative(env.work, tool.file) : tool.file;
}

export function writeCommand(
  env: GuardEnvironment,
  tool: DiscoveredTool,
  opts: { subcommand?: string; values?: Record<string, string | string[]>; booleans?: Set<string>; all?: boolean; label?: boolean } = {},
): string {
  const { subcommand, values = {}, booleans = new Set<string>(), all = false, label = false } = opts;
  const parts = ['node', quote(label ? scriptLabel(env, tool) : tool.file)];
  if (subcommand) parts.push(subcommand);
  const form = subcommand ? tool.forms.find((candidate) => candidate.positional === subcommand) : null;
  const baseListed: Array<ToolOption & { required: boolean }> = form
    ? form.pairs
        .map((pair) => {
          const base = tool.options.find((option) => option.name === pair.name);
          return base ? { ...base, required: !pair.optional } : null;
        })
        .filter((o): o is NonNullable<typeof o> => o !== null)
    : tool.options;
  const seenListed = new Set(baseListed.map((o) => o.name));
  const listed = [
    ...baseListed,
    ...tool.options.filter((o) => !seenListed.has(o.name) && (o.name in values || booleans.has(o.name))),
  ];

  for (const option of listed) {
    if (option.kind === 'boolean') {
      if (booleans.has(option.name)) parts.push(`--${option.name}`);
      else if (all) parts.push(`[--${option.name}]`);
      continue;
    }
    const given = option.name in values;
    if (!all && !given && !option.required) continue;
    if (given && Array.isArray(values[option.name])) {
      for (const entry of values[option.name] as string[]) parts.push(`--${option.name} ${quote(entry)}`);
      continue;
    }
    const rawVal = given
      ? quote(values[option.name] as string)
      : option.type === 'hub'
        ? env.urlPlaceholder
        : option.placeholder
          ? quote(option.placeholder)
          : quote('<值>');
    parts.push(!given && !option.required ? `[--${option.name} ${rawVal}]` : `--${option.name} ${rawVal}`);
  }
  let line = parts.join(' ');
  const expectedLines =
    subcommand && tool.subcommandStdin?.[subcommand]
      ? tool.subcommandStdin[subcommand]
      : tool.stdinMode === 'single'
        ? [env.tokenPlaceholder]
        : tool.stdinMode === 'keys'
          ? env.allowedPlaceholders
          : null;
  if (expectedLines?.length) line += ` <<'EOF'\n${expectedLines.join('\n')}\nEOF`;
  return line;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Refusal formatting & path/glob verification (fusing skillsGuard + ops-allow security boundaries).

const refuse = (env: GuardEnvironment, what: string, how: string): HookDecision => ({
  decision: 'deny',
  reason: [what, how, `规则全文：${env.allowedFile}（用 read_file 读）`].filter(Boolean).join('\n'),
});

const allowed = (env: GuardEnvironment): HookDecision =>
  env.declaration.allowReply === 'explicit' ? { decision: 'allow', reason: '本目录允许的工具' } : {};

const resolvedTarget = (env: GuardEnvironment, value: string, cwd = env.work ?? env.cwd): string =>
  canonical(path.isAbsolute(value) ? value : path.join(cwd, value));

function checkOptionValue(env: GuardEnvironment, option: ToolOption, value: string): string | null {
  switch (option.type) {
    case 'hub':
      if (value === env.urlPlaceholder || env.hubs.includes(value)) return null;
      return `--${option.name} 后面是 ${JSON.stringify(clip(value, 80))}，这个配置里 Hub 的地址是 ${env.hub || '（设置文件里没有）'}，要写 ${env.urlPlaceholder}`;
    case 'run': {
      const parts = value.split(',');
      if (parts.length && parts.every((part) => /^run_[a-z0-9]+$/.test(part))) return null;
      return `--${option.name} 后面是 ${JSON.stringify(clip(value))}，要写运行编号（形如 run_…）`;
    }
    case 'int':
      return /^[1-9][0-9]{0,5}$/.test(value) ? null : `--${option.name} 后面是 ${JSON.stringify(clip(value))}，要写正整数`;
    case 'text':
      if (env.allowedPlaceholders.some((p) => value.includes(p)) || value.includes(env.tokenPlaceholder)) {
        return `令牌不能写在 --${option.name} 的值里`;
      }
      if (value === '' || /[\0\r\n]/.test(value)) return `--${option.name} 的值是空的或含换行`;
      return null;
    default: {
      if (env.allowedPlaceholders.some((p) => value.includes(p)) || value.includes(env.tokenPlaceholder)) {
        return `令牌 ${env.tokenPlaceholder} 只能放在 here-doc 里，不能写在 --${option.name} 的值里`;
      }
      if (value === '' || /[\0\r\n]/.test(value)) return `--${option.name} 的值是空的或含换行`;
      const pieces = option.name.startsWith('prior-') ? value.split(',').filter((p) => p !== '' && p !== '-') : [value];
      for (const piece of pieces) {
        if (!env.work || !inside(resolvedTarget(env, piece), env.work)) {
          return `--${option.name} 的路径 ${JSON.stringify(clip(piece, 90))} 不在工作目录 ${env.work} 里`;
        }
      }
      return null;
    }
  }
}

function tokenProblem(env: GuardEnvironment, tool: DiscoveredTool, subcommand: string | null, heredoc: ParsedCommand['heredoc']): string | null {
  const expectedLines =
    subcommand && tool.subcommandStdin?.[subcommand]
      ? tool.subcommandStdin[subcommand]
      : tool.stdinMode === 'single'
        ? [env.tokenPlaceholder]
        : null;
  const requiresStdin = expectedLines !== null || tool.stdinMode === 'keys';

  if (!heredoc) {
    return tool.restricted && requiresStdin ? '这个脚本从标准输入读令牌，命令后面少了令牌的 here-doc' : null;
  }
  if (tool.restricted && !requiresStdin) {
    return '这个脚本不读标准输入，命令后面不要写 here-doc';
  }
  if (heredoc.delimiter === env.tokenPlaceholder || env.allowedPlaceholders.includes(heredoc.delimiter)) {
    return `here-doc 的结束标记写成了 ${heredoc.delimiter}，令牌行被当成结束行，令牌是空的；结束标记写 EOF`;
  }
  if (!heredoc.closed) return `here-doc 没有结束行 ${heredoc.delimiter}`;
  if (heredoc.after && heredoc.after.trim() !== '') return `here-doc 的结束行 ${heredoc.delimiter} 之后还有内容：${JSON.stringify(clip(heredoc.after, 30))}`;
  if (!heredoc.body.length) return `here-doc 里缺少令牌占位符（例如 ${env.tokenPlaceholder}）`;
  for (const row of heredoc.body) {
    if (!/^%[A-Z][A-Z0-9_]*%$/.test(row) || !env.allowedPlaceholders.includes(row)) {
      return `here-doc 每一行只能写允许的客户端占位符（${env.allowedPlaceholders.join(' / ')}）`;
    }
  }
  if (expectedLines) {
    if (heredoc.body.length !== expectedLines.length || expectedLines.some((exp, idx) => heredoc.body[idx] !== exp)) {
      return `here-doc 必须依次写 ${expectedLines.length} 行占位符：${expectedLines.join('、')}`;
    }
  }
  return null;
}

function shellHint(env: GuardEnvironment, words: string[], command: string): string | null {
  const alternatives = env.declaration.shellAlternatives ?? {};
  const virtual = asList(env.declaration.files?.virtualReadOnly).map((pattern) => new RegExp(pattern));
  const seen = (command.match(/\/(?:large_tool_results|background_jobs)\/[A-Za-z0-9._/-]+/g) ?? []).find((candidate) =>
    virtual.some((re) => re.test(candidate)),
  );
  if (seen) return `这次可以这样做：读 ${seen} 用 read_file（路径照写），在里面找内容用 grep，不用 shell。`;
  const first = words[0] ?? '';
  const alt = alternatives[path.basename(first)];
  if (alt) return `这次可以这样做：${path.basename(first)} 的事用 ${alt} 做（路径写相对工作目录）；execute 只运行已装脚本。`;
  return null;
}

/** Narrow glob subset safe under Circle glob (follow:false): no '..', braces, brackets, extglobs, escapes, or escapes-of-dots. */
export function safeGlob(value: unknown): boolean {
  if (typeof value !== 'string' || !value.length || /[^A-Za-z0-9_.*\/-]/.test(value)) return false;
  return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..' && (!segment.includes('**') || segment === '**'));
}

function globWithin(base: string, pattern: string, root: string): void {
  const segments = pattern.split('/');
  const stack: Array<{ directory: string; index: number }> = [{ directory: base, index: 0 }];
  const seen = new Set<string>();
  const caseInsensitive = process.platform === 'darwin' || process.platform === 'win32';
  const matchers = segments.map(
    (segment) =>
      new RegExp(
        '^' +
          [...segment].map((char) => (char === '*' ? '[^/]*' : char === '.' ? '\\.' : char)).join('') +
          '$',
        caseInsensitive ? 'i' : '',
      ),
  );
  const inspect = (file: string): fs.Stats | null => {
    try {
      return fs.lstatSync(file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw new GuardRefusal('glob 缺少可核验的路径元数据；请核对工作目录的读取权限后重试');
    }
  };
  const noLink = (file: string): never => {
    throw new GuardRefusal(`glob 模式经过软链接段 ${JSON.stringify(path.relative(root, file))}；请改用工作目录内的真实目录或不经过该链接的模式后重试`);
  };

  while (stack.length) {
    const current = stack.pop()!;
    const key = `${current.directory}\0${current.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (seen.size > 10000) throw new GuardRefusal('glob 的目录核对超过上限，尚不能证明全部路径在工作目录内；请缩小真实目录前缀后重试');
    const info = inspect(current.directory);
    if (!info) continue;
    if (info.isSymbolicLink()) noLink(current.directory);
    if (!info.isDirectory()) continue;
    if (!inside(canonical(current.directory), root)) throw new GuardRefusal('glob 的真实目录已越过工作目录；请恢复目录并改用工作目录内的真实路径后重试');
    const segment = segments[current.index];
    const last = current.index === segments.length - 1;
    if (segment === '**' && !last) stack.push({ directory: current.directory, index: current.index + 1 });
    let names: string[];
    try {
      names = segment.includes('*') ? fs.readdirSync(current.directory) : [segment];
    } catch {
      throw new GuardRefusal('glob 缺少可核验的目录列表；请核对工作目录的读取权限或缩小真实目录前缀后重试');
    }
    for (const name of names) {
      if (!matchers[current.index].test(name)) continue;
      const file = path.join(current.directory, name);
      const entry = inspect(file);
      if (!entry) continue;
      if (entry.isSymbolicLink()) {
        if (segment === '**' && current.index === 0 && !last) continue;
        noLink(file);
      }
      if (!inside(canonical(file), root)) throw new GuardRefusal('glob 的匹配真实路径已越过工作目录；请恢复目录并改用工作目录内的真实路径后重试');
      if (entry.isDirectory() && (segment === '**' || !last)) {
        stack.push({ directory: file, index: segment === '**' ? current.index : current.index + 1 });
      }
    }
  }
}

function globMatches(file: string, pattern: string, cwd: string): boolean {
  const normalize = (value: string) => {
    const normalized = path.normalize(value).replaceAll('\\', '/');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  const absolute = canonical(path.resolve(cwd, file));
  let glob = pattern.trim().replaceAll('\\', '/');
  let target: string;
  if (path.isAbsolute(glob)) {
    const star = glob.search(/[*?]/);
    const slash = star < 0 ? -1 : glob.lastIndexOf('/', star);
    glob = star < 0 ? canonical(glob) : slash >= 0 ? path.join(canonical(glob.slice(0, slash) || path.parse(glob).root), glob.slice(slash + 1)) : glob;
    target = normalize(absolute);
  } else {
    const root = canonical(cwd);
    if (!inside(absolute, root)) return false;
    target = normalize(path.relative(root, absolute));
  }
  glob = normalize(glob);
  let expression = '^';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        expression += '(?:.*/)?';
        i += 2;
      } else {
        expression += '.*';
        i++;
      }
    } else if (char === '*') expression += '[^/]*';
    else if (char === '?') expression += '[^/]';
    else expression += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${expression}$`).test(target);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Delegated per-skill hooks (<skill>/hooks.json before_tool) with strict fail-closed bounds.

function skillDirectoryOf(script: string, skillsRoot: string): string {
  let dir = path.dirname(script);
  while (dir !== skillsRoot) {
    if (existsLstat(path.join(dir, 'SKILL.md'))) return dir;
    const parent = path.dirname(dir);
    if (parent === skillsRoot || parent === dir) return dir;
    dir = parent;
  }
  return skillsRoot;
}

function hookMatches(hook: Record<string, unknown>, input: Record<string, unknown>): boolean {
  const matcher = hook.tools ?? hook.matcher;
  if (matcher !== undefined && matcher !== '' && matcher !== '*') {
    const parts = Array.isArray(matcher) ? matcher : typeof matcher === 'string' ? matcher.split(/[|,]/) : [];
    const names = parts.map((p) => String(p).trim()).filter((p) => p && p !== '*');
    if (names.length && !names.includes(String(input.tool_name))) return false;
  }
  const patterns = hook.paths === undefined ? [] : Array.isArray(hook.paths) ? hook.paths : [hook.paths];
  const globs = patterns.filter((part): part is string => typeof part === 'string').map((p) => p.trim()).filter(Boolean);
  return (
    !globs.length ||
    (Array.isArray(input.paths) &&
      input.paths.some((file) => typeof file === 'string' && globs.some((glob) => globMatches(file, glob, String(input.cwd)))))
  );
}

async function runDelegatedHook(hook: Record<string, unknown>, raw: string, cwd: string): Promise<{ decision: 'allow' | 'ask' | 'deny'; reason: string }> {
  const setting = typeof hook.timeout_ms === 'number' && Number.isFinite(hook.timeout_ms) ? hook.timeout_ms : 30000;
  const timeout = Math.max(100, Math.min(600000, Math.floor(setting)));
  return new Promise((done) => {
    const child = spawn(hook.command as string, {
      cwd,
      shell: true,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let failureReason: string | null = null;
    let settled = false;
    let force: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => {});
      else {
        try {
          process.kill(-child.pid, signal);
        } catch {
          try {
            child.kill(signal);
          } catch {
            // Already exited.
          }
        }
      }
    };
    const stop = (reason: string) => {
      if (failureReason !== null) return;
      failureReason = reason;
      kill('SIGTERM');
      force = setTimeout(() => kill('SIGKILL'), 500);
    };
    const interrupted = () => {
      failureReason = '技能钩子被宿主停止，缺少完整决定；请重新发起调用';
      kill('SIGKILL');
    };
    process.once('SIGTERM', interrupted);
    process.once('SIGINT', interrupted);
    const timer = setTimeout(() => stop('技能钩子超过配置时限，缺少完整决定；请修复耗时并运行 verify 核对安装后重试'), timeout);
    const finish = (decision: { decision: 'allow' | 'ask' | 'deny'; reason: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (force) clearTimeout(force);
      process.removeListener('SIGTERM', interrupted);
      process.removeListener('SIGINT', interrupted);
      done(decision);
    };
    child.stdout.on('data', (chunk) => {
      if (failureReason !== null) return;
      stdout += chunk.toString('utf8');
      if (stdout.length > 100000) stop('技能钩子输出超过上限，缺少完整 JSON；请修复输出并运行 verify 后重试');
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.stdin.end(raw);
    child.once('error', () => finish({ decision: 'deny', reason: '技能钩子启动失败；请核对工作目录和安装并运行 verify 后重试' }));
    child.once('close', (code) => {
      if (failureReason !== null) {
        finish({ decision: 'deny', reason: failureReason });
        return;
      }
      if (code !== 0) {
        finish({ decision: 'deny', reason: `技能钩子退出码 ${code ?? '未知'}，缺少允许决定；请修正参数或钩子安装并运行 verify 后重试` });
        return;
      }
      try {
        const reply: unknown = JSON.parse(stdout.trim());
        if (!isRecord(reply)) throw new Error('not an object');
        const word = typeof reply.decision === 'string' ? reply.decision.trim() : '';
        const decision: 'allow' | 'ask' | 'deny' = word === 'deny' || word === 'ask' ? word : 'allow';
        const reason =
          (typeof reply.reason === 'string' ? reply.reason.trim() : typeof reply.context === 'string' ? reply.context.trim() : '') ||
          (decision === 'ask'
            ? '需要确认；请核对本次工具调用后明确允许或拒绝'
            : decision === 'deny'
              ? '拒绝本次调用；请按技能约束修正参数后重试'
              : '允许本次调用');
        finish({ decision, reason });
      } catch {
        finish({ decision: 'deny', reason: '技能钩子未输出 JSON 对象；请修复脚本输出并运行 verify 后重试' });
      }
    });
  });
}

async function runDelegatedSkillHooks(
  env: GuardEnvironment,
  script: string,
  input: Record<string, unknown>,
  raw: string,
): Promise<HookDecision> {
  if (!inside(script, env.skills)) return allowed(env);
  const skill = skillDirectoryOf(script, env.skills);
  const file = path.join(skill, 'hooks.json');
  const who = `技能 ${JSON.stringify(path.relative(env.skills, skill) || '.')}`;
  const recover = '请重新安装技能，并运行 local-tools verify --digest 或 pack-files.ts --verify-install 后重试';
  let present: boolean;
  try {
    present = existsLstat(file);
  } catch {
    throw new GuardRefusal(`${who} 的 hooks.json 元数据不可读；${recover}`);
  }
  if (!present) return allowed(env);
  let real: string;
  try {
    real = canonical(file);
  } catch {
    throw new GuardRefusal(`${who} 的 hooks.json 路径无法核验；${recover}`);
  }
  if (!inside(real, skill)) throw new GuardRefusal(`${who} 的 hooks.json 指向技能目录之外；${recover}`);
  let contents: string;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch {
    throw new GuardRefusal(`${who} 的 hooks.json 不可读；${recover}`);
  }
  let declaration: unknown;
  try {
    declaration = JSON.parse(contents);
  } catch {
    throw new GuardRefusal(`${who} 的 hooks.json JSON 语法无效；${recover}`);
  }
  if (
    !isRecord(declaration) ||
    (declaration.version !== undefined && declaration.version !== 1) ||
    (declaration.hooks !== undefined && !isRecord(declaration.hooks))
  ) {
    throw new GuardRefusal(`${who} 的 hooks.json 对象或版本不受支持；${recover}`);
  }
  const entries = isRecord(declaration.hooks) ? declaration.hooks.before_tool ?? [] : [];
  if (
    !Array.isArray(entries) ||
    entries.length > 100 ||
    entries.some(
      (hook) =>
        !isRecord(hook) ||
        typeof hook.command !== 'string' ||
        !hook.command.trim() ||
        hook.command.length > 4000 ||
        hook.command.includes('\0'),
    )
  ) {
    throw new GuardRefusal(`${who} 的 hooks.json.before_tool 缺少可执行的命令列表或超过上限；${recover}`);
  }

  let strictest: { decision: 'allow' | 'ask' | 'deny'; reason: string } = { decision: 'allow', reason: '' };
  let matched = false;
  for (const [index, hook] of (entries as Record<string, unknown>[]).entries()) {
    const named = typeof hook.name === 'string' && hook.name.trim() ? hook.name.trim() : `before_tool[${index + 1}]`;
    const identity = `${who} / 钩子 ${JSON.stringify(named.length > 80 ? `${named.slice(0, 80)}…` : named)}（第 ${index + 1} 项）`;
    let selected: boolean;
    try {
      selected = hookMatches(hook, input);
    } catch (error) {
      throw new GuardRefusal(`${identity} 的匹配检查未完成；${error instanceof GuardRefusal ? error.message : recover}`);
    }
    if (!selected) continue;
    const outcome = await runDelegatedHook(hook, raw, String(input.cwd));
    outcome.reason = `${identity}：${outcome.reason}`;
    if (!matched || (outcome.decision === 'deny' && strictest.decision !== 'deny') || (outcome.decision === 'ask' && strictest.decision === 'allow')) {
      strictest = outcome;
    } else if (outcome.decision === strictest.decision && outcome.decision !== 'allow') {
      strictest = { ...strictest, reason: `${strictest.reason}；${outcome.reason}` };
    }
    matched = true;
  }
  if (!matched || strictest.decision === 'allow') return allowed(env);
  if (strictest.decision === 'ask') return { decision: 'ask', reason: strictest.reason };
  return refuse(env, `不允许：${strictest.reason}`, `这次可以这样做：${recover}`);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Core decision tree for execute, files, skill, and declarative rules.

const ALLOWED_EXECUTE_KEYS = new Set(['command', 'background', 'timeout', 'description']);

function notTrusted(env: GuardEnvironment): HookDecision {
  return refuse(
    env,
    `不允许：这次会话的工作目录 ${env.cwd} 不在这个配置信任的文件夹里（settings.json 的 trusted_folders），守卫不知道该放行哪个目录。`,
    '这次可以这样做：请使用者把这个文件夹加入信任，或在已信任的工作目录里开会话。',
  );
}

function scriptCandidates(tools: DiscoveredTool[], word: string): DiscoveredTool[] {
  const parts = word.split('/').filter((part) => part !== '' && part !== '.' && part !== '..');
  for (let n = Math.min(3, parts.length); n >= 1; n--) {
    const suffix = parts.slice(-n).join('/');
    const hits = tools.filter((tool) => tool.id === suffix || tool.id.endsWith(`/${suffix}`) || tool.file.endsWith(`/${suffix}`));
    if (hits.length) return hits;
  }
  return [];
}

type ExecuteValidation =
  | { ok: true; physicalScript?: string }
  | { ok: false; what: string; how: string };

function installedToolsAdvice(
  env: GuardEnvironment,
  tools: DiscoveredTool[],
  opts: { preferred?: DiscoveredTool[]; prefix?: string } = {},
): string {
  const list = opts.preferred?.length ? opts.preferred : tools;
  if (!list.length) {
    return `这次可以这样做：当前没有已装并声明的可执行脚本（仅放行 skills 目录内已声明工具），规则全文见 ${env.allowedFile}（用 read_file 读）。`;
  }
  const shown = list.slice(0, 8).map((tool) => tool.id);
  const more = list.length > 8 ? ` 等共 ${list.length} 个` : '';
  return `这次可以这样做：${opts.prefix ?? '已装的可执行脚本有 '}${shown.join('、')}${more}；完整路径与写法见规则全文（${env.allowedFile}）。`;
}

function validateExecuteCommand(
  env: GuardEnvironment,
  tools: DiscoveredTool[],
  command: string,
  allowSuggestion: boolean,
): ExecuteValidation {
  const d = env.declaration;
  const parsed = parseCommand(command);

  if (!parsed.words.length) {
    const why = parsed.problem ?? '命令是空的';
    return {
      ok: false,
      what: `不允许：这个目录只放行技能目录里的脚本；${why}。`,
      how: shellHint(env, parsed.words, command) ?? installedToolsAdvice(env, tools),
    };
  }

  const [first, second] = parsed.words;
  const simple = asList(d.commands).find((entry) => entry.name === first);
  if (simple) {
    const value = parsed.words[1];
    const max = simple.max ?? 600;
    const bad =
      parsed.problem ??
      (parsed.words.length !== 2 || !/^[1-9][0-9]{0,3}$/.test(value ?? '') || Number(value) > max
        ? `${first} 只接受一个 1 到 ${max} 的整数`
        : null) ??
      (parsed.heredoc ? '这条命令不读标准输入' : null);
    if (!bad) return { ok: true };
    const safeValue = Math.max(1, Math.min(/^[1-9][0-9]{0,3}$/.test(value ?? '') ? Number(value) : 30, max));
    const candidate = `${first} ${safeValue}`;
    const how =
      allowSuggestion && validateExecuteCommand(env, tools, candidate, false).ok
        ? `这次可以这样写：${candidate}`
        : `这次可以这样做：请写 ${first} 加 1 到 ${max} 的整数后重试。`;
    return {
      ok: false,
      what: `不允许：${bad}${simple.note ? `（${simple.note}）` : ''}。`,
      how,
    };
  }

  if (!asList(d.interpreters).includes(first)) {
    const prefix = parsed.problem ? `这个目录只放行技能目录里的脚本（${parsed.problem}）；` : '这个目录只放行技能目录里的脚本；';
    return {
      ok: false,
      what: `不允许：${prefix}execute 只运行“node 加已装脚本”${asList(d.commands).length ? `（或 ${asList(d.commands).map((c) => c.name).join('、')}）` : ''}，看到的是 ${JSON.stringify(clip(command.replace(/\s+/g, ' '), 70))}。`,
      how: shellHint(env, parsed.words, command) ?? installedToolsAdvice(env, tools),
    };
  }

  if (second === undefined || second.startsWith('-')) {
    return {
      ok: false,
      what: `不允许：这个目录只放行技能目录里的脚本；node 后面要直接写已装脚本的绝对路径，看到的是 ${JSON.stringify(second ?? '（空）')}。`,
      how: /^(-e|-p|--eval|--print|--input-type.*)$/.test(second ?? '')
        ? '这次可以这样做：不能用 node 运行自己写的代码；读文件用 read_file，找内容用 grep，要写文件用 write_file。'
        : installedToolsAdvice(env, tools),
    };
  }

  const problems: string[] = parsed.problem ? [parsed.problem] : [];

  // Strict lexical & canonical containment for script path (rejects relative paths, '..', '%', non-.ts, symlinks, and APFS case mismatches).
  if (!path.isAbsolute(second) || second.split(/[\\/]/).includes('..') || second.includes('%') || !second.endsWith('.ts')) {
    const hits = scriptCandidates(tools, second);
    let how = installedToolsAdvice(env, tools, hits.length ? { preferred: hits, prefix: '可能是这些已装脚本：' } : undefined);
    if (allowSuggestion && hits.length === 1) {
      const rebuilt =
        ['node', quote(hits[0].file), ...parsed.words.slice(2).map(quote)].join(' ') +
        (parsed.heredoc?.closed ? ` <<'EOF'\n${parsed.heredoc.body.join('\n')}\nEOF` : '');
      const check = validateExecuteCommand(env, tools, rebuilt, true);
      if (check.ok) how = `这次可以这样写：${rebuilt}`;
      else if (check.how.startsWith('这次可以这样写：')) how = check.how;
    }
    return {
      ok: false,
      what: `不允许：这个目录只放行技能目录里的脚本；脚本路径 ${JSON.stringify(clip(second, 90))} 必须是已装技能脚本的真实绝对路径（不写相对路径、.. 或非 .ts）。`,
      how,
    };
  }

  const lexicalScript = path.resolve(second);
  let physicalScript: string;
  try {
    physicalScript = fs.realpathSync.native(lexicalScript);
  } catch {
    return {
      ok: false,
      what: `不允许：缺少已安装技能脚本的实际路径 ${JSON.stringify(clip(second, 90))}。`,
      how: '这次可以这样做：请集成者安装并运行 local-tools verify --digest 或 pack-files.ts --verify-install 后按真实路径重试。',
    };
  }

  const exactUnderRoot = (canonRoot: string): boolean => {
    if (!inside(physicalScript, canonRoot)) return false;
    const rel = path.relative(canonRoot, physicalScript);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
    if (!lexicalScript.endsWith(path.sep + rel)) return false;
    const lexicalRoot = lexicalScript.slice(0, -(rel.length + 1));
    if (lexicalRoot !== canonRoot) {
      try {
        if (fs.lstatSync(lexicalRoot).isSymbolicLink() || fs.lstatSync(path.dirname(lexicalRoot)).isSymbolicLink()) return false;
        if (fs.realpathSync.native(lexicalRoot) !== canonRoot) return false;
      } catch {
        return false;
      }
    }
    return true;
  };

  const inSkills = exactUnderRoot(env.skills);
  const inLocalTools = Boolean(d.allowLocalTools) && env.work !== null && exactUnderRoot(path.join(env.work, 'local-tools'));

  if (!inSkills && !inLocalTools) {
    return {
      ok: false,
      what: `不允许：这个目录只放行技能目录里的脚本；脚本 ${JSON.stringify(clip(second, 90))} 指向已装技能目录之外或经过了软链接/别名。`,
      how: installedToolsAdvice(env, tools),
    };
  }

  const tool = tools.find((candidate) => candidate.file === physicalScript);
  if (!tool) {
    const sameDir = tools.filter((candidate) => path.dirname(candidate.file) === path.dirname(physicalScript));
    return {
      ok: false,
      what: `不允许：这个目录只放行技能目录里的脚本；脚本 ${JSON.stringify(clip(second, 90))} 不是已声明的可执行工具（或仅是内部辅助库）。`,
      how: installedToolsAdvice(env, tools, { preferred: sameDir.length ? sameDir : tools }),
    };
  }

  const values: Record<string, string | string[]> = {};
  const booleans = new Set<string>();
  let rest = parsed.words.slice(2);
  let subcommand: string | null = null;
  if (tool.subcommands) {
    subcommand = rest[0] ?? null;
    if (!subcommand || !tool.subcommands.includes(subcommand)) {
      problems.push(`子命令 ${JSON.stringify(clip(subcommand ?? '（空）'))} 不在放行的 ${tool.subcommands.join('、')} 里`);
    }
    rest = rest.slice(1);
  }

  const form = subcommand ? tool.forms.find((candidate) => candidate.positional === subcommand) : null;
  const activeOptions = form
    ? form.pairs
        .map((pair) => {
          const base = tool.options.find((option) => option.name === pair.name);
          return base ? { ...base, required: !pair.optional } : null;
        })
        .filter((o): o is NonNullable<typeof o> => o !== null)
    : tool.options;
  const optionsOf = new Map(tool.options.map((option) => [option.name, option]));
  const seen = new Set<string>();

  for (let i = 0; i < rest.length; ) {
    const word = rest[i];
    if (!word.startsWith('--') || word === '--') {
      problems.push(`多出一个 ${JSON.stringify(clip(word))}（选项要写成 --名字 值）`);
      i++;
      continue;
    }
    const eq = word.indexOf('=');
    let name: string;
    let value: string | undefined;
    let equals = false;
    let option: ToolOption | null;

    if (eq > 2) {
      name = word.slice(2, eq);
      value = word.slice(eq + 1);
      equals = true;
      option = optionsOf.get(name) ?? (tool.restricted ? null : { name, kind: 'string', multiple: false, type: 'path', placeholder: null, required: false });
      i++;
    } else {
      name = word.slice(2);
      option = optionsOf.get(name) ?? (tool.restricted ? null : { name, kind: 'string', multiple: false, type: 'path', placeholder: null, required: false });
      if (option?.kind === 'boolean') {
        if (rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')) {
          problems.push(`--${name} 是开关选项，后面不要跟值 ${JSON.stringify(clip(rest[i + 1]))}`);
          i += 2;
        } else {
          i++;
        }
        if (seen.has(name) && !option.multiple) problems.push(`--${name} 写了两次`);
        else {
          seen.add(name);
          booleans.add(name);
        }
        continue;
      }
      if (rest[i + 1] === undefined || rest[i + 1].startsWith('--')) {
        if (!tool.restricted) {
          seen.add(name);
          booleans.add(name);
          i++;
          continue;
        }
        value = undefined;
        i++;
      } else {
        value = rest[i + 1];
        i += 2;
      }
    }

    if (!option) {
      problems.push(`这个脚本没有 --${name} 选项（它的选项：${tool.options.map((o) => `--${o.name}`).join(' ') || '无'}）`);
      continue;
    }
    if (seen.has(name) && !option.multiple) {
      problems.push(`--${name} 写了两次`);
      continue;
    }
    seen.add(name);
    if (equals && d.equalsForm !== 'accept') {
      problems.push(`--${name}=… 这个脚本只认“--${name} 值”（选项和值之间空格），不认“=”`);
    }
    if (value === undefined) {
      problems.push(`--${name} 后面没有值`);
      continue;
    }
    const bad = checkOptionValue(env, option, value);
    if (bad) {
      problems.push(bad);
      if (option.type !== 'hub') continue;
    }
    const recorded = option.type === 'hub' ? env.urlPlaceholder : value;
    if (option.multiple) {
      const arr = Array.isArray(values[name]) ? (values[name] as string[]) : [];
      arr.push(recorded);
      values[name] = arr;
    } else {
      values[name] = recorded;
    }
  }

  for (const req of activeOptions) {
    if (req.required && !seen.has(req.name)) problems.push(`缺少必填选项 --${req.name}`);
  }

  const tokenBad = tokenProblem(env, tool, subcommand, parsed.heredoc);
  if (tokenBad) problems.push(tokenBad);

  if (!problems.length) {
    return { ok: true, physicalScript };
  }

  const fixed: Record<string, string | string[]> = {};
  for (const option of tool.options) if (option.name in values) fixed[option.name] = values[option.name];
  const fallbackSub = subcommand && tool.subcommands?.includes(subcommand) ? subcommand : undefined;
  const fallbackForm = fallbackSub ? tool.forms.find((candidate) => candidate.positional === fallbackSub) : null;
  const fallbackRequired = fallbackForm
    ? fallbackForm.pairs
        .map((pair) => {
          const base = tool.options.find((option) => option.name === pair.name);
          return base ? { ...base, required: !pair.optional } : null;
        })
        .filter((o): o is NonNullable<typeof o> => o !== null && o.required)
    : tool.options.filter((o) => o.required);
  const allRequiredProvided =
    (!tool.subcommands || fallbackSub !== undefined) &&
    fallbackRequired.every((req) => req.name in fixed || booleans.has(req.name));

  let how = `这次可以这样做：请按规则全文（${env.allowedFile}）中 ${tool.id}${tool.subcommands ? `（可用子命令：${tool.subcommands.join('、')}）` : ''} 的完整写法补齐必填参数并修正值后重试。`;
  if (allowSuggestion && allRequiredProvided) {
    const candidate = writeCommand(env, tool, { subcommand: fallbackSub, values: fixed, booleans });
    if (validateExecuteCommand(env, tools, candidate, false).ok) {
      how = `这次可以这样写：${candidate}`;
    }
  }
  const prefix = parsed.problem && problems.includes(parsed.problem) ? '这个目录只放行技能目录里的脚本；' : '';
  return {
    ok: false,
    what: `不允许：${prefix}${problems.slice(0, 2).join('；')}${problems.length > 2 ? `（另有 ${problems.length - 2} 处）` : ''}。`,
    how,
  };
}

async function executeDecision(env: GuardEnvironment, input: Record<string, unknown>, raw: string): Promise<HookDecision> {
  if (env.work === null) return notTrusted(env);
  const args = input.tool_input as Record<string, unknown>;
  if (
    Object.keys(args).some((key) => !ALLOWED_EXECUTE_KEYS.has(key)) ||
    (args.background !== undefined && typeof args.background !== 'boolean') ||
    (args.timeout !== undefined && (typeof args.timeout !== 'number' || !Number.isFinite(args.timeout))) ||
    (args.description !== undefined && typeof args.description !== 'string')
  ) {
    return refuse(env, '不允许：execute 参数形状无效；请只用 command、background 和 timeout 的正确类型重新调用。', '这次可以这样做：只传入合规的 command、background 和 timeout 字段后重试。');
  }
  if (typeof args.command !== 'string') {
    return refuse(env, '不允许：execute 缺少 command 文字；请补齐字符串命令后重试。', '这次可以这样做：提供完整的单行 node 脚本命令后重试。');
  }
  if (!env.skillsRootValid) {
    return refuse(
      env,
      `不允许：skills 目录根 ${env.skillsRaw} 已改变（是软链接）或缺失。`,
      '这次可以这样做：请集成者恢复专用主目录的真实 skills 目录并核对安装后重试。',
    );
  }

  const tools = discoverTools(env);
  const verdict = validateExecuteCommand(env, tools, args.command, true);
  if (!verdict.ok) {
    return refuse(env, verdict.what, verdict.how);
  }
  return verdict.physicalScript
    ? runDelegatedSkillHooks(env, verdict.physicalScript, input, raw)
    : allowed(env);
}

function filesDecision(env: GuardEnvironment, input: Record<string, unknown>): HookDecision {
  if (env.work === null) return notTrusted(env);
  const tool = String(input.tool_name);
  const args = input.tool_input as Record<string, unknown>;
  const d = env.declaration;
  const isWrite = asList(d.files?.write).includes(tool);

  const rootKind = isWrite ? d.files?.writeRoots ?? ['work'] : d.files?.readRoots ?? ['work', 'skills'];
  const roots: string[] = [];
  if (rootKind.includes('work') && env.work) roots.push(env.work);
  if (rootKind.includes('skills') && env.skillsRootValid) roots.push(env.skills);

  const where = isWrite || !rootKind.includes('skills') ? '工作目录' : '工作目录或已装技能目录';
  const how = isWrite
    ? `这次可以这样做：路径写相对工作目录的位置，只能写工作目录 ${env.work} 里面的文件。`
    : `这次可以这样做：请改用工作目录 ${env.work} 内的相对路径（当前目录写 .${rootKind.includes('skills') ? `；已装技能目录 ${env.skills} 仅只读` : ''}）。`;

  const virtual = asList(d.files?.virtualReadOnly).map((pattern) => new RegExp(pattern));
  const virtualTools = asList(d.files?.virtualReadOnlyTools);
  const readable = asList(d.files?.readableFiles).map((rel) => bestEffortReal(path.join(env.home, rel)));

  const matchRoot = (target: string): string | null => roots.find((r) => inside(target, r)) ?? null;
  const isVirtual = (p: string): boolean => virtualTools.includes(tool) && virtual.some((re) => re.test(p));

  const paths: string[] = [];
  if (Array.isArray(input.paths)) {
    for (const p of input.paths) {
      if (typeof p !== 'string' || !p.length) {
        return refuse(env, `不允许：${tool} 含空路径或非文字路径。`, `${how} 补齐后重试。`);
      }
      paths.push(p);
    }
  }
  const argPaths: string[] = [];
  for (const key of ['file_path', 'filePath', 'path']) {
    if (key in args && args[key] !== undefined) {
      if (typeof args[key] !== 'string' || !args[key]) {
        return refuse(env, `不允许：${tool} 的 ${key} 必须是有效路径文字。`, `${how} 补齐后重试。`);
      }
      argPaths.push(args[key] as string);
    }
  }

  // Validate glob/grep patterns strictly before walking directories.
  let globRelPattern: string | null = null;
  let globAbsPrefix: string | null = null;
  if (tool === 'glob') {
    const rawPattern = typeof args.pattern === 'string' ? args.pattern : '';
    const star = rawPattern.search(/[*?[{]/);
    if (path.isAbsolute(rawPattern)) {
      const prefix = star < 0 ? rawPattern : rawPattern.slice(0, rawPattern.lastIndexOf('/', star) + 1) || '/';
      const tail = star < 0 ? path.basename(rawPattern) : rawPattern.slice(rawPattern.lastIndexOf('/', star) + 1);
      const canonPrefix = canonical(prefix);
      const owningRoot = matchRoot(canonPrefix);
      if (!owningRoot || (tail !== '' && !safeGlob(tail))) {
        return refuse(
          env,
          `不允许：glob 的 pattern ${JSON.stringify(clip(rawPattern, 80))} 不符合工作目录相对安全文法（或越出${where}）。`,
          '这次可以这样做：改用 / 分隔的非空相对段，每段只含英文字母、数字、_、-、.、*，** 须独占一段；不用绝对根外路径、..、括号类、花括号、extglob 或转义，请拆成多次简单查询后重试。',
        );
      }
      globAbsPrefix = canonPrefix;
      globRelPattern = tail || '*';
    } else {
      if (!safeGlob(rawPattern)) {
        return refuse(
          env,
          `不允许：glob 的 pattern ${JSON.stringify(clip(rawPattern, 80))} 不符合本主目录的安全文法。`,
          '这次可以这样做：改用 / 分隔的非空相对段，每段只含英文字母、数字、_、-、.、*，** 须独占一段；不许 .、..、括号类、花括号、extglob 或转义，请拆成多次简单查询后重试。',
        );
      }
      globRelPattern = rawPattern;
    }
  }
  if (tool === 'grep' && args.glob !== undefined && !safeGlob(args.glob)) {
    return refuse(
      env,
      `不允许：grep 的 glob ${JSON.stringify(clip(args.glob, 80))} 不符合安全文法。`,
      '这次可以这样做：只用 / 分隔的非空相对段（含字母、数字、_、-、.、*，不用 .. 或扩展文法）后重试。',
    );
  }

  const allTargets = [...new Set([...paths, ...argPaths])];
  if (!allTargets.length && globAbsPrefix === null && !(tool === 'glob' && globRelPattern !== null && paths.length === 0 && argPaths.length === 0 && env.work)) {
    return refuse(env, `不允许：${tool} 缺少路径，没有检查目标。`, `这次可以这样做：请填写工作目录内的 path 或 file_path 后重试（当前目录写 .）。`);
  }
  if (!allTargets.length && globAbsPrefix === null && tool === 'glob' && globRelPattern !== null) {
    // `glob { pattern: 'records/*.json' }` with omitted `path` and empty `paths` defaults to `env.work`.
    globWithin(env.work, globRelPattern, env.work);
    return allowed(env);
  }

  for (const p of allTargets) {
    if (isVirtual(p)) continue;
    const target = resolvedTarget(env, p, String(input.cwd));
    if (!isWrite && readable.includes(target)) continue;
    const owningRoot = matchRoot(target);
    if (!owningRoot) {
      return refuse(env, `不允许：${tool} 的路径 ${JSON.stringify(clip(p, 100))} 不在${where}里。`, how);
    }
    if (tool === 'glob' && globRelPattern !== null) {
      globWithin(globAbsPrefix ?? target, globRelPattern, globAbsPrefix ? matchRoot(globAbsPrefix) ?? owningRoot : owningRoot);
    }
  }
  if (tool === 'glob' && globRelPattern !== null && !allTargets.length && globAbsPrefix !== null) {
    const owningRoot = matchRoot(globAbsPrefix)!;
    globWithin(globAbsPrefix, globRelPattern, owningRoot);
  }
  return allowed(env);
}

function ruleMatches(rule: GuardRule, tool: string, args: Record<string, unknown>): boolean {
  if (rule.tool !== tool) return false;
  let parameters: unknown = args.parameters ?? {};
  if (typeof parameters === 'string') {
    try {
      parameters = JSON.parse(parameters);
    } catch {
      parameters = {};
    }
  }
  const scope: Record<string, unknown> = { ...args, parameters };
  for (const test of asList(rule.match)) {
    let rawVal: unknown = test.path.split('.').reduce<unknown>((node, key) => (isRecord(node) ? node[key] : undefined), scope);
    let value = String(rawVal ?? '').trim();
    if (test.equalsBefore) value = value.split(test.equalsBefore)[0].trim();
    if (test.normalize === 'lower') value = value.toLowerCase();
    if (Array.isArray(test.in)) {
      const candidates = test.in.map((v) => (test.normalize === 'lower' ? String(v).toLowerCase() : String(v)));
      if (!candidates.includes(value)) return false;
    } else if (test.value !== undefined) {
      const expected = test.normalize === 'lower' ? String(test.value).toLowerCase() : String(test.value);
      if (value !== expected) return false;
    }
  }
  return true;
}

/** Default Circle SQLite subagent check: returns true only when `sessions.parent_id` is non-empty for `id`. */
export async function defaultIsSubagent(home: string, id: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(id)) return false;
  const origWarn = process.emitWarning;
  process.emitWarning = () => {};
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(home, 'circle.sqlite'), { readOnly: true });
    try {
      const row = db.prepare('select parent_id from sessions where id = ?').get(id) as { parent_id?: unknown } | undefined;
      return typeof row?.parent_id === 'string' && row.parent_id !== '';
    } finally {
      db.close();
    }
  } catch {
    return false;
  } finally {
    process.emitWarning = origWarn;
  }
}

/** Evaluates one Circle `before_tool` stdin payload against the loaded environment & declaration. */
export async function decideRaw(
  env: GuardEnvironment,
  raw: string,
  opts: { isSubagent?: (id: string) => Promise<boolean> } = {},
): Promise<HookDecision> {
  if (env.declarationError) {
    return refuse(
      env,
      `不允许：守卫的声明文件读不了（${clip(env.declarationError, 80)}）。`,
      '这次可以这样做：告诉主代理修好声明文件；修好以前所有调用都会被拒。',
    );
  }
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return refuse(env, '不允许：守卫读不懂 Circle 交来的调用信息（不是合法 JSON）。', '这次可以这样做：请宿主用完整的 before_tool JSON 对象重新发起调用。');
  }
  if (!isRecord(input) || input.event !== 'before_tool' || typeof input.tool_name !== 'string' || !isRecord(input.tool_input)) {
    return refuse(env, '不允许：调用信息缺少 before_tool、tool_name 或 tool_input 对象。', '这次可以这样做：请宿主补齐完整字段后重试。');
  }
  if (input.paths !== undefined && (!Array.isArray(input.paths) || input.paths.some((file) => typeof file !== 'string'))) {
    return refuse(env, '不允许：工具 paths 不是文字路径列表。', '这次可以这样做：请用工作目录内的完整路径重新发起调用。');
  }
  if (typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd)) {
    return refuse(env, '不允许：调用缺少绝对工作目录 cwd。', '这次可以这样做：请在已信任的专用工作目录重新发起调用。');
  }

  const tool = input.tool_name;
  const args = input.tool_input as Record<string, unknown>;
  const session = typeof input.session_id === 'string' ? input.session_id : '';
  const isSubagent = opts.isSubagent ?? ((id: string) => defaultIsSubagent(env.home, id));

  try {
    const d = env.declaration;
    for (const rule of asList(d.rules)) {
      if (!ruleMatches(rule, tool, args)) continue;
      if (rule.session === 'subagent' && !(await isSubagent(session))) continue;
      return refuse(env, rule.what, rule.how);
    }

    const everyAllowed = new Set(Object.values(d.allow ?? {}).flat());
    if (everyAllowed.has(tool)) return allowed(env);

    if (asList(d.files?.read).includes(tool) || asList(d.files?.write).includes(tool)) {
      return filesDecision(env, input);
    }

    if (tool === (d.skillTool ?? 'skill')) {
      const name = typeof args.name === 'string' ? args.name : '';
      const installed = env.skillsRootValid
        ? listNames(env.skills, (entry) => existsLstat(path.join(env.skills, entry, 'SKILL.md')))
        : [];
      if (d.skillRequiresInstalled === false && name === '') return allowed(env);
      return name !== '' && installed.includes(name)
        ? allowed(env)
        : refuse(
            env,
            `不允许：skill ${JSON.stringify(clip(name || '（空）'))} 不是已装技能。`,
            `这次可以这样做：已装技能有 ${installed.join('、') || '（没有）'}。`,
          );
    }

    if (tool === (d.executeTool ?? 'execute')) {
      return await executeDecision(env, input, raw);
    }

    for (const [prefix, why] of Object.entries(d.denyPrefix ?? {})) {
      if (tool.startsWith(prefix)) {
        return refuse(
          env,
          `不允许：${tool}。${why}。`,
          '这次可以这样做：要查资料或操作设备，用 hub_list_task_packs 列出可用的工作流，再用 Hub 的工具。',
        );
      }
    }

    return refuse(
      env,
      `不允许：${tool || '这个工具'} 不在这个配置放行的工具里。`,
      '这次可以这样做：放行的工具见规则全文；要查资料或操作设备，先用 hub_list_task_packs。',
    );
  } catch (error) {
    if (error instanceof GuardRefusal) {
      return refuse(env, `不允许：${error.message}`, '这次可以这样做：按上述核对要求修正路径或安装状态后重试。');
    }
    return refuse(
      env,
      `不允许：守卫自己出错了（${error instanceof Error ? error.message : String(error)}）。`,
      '这次可以这样做：告诉主代理检查守卫配置与安装后重试。',
    );
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// ALLOWED.md generator + schema generator: uses the identical declaration and single-quote rule.

/** Renders ALLOWED.md from the declaration and discovered installed tools. */
export function renderAllowed(env: GuardEnvironment, genCommand = 'node hooks/guard-gen.mjs'): string {
  const d = env.declaration;
  const tools = discoverTools(env);
  const readList = asList(d.files?.read);
  const writeList = asList(d.files?.write);
  const installed = env.skillsRootValid ? listNames(env.skills, (entry) => existsLstat(path.join(env.skills, entry, 'SKILL.md'))) : [];

  const lines: string[] = [
    '# 这个 Circle 配置放行什么',
    '',
    `这份文件由 \`${genCommand}\` 生成，不要手改；要改规则，改对应的 declaration.json 后重新生成。守卫每次直接读 declaration.json 和已装脚本本身。`,
    '',
    '## 工具',
    '',
  ];
  for (const [label, names] of Object.entries(d.allow ?? {})) lines.push(`- ${label}：${names.join('、')}`);
  const fileNotes = [`${readList.join('、')} 可读工作目录${d.files?.readRoots?.includes('skills') !== false ? '和已装技能目录（技能目录只读）' : ''}`];
  if (writeList.length) fileNotes.push(`${writeList.join('、')} 只写工作目录`);
  else fileNotes.push('本目录禁止写文件');
  lines.push(`- 文件：${fileNotes.join('；')}。路径优先写相对工作目录的位置。`);
  lines.push(`- ${d.skillTool ?? 'skill'}：加载已装技能（现有：${installed.join('、') || '没有'}）。`);
  lines.push(`- ${d.executeTool ?? 'execute'}：只运行已装技能目录下的签名 CLI 脚本${asList(d.commands).length ? `和 ${asList(d.commands).map((c) => c.name).join('、')}` : ''}，见下一节。`);
  for (const [prefix, why] of Object.entries(d.denyPrefix ?? {})) lines.push(`- ${prefix}* 不放行：${why}。`);

  lines.push('', '## 本地脚本怎么写', '');
  lines.push(`一条命令一行，形式：\`node '<技能目录>/tools/<脚本>.ts' --选项 值 …\`。`, '');
  lines.push(`- 引号与路径写法（唯一规则）：只含英文数字与 \`_./:%=@,+-\` 的路径或值可不加引号；**只要含空格（如路径中的 \`Application Support\`）、中文或 \`<\`/\`>\` 等字符，统一用英文单引号 \`'…'\` 包住**。不用英文双引号 \`"\`，不写反斜杠转义（\`\\ \`）或续行（\`\\\`），不写紧连引号 \`'a'b\`。`);
  lines.push(`- \`--hub\` 的值写 \`${env.urlPlaceholder}\`（客户端会展开成这个配置的 Hub 地址），写成配置里的 Hub 地址本身也行，别的主机不行。`);
  lines.push('- 选项写成 `--名字 值`，中间空格；不用 `--名字=值`（脚本和守卫都不认）。');
  lines.push('- 路径类的值必须在工作目录里。');
  lines.push(
    '- 需要令牌或密钥的脚本，占位符从标准输入给，命令末尾在同一行写 `<<\'EOF\'`，下一行起只写允许的占位符（如 `' + env.tokenPlaceholder + '`），最后一行只写 `EOF`：',
    '',
    '```sh',
    `<命令> <<'EOF'`,
    env.tokenPlaceholder,
    'EOF',
    '```',
    '',
  );
  lines.push('- 不放行：`;` `&` `|` 反引号 `$` `"` `\\` 重定向 通配符 `~` `#`、多条合并成一行、别的主机、工作目录以外路径、软链接逃逸、内部辅助库或未声明脚本。', '');

  lines.push('### 已装脚本和标准写法', '');
  const example = tools.find((tool) => tool.skill && !tool.subcommands);
  lines.push(
    `表里的 \`<技能目录>\` 指第一列技能的目录，即 \`${env.skills}/<技能名>\`。例如 ${example?.id ?? 'case-compile/tools/download-run.ts'}，完整路径需用单引号写为 \`'${example?.file ?? `${env.skills}/case-compile/tools/download-run.ts`}'\`。`,
    '',
  );
  lines.push('| 脚本 | 标准写法（可照抄，把 `<…>` 换成实际值） |', '| --- | --- |');
  for (const tool of tools) {
    if (tool.subcommands) {
      for (const sub of tool.subcommands) {
        lines.push(`| ${tool.id} ${sub} | \`${writeCommand(env, tool, { subcommand: sub, all: true, label: true }).replace(/\n/g, ' ⏎ ')}\` |`);
      }
    } else {
      lines.push(
        `| ${tool.id} | \`${writeCommand(env, tool, { all: true, label: true }).replace(/\n/g, ' ⏎ ')}\`${tool.restricted ? '' : '（选项没有声明，按通用规则检查）'} |`,
      );
    }
  }
  lines.push('', '其中 `⏎` 表示换行；需要标准输入令牌的脚本，命令后紧接上面三行；方括号里的选项可省略。', '');
  for (const command of asList(d.commands)) {
    lines.push(`- \`${command.name} <秒数>\`（最多 ${command.max ?? 600}）：${command.note ?? ''}`);
  }
  if (asList(d.rules).length) {
    lines.push('', '## 例外与拦截规则', '');
    for (const rule of asList(d.rules)) {
      lines.push(`- ${rule.what.replace(/^不允许：/, '')} → ${rule.how ? rule.how.replace(/^这次可以这样做：/, '') : ''}`);
    }
  }
  lines.push('', '## 拒绝的话怎么读', '');
  lines.push('每次拒绝固定三行：哪里不行（看到的是什么）；这次可以怎样改写（能算出时直接给完整单引号命令）；规则全文路径。', '');
  return `${lines.join('\n')}\n`;
}

/** Builds JSON schemas describing installed single-form tools (for `--schemas`). */
export function buildToolSchemas(env: GuardEnvironment): unknown[] {
  return discoverTools(env)
    .filter((tool) => !tool.subcommands)
    .map((tool) => {
      const properties: Record<string, unknown> = {};
      for (const option of tool.options) {
        if (option.type === 'hub') continue;
        if (option.kind === 'boolean') properties[option.name] = { type: 'boolean' };
        else if (option.type === 'run') properties[option.name] = { type: 'string', pattern: '^run_[a-z0-9]+(,run_[a-z0-9]+)*$' };
        else if (option.type === 'int') properties[option.name] = { type: 'integer', minimum: 1 };
        else if (option.type === 'text') properties[option.name] = { type: 'string' };
        else properties[option.name] = { type: 'string', description: '工作目录里的路径' };
      }
      return {
        name: `${tool.skill ?? 'local'}__${path.basename(tool.file, '.ts')}`,
        description: `运行 ${tool.id}${tool.stdinMode !== 'none' ? '；令牌由客户端从保存的凭据给脚本，模型不写' : ''}`,
        inputSchema: {
          type: 'object',
          properties,
          required: tool.options.filter((o) => o.required && o.type !== 'hub').map((o) => o.name),
          additionalProperties: false,
        },
      };
    });
}
