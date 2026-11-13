// Cross-package dependency cycle check over production TypeScript modules under hub/. Both value and type-only imports
// create package edges; hub/ports.ts, hub/listen.ts, contracts/ and packs/ are outside the hub package graph. Tarjan's
// strongly connected components (SCC) algorithm detects every package cycle (size >= 2), and every directed edge within
// each SCC is checked bidirectionally against .github/checks/exceptions.json (check === 'package-cycles').
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, posix, relative } from 'node:path';
import ts from 'typescript';

export const PACKAGE_CYCLES_CHECK = 'package-cycles';
export const DEFAULT_EXCEPTIONS_PATH = '.github/checks/exceptions.json';

export type ImportKind = 'value' | 'type';

export interface SourceModule {
  readonly file: string;
  readonly source: string;
}

export interface ModuleSpecifier {
  readonly specifier: string;
  readonly line: number;
  readonly kind: ImportKind;
}

export interface ImportSite {
  readonly file: string;
  readonly line: number;
  readonly target: string;
  readonly kind: ImportKind;
}

export interface CycleEdge {
  readonly from: string;
  readonly to: string;
  readonly sites: readonly ImportSite[];
}

export interface PackageCycle {
  readonly members: readonly string[];
  readonly edges: readonly CycleEdge[];
}

export interface CheckException {
  readonly check: string;
  readonly path: string;
  readonly what: string;
  readonly reason: string;
  readonly removeWhen: string;
}

export interface CycleCheckOptions {
  readonly exceptionsPath?: string;
  readonly exceptions?: readonly CheckException[];
  readonly leafTargets?: readonly string[];
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Normalize a repository-relative path to POSIX separators without a leading dot-slash. */
export function normalizeRepoPath(filePath: string): string {
  return posix.normalize(filePath.replaceAll('\\', '/')).replace(/^\.\//, '');
}

/** True when a tracked file belongs to production Hub code inside a `hub/<pkg>` package directory. */
export function isProductionHubFile(filePath: string): boolean {
  const normalized = normalizeRepoPath(filePath);
  if (!normalized.startsWith('hub/') || !normalized.endsWith('.ts') || normalized.endsWith('.test.ts') || normalized.endsWith('.d.ts')) {
    return false;
  }
  const parts = normalized.split('/');
  if (parts.length < 3) return false;
  if (parts.slice(1, -1).some((segment) => segment === 'testing' || segment === 'fixtures')) return false;
  const base = parts[parts.length - 1] ?? '';
  if (base === 'fakes.ts' || /-support\.ts$/.test(base) || /^testing(?:-|\.)/.test(base) || /^test-/.test(base)) return false;
  return true;
}

/** The `hub/<pkg>` package name of a production Hub module, or undefined for leaves and non-production files. */
export function packageOfHubFile(filePath: string): string | undefined {
  if (!isProductionHubFile(filePath)) return undefined;
  return normalizeRepoPath(filePath).split('/')[1];
}

function stringLiteralText(node: ts.Node | undefined): string | undefined {
  if (node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text;
  return undefined;
}

function isTypeOnlyImportClause(clause: ts.ImportClause | undefined): boolean {
  if (clause === undefined) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name === undefined && clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
    const { elements } = clause.namedBindings;
    return elements.length > 0 && elements.every((element) => element.isTypeOnly);
  }
  return false;
}

function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
    const { elements } = node.exportClause;
    return elements.length > 0 && elements.every((element) => element.isTypeOnly);
  }
  return false;
}

/** Extract all static, type, re-export and dynamic import specifiers from TypeScript source using the TS AST. */
export function extractModuleSpecifiers(file: string, source: string): ModuleSpecifier[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers: ModuleSpecifier[] = [];
  const lineOf = (node: ts.Node): number => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      const specifier = stringLiteralText(node.moduleSpecifier);
      if (specifier !== undefined) {
        specifiers.push({ specifier, line: lineOf(node), kind: isTypeOnlyImportClause(node.importClause) ? 'type' : 'value' });
      }
    } else if (ts.isExportDeclaration(node)) {
      const specifier = stringLiteralText(node.moduleSpecifier);
      if (specifier !== undefined) {
        specifiers.push({ specifier, line: lineOf(node), kind: isTypeOnlyExport(node) ? 'type' : 'value' });
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const specifier = stringLiteralText(node.argument.literal);
      if (specifier !== undefined) {
        specifiers.push({ specifier, line: lineOf(node), kind: 'type' });
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length >= 1) {
      const specifier = stringLiteralText(node.arguments[0]);
      if (specifier !== undefined) {
        specifiers.push({ specifier, line: lineOf(node), kind: 'value' });
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const specifier = stringLiteralText(node.moduleReference.expression);
      if (specifier !== undefined) {
        specifiers.push({ specifier, line: lineOf(node), kind: node.isTypeOnly ? 'type' : 'value' });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

function resolveCrossPackageTarget(
  fromFile: string,
  fromPkg: string,
  specifier: string,
  leafTargets: ReadonlySet<string>,
): { toPkg: string; target: string } | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const clean = specifier.split(/[?#]/, 1)[0] ?? specifier;
  const target = posix.normalize(posix.join(posix.dirname(fromFile), clean));
  if (leafTargets.has(target)) return undefined;
  const toPkg = packageOfHubFile(target);
  if (toPkg === undefined || toPkg === fromPkg) return undefined;
  return { toPkg, target };
}

function stronglyConnectedComponents(nodes: readonly string[], adjacency: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  function strongConnect(vertex: string): void {
    const currentIndex = nextIndex++;
    indices.set(vertex, currentIndex);
    lowlink.set(vertex, currentIndex);
    stack.push(vertex);
    onStack.add(vertex);

    const neighbors = [...(adjacency.get(vertex) ?? [])].sort(compareText);
    for (const neighbor of neighbors) {
      const neighborIndex = indices.get(neighbor);
      if (neighborIndex === undefined) {
        strongConnect(neighbor);
        lowlink.set(vertex, Math.min(lowlink.get(vertex)!, lowlink.get(neighbor)!));
      } else if (onStack.has(neighbor)) {
        lowlink.set(vertex, Math.min(lowlink.get(vertex)!, neighborIndex));
      }
    }

    if (lowlink.get(vertex) === indices.get(vertex)) {
      const component: string[] = [];
      for (;;) {
        const member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
        if (member === vertex) break;
      }
      if (component.length >= 2) components.push(component.sort(compareText));
    }
  }

  for (const node of [...nodes].sort(compareText)) {
    if (!indices.has(node)) strongConnect(node);
  }

  return components.sort((a, b) => compareText(a.join(','), b.join(',')));
}

/** Find every cross-package strongly connected component (size >= 2) and its intra-SCC edges and import sites. */
export function findPackageCycles(
  modules: readonly SourceModule[],
  options: { readonly leafTargets?: readonly string[] } = {},
): PackageCycle[] {
  const leafTargets = new Set((options.leafTargets ?? []).map(normalizeRepoPath));
  const packages = new Set<string>();
  const adjacency = new Map<string, Set<string>>();
  const edgeSites = new Map<string, ImportSite[]>();

  for (const mod of modules) {
    const file = normalizeRepoPath(mod.file);
    const fromPkg = packageOfHubFile(file);
    if (fromPkg === undefined) continue;
    packages.add(fromPkg);
    let neighbors = adjacency.get(fromPkg);
    if (neighbors === undefined) {
      neighbors = new Set<string>();
      adjacency.set(fromPkg, neighbors);
    }

    for (const spec of extractModuleSpecifiers(file, mod.source)) {
      const resolved = resolveCrossPackageTarget(file, fromPkg, spec.specifier, leafTargets);
      if (resolved === undefined) continue;
      packages.add(resolved.toPkg);
      neighbors.add(resolved.toPkg);
      const key = `${fromPkg}->${resolved.toPkg}`;
      let sites = edgeSites.get(key);
      if (sites === undefined) {
        sites = [];
        edgeSites.set(key, sites);
      }
      sites.push({ file, line: spec.line, target: resolved.target, kind: spec.kind });
    }
  }

  return stronglyConnectedComponents([...packages], adjacency).map((members) => {
    const memberSet = new Set(members);
    const edges: CycleEdge[] = [];
    for (const from of members) {
      for (const to of [...(adjacency.get(from) ?? [])].sort(compareText)) {
        if (!memberSet.has(to)) continue;
        const sites = [...(edgeSites.get(`${from}->${to}`) ?? [])].sort(
          (a, b) => compareText(a.file, b.file) || a.line - b.line || compareText(a.target, b.target) || compareText(a.kind, b.kind),
        );
        edges.push({ from, to, sites });
      }
    }
    return { members, edges };
  });
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function formatSites(sites: readonly ImportSite[]): string {
  return sites.map((site) => `${site.file}:${site.line} -> ${site.target} [${site.kind}]`).join(', ');
}

/**
 * Bidirectionally verify detected SCC edges against registered `package-cycles` exceptions:
 * every live SCC edge (`path: hub/<from>`, `what: <from> -> <to>`) must be registered, and every
 * registered entry must still match a live SCC edge.
 */
export function validateCycleExceptions(cycles: readonly PackageCycle[], exceptions: readonly CheckException[]): string[] {
  const problems: string[] = [];
  const registered = new Map<string, CheckException>();

  for (let index = 0; index < exceptions.length; index++) {
    const entry = exceptions[index];
    if (entry?.check !== PACKAGE_CYCLES_CHECK) continue;
    const path = nonEmptyString(entry.path);
    const what = nonEmptyString(entry.what);
    const reason = nonEmptyString(entry.reason);
    const removeWhen = nonEmptyString(entry.removeWhen);
    if (path === undefined || what === undefined || reason === undefined || removeWhen === undefined) {
      problems.push(`${DEFAULT_EXCEPTIONS_PATH}: package-cycles entry #${index} must have non-empty string path, what, reason and removeWhen`);
      continue;
    }
    const key = `${path}::${what}`;
    if (registered.has(key)) {
      problems.push(`${path}: duplicate package-cycles exception for ${what}`);
      continue;
    }
    registered.set(key, { check: PACKAGE_CYCLES_CHECK, path, what, reason, removeWhen });
  }

  const liveKeys = new Set<string>();
  for (const cycle of cycles) {
    const membersLabel = cycle.members.join(', ');
    for (const edge of cycle.edges) {
      const path = `hub/${edge.from}`;
      const what = `${edge.from} -> ${edge.to}`;
      const key = `${path}::${what}`;
      liveKeys.add(key);
      if (!registered.has(key)) {
        problems.push(`${path}: unregistered package cycle edge ${what} in SCC [${membersLabel}] (${formatSites(edge.sites)})`);
      }
    }
  }

  for (const [key, entry] of registered) {
    if (!liveKeys.has(key)) {
      problems.push(`${entry.path}: stale package-cycles exception for ${entry.what} (no longer part of any package cycle; removeWhen: ${entry.removeWhen})`);
    }
  }

  return problems;
}

/** Check an in-memory set of modules against an explicit list of exception entries. */
export function cycleProblemsFromModules(
  modules: readonly SourceModule[],
  options: { readonly exceptions?: readonly CheckException[]; readonly leafTargets?: readonly string[] } = {},
): string[] {
  const cycles = findPackageCycles(modules, options);
  return validateCycleExceptions(cycles, options.exceptions ?? []);
}

/** Load all tracked production TypeScript modules under `hub/` from Git. */
export function loadHubProductionModules(root: string): SourceModule[] {
  const files = execFileSync('git', ['ls-files', '-z', '--', 'hub/'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    .split('\0')
    .filter((file) => file !== '' && isProductionHubFile(file))
    .sort(compareText);
  return files.map((file) => ({ file, source: readFileSync(join(root, file), 'utf8') }));
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

/** Every unregistered or stale package cycle across tracked production Hub modules under `root`. */
export function cycleProblems(root: string, options: CycleCheckOptions = {}): string[] {
  const cycles = findPackageCycles(loadHubProductionModules(root), options);
  if (options.exceptions !== undefined) return validateCycleExceptions(cycles, options.exceptions);

  const exceptionsPath = options.exceptionsPath ?? join(root, DEFAULT_EXCEPTIONS_PATH);
  const rel = relative(root, exceptionsPath).replaceAll('\\', '/');
  const displayPath =
    options.exceptionsPath === undefined
      ? DEFAULT_EXCEPTIONS_PATH
      : rel !== '' && !rel.startsWith('..')
        ? rel
        : basename(exceptionsPath);
  if (!existsSync(exceptionsPath)) {
    return [`${displayPath}: exceptions file is missing`, ...validateCycleExceptions(cycles, [])];
  }

  const loaded = readExceptionsFile(exceptionsPath, displayPath);
  if (loaded.error !== undefined) return [loaded.error];
  return validateCycleExceptions(cycles, loaded.entries ?? []);
}
