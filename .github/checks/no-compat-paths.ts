import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const CHECK_ID = 'no-compat-paths';
export const DEFAULT_REGISTER_RELATIVE_PATH = '.github/checks/compat-register.json';
export const DEFAULT_EXCEPTIONS_RELATIVE_PATH = '.github/checks/exceptions.json';
export const DEFAULT_EXCLUDE_PATHS: readonly string[] = ['hub/records/migrations.ts'];

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VALID_WHAT_PREFIXES = ['word:', 'literal:', 'prefix:', 'symbol:'] as const;

const NON_PRODUCTION_PATTERNS: readonly RegExp[] = [
  /\.test\.ts$/,
  /-support\.ts$/,
  /(?:^|\/)fakes\.ts$/,
  /(?:^|\/)testing(?:[^/]*\.ts$|\/)/,
  /(?:^|\/|-)fixtures(?:-|\/|\.ts$)/,
  /(?:^|\/)test-[^/]+\.ts$/,
];

export type CompatMatchKind = 'word' | 'literal' | 'prefix' | 'symbol';

export interface CompatRegister {
  readonly schema: string;
  readonly status?: string;
  readonly description?: string;
  readonly excludePaths: readonly string[];
  readonly words: readonly string[];
  readonly literals: readonly string[];
  readonly prefixes: readonly string[];
  readonly symbols: readonly string[];
}

export interface CompatException {
  readonly check: string;
  readonly path: string;
  readonly what: string;
  readonly reason: string;
  readonly removeWhen: string;
}

export interface CompatHit {
  readonly path: string;
  readonly line: number;
  readonly kind: CompatMatchKind;
  readonly what: string;
  readonly sample: string;
  readonly astKind: 'identifier' | 'string';
}

export interface CompatSourceFile {
  readonly path: string;
  readonly content: string;
}

export interface CompatOptions {
  readonly register?: CompatRegister;
  readonly registerPath?: string;
  readonly exceptions?: readonly unknown[];
  readonly exceptionsPath?: string;
  readonly files?: readonly string[];
}

export interface CompatWhatSummary {
  readonly what: string;
  readonly count: number;
  readonly files: number;
  readonly samples: readonly string[];
}

export interface CompatPairSummary {
  readonly path: string;
  readonly what: string;
  readonly count: number;
  readonly lines: readonly number[];
  readonly samples: readonly string[];
}

export interface CompatHitSummary {
  readonly totalHits: number;
  readonly uniquePairs: number;
  readonly byWhat: readonly CompatWhatSummary[];
  readonly pairs: readonly CompatPairSummary[];
}

interface CompiledRegister {
  readonly words: ReadonlySet<string>;
  readonly literals: readonly string[];
  readonly literalsSet: ReadonlySet<string>;
  readonly prefixes: readonly string[];
  readonly symbols: readonly string[];
  readonly symbolsSet: ReadonlySet<string>;
  readonly stringLiteralRegexes: ReadonlyArray<{ readonly term: string; readonly regex: RegExp }>;
  readonly stringPrefixRegexes: ReadonlyArray<{ readonly term: string; readonly regex: RegExp }>;
  readonly stringSymbolRegexes: ReadonlyArray<{ readonly term: string; readonly regex: RegExp }>;
}

interface SpanMatch {
  readonly start: number;
  readonly end: number;
  readonly kind: CompatMatchKind;
  readonly what: string;
  readonly sample: string;
}

function normalizePath(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/');
  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readStringArrayField(obj: Record<string, unknown>, field: string, sourceLabel: string): string[] {
  const value = obj[field];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new Error(`${sourceLabel}: "${field}" must be an array of non-empty strings`);
  }
  return [...value];
}

function validateRegister(raw: unknown, sourceLabel: string): CompatRegister {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${sourceLabel}: register must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.schema !== 'string' || obj.schema.length === 0) {
    throw new Error(`${sourceLabel}: "schema" must be a non-empty string`);
  }
  const words = readStringArrayField(obj, 'words', sourceLabel).map((word) => word.toLowerCase());
  const literals = readStringArrayField(obj, 'literals', sourceLabel);
  const prefixes = readStringArrayField(obj, 'prefixes', sourceLabel);
  const symbols = readStringArrayField(obj, 'symbols', sourceLabel);
  const excludePaths =
    obj.excludePaths === undefined
      ? [...DEFAULT_EXCLUDE_PATHS]
      : readStringArrayField(obj, 'excludePaths', sourceLabel).map(normalizePath);

  return {
    schema: obj.schema,
    ...(typeof obj.status === 'string' ? { status: obj.status } : {}),
    ...(typeof obj.description === 'string' ? { description: obj.description } : {}),
    excludePaths,
    words,
    literals,
    prefixes,
    symbols,
  };
}

function compileRegister(register: CompatRegister): CompiledRegister {
  const words = new Set(register.words.map((word) => word.toLowerCase()));
  const literals = [...register.literals].sort((a, b) => b.length - a.length);
  const prefixes = [...register.prefixes].sort((a, b) => b.length - a.length);
  const symbols = [...register.symbols].sort((a, b) => b.length - a.length);

  return {
    words,
    literals,
    literalsSet: new Set(literals),
    prefixes,
    symbols,
    symbolsSet: new Set(symbols),
    stringSymbolRegexes: symbols.map((term) => ({
      term,
      regex: new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(term)}(?![A-Za-z0-9_])`, 'g'),
    })),
    stringLiteralRegexes: literals.map((term) => ({
      term,
      regex: new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(term)}(?![A-Za-z0-9])`, 'g'),
    })),
    stringPrefixRegexes: prefixes.map((term) => ({
      term,
      regex: new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(term)}[A-Za-z0-9_]*`, 'g'),
    })),
  };
}

export function splitIdentifierWords(name: string): string[] {
  const cleaned = name.startsWith('#') ? name.slice(1) : name;
  const words: string[] = [];
  for (const rawSegment of cleaned.split(/[^A-Za-z0-9]+/)) {
    if (!rawSegment) continue;
    const spaced = rawSegment
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
    for (const part of spaced.split(' ')) {
      if (part) {
        words.push(part.toLowerCase());
      }
    }
  }
  return words;
}

export function isProductionTarget(
  relativePath: string,
  excludePaths: readonly string[] = DEFAULT_EXCLUDE_PATHS,
): boolean {
  const normalized = normalizePath(relativePath);
  if (!normalized.startsWith('hub/') && !normalized.startsWith('contracts/src/')) {
    return false;
  }
  if (!normalized.endsWith('.ts') || normalized.endsWith('.d.ts')) {
    return false;
  }
  const excludedSet = new Set(excludePaths.map(normalizePath));
  if (excludedSet.has(normalized)) {
    return false;
  }
  return !NON_PRODUCTION_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function loadCompatRegister(root: string, registerPath?: string): CompatRegister {
  const resolved = registerPath
    ? isAbsolute(registerPath)
      ? registerPath
      : join(root, registerPath)
    : join(root, DEFAULT_REGISTER_RELATIVE_PATH);
  const raw: unknown = JSON.parse(readFileSync(resolved, 'utf8'));
  return validateRegister(raw, resolved);
}

export function loadCompatExceptions(root: string, exceptionsPath?: string): readonly unknown[] {
  const resolved = exceptionsPath
    ? isAbsolute(exceptionsPath)
      ? exceptionsPath
      : join(root, exceptionsPath)
    : join(root, DEFAULT_EXCEPTIONS_RELATIVE_PATH);

  if (!existsSync(resolved)) {
    if (exceptionsPath !== undefined) {
      throw new Error(`Exceptions file not found: ${resolved}`);
    }
    return [];
  }

  const raw: unknown = JSON.parse(readFileSync(resolved, 'utf8'));
  if (Array.isArray(raw)) {
    return raw;
  }
  if (typeof raw === 'object' && raw !== null && Array.isArray((raw as Record<string, unknown>).exceptions)) {
    return (raw as { readonly exceptions: readonly unknown[] }).exceptions;
  }
  throw new Error(`${resolved}: exceptions must be a JSON array or an object with an "exceptions" array`);
}

export function trackedProductionFiles(
  root: string,
  excludePaths: readonly string[] = DEFAULT_EXCLUDE_PATHS,
): string[] {
  const output = execFileSync('git', ['ls-files', '-z', '--', 'hub', 'contracts/src'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return output
    .split('\0')
    .filter((entry) => entry.length > 0 && isProductionTarget(entry, excludePaths))
    .sort();
}

function scanIdentifier(
  rawText: string,
  sample: string,
  path: string,
  line: number,
  compiled: CompiledRegister,
): CompatHit[] {
  const clean = rawText.startsWith('#') ? rawText.slice(1) : rawText;
  if (!clean) return [];

  if (compiled.symbolsSet.has(clean)) {
    return [{ path, line, kind: 'symbol', what: `symbol:${clean}`, sample, astKind: 'identifier' }];
  }
  if (compiled.literalsSet.has(clean)) {
    return [{ path, line, kind: 'literal', what: `literal:${clean}`, sample, astKind: 'identifier' }];
  }
  for (const prefix of compiled.prefixes) {
    if (clean.startsWith(prefix)) {
      return [{ path, line, kind: 'prefix', what: `prefix:${prefix}`, sample, astKind: 'identifier' }];
    }
  }

  const hits: CompatHit[] = [];
  const seenWords = new Set<string>();
  for (const word of splitIdentifierWords(clean)) {
    if (compiled.words.has(word) && !seenWords.has(word)) {
      seenWords.add(word);
      hits.push({ path, line, kind: 'word', what: `word:${word}`, sample, astKind: 'identifier' });
    }
  }
  return hits;
}

function overlapsClaimed(start: number, end: number, claimed: readonly SpanMatch[]): boolean {
  return claimed.some((span) => start < span.end && end > span.start);
}

function collectRegexSpans(
  text: string,
  kind: CompatMatchKind,
  matchers: ReadonlyArray<{ readonly term: string; readonly regex: RegExp }>,
  claimed: SpanMatch[],
): void {
  for (const { term, regex } of matchers) {
    regex.lastIndex = 0;
    let match = regex.exec(text);
    while (match !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (!overlapsClaimed(start, end, claimed)) {
        claimed.push({
          start,
          end,
          kind,
          what: `${kind}:${term}`,
          sample: match[0],
        });
      }
      match = regex.exec(text);
    }
  }
}

function scanStringText(
  text: string,
  path: string,
  line: number,
  compiled: CompiledRegister,
): CompatHit[] {
  if (!text) return [];

  const claimed: SpanMatch[] = [];
  collectRegexSpans(text, 'symbol', compiled.stringSymbolRegexes, claimed);
  collectRegexSpans(text, 'literal', compiled.stringLiteralRegexes, claimed);
  collectRegexSpans(text, 'prefix', compiled.stringPrefixRegexes, claimed);

  const hits: CompatHit[] = [];
  const seenWhat = new Set<string>();

  for (const span of claimed) {
    if (!seenWhat.has(span.what)) {
      seenWhat.add(span.what);
      hits.push({ path, line, kind: span.kind, what: span.what, sample: span.sample, astKind: 'string' });
    }
  }

  const sortedClaimed = [...claimed].sort((a, b) => a.start - b.start);
  let cursor = 0;
  const unclaimedSlices: string[] = [];
  for (const span of sortedClaimed) {
    if (cursor < span.start) {
      unclaimedSlices.push(text.slice(cursor, span.start));
    }
    cursor = Math.max(cursor, span.end);
  }
  if (cursor < text.length) {
    unclaimedSlices.push(text.slice(cursor));
  }

  const tokenRegex = /[A-Za-z0-9]+/g;
  for (const slice of unclaimedSlices) {
    tokenRegex.lastIndex = 0;
    let tokenMatch = tokenRegex.exec(slice);
    while (tokenMatch !== null) {
      const token = tokenMatch[0];
      for (const word of splitIdentifierWords(token)) {
        const what = `word:${word}`;
        if (compiled.words.has(word) && !seenWhat.has(what)) {
          seenWhat.add(what);
          hits.push({ path, line, kind: 'word', what, sample: token, astKind: 'string' });
        }
      }
      tokenMatch = tokenRegex.exec(slice);
    }
  }

  return hits;
}

function scanSourceWithCompiled(
  filePath: string,
  content: string,
  compiled: CompiledRegister,
): CompatHit[] {
  const normalizedPath = normalizePath(filePath);
  const sourceFile = ts.createSourceFile(normalizedPath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hits: CompatHit[] = [];

  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      hits.push(...scanIdentifier(node.text, node.text, normalizedPath, line, compiled));
    } else if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      hits.push(...scanStringText(node.text, normalizedPath, line, compiled));
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return hits;
}

export function compatHitsInSource(
  filePath: string,
  content: string,
  register: CompatRegister,
): CompatHit[] {
  return scanSourceWithCompiled(filePath, content, compileRegister(register));
}

function isValidWhatFormat(what: string): boolean {
  return VALID_WHAT_PREFIXES.some((prefix) => what.startsWith(prefix) && what.length > prefix.length);
}

export function compatProblemsForHits(
  hits: readonly CompatHit[],
  rawExceptions: readonly unknown[],
): string[] {
  const problems: string[] = [];
  const exceptionsByKey = new Map<string, CompatException>();

  for (let index = 0; index < rawExceptions.length; index += 1) {
    const item = rawExceptions[index];
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (record.check !== CHECK_ID) {
      continue;
    }

    const path = typeof record.path === 'string' ? normalizePath(record.path) : '';
    const what = typeof record.what === 'string' ? record.what : '';
    const reason = typeof record.reason === 'string' ? record.reason : '';
    const removeWhen = typeof record.removeWhen === 'string' ? record.removeWhen : '';

    if (!path || !what || !reason.trim() || !removeWhen.trim()) {
      problems.push(
        `.github/checks/exceptions.json[${index}]: ${CHECK_ID} entry must define non-empty path, what, reason, and removeWhen`,
      );
      continue;
    }
    if (!isValidWhatFormat(what)) {
      problems.push(
        `.github/checks/exceptions.json[${index}]: invalid what "${what}" for ${path} (expected word:, literal:, prefix:, or symbol:)`,
      );
      continue;
    }

    const key = `${path}\0${what}`;
    if (exceptionsByKey.has(key)) {
      problems.push(`.github/checks/exceptions.json[${index}]: duplicate ${CHECK_ID} entry for ${path} [${what}]`);
      continue;
    }
    exceptionsByKey.set(key, { check: CHECK_ID, path, what, reason, removeWhen });
  }

  const hitsByKey = new Map<string, { readonly first: CompatHit; count: number }>();
  for (const hit of hits) {
    const path = normalizePath(hit.path);
    const key = `${path}\0${hit.what}`;
    const existing = hitsByKey.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      hitsByKey.set(key, { first: { ...hit, path }, count: 1 });
    }
  }

  for (const [key, group] of hitsByKey.entries()) {
    if (!exceptionsByKey.has(key)) {
      problems.push(
        `${group.first.path}:${group.first.line}: unlisted compat path [${group.first.what}] (sample: "${group.first.sample}", ${group.count} hit(s))`,
      );
    }
  }

  for (const [key, entry] of exceptionsByKey.entries()) {
    if (!hitsByKey.has(key)) {
      problems.push(
        `.github/checks/exceptions.json: stale ${CHECK_ID} exception for ${entry.path} [${entry.what}] (removeWhen: ${entry.removeWhen})`,
      );
    }
  }

  return problems;
}

export function compatProblemsForSources(
  sources: readonly CompatSourceFile[],
  rawExceptions: readonly unknown[],
  register: CompatRegister,
): string[] {
  const compiled = compileRegister(register);
  const hits: CompatHit[] = [];
  for (const source of sources) {
    if (!isProductionTarget(source.path, register.excludePaths)) {
      continue;
    }
    hits.push(...scanSourceWithCompiled(source.path, source.content, compiled));
  }
  return compatProblemsForHits(hits, rawExceptions);
}

export function compatHitsInRepo(root: string = REPO_ROOT, options: CompatOptions = {}): CompatHit[] {
  const register = options.register ?? loadCompatRegister(root, options.registerPath);
  const compiled = compileRegister(register);
  const files = options.files
    ? options.files.map(normalizePath).filter((filePath) => isProductionTarget(filePath, register.excludePaths))
    : trackedProductionFiles(root, register.excludePaths);

  const hits: CompatHit[] = [];
  for (const relativePath of files) {
    const content = readFileSync(join(root, relativePath), 'utf8');
    hits.push(...scanSourceWithCompiled(relativePath, content, compiled));
  }
  return hits;
}

export function summarizeCompatHits(hits: readonly CompatHit[]): CompatHitSummary {
  const whatMap = new Map<
    string,
    { count: number; readonly files: Set<string>; readonly samples: Set<string> }
  >();
  const pairMap = new Map<
    string,
    { readonly path: string; readonly what: string; count: number; readonly lines: Set<number>; readonly samples: Set<string> }
  >();

  for (const hit of hits) {
    const path = normalizePath(hit.path);
    const whatGroup = whatMap.get(hit.what);
    if (whatGroup) {
      whatGroup.count += 1;
      whatGroup.files.add(path);
      if (whatGroup.samples.size < 5) {
        whatGroup.samples.add(`${path}:${hit.line}:${hit.sample}`);
      }
    } else {
      whatMap.set(hit.what, {
        count: 1,
        files: new Set([path]),
        samples: new Set([`${path}:${hit.line}:${hit.sample}`]),
      });
    }

    const pairKey = `${path}\0${hit.what}`;
    const pairGroup = pairMap.get(pairKey);
    if (pairGroup) {
      pairGroup.count += 1;
      pairGroup.lines.add(hit.line);
      if (pairGroup.samples.size < 4) {
        pairGroup.samples.add(hit.sample);
      }
    } else {
      pairMap.set(pairKey, {
        path,
        what: hit.what,
        count: 1,
        lines: new Set([hit.line]),
        samples: new Set([hit.sample]),
      });
    }
  }

  const byWhat: CompatWhatSummary[] = [...whatMap.entries()]
    .map(([what, group]) => ({
      what,
      count: group.count,
      files: group.files.size,
      samples: [...group.samples],
    }))
    .sort((a, b) => b.count - a.count || a.what.localeCompare(b.what));

  const pairs: CompatPairSummary[] = [...pairMap.values()]
    .map((group) => ({
      path: group.path,
      what: group.what,
      count: group.count,
      lines: [...group.lines].sort((a, b) => a - b),
      samples: [...group.samples],
    }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.what.localeCompare(b.what));

  return {
    totalHits: hits.length,
    uniquePairs: pairs.length,
    byWhat,
    pairs,
  };
}

export function compatProblems(root: string = REPO_ROOT, options: CompatOptions = {}): string[] {
  const register = options.register ?? loadCompatRegister(root, options.registerPath);
  const exceptions = options.exceptions ?? loadCompatExceptions(root, options.exceptionsPath);
  const hits = compatHitsInRepo(root, {
    register,
    ...(options.registerPath !== undefined ? { registerPath: options.registerPath } : {}),
    ...(options.files !== undefined ? { files: options.files } : {}),
  });
  return compatProblemsForHits(hits, exceptions);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(currentFile)) {
  const problems = compatProblems(REPO_ROOT);
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
  }
}
