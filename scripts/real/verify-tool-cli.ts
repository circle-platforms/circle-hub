// Publish-time verification: integrity-checked declarations and explicitly supplied synthetic invocations.
// Inspected modules are never imported. Behavior probes run only the caller's enumerated entry points.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseToolCliDeclaration } from './guard-lib.ts';

type Declaration = ReturnType<typeof parseToolCliDeclaration>;
export interface CliProbeOutcome { status: number; stdout?: string }
export interface CliProbe {
  argv: string[];
  cwd: string;
  /** Exact subcommand whose stdin contract is exercised, or null for the base form. */
  subcommand: string | null;
  /** Synthetic values in declaration order. No production environment is inherited. */
  stdinValues: string[];
  complete: CliProbeOutcome;
  /** Explicit expected result for empty stdin; required when the declaration requires input. */
  empty?: CliProbeOutcome;
}
export interface CliVerification { declarations: number; invocations: number; processes: number }

function fileBytes(root: string, rel: string): Buffer {
  assert.ok(rel && !isAbsolute(rel) && !rel.includes('\\') && rel.split('/').every(part => part && part !== '.' && part !== '..'), 'manifest path must be relative and canonical');
  let current = root;
  assert.ok(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), 'staged root must be a real directory');
  for (const part of rel.split('/')) {
    current = join(current, part);
    assert.ok(!lstatSync(current).isSymbolicLink(), 'manifest paths must not traverse symlinks');
  }
  assert.ok(lstatSync(current).isFile(), 'manifest entry must be a regular file');
  return readFileSync(current);
}

/** `helpers` is an explicit release inventory, never inferred from module text or export names. */
export function verifyCliManifest(stagedDirectory: string, helpers: ReadonlySet<string>): Map<string, Declaration> {
  const root = resolve(stagedDirectory);
  const manifest = JSON.parse(fileBytes(root, 'pack.json').toString()) as { files: { path: string; sha256: string; size: number }[] };
  assert.ok(Array.isArray(manifest.files), 'manifest must declare files');
  const listed = new Set<string>(); const declarations = new Map<string, Declaration>();
  for (const entry of manifest.files) {
    assert.equal(typeof entry.path, 'string'); assert.ok(!listed.has(entry.path), 'manifest paths must be unique'); listed.add(entry.path);
    const bytes = fileBytes(root, entry.path);
    assert.equal(bytes.length, entry.size, `size mismatch: ${entry.path}`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `digest mismatch: ${entry.path}`);
    if (entry.path.startsWith('tools/') && entry.path.endsWith('.cli.json')) {
      const tool = `${entry.path.slice(0, -'.cli.json'.length)}.ts`;
      const declaration = parseToolCliDeclaration(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      assert.ok(declaration.options !== null, `publish CLI requires tool-cli@2: ${entry.path}`);
      assert.ok(declaration.stdinLines !== null || declaration.subcommandStdin !== null, `stdin contract is unknown: ${entry.path}`);
      declarations.set(tool, declaration);
    }
  }
  for (const tool of declarations.keys()) assert.ok(listed.has(tool) && !helpers.has(tool), `orphan or conflicting declaration: ${tool}`);
  for (const helper of helpers) assert.ok(listed.has(helper), `helper is not in manifest: ${helper}`);
  for (const file of listed) {
    if (file.startsWith('tools/') && file.endsWith('.ts') && !file.endsWith('.test.ts')) assert.ok(declarations.has(file) || helpers.has(file), `missing executable/helper declaration: ${file}`);
  }
  return declarations;
}

/** Every declared executable gets one or more caller-authored probes, with no argument or status inference. */
export function verifyCliInvocations(
  stagedDirectory: string,
  helpers: ReadonlySet<string>,
  probes: Readonly<Record<string, readonly CliProbe[]>>,
): CliVerification {
  const root = resolve(stagedDirectory); const declarations = verifyCliManifest(root, helpers);
  let invocations = 0; let processes = 0;
  for (const tool of Object.keys(probes)) assert.ok(declarations.has(tool), `probe names an undeclared executable: ${tool}`);
  for (const [tool, declaration] of declarations) {
    const cases = probes[tool]; assert.ok(cases?.length, `missing synthetic invocation: ${tool}`);
    const exercised = new Set<string | null>();
    for (const probe of cases) {
      invocations++; exercised.add(probe.subcommand);
      const stdin = probe.subcommand === null ? declaration.stdinLines : declaration.subcommandStdin?.[probe.subcommand];
      assert.ok(stdin, `stdin contract is unknown for probe: ${tool}`);
      assert.equal(probe.stdinValues.length, stdin.length, `stdin arity mismatch: ${tool}`);
      assert.ok(probe.stdinValues.every(value => !/[\r\n\0]/.test(value)), 'stdin values must each occupy one line');
      if (probe.subcommand !== null) assert.equal(probe.argv[0], probe.subcommand, 'probe must select its declared subcommand');
      const run = (input: string, expected: CliProbeOutcome) => {
        const result = spawnSync(process.execPath, [join(root, tool), ...probe.argv], { cwd: probe.cwd, input, encoding: 'utf8', env: { NODE_NO_WARNINGS: '1' }, timeout: 30_000 });
        processes++;
        assert.ok(!result.error, `synthetic invocation did not complete: ${tool}`);
        assert.equal(result.status, expected.status, `unexpected synthetic exit status: ${tool}`);
        if (expected.stdout !== undefined) assert.equal(result.stdout, expected.stdout, `unexpected synthetic output: ${tool}`);
      };
      run(probe.stdinValues.length ? `${probe.stdinValues.join('\n')}\n` : '', probe.complete);
      if (stdin.length) {
        assert.ok(probe.empty, `missing explicit empty-stdin outcome: ${tool}`);
        assert.notEqual(probe.empty.status, probe.complete.status, `empty stdin must distinguish this input contract: ${tool}`);
        run('', probe.empty);
      }
    }
    for (const subcommand of Object.keys(declaration.subcommandStdin ?? {})) assert.ok(exercised.has(subcommand), `missing subcommand probe: ${tool} ${subcommand}`);
  }
  return { declarations: declarations.size, invocations, processes };
}
