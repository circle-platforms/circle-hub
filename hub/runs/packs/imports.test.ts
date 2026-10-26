// The static scan must see exactly what the runtime sees: an import Node's type stripping keeps is an import, one it erases
// is not; a builtin or package the sandbox admits is admitted, one it refuses is refused. Both are checked against the real
// thing (module.stripTypeScriptTypes, callPackFunction of hub/rules), so the copied policy cannot drift unnoticed.
import assert from 'node:assert/strict';
import { builtinModules, stripTypeScriptTypes } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { callPackFunction, SandboxError } from '../../rules/api.ts';
import { SANDBOX_IMPORT_POLICY, scanFunctions } from './imports.ts';
import { temporaryDirectory } from './testing/builder.ts';

let temp: { path: string; remove: () => Promise<void> };
before(async () => {
  temp = await temporaryDirectory();
});
after(() => temp?.remove());

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const DEFAULT_EXPORT = '\nexport default function probe(): unknown {\n  return 1;\n}\n';

/** Package names the scan reported as imports of one module (every snippet imports undeclared packages pkg-*). */
async function scannedPackages(source: string): Promise<Set<string>> {
  const files = new Map([['functions/m.ts', encode(source + DEFAULT_EXPORT)]]);
  const problems = await scanFunctions(files, [{ module: 'functions/m.ts', export: 'default', file: 'workflow.json', field: '/projection' }]);
  return new Set(problems.filter((p) => p.rule === 'functions.import_package').map((p) => /导入了包 (\S+)；/.exec(p.message)?.[1] ?? '?'));
}

test('type-only imports are what Node type stripping erases, no more and no less', async () => {
  const snippets = [
    "import type { A } from 'pkg-a';",
    "import { type B } from 'pkg-b';",
    "import { type C, d } from 'pkg-c';",
    "import type * as E from 'pkg-e';",
    "import type F from 'pkg-f';",
    "export type { G } from 'pkg-g';",
    "export { type H } from 'pkg-h';",
    "import 'pkg-j';",
    "export * from 'pkg-k';",
    "export * as L from 'pkg-l';",
    "const m = await import('pkg-m');",
    "type N = typeof import('pkg-n');",
    "import { type R as R2 } from 'pkg-r';",
    "import {} from 'pkg-s';",
    "// import 'pkg-u';\n/* export * from 'pkg-v'; */",
    "export type * from 'pkg-w';",
  ];
  for (const snippet of snippets) {
    let stripped: string;
    try {
      stripped = stripTypeScriptTypes(snippet, { mode: 'strip' });
    } catch {
      continue; // syntax this Node does not take at all is not an import question
    }
    // Comments survive stripping as blanks only when they are types; compare on code without comments.
    const runtime = new Set([...stripped.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').matchAll(/'(pkg-[a-z])'/g)].map((m) => m[1]));
    assert.deepEqual([...(await scannedPackages(snippet))].sort(), [...runtime].sort(), snippet);
  }
});

const specifierOf = (name: string): string => (name.startsWith('node:') ? name : `node:${name}`);

test('the copied import policy admits exactly the builtins and packages the sandbox admits', async () => {
  const packDir = join(temp.path, 'probe');
  await mkdir(join(packDir, 'functions'), { recursive: true });
  const names = [...new Set(builtinModules)].sort();
  const packages = [...SANDBOX_IMPORT_POLICY.packages, 'pg', 'typescript', 'exceljs', '@modelcontextprotocol/sdk', 'left-pad-not-installed'];
  const cases = [
    ...names.map((name) => ({ what: name, line: `import * as m from '${specifierOf(name)}';\nvoid m;` })),
    ...packages.map((name) => ({ what: name, line: `import * as m from '${name}';\nvoid m;` })),
  ];
  const results = await Promise.all(
    cases.map(async ({ what, line }, i) => {
      const module = `functions/probe-${i}.ts`;
      await writeFile(join(packDir, module), line + DEFAULT_EXPORT);
      const problems = await scanFunctions(new Map([[module, encode(line + DEFAULT_EXPORT)]]), [{ module, export: 'default', file: 'workflow.json', field: '/projection' }]);
      const scanAdmits = problems.length === 0;
      let sandboxAdmits: boolean;
      try {
        await callPackFunction({ packDir, module }, null, { timeoutMs: 20_000 }, { requireOsIsolation: false });
        sandboxAdmits = true;
      } catch (error) {
        assert.ok(error instanceof SandboxError, `${what}: ${String(error)}`);
        // Refused imports are IMPORT_NOT_DECLARED; an undeclared package that is not installed fails the same way.
        assert.equal(error.code, 'IMPORT_NOT_DECLARED', `${what}: ${error.code} ${JSON.stringify(error.detail)}`);
        sandboxAdmits = false;
      }
      return { what, scanAdmits, sandboxAdmits };
    }),
  );
  const disagreements = results.filter((r) => r.scanAdmits !== r.sandboxAdmits);
  assert.deepEqual(disagreements, [], 'the scan and the sandbox disagree');
  // The policy is not empty on either side: pure builtins and the declared packages run.
  assert.ok(results.some((r) => r.what === 'crypto' && r.sandboxAdmits));
  assert.ok(results.some((r) => r.what === 'zod' && r.sandboxAdmits));
  assert.ok(results.some((r) => r.what === 'fs' && !r.sandboxAdmits));
});

/** Scans `files` from `entry` and calls it in the sandbox from a pack directory holding the same files. */
async function scanAndRun(name: string, files: Record<string, string>, entry: string): Promise<{ scanAdmits: boolean; sandboxAdmits: boolean; detail: string }> {
  const packDir = join(temp.path, name);
  const map = new Map<string, Uint8Array>();
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(packDir, path, '..'), { recursive: true });
    await writeFile(join(packDir, path), text);
    map.set(path, encode(text));
  }
  const problems = await scanFunctions(map, [{ module: entry, export: 'default', file: 'workflow.json', field: '/projection' }]);
  try {
    await callPackFunction({ packDir, module: entry }, null, { timeoutMs: 20_000 }, { requireOsIsolation: false });
    return { scanAdmits: problems.length === 0, sandboxAdmits: true, detail: problems.map((p) => p.rule).join(',') };
  } catch (error) {
    assert.ok(error instanceof SandboxError, `${name}: ${String(error)}`);
    return { scanAdmits: problems.length === 0, sandboxAdmits: false, detail: `${problems.map((p) => p.rule).join(',')} / ${error.code}` };
  }
}

test('the scan refuses exactly the module formats the sandbox refuses: ES modules only, as Node detects them after stripping types', async () => {
  const types = 'export type T = string;\nexport {};\n';
  const helpers: [string, string, string][] = [
    ['statement-only', '.ts', 'globalThis.helperValue = 41;\n'],
    ['statement-only-js', '.js', 'globalThis.helperValue = 41;\n'],
    ['statement-only-mjs', '.mjs', 'globalThis.helperValue = 41;\n'],
    ['statement-only-mts', '.mts', 'globalThis.helperValue = 41;\n'],
    ['empty', '.ts', ''],
    ['export-empty', '.ts', 'export {};\n'],
    ['export-value', '.ts', 'export const a = 1;\n'],
    ['export-default', '.ts', 'export default 1;\n'],
    ['export-type-only', '.ts', 'export type T = string;\nglobalThis.helperValue = 41;\n'],
    ['export-interface', '.ts', 'export interface I { a: string }\nglobalThis.helperValue = 41;\n'],
    ['export-declare', '.ts', 'export declare const x: number;\nglobalThis.helperValue = 41;\n'],
    ['import-type-only', '.ts', "import type { T } from './types.ts';\nglobalThis.helperValue = 41;\n"],
    ['import-inline-type', '.ts', "import { type T } from './types.ts';\nglobalThis.helperValue = 41;\n"],
    ['export-type-from', '.ts', "export type { T } from './types.ts';\nglobalThis.helperValue = 41;\n"],
    ['import-meta', '.ts', 'globalThis.helperValue = import.meta.url.length;\n'],
    ['top-level-await', '.ts', 'await Promise.resolve(1);\n'],
    ['top-level-for-await', '.ts', 'for await (const x of []) void x;\n'],
    ['await-in-function', '.ts', 'const f = async () => {\n  await 1;\n};\nvoid f;\n'],
    ['dynamic-import-only', '.ts', "void import('./types.ts');\n"],
    ['const-require', '.ts', 'const require = 1;\nglobalThis.helperValue = require;\n'],
    ['class-module', '.ts', 'class module {}\nvoid module;\n'],
    ['var-require', '.ts', 'var require = 1;\nglobalThis.helperValue = require;\n'],
    ['function-exports', '.ts', 'function exports() {}\nvoid exports;\n'],
  ];
  const results = await Promise.all(
    helpers.map(async ([name, extension, text]) => ({
      name,
      ...(await scanAndRun(`format-${name}`, { 'functions/types.ts': types, [`functions/helper${extension}`]: text, 'functions/entry.ts': `import './helper${extension}';${DEFAULT_EXPORT}` }, 'functions/entry.ts')),
    })),
  );
  assert.deepEqual(results.filter((r) => r.scanAdmits !== r.sandboxAdmits), [], 'the scan and the sandbox disagree on a module format');
  assert.ok(results.some((r) => r.name === 'statement-only' && !r.sandboxAdmits));
  assert.ok(results.some((r) => r.name === 'export-empty' && r.sandboxAdmits));
});

test('the scan admits exactly the JSON imports the sandbox runs: static or dynamic, with the json attribute', async () => {
  const table = '{"a":1}';
  const calls: [string, string][] = [
    ['static-with', "import t from '../tables/t.json' with { type: 'json' };\nvoid t;"],
    ['static-without', "import t from '../tables/t.json';\nvoid t;"],
    ['dynamic-with', "const t = await import('../tables/t.json', { with: { type: 'json' } });\nvoid t;"],
    ['dynamic-with-quoted', "const t = await import('../tables/t.json', { 'with': { 'type': 'json' } });\nvoid t;"],
    ['dynamic-without', "const t = await import('../tables/t.json');\nvoid t;"],
    ['dynamic-assert', "const t = await import('../tables/t.json', { assert: { type: 'json' } });\nvoid t;"],
    ['dynamic-other-type', "const t = await import('../tables/t.json', { with: { type: 'css' } });\nvoid t;"],
  ];
  const results = await Promise.all(calls.map(async ([name, line]) => ({ name, ...(await scanAndRun(`json-${name}`, { 'tables/t.json': table, 'functions/entry.ts': `${line}${DEFAULT_EXPORT}` }, 'functions/entry.ts')) })));
  assert.deepEqual(results.filter((r) => r.scanAdmits !== r.sandboxAdmits), [], 'the scan and the sandbox disagree on a JSON import');
  assert.ok(results.some((r) => r.name === 'dynamic-with' && r.sandboxAdmits));
});

test('local tools admit all builtins and relative modules without requiring exported functions', async () => {
  const { scanTools } = await import('./imports.ts');
  const files = new Map([['tools/task.ts', encode("import { readFile } from 'node:fs/promises'; import '../functions/helper.ts'; void readFile;")], ['functions/helper.ts', encode("import { spawn } from 'node:child_process'; void spawn;")]]);
  assert.deepEqual(await scanTools(files), []);
  assert.deepEqual(await scanTools(new Map([['functions/unused.ts', encode("import 'zod';")]])), []);
});

test('local tools reject packages outside imports CommonJS computed loads and transforming syntax', async () => {
  const { scanTools } = await import('./imports.ts');
  for (const [source, rule] of [["import 'zod';", 'tools.import_package'], ["import '../../outside.ts';", 'tools.import_outside'], ["module.exports = 1;", 'tools.module_format'], ["const x = require('fs');", 'tools.module_format'], ["await import(process.argv[2]);", 'tools.import_computed'], ['export enum X { A }', 'tools.unsupported_syntax']]) {
    const problems = await scanTools(new Map([['tools/task.ts', encode(source!)]]));
    assert.ok(problems.some((p) => p.rule === rule), JSON.stringify(problems));
    assert.ok(problems.every((p) => p.rule.startsWith('tools.') && p.file && p.fix));
  }
});

test('local tools reject CommonJS even when mixed with ES module syntax or in mjs', async () => {
  const { scanTools } = await import('./imports.ts');
  for (const path of ['tools/task.ts', 'tools/task.mjs']) for (const text of ["export {}; require('fs');", 'export {}; module.exports = 1;', "export {}; exports['x'] = 1;"]) assert.ok((await scanTools(new Map([[path, encode(text)]]))).some((p) => p.rule === 'tools.unsupported_syntax'));
  assert.deepEqual(await scanTools(new Map([['tools/task.mjs', encode('console.log(1);')]])), []);
});

test('local tools accept every Node builtin including prefix-only builtins', async () => {
  const { scanTools } = await import('./imports.ts');
  for (const name of builtinModules) assert.deepEqual(await scanTools(new Map([['tools/task.mjs', encode(`import '${specifierOf(name)}';`)]])), [], name);
});

test('local tools refuse CommonJS files and createRequire package loads', async () => {
  const { scanTools } = await import('./imports.ts');
  const fix = "删掉 createRequire，也不要 getBuiltinModule('module' 或 'node:module')；本地工具只用 import 导入包内文件或 Node 内置模块";
  for (const path of ['tools/run.cjs', 'tools/run.cts']) {
    const problems = await scanTools(new Map([[path, encode("require('zod');\n")]]));
    assert.equal(problems.length, 1, JSON.stringify(problems));
    assert.equal(problems[0]?.rule, 'tools.module_format');
    assert.equal(problems[0]?.file, path);
    assert.equal(problems[0]?.fix.includes('require'), true);
  }
  assert.deepEqual(await scanTools(new Map([['tools/task.mjs', encode("import { builtinModules } from 'node:module';\nvoid builtinModules;\n")]])), []);
  for (const source of [
    "import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)('zod');\n",
    "import { createRequire } from 'module';\ncreateRequire(import.meta.url)('zod');\n",
    "process.getBuiltinModule('node:module').createRequire(import.meta.url)('zod');\n",
    "process.getBuiltinModule('module').createRequire(import.meta.url)('zod');\n",
  ]) {
    const problems = await scanTools(new Map([['tools/task.mjs', encode(source)]]));
    const hit = problems.find((item) => item.rule === 'tools.import_computed');
    assert.ok(hit, JSON.stringify(problems));
    assert.equal(hit.fix, fix);
  }
});

test('a reviewed browser module exempts only its exact path and bytes from static dynamic-import checks',async()=>{
 const {readFile}=await import('node:fs/promises');
 const bytes=await readFile(new URL('../../../packs/product/famx/functions/adoc/vendor/core.mjs',import.meta.url));
 const path='functions/adoc/vendor/core.mjs';const entry={module:path,export:'load',file:'product.json',field:'/producers/0/function'};
 assert.deepEqual(await scanFunctions(new Map([[path,bytes]]),[entry]),[]);
 const changed=Buffer.concat([bytes,Buffer.from('\n')]);
 assert.ok((await scanFunctions(new Map([[path,changed]]),[entry])).some(p=>p.rule==='functions.import_builtin'));
 const renamed='functions/vendor/renamed.mjs';
 assert.ok((await scanFunctions(new Map([[renamed,bytes]]),[{...entry,module:renamed}])).some(p=>p.rule==='functions.import_builtin'));
});
test('executing denied dynamic imports is still refused even at the reviewed relative path',async()=>{
 const path='functions/adoc/vendor/core.mjs',packDir=join(temp.path,'reviewed-runtime');
 await mkdir(join(packDir,'functions/adoc/vendor'),{recursive:true});
 for(const spec of ['node:fs','node:fs/promises','node:async_hooks']){
  const source=`export default async function(){return import(${JSON.stringify(spec)});}`;
  await writeFile(join(packDir,path),source);
  const scanned=await scanFunctions(new Map([[path,encode(source)]]),[{module:path,export:'default',file:'product.json',field:'/producers/0/function'}]);
  assert.ok(scanned.some(p=>p.rule==='functions.import_builtin'));
  await assert.rejects(callPackFunction({packDir,module:path},null,{}, {requireOsIsolation:false}),e=>e instanceof SandboxError&&e.code==='IMPORT_NOT_DECLARED');
 }
});
