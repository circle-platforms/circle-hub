// Enforces Hub package boundaries on production TypeScript files under hub/: cross-package imports must go through
// each package's declared entrypoint (api.ts, or index.ts for hub/config) and stay within allowed_dependencies,
// with explicit shared leaves (hub/ports.ts, hub/listen.ts, contracts/), scoped entrypoint exceptions (hub/telemetry/usage.ts),
// pack import restrictions, and strict bidirectional reconciliation against exceptions.json.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

export const CHECK_NAME = 'package-boundaries';

export interface EntrypointException {
  target: string;
  allowed_importers: readonly string[];
  reason?: string;
}

export interface PackException {
  file: string;
  import: string;
  reason?: string;
}

export interface PackageEdgesConfig {
  format_version: number;
  status?: string;
  scope?: string;
  entrypoints: Record<string, string>;
  allowed_dependencies: Record<string, readonly string[]>;
  shared_interfaces: readonly string[];
  shared_pure_modules: readonly string[];
  entrypoint_exceptions?: readonly EntrypointException[];
  leaf_prefixes?: readonly string[];
  excluded: readonly string[];
  pack_exceptions?: readonly PackException[];
}

export interface ExceptionEntry {
  check: string;
  path: string;
  what: string;
  reason?: string;
  removeWhen?: string;
}

export interface ExtractedImport {
  specifier: string;
  line: number;
  isTypeOnly: boolean;
}

export type BoundaryViolationKind =
  | 'entrypoint-bypass'
  | 'disallowed-dependency'
  | 'pack-import'
  | 'shared-interface-value-import'
  | 'shared-pure-import'
  | 'unknown-package'
  | 'unknown-target'
  | 'outside-hub';

export interface BoundaryViolation {
  kind: BoundaryViolationKind;
  path: string;
  what: string;
  target: string;
  specifier: string;
  line: number;
  fromPackage: string | null;
  toPackage: string | null;
  isTypeOnly: boolean;
  message: string;
}

export interface BoundaryScanStats {
  filesScanned: number;
  specifiersScanned: number;
  crossPackageImports: number;
}

export interface BoundaryScanResult {
  violations: BoundaryViolation[];
  stats: BoundaryScanStats;
  config: PackageEdgesConfig;
}

export interface BoundaryCheckOptions {
  edgesPath?: string;
  edges?: PackageEdgesConfig;
  exceptionsPath?: string;
  exceptions?: readonly ExceptionEntry[];
  /** Require exceptions.json on disk when `exceptions` is not provided in memory; defaults to true. */
  requireExceptionsFile?: boolean;
}

function normalizePath(file: string): string {
  const slashed = file.split('\\').join('/');
  return slashed.startsWith('./') ? posix.normalize(slashed.slice(2)) : posix.normalize(slashed);
}

/** Converts a POSIX glob pattern (`**`, `*`, `?`) into an anchored RegExp. */
export function globToRegExp(pattern: string): RegExp {
  const normalized = normalizePath(pattern);
  let regex = '^';
  let i = 0;
  while (i < normalized.length) {
    if (normalized.startsWith('**/', i)) {
      regex += '(?:.+/)?';
      i += 3;
    } else if (normalized.slice(i) === '/**') {
      regex += '/.*';
      i += 3;
    } else if (normalized.startsWith('**', i)) {
      regex += '.*';
      i += 2;
    } else if (normalized[i] === '*') {
      regex += '[^/]*';
      i += 1;
    } else if (normalized[i] === '?') {
      regex += '[^/]';
      i += 1;
    } else {
      regex += normalized[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  regex += '$';
  return new RegExp(regex);
}

export function compileExcludedMatchers(patterns: readonly string[]): RegExp[] {
  return patterns.map(globToRegExp);
}

export function isExcludedPath(file: string, matchers: readonly RegExp[]): boolean {
  const normalized = normalizePath(file);
  return matchers.some((matcher) => matcher.test(normalized));
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value as readonly string[];
}

function assertStringRecord(value: unknown, label: string): Record<string, string> {
  if (!isObjectRecord(value)) throw new Error(`${label} must be an object`);
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw new Error(`${label}.${key} must be a string`);
    out[key] = normalizePath(item);
  }
  return out;
}

function assertStringArrayRecord(value: unknown, label: string): Record<string, readonly string[]> {
  if (!isObjectRecord(value)) throw new Error(`${label} must be an object`);
  const out: Record<string, readonly string[]> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = assertStringArray(item, `${label}.${key}`);
  }
  return out;
}

/** Loads and validates a package-edges.json configuration file. */
export function loadPackageEdges(edgesPath: string): PackageEdgesConfig {
  const raw: unknown = JSON.parse(readFileSync(edgesPath, 'utf8'));
  if (!isObjectRecord(raw)) throw new Error(`${edgesPath}: expected a JSON object`);
  if (typeof raw.format_version !== 'number') throw new Error(`${edgesPath}: missing numeric format_version`);
  const entrypointExceptions = raw.entrypoint_exceptions === undefined
    ? []
    : (Array.isArray(raw.entrypoint_exceptions) ? raw.entrypoint_exceptions : (() => { throw new Error(`${edgesPath}: entrypoint_exceptions must be an array`); })()).map((item, index) => {
      if (!isObjectRecord(item) || typeof item.target !== 'string') {
        throw new Error(`${edgesPath}: entrypoint_exceptions[${index}] must have a string target`);
      }
      return {
        target: normalizePath(item.target),
        allowed_importers: assertStringArray(item.allowed_importers, `${edgesPath}: entrypoint_exceptions[${index}].allowed_importers`),
        ...(typeof item.reason === 'string' ? { reason: item.reason } : {}),
      };
    });
  const packExceptions = raw.pack_exceptions === undefined
    ? []
    : (Array.isArray(raw.pack_exceptions) ? raw.pack_exceptions : (() => { throw new Error(`${edgesPath}: pack_exceptions must be an array`); })()).map((item, index) => {
      if (!isObjectRecord(item) || typeof item.file !== 'string' || typeof item.import !== 'string') {
        throw new Error(`${edgesPath}: pack_exceptions[${index}] must have string file and import`);
      }
      return {
        file: normalizePath(item.file),
        import: normalizePath(item.import),
        ...(typeof item.reason === 'string' ? { reason: item.reason } : {}),
      };
    });
  return {
    format_version: raw.format_version,
    ...(typeof raw.status === 'string' ? { status: raw.status } : {}),
    ...(typeof raw.scope === 'string' ? { scope: raw.scope } : {}),
    entrypoints: assertStringRecord(raw.entrypoints, `${edgesPath}: entrypoints`),
    allowed_dependencies: assertStringArrayRecord(raw.allowed_dependencies, `${edgesPath}: allowed_dependencies`),
    shared_interfaces: assertStringArray(raw.shared_interfaces, `${edgesPath}: shared_interfaces`).map(normalizePath),
    shared_pure_modules: assertStringArray(raw.shared_pure_modules, `${edgesPath}: shared_pure_modules`).map(normalizePath),
    entrypoint_exceptions: entrypointExceptions,
    leaf_prefixes: raw.leaf_prefixes === undefined ? ['contracts/'] : assertStringArray(raw.leaf_prefixes, `${edgesPath}: leaf_prefixes`).map(normalizePath),
    excluded: assertStringArray(raw.excluded, `${edgesPath}: excluded`),
    pack_exceptions: packExceptions,
  };
}

/** Loads and validates exceptions.json (supports either a top-level array or `{ exceptions: [...] }`). */
export function loadExceptions(exceptionsPath: string): ExceptionEntry[] {
  const raw: unknown = JSON.parse(readFileSync(exceptionsPath, 'utf8'));
  let items: unknown[];
  if (Array.isArray(raw)) items = raw;
  else if (isObjectRecord(raw) && Array.isArray(raw.exceptions)) items = raw.exceptions;
  else if (isObjectRecord(raw) && Array.isArray(raw.entries)) items = raw.entries;
  else throw new Error(`${exceptionsPath}: expected an array or { exceptions: [...] }`);

  return items.map((item, index) => {
    if (!isObjectRecord(item) || typeof item.check !== 'string' || typeof item.path !== 'string' || typeof item.what !== 'string') {
      throw new Error(`${exceptionsPath}: entry[${index}] must have string check, path and what`);
    }
    return {
      check: item.check,
      path: normalizePath(item.path),
      what: item.what,
      ...(typeof item.reason === 'string' ? { reason: item.reason } : {}),
      ...(typeof item.removeWhen === 'string' ? { removeWhen: item.removeWhen } : {}),
    };
  });
}

function isNamedBindingsTypeOnly(clause: ts.ImportClause): boolean {
  if (clause.name !== undefined || clause.namedBindings === undefined || !ts.isNamedImports(clause.namedBindings)) {
    return false;
  }
  const elements = clause.namedBindings.elements;
  return elements.length > 0 && elements.every((element) => element.isTypeOnly);
}

function isNamedExportsTypeOnly(decl: ts.ExportDeclaration): boolean {
  if (decl.exportClause === undefined || !ts.isNamedExports(decl.exportClause)) {
    return false;
  }
  const elements = decl.exportClause.elements;
  return elements.length > 0 && elements.every((element) => element.isTypeOnly);
}

/** Extracts all static, dynamic-literal, re-export, and type-import module specifiers using the TypeScript AST. */
export function scanFileImports(file: string, source: string): ExtractedImport[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2024, true, ts.ScriptKind.TS);
  const found: ExtractedImport[] = [];

  const record = (node: ts.Node, specifier: string, isTypeOnly: boolean): void => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    found.push({ specifier, line, isTypeOnly });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const clause = node.importClause;
      const isTypeOnly = clause !== undefined && (clause.phaseModifier === ts.SyntaxKind.TypeKeyword || isNamedBindingsTypeOnly(clause));
      record(node, node.moduleSpecifier.text, isTypeOnly);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const isTypeOnly = node.isTypeOnly || isNamedExportsTypeOnly(node);
      record(node, node.moduleSpecifier.text, isTypeOnly);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length >= 1) {
      const arg = node.arguments[0];
      if (arg !== undefined && ts.isStringLiteralLike(arg)) record(node, arg.text, false);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
      record(node, node.argument.literal.text, true);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) {
      record(node, node.moduleReference.expression.text, node.isTypeOnly);
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return found;
}

function packageOfHubPath(file: string): string | null {
  const parts = file.split('/');
  if (parts[0] !== 'hub' || parts.length < 3) return null;
  return parts[1] ?? null;
}

function resolveImportTarget(fromFile: string, specifier: string): string | null {
  if (specifier.startsWith('.')) {
    return posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  }
  if (specifier.startsWith('hub/') || specifier.startsWith('packs/')) {
    return posix.normalize(specifier);
  }
  return null;
}

function recordViolation(
  out: Map<string, BoundaryViolation>,
  violation: BoundaryViolation,
): void {
  const key = `${violation.path}\0${violation.what}`;
  if (!out.has(key)) out.set(key, violation);
}

/** Checks a single Hub file's boundaries against package-edges configuration. */
export function checkFileBoundaries(
  file: string,
  source: string,
  config: PackageEdgesConfig,
  excludedMatchers: readonly RegExp[] = compileExcludedMatchers(config.excluded),
): { violations: BoundaryViolation[]; specifiersScanned: number; crossPackageImports: number } {
  const normalized = normalizePath(file);
  if (!normalized.startsWith('hub/') || isExcludedPath(normalized, excludedMatchers)) {
    return { violations: [], specifiersScanned: 0, crossPackageImports: 0 };
  }

  const sharedInterfaces = new Set(config.shared_interfaces.map(normalizePath));
  const sharedPureModules = new Set(config.shared_pure_modules.map(normalizePath));
  const leafPrefixes = config.leaf_prefixes ?? ['contracts/'];
  const entrypointExceptions = config.entrypoint_exceptions ?? [];
  const packExceptions = config.pack_exceptions ?? [];

  const fileRole: 'shared_interface' | 'shared_pure' | 'package' = sharedInterfaces.has(normalized)
    ? 'shared_interface'
    : sharedPureModules.has(normalized)
      ? 'shared_pure'
      : 'package';
  const fromPackage = fileRole === 'package' ? packageOfHubPath(normalized) : null;

  const violations = new Map<string, BoundaryViolation>();
  if (fileRole === 'package' && (fromPackage === null || !Object.hasOwn(config.entrypoints, fromPackage))) {
    const label = fromPackage ?? normalized;
    recordViolation(violations, {
      kind: 'unknown-package',
      path: normalized,
      what: `unknown-package: ${label}`,
      target: normalized,
      specifier: '',
      line: 1,
      fromPackage,
      toPackage: null,
      isTypeOnly: false,
      message: `file is not inside any declared Hub package entrypoint`,
    });
  }

  const imports = scanFileImports(normalized, source);
  let crossPackageImports = 0;

  for (const item of imports) {
    const target = resolveImportTarget(normalized, item.specifier);
    if (target === null) continue;
    if (leafPrefixes.some((prefix) => target.startsWith(prefix))) continue;

    if (target.startsWith('packs/')) {
      const allowedPack = packExceptions.some((entry) => normalizePath(entry.file) === normalized && normalizePath(entry.import) === target);
      if (!allowedPack) {
        recordViolation(violations, {
          kind: 'pack-import',
          path: normalized,
          what: `pack-import: ${target}`,
          target,
          specifier: item.specifier,
          line: item.line,
          fromPackage,
          toPackage: null,
          isTypeOnly: item.isTypeOnly,
          message: `core production code must not import pack module ${target}`,
        });
      }
      continue;
    }

    if (!target.startsWith('hub/')) {
      recordViolation(violations, {
        kind: 'outside-hub',
        path: normalized,
        what: `outside-hub: ${target}`,
        target,
        specifier: item.specifier,
        line: item.line,
        fromPackage,
        toPackage: null,
        isTypeOnly: item.isTypeOnly,
        message: `import ${item.specifier} resolves outside hub/ (${target})`,
      });
      continue;
    }

    if (sharedInterfaces.has(target) || sharedPureModules.has(target)) {
      if (fileRole === 'shared_pure' && target !== normalized) {
        recordViolation(violations, {
          kind: 'shared-pure-import',
          path: normalized,
          what: `shared-pure-import: ${target}`,
          target,
          specifier: item.specifier,
          line: item.line,
          fromPackage,
          toPackage: null,
          isTypeOnly: item.isTypeOnly,
          message: `shared pure module ${normalized} must not import hub module ${target}`,
        });
      }
      continue;
    }

    const toPackage = packageOfHubPath(target);
    if (toPackage === null || !Object.hasOwn(config.entrypoints, toPackage)) {
      recordViolation(violations, {
        kind: 'unknown-target',
        path: normalized,
        what: `unknown-target: ${target}`,
        target,
        specifier: item.specifier,
        line: item.line,
        fromPackage,
        toPackage,
        isTypeOnly: item.isTypeOnly,
        message: `import ${item.specifier} targets undeclared hub module ${target}`,
      });
      continue;
    }

    const expectedEntry = config.entrypoints[toPackage];

    if (fileRole === 'shared_interface') {
      if (!item.isTypeOnly) {
        recordViolation(violations, {
          kind: 'shared-interface-value-import',
          path: normalized,
          what: `shared-interface-value-import: ${target}`,
          target,
          specifier: item.specifier,
          line: item.line,
          fromPackage: null,
          toPackage,
          isTypeOnly: false,
          message: `shared interface ${normalized} must use type-only imports when referencing ${target}`,
        });
      }
      if (target !== expectedEntry) {
        recordViolation(violations, {
          kind: 'entrypoint-bypass',
          path: normalized,
          what: `entrypoint-bypass: ${target}`,
          target,
          specifier: item.specifier,
          line: item.line,
          fromPackage: null,
          toPackage,
          isTypeOnly: item.isTypeOnly,
          message: `shared interface ${normalized} bypasses ${expectedEntry} by importing ${target}`,
        });
      }
      continue;
    }

    if (fileRole === 'shared_pure') {
      recordViolation(violations, {
        kind: 'shared-pure-import',
        path: normalized,
        what: `shared-pure-import: ${target}`,
        target,
        specifier: item.specifier,
        line: item.line,
        fromPackage: null,
        toPackage,
        isTypeOnly: item.isTypeOnly,
        message: `shared pure module ${normalized} must not import hub package module ${target}`,
      });
      continue;
    }

    if (fromPackage === null || fromPackage === toPackage) continue;

    crossPackageImports += 1;

    const allowedByEntrypointException = entrypointExceptions.some(
      (exception) => normalizePath(exception.target) === target && exception.allowed_importers.includes(fromPackage),
    );
    if (target !== expectedEntry && !allowedByEntrypointException) {
      recordViolation(violations, {
        kind: 'entrypoint-bypass',
        path: normalized,
        what: `entrypoint-bypass: ${target}`,
        target,
        specifier: item.specifier,
        line: item.line,
        fromPackage,
        toPackage,
        isTypeOnly: item.isTypeOnly,
        message: `${fromPackage} bypasses ${expectedEntry} by importing ${target}`,
      });
    }

    const allowedTargets = config.allowed_dependencies[fromPackage] ?? [];
    if (!allowedTargets.includes(toPackage)) {
      recordViolation(violations, {
        kind: 'disallowed-dependency',
        path: normalized,
        what: `disallowed-dependency: ${target}`,
        target,
        specifier: item.specifier,
        line: item.line,
        fromPackage,
        toPackage,
        isTypeOnly: item.isTypeOnly,
        message: `${fromPackage} is not allowed to depend on ${toPackage} (imports ${target})`,
      });
    }
  }

  return {
    violations: [...violations.values()],
    specifiersScanned: imports.length,
    crossPackageImports,
  };
}

/** Scans all tracked production TypeScript files under hub/ using git ls-files. */
export function scanRepositoryBoundaries(
  root: string,
  options: { edgesPath?: string; edges?: PackageEdgesConfig } = {},
): BoundaryScanResult {
  const config = options.edges ?? loadPackageEdges(options.edgesPath ?? join(root, '.github/checks/package-edges.json'));
  const matchers = compileExcludedMatchers(config.excluded);
  const tracked = execFileSync('git', ['ls-files', '-z', '--', 'hub'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
    .split('\0')
    .map(normalizePath)
    .filter((file) => file !== '' && file.endsWith('.ts') && !isExcludedPath(file, matchers))
    .sort();

  const violations: BoundaryViolation[] = [];
  let specifiersScanned = 0;
  let crossPackageImports = 0;

  for (const file of tracked) {
    const source = readFileSync(join(root, file), 'utf8');
    const result = checkFileBoundaries(file, source, config, matchers);
    violations.push(...result.violations);
    specifiersScanned += result.specifiersScanned;
    crossPackageImports += result.crossPackageImports;
  }

  violations.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.what.localeCompare(b.what));

  return {
    violations,
    stats: {
      filesScanned: tracked.length,
      specifiersScanned,
      crossPackageImports,
    },
    config,
  };
}

/** Strictly reconciles live violations against registered exceptions in both directions (unregistered and stale fail). */
export function reconcileExceptions(
  violations: readonly BoundaryViolation[],
  exceptions: readonly ExceptionEntry[],
  checkName = CHECK_NAME,
): string[] {
  const relevant = exceptions.filter((entry) => entry.check === checkName);
  const registered = new Map<string, ExceptionEntry>();
  const problems: string[] = [];

  for (const entry of relevant) {
    const normalizedPath = normalizePath(entry.path);
    const key = `${normalizedPath}\0${entry.what}`;
    if (registered.has(key)) {
      problems.push(`${normalizedPath}: duplicate exception entry (${entry.what})`);
      continue;
    }
    registered.set(key, { ...entry, path: normalizedPath });
  }

  const matched = new Set<string>();
  for (const violation of violations) {
    const key = `${violation.path}\0${violation.what}`;
    if (registered.has(key)) {
      matched.add(key);
    } else {
      problems.push(`${violation.path}:${violation.line}: unregistered ${checkName} violation (${violation.what}) — ${violation.message}`);
    }
  }

  for (const [key, entry] of registered.entries()) {
    if (!matched.has(key)) {
      const suffix = entry.removeWhen ? ` [removeWhen: ${entry.removeWhen}]` : '';
      problems.push(`${entry.path}: stale ${checkName} exception (${entry.what}) no longer matches a live violation${suffix}`);
    }
  }

  return problems.sort();
}

/** Runs the full repository boundary check against package-edges.json and exceptions.json. */
export function boundaryProblems(root: string, options: BoundaryCheckOptions = {}): string[] {
  const { violations } = scanRepositoryBoundaries(root, options);

  let exceptions: readonly ExceptionEntry[];
  if (options.exceptions !== undefined) {
    exceptions = options.exceptions;
  } else {
    const exceptionsPath = options.exceptionsPath ?? join(root, '.github/checks/exceptions.json');
    if (!existsSync(exceptionsPath)) {
      if (options.requireExceptionsFile !== false) {
        const display = normalizePath(relative(root, exceptionsPath)) || exceptionsPath;
        return [`missing exceptions manifest: ${display} (${violations.length} live violation(s) found)`];
      }
      exceptions = [];
    } else {
      exceptions = loadExceptions(exceptionsPath);
    }
  }

  return reconcileExceptions(violations, exceptions, CHECK_NAME);
}

/** CLI entrypoint: verifies repository boundaries or prints live violations as JSON (`--dump-violations`). */
export function main(argv: readonly string[], out: (line: string) => void = (line) => console.log(line)): number {
  let root = fileURLToPath(new URL('../../', import.meta.url));
  let dump = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dump-violations') {
      dump = true;
    } else if (arg === '--root' && argv[i + 1] !== undefined) {
      root = argv[i + 1]!;
      i += 1;
    } else {
      out(`usage: node .github/checks/package-boundaries.ts [--root <dir>] [--dump-violations]`);
      return 2;
    }
  }

  if (dump) {
    const { violations, stats } = scanRepositoryBoundaries(root);
    out(JSON.stringify({ stats, violations }, null, 2));
    return 0;
  }

  const problems = boundaryProblems(root);
  for (const problem of problems) out(problem);
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
