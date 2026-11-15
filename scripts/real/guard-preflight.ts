// Read-only preflight: replay allow/deny cases through the installed Circle home hook.
// Does not read credential values, does not change the home, and does not contact the Hub.
//   node scripts/real/guard-preflight.ts --home <dir>
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { discoverTools, environment, quote, writeCommand, type DiscoveredTool, type GuardEnvironment } from './guard-lib.ts';

export type Verdict = 'allow' | 'deny' | 'ask';
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
  const entry = resolve(match[1] ?? match[2] ?? match[3]!);
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
  const word = parsed?.decision;
  if (word === 'deny' || word === 'ask') return word;
  return 'allow';
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
  let parsed: { decision?: string; reason?: string } | null = null;
  try {
    parsed = JSON.parse(child.stdout || '{}') as { decision?: string; reason?: string };
  } catch {
    parsed = null;
  }
  return {
    verdict: classifyDecision(parsed),
    reason: parsed?.reason,
    raw: child.stdout || child.stderr || '',
    status: child.status,
  };
}

// Placeholders must satisfy guard `run_[a-z0-9]+` but must not be protected-prefix+26-char
// internal IDs (address-id-check); only APPROVED_PUBLIC_RUN_ID / run_0{26} are auto-allowed there.
const SYNTHETIC: Record<string, string> = {
  脚本编写编号: 'run_syntheticplan',
  用例重组编号: 'run_syntheticrecomp',
  脚本合并编号: 'run_syntheticverify',
  合并或上机编号: 'run_syntheticverify',
  脚本编写目录: 'case-compile-run',
  上一轮脚本编写目录: 'prev-case-compile-run',
  新脚本编写目录: 'case-compile-run',
  上一轮自动化用例目录: 'prev-plans',
  上一轮核对目录: 'prev-fidelity',
  逗号分隔autoid: 'orbit-case-0001',
  autoid: 'orbit-case-0001',
  前缀: '0',
  '8位摘要': 'aaaaaaaa',
  运行目录: 'case-compile-run',
  核对目录: 'fidelity',
  核对任务目录: 'fidelity-tasks',
  核对文件: 'fidelity/0.brief.json',
  自动化用例目录: 'plans',
  重组后的用例目录: 'records',
  下载运行目录: 'recompose-run',
  新目录: 'run-out',
  导出文件: 'export.json',
  规整文件: 'normalized.json',
  '说明.json': 'notes.json',
  'scope.md': 'scope.md',
  用例或范围: 'case-01',
  简报或输入路径: 'briefs/0.md',
  目标路径: 'plans/0.json',
  目标文件路径: 'plans/0.json',
  任务文件路径: 'tasks/0.md',
  补充: '合成补充说明',
  补充说明: '合成补充说明',
  轮次: '2',
  条目JSON: 'items/0.json',
  '路径...': 'plans/r1/0.json',
  '目录...': 'returns/r1',
  范围文件: 'scope.md',
  结构简报JSON: 'briefs/0.json',
  计划或判断JSON: 'plans/0.json',
  计划JSON相对路径: 'plans/0.json',
  目标计划相对路径: 'plans/0.json',
  verdict相对路径: 'fidelity/0.verdict.json',
  brief相对路径: 'fidelity/0.brief.json',
  模型: 'synthetic-model',
  秒数: '30',
  会话号: 'sess-synthetic',
  '原件 SHA-256': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'Hub MCP 地址': '%HUB_URL%',
  令牌文件: 'token.txt',
  值: 'synthetic',
};

function splitAlternativesOutsideAngles(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '<') depth++;
    else if (ch === '>') depth = Math.max(0, depth - 1);
    else if (ch === '|' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function expandTemplate(template: string, skillDir: string): string[] {
  // Quote the full script path in one step so homes under "Application Support" stay a single token.
  const withSkill = template.replace(/node <技能目录>\/(\S+\.ts)/g, (_whole, rel: string) => `node ${quote(join(skillDir, rel))}`);
  const groups: Array<{ start: number; end: number; branches: string[] }> = [];
  for (const match of withSkill.matchAll(/\[([^\[\]]+)\]/g)) {
    groups.push({ start: match.index!, end: match.index! + match[0].length, branches: splitAlternativesOutsideAngles(match[1]!) });
  }
  const renderBrackets = (chosen: Map<number, string>): string => {
    let cursor = 0;
    let result = '';
    for (let idx = 0; idx < groups.length; idx++) {
      result += withSkill.slice(cursor, groups[idx]!.start);
      result += chosen.get(idx) ?? '';
      cursor = groups[idx]!.end;
    }
    result += withSkill.slice(cursor);
    return result.replace(/ +/g, ' ').trim();
  };
  const bracketForms = new Set<string>([renderBrackets(new Map())]);
  for (let idx = 0; idx < groups.length; idx++) {
    for (const branch of groups[idx]!.branches) bracketForms.add(renderBrackets(new Map([[idx, branch]])));
  }
  if (groups.length > 1) {
    bracketForms.add(renderBrackets(new Map(groups.map((group, idx) => [idx, group.branches[0]!]!))));
  }

  const concretes: string[] = [];
  for (const form of bracketForms) {
    // Choice placeholders first (`<a|b>`), then any remaining `<…>` including names with spaces (`<原件 SHA-256>`).
    const choices = [...form.matchAll(/<([^<>|]+\|[^<>]+)>/g)];
    const choiceForms =
      choices.length === 1
        ? choices[0]![1]!.split('|').map((opt) => form.slice(0, choices[0]!.index) + opt + form.slice(choices[0]!.index! + choices[0]![0]!.length))
        : [form];
    for (const choiceForm of choiceForms) {
      const substituted = choiceForm.replace(/<([^<>]+)>/g, (whole, name: string) => {
        const trimmed = name.trim();
        if (Object.hasOwn(SYNTHETIC, trimmed)) return SYNTHETIC[trimmed]!;
        if (trimmed === 'HUB_URL' || whole === '%HUB_URL%') return '%HUB_URL%';
        // Keep the whole <…> (spaces included) as one token; sanitize to a workdir-relative path.
        return `out/${trimmed.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40) || 'value'}`;
      });
      concretes.push(substituted);
    }
  }
  return concretes;
}

function finalizeNodeCommand(command: string): string {
  const m = /^(node)\s+(?:'([^']+\.ts)'|(\S+\.ts))(.*)$/s.exec(command);
  if (!m) return command;
  const script = m[2] ?? m[3]!;
  return `${m[1]} ${quote(script)}${m[4] ?? ''}`;
}

interface DocCommand {
  source: string;
  template: string;
  heredocLines: string[] | null;
}

/** Extracts taught execute examples from skill and agent markdown under an installed skill. */
export function extractDocCommands(docPath: string, text: string): DocCommand[] {
  const out: DocCommand[] = [];
  for (const match of text.matchAll(/^```sh\n([\s\S]*?)^```$/gm)) {
    const lines = match[1]!.split('\n');
    for (let i = 0; i < lines.length; ) {
      const line = lines[i]!;
      if (line === '' || line.startsWith('#')) {
        i += 1;
        continue;
      }
      if (!line.startsWith('node <技能目录>/') && !/^node\s/.test(line)) {
        i += 1;
        continue;
      }
      if (line.includes('<<')) {
        if (!/ <<'EOF'$/.test(line)) {
          i += 1;
          continue;
        }
        const body: string[] = [];
        let j = i + 1;
        while (j < lines.length && lines[j] !== 'EOF') {
          body.push(lines[j]!);
          j += 1;
        }
        if (lines[j] !== 'EOF') {
          i += 1;
          continue;
        }
        out.push({ source: docPath, template: line.slice(0, -" <<'EOF'".length), heredocLines: body });
        i = j + 1;
      } else {
        out.push({ source: docPath, template: line, heredocLines: null });
        i += 1;
      }
    }
  }
  const heredocNote = " <<'EOF'（接两行 %HUB_TOKEN% 与 EOF，切勿在 <<'EOF' 前换行）";
  for (const line of text.split('\n')) {
    const labelled = /^[^:\n]+: ((?:node <技能目录>\/)?tools\/\S+\.ts(?: [^\n]*)?)$/.exec(line);
    if (labelled) {
      let cmd = labelled[1]!;
      let heredocLines: string[] | null = null;
      if (cmd.endsWith(heredocNote)) {
        cmd = cmd.slice(0, -heredocNote.length);
        heredocLines = ['%HUB_TOKEN%'];
      }
      if (cmd.includes('<<') || cmd.includes('（')) continue;
      if (cmd.startsWith('tools/')) cmd = `node <技能目录>/${cmd}`;
      out.push({ source: docPath, template: cmd, heredocLines });
    }
    for (const match of line.matchAll(/`(node <技能目录>[^`]+)`/g)) {
      const cmd = match[1]!;
      if (cmd === 'node <技能目录>/tools/<脚本>.ts --选项 值') continue;
      // Bare script path in prose is not a runnable example.
      if (/^node <技能目录>\/\S+\.ts$/.test(cmd)) continue;
      if (cmd.includes('<<') || cmd.includes('\n')) continue;
      out.push({ source: docPath, template: cmd, heredocLines: null });
    }
  }
  return out;
}

function listSkillDocFiles(skillDir: string): string[] {
  const out: string[] = [];
  const skillMd = join(skillDir, 'SKILL.md');
  if (existsSync(skillMd)) out.push(skillMd);
  const agents = join(skillDir, 'agents');
  if (existsSync(agents) && statSync(agents).isDirectory()) {
    for (const name of readdirSync(agents)) {
      if (name.endsWith('.md')) out.push(join(agents, name));
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
    skills = readdirSync(env.skills).filter((name) => existsSync(join(env.skills, name, 'SKILL.md')));
  } catch {
    return out;
  }
  for (const skill of skills) {
    const skillDir = join(env.skills, skill);
    for (const docFile of listSkillDocFiles(skillDir)) {
      const rel = `${skill}/${docFile.slice(skillDir.length + 1)}`;
      const text = readFileSync(docFile, 'utf8');
      for (const usage of extractDocCommands(rel, text)) {
        for (const concrete of expandTemplate(usage.template, skillDir)) {
          let command = finalizeNodeCommand(
            concrete.replaceAll('%HUB_URL%', env.urlPlaceholder).replaceAll('%JEV_MODEL%', 'synthetic-model'),
          );
          if (usage.heredocLines && !command.includes("<<'EOF'")) {
            command += ` <<'EOF'\n${usage.heredocLines.join('\n')}\nEOF`;
          }
          out.push({ name: `文档 ${rel}: ${usage.template.slice(0, 80)}`, command });
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
    if (item.kind === 'declaration-limit') {
      // Listed for humans; never fails the exit code. Prefer recording the hook's deny reason.
      results.push({
        name: item.name,
        kind: 'declaration-limit',
        want: item.want,
        got,
        ok: true,
        reason: (invoked.reason ?? invoked.raw).split('\n')[0]?.slice(0, 160),
      });
      continue;
    }
    const ok = got === item.want;
    results.push({
      name: item.name,
      kind: 'check',
      want: item.want,
      got,
      ok,
      reason: ok ? undefined : (invoked.reason ?? invoked.raw).split('\n')[0]?.slice(0, 160),
    });
  }
  const mismatches = results.filter((r) => r.kind === 'check' && !r.ok);
  const declarationLimits = results.filter((r) => r.kind === 'declaration-limit');
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
    `用例：放行 ${report.allowCount}、必拒 ${report.denyCount}；不符 ${report.mismatches.length}；声明限制 ${report.declarationLimits.length}`,
  ];
  if (report.ok) {
    lines.push(report.declarationLimits.length ? '结果：核对相符（另有声明限制，见下）' : '结果：全部相符');
  } else {
    lines.push('结果：有不符（装着的守卫与装着的技能或必拒用例不一致）');
    for (const miss of report.mismatches.slice(0, 40)) {
      lines.push(`- 不符 want=${miss.want} got=${miss.got} | ${miss.name}${miss.reason ? ` | ${miss.reason}` : ''}`);
    }
    if (report.mismatches.length > 40) lines.push(`- …另有 ${report.mismatches.length - 40} 条不符`);
  }
  if (report.declarationLimits.length) {
    lines.push('声明限制（技能教了、声明明确不放行；不计入退出码）：');
    for (const item of report.declarationLimits.slice(0, 40)) {
      lines.push(`- 声明限制 got=${item.got} | ${item.name}${item.reason ? ` | ${item.reason}` : ''}`);
    }
    if (report.declarationLimits.length > 40) lines.push(`- …另有 ${report.declarationLimits.length - 40} 条声明限制`);
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
