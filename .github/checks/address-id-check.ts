import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackedFileText } from './docs-rules.ts';

export const DEFAULT_EXCEPTIONS_PATH = '.github/checks/address-id-exceptions.tsv';
export const APPROVED_PUBLIC_RUN_ID = 'run_01arz3ndektsv4rrffq69g5fav';
export const ALLOWED_ID_PREFIXES = ['run', 'usr', 'tm', 'tok', 'exe', 'rec'] as const;
const ID_PREFIX_GROUP = ALLOWED_ID_PREFIXES.join('|');
const IPV4_OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_QUAD = `${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}`;

export const IPV4_PATTERN = new RegExp(`(?<!\\d\\.?)${IPV4_QUAD}(?!\\.?\\d)`, 'g');
export const SINGLE_IPV4_PATTERN = new RegExp(`^${IPV4_QUAD}$`);

export const INTERNAL_ID_PATTERN = new RegExp(`(?<![a-z0-9_])(?:${ID_PREFIX_GROUP})_[0-9a-z]{26}(?![a-z0-9_])`, 'g');
export const SINGLE_INTERNAL_ID_PATTERN = new RegExp(`^(?:${ID_PREFIX_GROUP})_[0-9a-z]{26}$`);
export const ZERO_INTERNAL_ID_PATTERN = new RegExp(`^(?:${ID_PREFIX_GROUP})_0{26}$`);

export const IPV4_CATEGORIES = [
  '协议节号、OID与版本串',
  '合成产品版本号',
  '私网定义表、掩码与测试字面量',
  '待随合并清理',
] as const;

export const ID_CATEGORIES = ['已发布示例编号', '已批准非零编号'] as const;

export type LiteralKind = 'ipv4' | 'id';
export type Ipv4Category = (typeof IPV4_CATEGORIES)[number];
export type IdCategory = (typeof ID_CATEGORIES)[number];
export type ExceptionCategory = Ipv4Category | IdCategory;

export interface ExceptionEntry {
  readonly line: number;
  readonly kind: LiteralKind;
  readonly path: string;
  readonly literal: string;
  readonly category: ExceptionCategory;
  readonly note: string;
}

export interface ParsedExceptions {
  readonly entries: readonly ExceptionEntry[];
  readonly errors: readonly string[];
}

export interface LiteralHit {
  readonly kind: LiteralKind;
  readonly scope: 'ipv4' | 'docs-id' | 'artifact-id';
  readonly path: string;
  readonly line: number;
  readonly literal: string;
}

export interface SourceEntry {
  readonly path: string;
  readonly text: string;
}

export interface CheckOptions {
  readonly exceptionsPath?: string;
  readonly exceptionsText?: string;
}

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const IPV4_CATEGORY_SET = new Set<string>(IPV4_CATEGORIES);
const ID_CATEGORY_SET = new Set<string>(ID_CATEGORIES);

/** Returns true only for loopback (`127.0.0.0/8`) and RFC 5737 documentation blocks. */
export function isAutoAllowedIpv4(literal: string): boolean {
  if (!SINGLE_IPV4_PATTERN.test(literal)) return false;
  const parts = literal.split('.');
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  const c = Number(parts[2]);
  if (a === 127) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return false;
}

/** Returns true for all-zero placeholder IDs and the single approved public example ID. */
export function isAutoAllowedId(literal: string): boolean {
  return literal === APPROVED_PUBLIC_RUN_ID || ZERO_INTERNAL_ID_PATTERN.test(literal);
}

/** Documentation tree allows zero internal 26-character IDs of the protected prefixes. */
export function isDocsPath(relPath: string): boolean {
  return relPath.startsWith('docs/');
}

/** Non-test files under `packs/`, `scripts/`, and `tools/` must not contain unapproved IDs. */
export function isIdArtifactPath(relPath: string): boolean {
  if (!relPath.startsWith('packs/') && !relPath.startsWith('scripts/') && !relPath.startsWith('tools/')) {
    return false;
  }
  if (relPath.endsWith('.test.ts')) return false;
  if (/(?:^|\/)testing(?:[^/]*\.ts$|\/)/.test(relPath)) return false;
  return true;
}

function entryKey(kind: LiteralKind, path: string, literal: string): string {
  return `${kind}\t${path}\t${literal}`;
}

function countLinesIncrementally(text: string, fromIndex: number, toIndex: number): number {
  let newlines = 0;
  for (let i = fromIndex; i < toIndex; i += 1) {
    if (text.charCodeAt(i) === 10) newlines += 1;
  }
  return newlines;
}

function scanPatternInText(
  text: string,
  pattern: RegExp,
  accept: (literal: string, line: number) => void,
): void {
  const re = new RegExp(pattern.source, pattern.flags);
  let lastIndex = 0;
  let line = 1;
  for (const match of text.matchAll(re)) {
    const idx = match.index ?? 0;
    line += countLinesIncrementally(text, lastIndex, idx);
    lastIndex = idx;
    accept(match[0], line);
  }
}

/** Collects non-exempt IPv4 and internal ID literals found in a single source text. */
export function collectLiteralsInText(relPath: string, text: string): LiteralHit[] {
  const hits: LiteralHit[] = [];

  scanPatternInText(text, IPV4_PATTERN, (literal, line) => {
    if (isAutoAllowedIpv4(literal)) return;
    hits.push({ kind: 'ipv4', scope: 'ipv4', path: relPath, line, literal });
  });

  if (isDocsPath(relPath)) {
    scanPatternInText(text, INTERNAL_ID_PATTERN, (literal, line) => {
      hits.push({ kind: 'id', scope: 'docs-id', path: relPath, line, literal });
    });
  } else if (isIdArtifactPath(relPath)) {
    scanPatternInText(text, INTERNAL_ID_PATTERN, (literal, line) => {
      if (isAutoAllowedId(literal)) return;
      hits.push({ kind: 'id', scope: 'artifact-id', path: relPath, line, literal });
    });
  }

  return hits;
}

function isCanonicalRepoPath(relPath: string): boolean {
  if (!relPath || relPath.startsWith('/') || relPath.startsWith('./') || relPath.includes('\\')) return false;
  return !relPath.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}

/** Parses and strictly validates the tab-separated exception manifest. */
export function parseExceptionList(
  content: string,
  exceptionsPath = DEFAULT_EXCEPTIONS_PATH,
): ParsedExceptions {
  const entries: ExceptionEntry[] = [];
  const errors: string[] = [];
  const seenKeys = new Set<string>();
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i]!;
    const lineNo = i + 1;
    if (rawLine.trim() === '' || rawLine.startsWith('#')) continue;

    const cols = rawLine.split('\t');
    if (cols.length !== 4) {
      errors.push(
        `${exceptionsPath}:${lineNo}: 每行必须是「路径\\t字面量\\t归类\\t备注」共 4 列（实际 ${cols.length} 列）`,
      );
      continue;
    }

    const [path, literal, category, note] = cols as [string, string, string, string];
    if (cols.some((col) => col.length === 0 || col !== col.trim())) {
      errors.push(`${exceptionsPath}:${lineNo}: 路径、字面量、归类、备注均不能为空，且不能含首尾空白`);
      continue;
    }
    if (!isCanonicalRepoPath(path) || path === exceptionsPath) {
      errors.push(`${exceptionsPath}:${lineNo}: 无效仓库相对路径 "${path}"`);
      continue;
    }

    let kind: LiteralKind | null = null;
    if (SINGLE_IPV4_PATTERN.test(literal)) {
      kind = 'ipv4';
    } else if (SINGLE_INTERNAL_ID_PATTERN.test(literal)) {
      kind = 'id';
    } else {
      errors.push(`${exceptionsPath}:${lineNo}: 字面量 "${literal}" 既不是合法 IPv4 四段数字也不是 26 位内部编号`);
      continue;
    }

    if (kind === 'ipv4') {
      if (isAutoAllowedIpv4(literal)) {
        errors.push(`${exceptionsPath}:${lineNo}: ${literal} 已在文档专用或回环放行范围内，不应放进例外清单`);
        continue;
      }
      if (!IPV4_CATEGORY_SET.has(category)) {
        errors.push(`${exceptionsPath}:${lineNo}: IPv4 条目的归类 "${category}" 不受支持`);
        continue;
      }
    } else {
      if (isDocsPath(path)) {
        errors.push(`${exceptionsPath}:${lineNo}: docs/ 下不允许登记任何内部编号例外（${path}）`);
        continue;
      }
      if (!isIdArtifactPath(path)) {
        errors.push(`${exceptionsPath}:${lineNo}: ${path} 不在非测试制品编号检查范围内，不应登记 ID 例外`);
        continue;
      }
      if (isAutoAllowedId(literal)) {
        errors.push(`${exceptionsPath}:${lineNo}: ${literal} 属于自动放行编号，不应放进例外清单`);
        continue;
      }
      if (!ID_CATEGORY_SET.has(category)) {
        errors.push(`${exceptionsPath}:${lineNo}: 内部编号条目的归类 "${category}" 不受支持`);
        continue;
      }
      if (category === '已发布示例编号' && !note.includes('待随下次升版替换')) {
        errors.push(`${exceptionsPath}:${lineNo}: 「已发布示例编号」条目必须在备注中注明「待随下次升版替换」`);
        continue;
      }
    }

    const key = entryKey(kind, path, literal);
    if (seenKeys.has(key)) {
      errors.push(`${exceptionsPath}:${lineNo}: 重复例外条目 ${path} [${literal}]`);
      continue;
    }
    seenKeys.add(key);
    entries.push({
      line: lineNo,
      kind,
      path,
      literal,
      category: category as ExceptionCategory,
      note,
    });
  }

  return { entries, errors };
}

function formatViolation(hit: LiteralHit, exceptionsPath: string): string {
  if (hit.scope === 'ipv4') {
    return `${hit.path}:${hit.line}: 发现未登记的四段数字 ${hit.literal}（仅自动放行文档专用网段 192.0.2.0/24、198.51.100.0/24、203.0.113.0/24 与回环 127.0.0.0/8）；请换成文档专用网段，或者说明理由后加进 ${exceptionsPath} 并由 Boss 看过`;
  }
  if (hit.scope === 'docs-id') {
    return `${hit.path}:${hit.line}: docs/ 下禁止出现 26 位内部编号 ${hit.literal}；docs/ 不设例外，请删除或脱敏`;
  }
  return `${hit.path}:${hit.line}: 发现未登记的 26 位内部编号 ${hit.literal}（非测试文件仅自动放行全 0 占位编号与已公开示例 ${APPROVED_PUBLIC_RUN_ID}）；请换成全 0 占位编号，或者说明理由后加进 ${exceptionsPath} 并由 Boss 看过`;
}

/** Evaluates in-memory sources against parsed exceptions in both directions (missing and stale). */
export function evaluateAddressAndIds(
  sources: readonly SourceEntry[],
  parsed: ParsedExceptions,
  exceptionsPath = DEFAULT_EXCEPTIONS_PATH,
): string[] {
  const problems = [...parsed.errors];
  const byKey = new Map<string, ExceptionEntry>();
  for (const entry of parsed.entries) {
    byKey.set(entryKey(entry.kind, entry.path, entry.literal), entry);
  }
  const matchedKeys = new Set<string>();

  for (const source of sources) {
    if (source.path === exceptionsPath) continue;
    for (const hit of collectLiteralsInText(source.path, source.text)) {
      if (hit.scope === 'docs-id') {
        problems.push(formatViolation(hit, exceptionsPath));
        continue;
      }
      const key = entryKey(hit.kind, hit.path, hit.literal);
      if (byKey.has(key)) {
        matchedKeys.add(key);
        continue;
      }
      problems.push(formatViolation(hit, exceptionsPath));
    }
  }

  for (const entry of parsed.entries) {
    const key = entryKey(entry.kind, entry.path, entry.literal);
    if (!matchedKeys.has(key)) {
      problems.push(
        `${exceptionsPath}:${entry.line}: 例外已失效（仓库中不再出现 ${entry.path} 的 ${entry.literal} [${entry.category}]）；只减不增清单请删除该行（原备注：${entry.note}）`,
      );
    }
  }

  return problems;
}

/** Lists all git-tracked paths sorted in repository order. */
export function listTrackedPaths(root: string): string[] {
  const raw = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  return raw.split('\0').filter(Boolean).sort();
}

/** Runs the full address and internal ID check on a git repository worktree. */
export function addressAndIdProblems(root: string = REPO_ROOT, options: CheckOptions = {}): string[] {
  const exceptionsRelPath = options.exceptionsPath ?? DEFAULT_EXCEPTIONS_PATH;
  let exceptionsContent = options.exceptionsText;
  if (exceptionsContent === undefined) {
    const fullExceptions = join(root, exceptionsRelPath);
    if (!existsSync(fullExceptions)) {
      return [`missing exceptions manifest: ${exceptionsRelPath}`];
    }
    exceptionsContent = readFileSync(fullExceptions, 'utf8');
  }

  const parsed = parseExceptionList(exceptionsContent, exceptionsRelPath);
  const sources: SourceEntry[] = [];
  const missingProblems: string[] = [];

  for (const relPath of listTrackedPaths(root)) {
    if (relPath === exceptionsRelPath) continue;
    const fullPath = join(root, relPath);
    try {
      const text = trackedFileText(fullPath);
      if (text !== null) sources.push({ path: relPath, text });
    } catch {
      missingProblems.push(`${relPath}: tracked file missing on disk`);
    }
  }

  return [...missingProblems, ...evaluateAddressAndIds(sources, parsed, exceptionsRelPath)];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = addressAndIdProblems(REPO_ROOT);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exitCode = 1;
  } else {
    const parsed = parseExceptionList(readFileSync(join(REPO_ROOT, DEFAULT_EXCEPTIONS_PATH), 'utf8'));
    console.log(`address-id-check: ok (${parsed.entries.length} exceptions active)`);
  }
}
