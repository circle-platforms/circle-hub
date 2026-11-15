// Read-only preflight: replay allow/deny cases through the installed Circle home hook.
// Does not read credential values, does not change the home, and does not contact the Hub.
//   node scripts/real/guard-preflight.ts --home <dir>
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, lstatSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { discoverTools, environment, quote, writeCommand, type DiscoveredTool, type GuardEnvironment } from './guard-lib.ts';
import { extractTaughtCommands, instantiateTaughtCommand } from './taught-commands.ts';

export type Verdict = 'allow' | 'deny' | 'ask' | 'error';
/** How a case counts toward the exit code: checked allow/deny vs declaration-only listing. */
export type CaseKind = 'check' | 'declaration-limit';

export interface CaseResult {
  name: string;
  kind: CaseKind;
  want: Verdict;
  got: Verdict;
  ok: boolean;
  reason?: string;
}

export interface PreflightReport {
  home: string;
  workdir: string;
  entry: string;
  profile: 'skills' | 'ops';
  results: CaseResult[];
  mismatches: CaseResult[];
  declarationLimits: CaseResult[];
  allowCount: number;
  denyCount: number;
  ok: boolean;
}

export interface InstalledGuard {
  home: string;
  workdir: string;
  entry: string;
  profile: 'skills' | 'ops';
  declarationName: string;
}

function readJson(path: string): unknown {
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('预检元数据必须是普通文件');
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Resolves the installed before_tool entry and trusted work folder of a skills/ops home. */
export function resolveInstalledGuard(homeRaw: string): InstalledGuard {
  const home = resolve(homeRaw);
  const hooksJsonPath = join(home, 'hooks.json');
  if (!existsSync(hooksJsonPath)) throw new Error(`主目录没有 hooks.json：${home}`);
  const hooksJson = readJson(hooksJsonPath) as { hooks?: { before_tool?: Array<{ command?: string }> } };
  const command = hooksJson.hooks?.before_tool?.[0]?.command;
  if (typeof command !== 'string' || command === '') throw new Error('hooks.json 里没有 before_tool 命令');
  const match = /^node\s+(?:'([^']+)'|"([^"]+)"|(\S+))\s*$/.exec(command.trim());
  if (!match) throw new Error('hooks.json 的 before_tool 命令不是 node <入口>');
  const entry = resolve(home, match[1] ?? match[2] ?? match[3]!);
  if (lstatSync(home).isSymbolicLink() || lstatSync(join(home, 'hooks')).isSymbolicLink() || lstatSync(entry).isSymbolicLink() || !lstatSync(entry).isFile() || join(home, 'hooks', basename(entry)) !== entry) throw new Error('守卫入口必须是主目录 hooks 内的普通文件');
  if (!existsSync(entry)) throw new Error(`钩子入口不存在：${basename(entry)}`);
  const entryName = basename(entry);
  let profile: 'skills' | 'ops';
  let declarationName: string;
  if (entryName === 'ops-allow.mjs') {
    profile = 'ops';
    declarationName = 'ops-allow.declaration.json';
  } else if (entryName === 'skills-only.mjs') {
    profile = 'skills';
    declarationName = 'guard.declaration.json';
  } else {
    throw new Error(`不是 skills/ops 统一守卫入口（见到 ${entryName}）；核对只支持 skills-only.mjs / ops-allow.mjs`);
  }
  const settings = readJson(join(home, 'settings.json')) as { trusted_folders?: unknown };
  const folders = Array.isArray(settings.trusted_folders) ? settings.trusted_folders.filter((v): v is string => typeof v === 'string' && v !== '') : [];
  if (!folders.length) throw new Error('settings.json 里没有 trusted_folders');
  return { home, workdir: resolve(folders[0]!), entry, profile, declarationName };
}

export function classifyDecision(parsed: { decision?: string } | null | undefined): Verdict {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'error';
  const word = parsed.decision;
  if (word === 'deny' || word === 'ask') return word;
  return word === 'allow' || word === undefined ? 'allow' : 'error';
}

/** Invokes the installed hook entry with a before_tool payload; does not write home files. */
export function invokeInstalledHook(
  guard: InstalledGuard,
  call: { tool_name: string; tool_input: Record<string, unknown>; paths?: string[] },
): { verdict: Verdict; reason?: string; raw: string; status: number | null } {
  const payload = JSON.stringify({
    event: 'before_tool',
    session_id: 'guard-preflight',
    cwd: guard.workdir,
    tool_name: call.tool_name,
    tool_input: call.tool_input,
    paths: call.paths ?? [],
  });
  const child = spawnSync(process.execPath, [guard.entry], {
    cwd: guard.workdir,
    input: payload,
    encoding: 'utf8',
    timeout: 15_000,
  });
  const raw = `${child.stdout ?? ''}${child.stderr ?? ''}`;
  const fail = (reason: string): { verdict: Verdict; reason?: string; raw: string; status: number | null } => ({
    verdict: 'error',
    reason,
    raw,
    status: child.status,
  });
  // Hook crash / timeout / empty or non-JSON output is unknown, never treat as allow (G1).
  if (child.error) return fail(`钩子错误：${child.error.message}`);
  if (child.signal) return fail(`钩子被信号中断：${child.signal}`);
  if (child.status !== 0 && child.status !== null) return fail(`钩子退出码 ${child.status}`);
  const stdout = child.stdout ?? '';
  if (stdout.trim() === '') return fail('钩子没有输出');
  let parsed: { decision?: string; reason?: string };
  try {
    parsed = JSON.parse(stdout) as { decision?: string; reason?: string };
  } catch {
    return fail('钩子输出不是 JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('钩子输出不是 JSON 对象');
  return {
    verdict: classifyDecision(parsed),
    reason: parsed.reason,
    raw: stdout || child.stderr || '',
    status: child.status,
  };
}

function finalizeNodeCommand(command: string): string { return command; }

/** @deprecated Prefer extractTaughtCommands from taught-commands.ts; kept as a thin alias for callers. */
export function extractDocCommands(docPath: string, text: string): Array<{ source: string; template: string; heredocLines: string[] | null }> {
  return extractTaughtCommands(text, docPath).map((entry) => ({
    source: entry.source,
    template: entry.raw,
    heredocLines: entry.heredocLines,
  }));
}

function listSkillDocFiles(skillDir: string): string[] {
  const out: string[] = [];
  const skillMd = join(skillDir, 'SKILL.md');
  if (existsSync(skillMd) && lstatSync(skillMd).isFile() && !lstatSync(skillMd).isSymbolicLink()) out.push(skillMd);
  const agents = join(skillDir, 'agents');
  if (existsSync(agents) && lstatSync(agents).isDirectory() && !lstatSync(agents).isSymbolicLink()) {
    for (const name of readdirSync(agents)) {
      if (name.endsWith('.md') && lstatSync(join(agents, name)).isFile() && !lstatSync(join(agents, name)).isSymbolicLink()) out.push(join(agents, name));
    }
  }
  const tools = join(skillDir, 'tools');
  if (existsSync(tools) && lstatSync(tools).isDirectory() && !lstatSync(tools).isSymbolicLink()) {
    for (const name of readdirSync(tools)) {
      if (name.endsWith('.md') && lstatSync(join(tools, name)).isFile() && !lstatSync(join(tools, name)).isSymbolicLink()) out.push(join(tools, name));
    }
  }
  return out;
}

function syntheticOptionValues(env: GuardEnvironment, tool: DiscoveredTool): Record<string, string | string[]> {
  const values: Record<string, string | string[]> = {};
  for (const option of tool.options) {
    if (option.kind === 'boolean') continue;
    if (!option.required && option.type !== 'hub') continue;
    switch (option.type) {
      case 'hub':
        values[option.name] = env.urlPlaceholder;
        break;
      case 'run':
        values[option.name] = 'run_syntheticplan';
        break;
      case 'int':
        values[option.name] = '30';
        break;
      case 'text':
        values[option.name] = option.name === 'role' ? '脚本编写' : 'synthetic';
        break;
      default:
        values[option.name] = `out/${option.name}.txt`;
        break;
    }
  }
  return values;
}

function standardAllowCommands(env: GuardEnvironment): Array<{ name: string; command: string }> {
  const out: Array<{ name: string; command: string }> = [];
  for (const tool of discoverTools(env)) {
    if (tool.subcommands?.length) {
      for (const sub of tool.subcommands) {
        const command = writeCommand(env, tool, { subcommand: sub, values: syntheticOptionValues(env, tool) });
        out.push({ name: `标准写法 ${tool.id} ${sub}`, command });
      }
    } else {
      const command = writeCommand(env, tool, { values: syntheticOptionValues(env, tool) });
      out.push({ name: `标准写法 ${tool.id}`, command });
    }
  }
  return out;
}

function docAllowCommands(env: GuardEnvironment): Array<{ name: string; command: string }> {
  const out: Array<{ name: string; command: string }> = [];
  if (!env.skillsRootValid) return out;
  let skills: string[] = [];
  try {
    skills = readdirSync(env.skills).filter((name) => lstatSync(join(env.skills, name)).isDirectory() && !lstatSync(join(env.skills, name)).isSymbolicLink() && existsSync(join(env.skills, name, 'SKILL.md')));
  } catch {
    return out;
  }
  for (const skill of skills) {
    const skillDir = join(env.skills, skill);
    for (const docFile of listSkillDocFiles(skillDir)) {
      const rel = `${skill}/${docFile.slice(skillDir.length + 1)}`;
      const text = readFileSync(docFile, 'utf8');
      for (const taught of extractTaughtCommands(text, rel)) {
        for (const concrete of instantiateTaughtCommand(taught, { skillDir, skillName: skill })) {
          const command = finalizeNodeCommand(
            concrete.replaceAll('%HUB_URL%', env.urlPlaceholder).replaceAll('%JEV_MODEL%', 'synthetic-model'),
          );
          out.push({ name: `文档 ${taught.source}: ${taught.raw.slice(0, 80)}`, command });
        }
      }
    }
  }
  return out;
}

export interface HookCase {
  name: string;
  kind: CaseKind;
  want: Verdict;
  call: { tool_name: string; tool_input: Record<string, unknown>; paths?: string[] };
}

/** Parses `node <script> [subcommand] …` after finalize; subcommand is the first bare word after the script. */
export function parseExecuteHead(command: string): { script: string; subcommand: string | null } | null {
  const m = /^(?:node)\s+(?:'([^']+\.ts)'|(\S+\.ts))(?:\s+(.*))?$/s.exec(command);
  if (!m) return null;
  const script = m[1] ?? m[2]!;
  const rest = (m[3] ?? '').trim();
  if (!rest) return { script, subcommand: null };
  const first = rest.split(/\s+/)[0]!;
  if (first.startsWith('-') || first.startsWith('<') || first.startsWith("'") || first.includes('/')) return { script, subcommand: null };
  return { script, subcommand: first };
}

/**
 * Returns the declaration's subcommand allow-list for a script when the declaration names that script
 * with an explicit subcommands array; otherwise null (no structural restriction from the declaration).
 */
export function declarationSubcommandsFor(env: GuardEnvironment, scriptFile: string): string[] | null {
  const scripts = env.declaration.scripts ?? [];
  for (const entry of scripts) {
    if (!entry.subcommands || entry.subcommands.length === 0) continue;
    const declared = join(env.skills, entry.path);
    if (scriptFile === declared || scriptFile.endsWith(`/${entry.path}`)) return entry.subcommands;
  }
  return null;
}

/** True when the taught execute command's subcommand is outside the declaration's explicit list for that script. */
export function isDeclarationLimitedCommand(env: GuardEnvironment, command: string): boolean {
  const head = parseExecuteHead(command);
  if (!head?.subcommand) return false;
  const allowed = declarationSubcommandsFor(env, head.script);
  if (!allowed) return false;
  return !allowed.includes(head.subcommand);
}

/** Fixed cases that every skills/ops guard must deny. */
export function fixedDenyCases(guard: InstalledGuard): HookCase[] {
  const { home } = guard;
  const skillProbe = join(home, 'skills', 'case-compile', 'tools', 'fetch-run.ts');
  const script = existsSync(skillProbe)
    ? quote(skillProbe)
    : existsSync(join(home, 'skills', 'recompose', 'tools', 'download-run.ts'))
      ? quote(join(home, 'skills', 'recompose', 'tools', 'download-run.ts'))
      : quote(join(home, 'skills', 'missing', 'tools', 'probe.ts'));
  const deny = (name: string, call: HookCase['call']): HookCase => ({ name, kind: 'check', want: 'deny', call });
  return [
    deny('必拒：复制文件', { tool_name: 'execute', tool_input: { command: 'cp plans/1.json plans/2.json' } }),
    deny('必拒：管道', { tool_name: 'execute', tool_input: { command: 'ls | head' } }),
    deny('必拒：外联', { tool_name: 'execute', tool_input: { command: 'curl http://192.0.2.9/' } }),
    deny('必拒：令牌写成明文', {
      tool_name: 'execute',
      tool_input: {
        command: `node ${script} --hub %HUB_URL% --run run_syntheticplan --out run-out <<'EOF'\nsometoken\nEOF`,
      },
    }),
    deny('必拒：读凭据文件', { tool_name: 'read_file', tool_input: { file_path: join(home, 'secrets.json') } }),
    deny('必拒：读守卫代码', { tool_name: 'read_file', tool_input: { file_path: join(home, 'hooks', 'guard-lib.ts') } }),
    deny('必拒：往工作目录外写', { tool_name: 'write_file', tool_input: { file_path: join(home, 'settings.json'), content: '{}' } }),
    deny('必拒：释放预订', { tool_name: 'hub_start_run', tool_input: { pack: 'test-bed@1.0.0', parameters: { action: 'release' } } }),
  ];
}

function buildCases(env: GuardEnvironment): HookCase[] {
  const seen = new Set<string>();
  const out: HookCase[] = [];
  for (const item of [...standardAllowCommands(env), ...docAllowCommands(env)]) {
    if (seen.has(item.command)) continue;
    seen.add(item.command);
    const limited = isDeclarationLimitedCommand(env, item.command);
    out.push({
      name: item.name,
      kind: limited ? 'declaration-limit' : 'check',
      // Declaration-limited taught commands are expected to be denied by the installed guard.
      want: limited ? 'deny' : 'allow',
      call: { tool_name: 'execute', tool_input: { command: item.command } },
    });
  }
  return out;
}

/** Runs the read-only preflight against the installed hook. */
export function runPreflight(homeRaw: string): PreflightReport {
  const guard = resolveInstalledGuard(homeRaw);
  const env = environment(guard.home, guard.workdir, guard.declarationName);
  const cases = [...buildCases(env), ...fixedDenyCases(guard)];
  const results: CaseResult[] = [];
  for (const item of cases) {
    const invoked = invokeInstalledHook(guard, item.call);
    const got = invoked.verdict;
    const ok = got === item.want;
    const reason = ok ? undefined : (invoked.reason ?? invoked.raw).split('\n')[0]?.slice(0, 160);
    if (item.kind === 'declaration-limit') {
      // G2: only got=deny (matching want) is informational; any other got is a mismatch.
      results.push({
        name: item.name,
        kind: 'declaration-limit',
        want: item.want,
        got,
        ok,
        reason: ok ? (invoked.reason ?? invoked.raw).split('\n')[0]?.slice(0, 160) : reason,
      });
      continue;
    }
    results.push({
      name: item.name,
      kind: 'check',
      want: item.want,
      got,
      ok,
      reason,
    });
  }
  const mismatches = results.filter((r) => !r.ok);
  const declarationLimits = results.filter((r) => r.kind === 'declaration-limit' && r.ok);
  return {
    home: guard.home,
    workdir: guard.workdir,
    entry: guard.entry,
    profile: guard.profile,
    results,
    mismatches,
    declarationLimits,
    allowCount: cases.filter((c) => c.kind === 'check' && c.want === 'allow').length,
    denyCount: cases.filter((c) => c.kind === 'check' && c.want === 'deny').length,
    ok: mismatches.length === 0,
  };
}

export function formatPreflightReport(report: PreflightReport): string[] {
  const lines = [
    `核对主目录：${report.home}`,
    `配置：${report.profile}；钩子：${basename(report.entry)}；工作目录：${report.workdir}`,
    `用例：放行 ${report.allowCount}、必拒 ${report.denyCount}；不符 ${report.mismatches.length}；声明里未放行且已拒绝 ${report.declarationLimits.length}`,
  ];
  if (report.ok) {
    lines.push(report.declarationLimits.length ? '结果：核对相符（另有声明里未放行且已拒绝的项，见下）' : '结果：全部相符');
  } else {
    lines.push('结果：有不符（装着的守卫与装着的技能或必拒用例不一致）');
    for (const miss of report.mismatches.slice(0, 40)) {
      lines.push(`- 不符 want=${miss.want} got=${miss.got} | ${miss.name}${miss.reason ? ` | ${miss.reason}` : ''}`);
    }
    if (report.mismatches.length > 40) lines.push(`- …另有 ${report.mismatches.length - 40} 条不符`);
  }
  if (report.declarationLimits.length) {
    lines.push('声明里未放行且已拒绝（技能教了、声明明确不放行，钩子已拒绝；不计入退出码）：');
    for (const item of report.declarationLimits.slice(0, 40)) {
      lines.push(`- 声明里未放行 got=${item.got} | ${item.name}${item.reason ? ` | ${item.reason}` : ''}`);
    }
    if (report.declarationLimits.length > 40) lines.push(`- …另有 ${report.declarationLimits.length - 40} 条`);
  }
  return lines;
}

export function parsePreflightArgs(argv: string[]): { home: string } {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`参数不对：${key ?? ''}`);
    values.set(key.slice(2), value);
  }
  const home = values.get('home');
  if (!home) throw new Error('缺少 --home');
  return { home };
}

export function main(argv: string[], out: (line: string) => void): number {
  try {
    const { home } = parsePreflightArgs(argv);
    const report = runPreflight(home);
    for (const line of formatPreflightReport(report)) out(line);
    return report.ok ? 0 : 1;
  } catch (error) {
    out(`失败：${(error as Error).message}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), (line) => console.log(line));
}
