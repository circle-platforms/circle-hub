// A test file that runs pack functions in the sandbox needs sandbox-exec, which Ubuntu CI does not have. Without a guard
// such a test fails there with SANDBOX_UNAVAILABLE instead of skipping. This check finds every tracked *.test.ts that
// imports one of the sandbox entry points below and names none of the shared guards.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

/** The imports that start a pack function under operating-system isolation, by the module that exports them. */
export const ISOLATED_ENTRY_POINTS: Readonly<Record<string, readonly string[]>> = {
  'hub/rules/api.ts': ['callPackFunction', 'callPackFunctionBatch'],
  'hub/rules/sandbox/sandbox.ts': ['callPackFunction', 'callPackFunctionBatch'],
  'hub/rules/sandbox/isolation.ts': ['isolatedCommand'],
};

/**
 * The shared guards: sandboxSkip() (hub/runs/engine/testing/harness.ts) and osIsolationAvailable() (hub/rules/api.ts) skip
 * where sandbox-exec is missing; requireOsIsolation: false is the declared synthetic opt-out of SandboxOptions.
 */
export const GUARD = /\bsandboxSkip\b|\bosIsolationAvailable\b|\brequireOsIsolation\s*:\s*false\b/;

const NAMED_IMPORT = /\bimport\s+(type\s+)?\{([^}]*)\}\s*from\s*'([^']+)'/g;
const NAMESPACE_IMPORT = /\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*'([^']+)'/g;

function target(file: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  return normalize(join(dirname(file), specifier)).split('\\').join('/');
}

/** The isolated entry points one test file imports, as `<name> from <module>`. */
export function isolatedImports(file: string, source: string): string[] {
  const found: string[] = [];
  for (const [, typeOnly, names, specifier] of source.matchAll(NAMED_IMPORT)) {
    const module = target(file, specifier);
    const entries = module === undefined ? undefined : ISOLATED_ENTRY_POINTS[module];
    if (typeOnly !== undefined || entries === undefined) continue;
    for (const raw of names.split(',')) {
      const name = raw.trim();
      if (name === '' || name.startsWith('type ')) continue;
      const imported = name.split(/\s+as\s+/)[0].trim();
      if (entries.includes(imported)) found.push(`${imported} from ${module}`);
    }
  }
  for (const [, alias, specifier] of source.matchAll(NAMESPACE_IMPORT)) {
    const module = target(file, specifier);
    const entries = module === undefined ? undefined : ISOLATED_ENTRY_POINTS[module];
    if (entries === undefined) continue;
    for (const name of entries) if (new RegExp(`\\b${alias}\\.${name}\\b`).test(source)) found.push(`${name} from ${module}`);
  }
  return found;
}

/** A problem line for a test file that imports an isolated entry point and names no guard; undefined when it is fine. */
export function guardProblem(file: string, source: string): string | undefined {
  const imports = isolatedImports(file, source);
  if (imports.length === 0 || GUARD.test(source)) return undefined;
  return `${file}: imports ${imports.join(', ')} but never uses sandboxSkip(), osIsolationAvailable() or requireOsIsolation: false, so it fails instead of skipping where sandbox-exec is missing`;
}

/** Every tracked test file outside the frozen trees that breaks the rule. */
export function guardProblems(root: string): string[] {
  const files = execFileSync('git', ['ls-files', '-z', '--', '*.test.ts'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    .split('\0')
    .filter((file) => file !== '' && !file.startsWith('foundation/') && !file.startsWith('references/'));
  const problems: string[] = [];
  for (const file of files) {
    const problem = guardProblem(file, readFileSync(join(root, file), 'utf8'));
    if (problem !== undefined) problems.push(problem);
  }
  return problems;
}
