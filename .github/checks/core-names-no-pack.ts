// Core Hub and contract sources must stay pack-agnostic (C02): no production module under hub/ or contracts/src/ may
// import from packs/, name a packs/<kind>/... path, or embed a pack id discovered from packs/{product,skill,system,workflow}/*/pack.json.
// Comments and test/support/fixture files are excluded by design; human reviewers judge comments separately.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, posix, relative, resolve } from 'node:path';
import ts from 'typescript';

export const CORE_NAMES_CHECK = 'core-names-no-pack';
export const DEFAULT_EXCEPTIONS_PATH = '.github/checks/exceptions.json';
export const PACK_KINDS = ['product', 'skill', 'system', 'workflow'] as const;

const PACK_MANIFEST_PATTERN = /^packs\/(product|skill|system|workflow)\/([^/]+)\/pack\.json$/;

export interface PackManifestInfo {
  readonly id: string;
  readonly kind: string;
  readonly manifestPath: string;
  readonly directory: string;
}

export interface SourceModule {
  readonly file: string;
  readonly source: string;
}

export interface PackNameHit {
  readonly path: string;
  readonly what: string;
  readonly lines: readonly number[];
  readonly detail: string;
}

export interface CheckException {
  readonly check: string;
  readonly path: string;
  readonly what: string;
  readonly reason: string;
  readonly removeWhen: string;
}

export interface CoreNamesOptions {
  readonly exceptionsPath?: string;
  readonly exceptions?: readonly CheckException[];
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Normalize a repository-relative path to POSIX separators without a leading dot-slash. */
export function normalizeRepoPath(filePath: string): string {
  return posix.normalize(filePath.replaceAll('\\', '/')).replace(/^\.\//, '');
}

/** True when a tracked file belongs to production code under `hub/` or `contracts/src/`. */
export function isCoreProductionFile(filePath: string): boolean {
  const normalized = normalizeRepoPath(filePath);
  if (!normalized.startsWith('hub/') && !normalized.startsWith('contracts/src/')) return false;
  if (!/\.(?:ts|mts|cts|js|mjs|cjs)$/.test(normalized) || /\.d\.[cm]?ts$/.test(normalized)) return false;
  const parts = normalized.split('/');
  const base = parts[parts.length - 1] ?? '';
  if (/\.test\.[cm]?[jt]s$/.test(base)) return false;
  if (parts.slice(1, -1).some((segment) => segment === 'testing' || segment === 'fixtures')) return false;
  if (
    base === 'fakes.ts' ||
    /-support\.ts$/.test(base) ||
    /^(?:testing|test)[-.]|[-.]testing\.ts$|^fixtures?\.ts$|[-.]fixtures?\.ts$/.test(base)
  ) {
    return false;
  }
  return true;
}

function gitListFiles(root: string, pathspecs: readonly string[]): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...pathspecs], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return out.split('\0').filter((file) => file !== '').map(normalizeRepoPath);
}

/** Dynamically load pack manifests from tracked `packs/<kind>/<name>/pack.json` files. */
export function loadPackCatalog(root: string): PackManifestInfo[] {
  const manifests = gitListFiles(root, ['packs/'])
    .filter((file) => PACK_MANIFEST_PATTERN.test(file))
    .sort(compareText);
  const packs: PackManifestInfo[] = [];
  for (const manifestPath of manifests) {
    const match = PACK_MANIFEST_PATTERN.exec(manifestPath);
    if (match === null) continue;
    const raw: unknown = JSON.parse(readFileSync(join(root, manifestPath), 'utf8'));
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`${manifestPath}: pack.json must be a JSON object`);
    }
    const id = (raw as { id?: unknown }).id;
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error(`${manifestPath}: pack.json must declare a non-empty string id`);
    }
    const kindRaw = (raw as { kind?: unknown }).kind;
    const kind = typeof kindRaw === 'string' && kindRaw.trim() !== '' ? kindRaw : match[1];
    packs.push({
      id,
      kind,
      manifestPath,
      directory: posix.dirname(manifestPath),
    });
  }
  return packs;
}

/** Load all tracked production source files under `hub/` and `contracts/src/` from Git. */
export function loadCoreProductionModules(root: string): SourceModule[] {
  const files = gitListFiles(root, ['hub/', 'contracts/src/'])
    .filter((file) => isCoreProductionFile(file))
    .sort(compareText);
  return files.map((file) => ({ file, source: readFileSync(join(root, file), 'utf8') }));
}

function resolvePackTarget(fromFile: string, specifier: string): string | undefined {
  const unix = specifier.replaceAll('\\', '/');
  if (unix === 'packs' || unix.startsWith('packs/')) {
    return posix.normalize(unix).replace(/\/+$/, '');
  }
  if (!unix.startsWith('.')) return undefined;
  const resolved = posix.normalize(posix.join(posix.dirname(fromFile), unix)).replace(/\/+$/, '');
  if (resolved === 'packs' || resolved.startsWith('packs/')) {
    return resolved;
  }
  return undefined;
}

interface Matchers {
  readonly packPathRegex: RegExp;
  readonly packIdRegex: RegExp | null;
}

function compileMatchers(packIds: readonly string[], packKinds: readonly string[]): Matchers {
  const kinds = [...new Set([...PACK_KINDS, ...packKinds.filter((k) => k.trim() !== '')])].sort(compareText);
  const packPathRegex = new RegExp(
    `(?:^|(?<=[^A-Za-z0-9_-]))(packs/(?:${kinds.map(escapeRegExp).join('|')})(?:/[A-Za-z0-9._-]+)?)(?![A-Za-z0-9_-])`,
    'g',
  );
  const uniqueIds = [...new Set(packIds.filter((id) => id.trim() !== ''))].sort(
    (a, b) => b.length - a.length || compareText(a, b),
  );
  const packIdRegex =
    uniqueIds.length === 0
      ? null
      : new RegExp(`(?<![A-Za-z0-9_-])(${uniqueIds.map(escapeRegExp).join('|')})(?![A-Za-z0-9_-])`, 'g');
  return { packPathRegex, packIdRegex };
}

interface RawHit {
  readonly what: string;
  readonly line: number;
  readonly detail: string;
}

function scanModuleWithMatchers(file: string, source: string, matchers: Matchers): PackNameHit[] {
  const normalizedFile = normalizeRepoPath(file);
  const scriptKind =
    normalizedFile.endsWith('.js') || normalizedFile.endsWith('.mjs') || normalizedFile.endsWith('.cjs')
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(normalizedFile, source, ts.ScriptTarget.Latest, true, scriptKind);
  const rawHits: RawHit[] = [];
  const handledSpecifierNodes = new Set<ts.Node>();

  const lineOf = (node: ts.Node): number => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const checkSpecifierNode = (specNode: ts.Node | undefined): void => {
    if (specNode === undefined) return;
    if (ts.isStringLiteralLike(specNode)) {
      const target = resolvePackTarget(normalizedFile, specNode.text);
      if (target !== undefined) {
        handledSpecifierNodes.add(specNode);
        rawHits.push({
          what: `import ${target}`,
          line: lineOf(specNode),
          detail: `module specifier ${JSON.stringify(specNode.text)}`,
        });
      }
      return;
    }
    if (ts.isTemplateExpression(specNode)) {
      const target = resolvePackTarget(normalizedFile, specNode.head.text);
      if (target !== undefined) {
        handledSpecifierNodes.add(specNode.head);
        rawHits.push({
          what: `import ${target}`,
          line: lineOf(specNode.head),
          detail: `dynamic template specifier ${JSON.stringify(specNode.head.text)}`,
        });
      }
    }
  };

  const checkTextNode = (node: ts.Node, rawText: string): void => {
    const unixText = rawText.replaceAll('\\', '/');
    const line = lineOf(node);
    const seenInNode = new Set<string>();
    const stripped = unixText.replace(matchers.packPathRegex, (_full, packPath: string) => {
      if (!seenInNode.has(packPath)) {
        seenInNode.add(packPath);
        rawHits.push({ what: packPath, line, detail: `pack path literal ${JSON.stringify(packPath)}` });
      }
      return ' ';
    });
    if (matchers.packIdRegex === null) return;
    for (const match of stripped.matchAll(matchers.packIdRegex)) {
      const id = match[1];
      if (id === undefined || seenInNode.has(id)) continue;
      seenInNode.add(id);
      rawHits.push({ what: id, line, detail: `string literal mentioning ${JSON.stringify(id)}` });
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      checkSpecifierNode(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      checkSpecifierNode(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if ((isDynamicImport || isRequire) && node.arguments.length >= 1) {
        checkSpecifierNode(node.arguments[0]);
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      checkSpecifierNode(node.argument.literal);
    }

    if (
      !handledSpecifierNodes.has(node) &&
      (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
    ) {
      checkTextNode(node, node.text);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  const grouped = new Map<string, { lines: Set<number>; detail: string }>();
  for (const hit of rawHits) {
    const existing = grouped.get(hit.what);
    if (existing === undefined) {
      grouped.set(hit.what, { lines: new Set([hit.line]), detail: hit.detail });
    } else {
      existing.lines.add(hit.line);
    }
  }
  return [...grouped.entries()]
    .sort((a, b) => compareText(a[0], b[0]))
    .map(([what, info]) => ({
      path: normalizedFile,
      what,
      lines: [...info.lines].sort((a, b) => a - b),
      detail: info.detail,
    }));
}

/** Extract pack imports, `packs/<kind>` paths and pack-id string literals from one TypeScript/JavaScript source. */
export function coreNameHitsInFile(
  file: string,
  source: string,
  packIds: readonly string[],
  packKinds: readonly string[] = PACK_KINDS,
): PackNameHit[] {
  return scanModuleWithMatchers(file, source, compileMatchers(packIds, packKinds));
}

/** Scan a collection of source modules against discovered packs, ignoring non-production paths. */
export function findPackNameHits(modules: readonly SourceModule[], packs: readonly PackManifestInfo[]): PackNameHit[] {
  const matchers = compileMatchers(
    packs.map((pack) => pack.id),
    packs.map((pack) => pack.kind),
  );
  const hits: PackNameHit[] = [];
  for (const mod of modules) {
    if (!isCoreProductionFile(mod.file)) continue;
    hits.push(...scanModuleWithMatchers(mod.file, mod.source, matchers));
  }
  return hits.sort((a, b) => compareText(a.path, b.path) || compareText(a.what, b.what));
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Bidirectionally verify detected pack references against `core-names-no-pack` exceptions:
 * every live `(path, what)` hit must be registered, and every registered entry must match a live hit.
 */
export function validateCoreNameExceptions(
  hits: readonly PackNameHit[],
  exceptions: readonly CheckException[],
): string[] {
  const problems: string[] = [];
  const registered = new Map<string, CheckException>();

  for (let index = 0; index < exceptions.length; index++) {
    const entry = exceptions[index];
    if (entry?.check !== CORE_NAMES_CHECK) continue;
    const rawPath = nonEmptyString(entry.path);
    const what = nonEmptyString(entry.what);
    const reason = nonEmptyString(entry.reason);
    const removeWhen = nonEmptyString(entry.removeWhen);
    if (rawPath === undefined || what === undefined || reason === undefined || removeWhen === undefined) {
      problems.push(
        `${DEFAULT_EXCEPTIONS_PATH}: ${CORE_NAMES_CHECK} entry #${index} must have non-empty string path, what, reason and removeWhen`,
      );
      continue;
    }
    const path = normalizeRepoPath(rawPath);
    const key = `${path}::${what}`;
    if (registered.has(key)) {
      problems.push(`${path}: duplicate ${CORE_NAMES_CHECK} exception for ${JSON.stringify(what)}`);
      continue;
    }
    registered.set(key, { check: CORE_NAMES_CHECK, path, what, reason, removeWhen });
  }

  const liveKeys = new Set<string>();
  for (const hit of hits) {
    const key = `${hit.path}::${hit.what}`;
    liveKeys.add(key);
    if (!registered.has(key)) {
      problems.push(`${hit.path}:${hit.lines.join(',')}: unregistered pack reference ${JSON.stringify(hit.what)} (${hit.detail})`);
    }
  }

  for (const [key, entry] of registered) {
    if (!liveKeys.has(key)) {
      problems.push(
        `${entry.path}: stale ${CORE_NAMES_CHECK} exception for ${JSON.stringify(entry.what)} (no longer hits; removeWhen: ${entry.removeWhen})`,
      );
    }
  }

  return problems;
}

/** Check an in-memory set of modules and packs against explicit exception entries. */
export function coreNameProblemsFromModules(
  modules: readonly SourceModule[],
  packs: readonly PackManifestInfo[],
  options: { readonly exceptions?: readonly CheckException[] } = {},
): string[] {
  const hits = findPackNameHits(modules, packs);
  return validateCoreNameExceptions(hits, options.exceptions ?? []);
}

function readExceptionsFile(exceptionsPath: string, displayPath: string): { entries?: CheckException[]; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(exceptionsPath, 'utf8'));
  } catch (error) {
    return { error: `${displayPath}: failed to parse JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  if (!Array.isArray(parsed)) {
    return { error: `${displayPath}: exceptions JSON must be an array` };
  }
  const entries: CheckException[] = [];
  for (let index = 0; index < parsed.length; index++) {
    const item: unknown = parsed[index];
    if (typeof item !== 'object' || item === null || typeof (item as { check?: unknown }).check !== 'string') {
      return { error: `${displayPath}: entry #${index} must be an object with a string check field` };
    }
    entries.push(item as CheckException);
  }
  return { entries };
}

/** Every unregistered or stale `core-names-no-pack` finding across tracked production files under `root`. */
export function coreNamesNoPackProblems(root: string, options: CoreNamesOptions = {}): string[] {
  const packs = loadPackCatalog(root);
  const hits = findPackNameHits(loadCoreProductionModules(root), packs);
  if (options.exceptions !== undefined) {
    return validateCoreNameExceptions(hits, options.exceptions);
  }

  const exceptionsPath =
    options.exceptionsPath === undefined ? join(root, DEFAULT_EXCEPTIONS_PATH) : resolve(root, options.exceptionsPath);
  const rel = normalizeRepoPath(relative(root, exceptionsPath));
  const displayPath =
    options.exceptionsPath === undefined
      ? DEFAULT_EXCEPTIONS_PATH
      : rel !== '' && !rel.startsWith('..')
        ? rel
        : basename(exceptionsPath);
  if (!existsSync(exceptionsPath)) {
    return [`${displayPath}: exceptions file is missing`, ...validateCoreNameExceptions(hits, [])];
  }

  const loaded = readExceptionsFile(exceptionsPath, displayPath);
  if (loaded.error !== undefined) return [loaded.error];
  return validateCoreNameExceptions(hits, loaded.entries ?? []);
}
