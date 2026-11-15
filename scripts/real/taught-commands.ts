// Shared extraction and instantiation of taught `node` CLI examples from skill/agent markdown.
// Used by guard-preflight and (when merged) circle-guard regression tests — one grammar for
// both unquoted legacy docs (`node <技能目录>/tools/…`) and single-quoted docs
// (`node '<技能目录>/tools/…'`).

export type TaughtKind = 'shell' | 'text' | 'inline';

export interface TaughtCommand {
  source: string;
  kind: TaughtKind;
  raw: string;
  isMetaTemplate?: boolean;
  /** Body lines between <<'EOF' and EOF when the taught line opened a heredoc; null if none. */
  heredocLines: string[] | null;
}

/** Synthetic fills for `<占位符>`; values may contain spaces or non-ASCII (docs wrap them in `'…'`). */
export const TAUGHT_PLACEHOLDERS: Record<string, string> = {
  '用例重组|脚本编写|保真核对|失败分析': '脚本编写',
  脚本编写编号: 'run_syntheticplan',
  用例重组编号: 'run_syntheticrecomp',
  脚本合并编号: 'run_syntheticverify',
  合并或上机编号: 'run_syntheticverify',
  脚本编写目录: 'run dir',
  上一轮脚本编写目录: 'prev run dir',
  新脚本编写目录: 'next run dir',
  上一轮自动化用例目录: 'prev plans dir',
  上一轮核对目录: 'prev audit dir',
  逗号分隔autoid: 'case_1,case_2',
  autoid: 'case_1',
  前缀: 'case_1',
  '8位摘要': '12345678',
  运行目录: 'run dir',
  核对目录: 'audit dir',
  核对任务目录: 'audit tasks dir',
  核对文件: 'audit dir/case_1.12345678.brief.json',
  自动化用例目录: 'plans dir',
  重组后的用例目录: 'records dir',
  下载运行目录: 'recompose run dir',
  新目录: 'out dir',
  导出文件: 'inputs/mindmap raw.km',
  规整文件: 'inputs/mindmap norm.json',
  '提案.json': 'inputs/proposals 说明.json',
  产品: 'synthetic-product',
  操作者给定构建: 'Synthetic Build',
  整合模型身份: 'synthetic model',
  '说明.json': 'delivery dir/notes 说明.json',
  'scope.md': 'scope.md',
  用例或范围: 'case_1',
  简报或输入路径: 'briefs dir/case 01.md',
  目标路径: 'plans dir/case 01.json',
  目标文件路径: 'plans dir/case 01.json',
  目标自动化用例相对路径: 'plans dir/case 01.json',
  任务文件路径: 'tasks dir/case 01.md',
  补充: '补充 说明',
  补充说明: '补充 说明',
  轮次: '2',
  条目JSON: 'briefs dir/item 01.json',
  '路径...': 'prev plans dir/plan 01.json',
  '目录...': 'prev returns dir',
  范围文件: 'scope.md',
  结构简报JSON: 'briefs dir/brief 01.json',
  计划或判断JSON: 'plans dir/plan 01.json',
  计划JSON相对路径: 'plans dir/plan 01.json',
  目标计划相对路径: 'plans dir/plan 01.json',
  verdict相对路径: 'audit dir/case_1.12345678.verdict.json',
  brief相对路径: 'audit dir/case_1.12345678.brief.json',
  模型: 'synthetic model',
  秒数: '30',
  会话号: 'sess-synthetic',
  '原件 SHA-256': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'Hub MCP 地址': '%HUB_URL%',
  令牌文件: 'token.txt',
  值: 'synthetic',
};

const META_QUOTED = "node '<技能目录>/tools/<脚本>.ts' --选项 值";
const META_BARE = 'node <技能目录>/tools/<脚本>.ts --选项 值';
const META_QUOTED_VALUE = "node '<技能目录>/tools/<脚本>.ts' --选项 '值'";

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

/**
 * Structurally extracts taught `node` CLI commands from markdown:
 * fenced `sh`/`bash`/`shell` (including same-line `<<'EOF'`), `text` fences with optional
 * `label: ` prefix, and inline backticked `node …` spans.
 * Malformed heredocs remain literal input so the installed guard can reject them.
 */
export function extractTaughtCommands(markdown: string, sourceLabel: string): TaughtCommand[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: TaughtCommand[] = [];
  let fence: '' | 'sh' | 'text' | 'other' = '';

  const readHeredoc = (
    firstLine: string,
    startIndex: number,
  ): { command: string; heredocLines: string[] | null; nextIndex: number } | null => {
    if (!/<<'EOF'\s*$/.test(firstLine)) {
      return { command: firstLine, heredocLines: null, nextIndex: startIndex };
    }
    const head = firstLine.replace(/[ \t]*<<'EOF'\s*$/, '');
    const body: string[] = [];
    let j = startIndex + 1;
    while (j < lines.length && lines[j] !== 'EOF') {
      body.push(lines[j]!);
      j += 1;
    }
    if (lines[j] !== 'EOF') return { command: firstLine, heredocLines: null, nextIndex: startIndex };
    return { command: head, heredocLines: body, nextIndex: j };
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const source = `${sourceLabel}:${i + 1}`;
    if (fence === '') {
      const open = /^```([^\s`]*)/.exec(line);
      if (open) {
        const lang = open[1]!.toLowerCase();
        fence = lang === 'sh' || lang === 'bash' || lang === 'shell' ? 'sh' : lang === 'text' ? 'text' : 'other';
        continue;
      }
      for (const m of line.matchAll(/`([^`\n]+)`/g)) {
        const span = m[1]!.trim();
        if (!span.startsWith('node ')) continue;
        if (span === 'node -e') continue;
        const isMetaTemplate = span === META_QUOTED || span === META_BARE || span === META_QUOTED_VALUE;
        out.push({
          source,
          kind: 'inline',
          raw: span,
          isMetaTemplate,
          heredocLines: null,
        });
      }
      continue;
    }

    if (/^```\s*$/.test(line)) {
      fence = '';
      continue;
    }
    if (fence === 'other') continue;

    if (fence === 'sh') {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (!trimmed.startsWith('node ')) continue;
      const read = readHeredoc(trimmed, i);
      if (!read) continue;
      i = read.nextIndex;
      out.push({
        source,
        kind: 'shell',
        raw: read.command,
        heredocLines: read.heredocLines,
      });
      continue;
    }

    const textMatch = /^(?:[^:\n`]+:\s*)?(node\s.+)$/.exec(line.trim());
    if (textMatch) {
      const read = readHeredoc(textMatch[1]!, i);
      if (!read) continue;
      i = read.nextIndex;
      out.push({
        source,
        kind: 'text',
        raw: read.command,
        heredocLines: read.heredocLines,
      });
    }
  }
  return out;
}

/** Substitute the authored path placeholder without adding quoting or changing the spelling. */
export function bindSkillDirectory(command: string, skillDir: string): string {
  return command.split('<技能目录>').join(skillDir);
}

function resolvePlaceholderValue(name: string, extra: Record<string, string>): string | null {
  if (Object.hasOwn(extra, name)) return extra[name]!;
  if (Object.hasOwn(TAUGHT_PLACEHOLDERS, name)) return TAUGHT_PLACEHOLDERS[name]!;
  if (name === 'HUB_URL') return '%HUB_URL%';
  return null;
}

function bareToken(value: string): string { return value; }

/** Expands `[optional]` / `<a|b>` / `<占位符>` after the skill directory is already bound. */
export function expandTaughtPlaceholders(
  command: string,
  extraPlaceholders: Record<string, string> = {},
): string[] {
  const groups: Array<{ start: number; end: number; branches: string[] }> = [];
  for (const match of command.matchAll(/\[([^\[\]]+)\]/g)) {
    groups.push({
      start: match.index!,
      end: match.index! + match[0].length,
      branches: splitAlternativesOutsideAngles(match[1]!),
    });
  }
  const renderBrackets = (chosen: Map<number, string>): string => {
    let cursor = 0;
    let result = '';
    for (let idx = 0; idx < groups.length; idx++) {
      result += command.slice(cursor, groups[idx]!.start);
      result += chosen.get(idx) ?? '';
      cursor = groups[idx]!.end;
    }
    result += command.slice(cursor);
    return result.trim();
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
    const choices = [...form.matchAll(/<([^<>|]+\|[^<>]+)>/g)];
    const choiceForms =
      choices.length === 1
        ? choices[0]![1]!
            .split('|')
            .map((opt) => form.slice(0, choices[0]!.index) + opt + form.slice(choices[0]!.index! + choices[0]![0]!.length))
        : [form];
    for (const choiceForm of choiceForms) {
      // Preserve the authored quoting when substituting declared fixture values.
      const substituted = choiceForm
        .replace(/'<([^'<>]+)>'/g, (_whole, name: string) => {
          const value = resolvePlaceholderValue(name, extraPlaceholders);
          return value !== null
            ? `'${value}'`
            : `'<${name}>'`;
        })
        // Preserve comma-joined placeholders without adding shell quotes.
        .replace(/<([^<>]+)>,<([^<>]+)>/g, (_whole, left: string, right: string) => {
          const a = resolvePlaceholderValue(left, extraPlaceholders) ?? `<${left}>`;
          const b = resolvePlaceholderValue(right, extraPlaceholders) ?? `<${right}>`;
          return `${a},${b}`;
        })
        .replace(/<([^<>]+)>/g, (whole, name: string) => {
          if (whole === '%HUB_URL%') return '%HUB_URL%';
          const value = resolvePlaceholderValue(name, extraPlaceholders);
          if (value !== null) return bareToken(value);
          return whole;
        });
      concretes.push(substituted);
    }
  }
  return concretes;
}

export interface InstantiateOptions {
  skillDir: string;
  /** Used only to expand abstract meta-templates into a real tool. */
  skillName?: string;
  placeholders?: Record<string, string>;
}

/**
 * Instantiates one taught command into concrete execute strings (optional-bracket and choice variants).
 */
export function instantiateTaughtCommand(entry: TaughtCommand, options: InstantiateOptions): string[] {
  let command = entry.raw;
  if (entry.isMetaTemplate) return [];

  command = bindSkillDirectory(command, options.skillDir);
  if (command.includes('<技能目录>')) {
    // Unbound skill dir (e.g. prose that only mentions the placeholder) — not a runnable example.
    return [];
  }

  return expandTaughtPlaceholders(command, options.placeholders ?? {}).map((concrete) => {
    if (entry.heredocLines && !concrete.includes("<<'EOF'")) {
      return `${concrete} <<'EOF'\n${entry.heredocLines.join('\n')}\nEOF`;
    }
    return concrete;
  });
}
