import {createHash} from 'node:crypto';
// Static scan of pack functions at publish (T01 F[8], C03): every module a declared function reaches, what it imports and
// what it exports. The sandbox of hub/rules enforces the import policy at run time; this is the early warning, so a pack
// whose functions would be refused there is refused at publish instead. Type-only imports (`import type`, `export type`)
// are erased by Node's type stripping and are not imports; an import whose specifiers are all inline `type` ones is kept
// by Node as a module load, so it counts. The sandbox admits ES modules only: a .ts or .js module whose stripped code has no
// ES module syntax is loaded by Node as CommonJS, so the scan refuses it as well.
import { isBuiltin } from 'node:module';
import { posix } from 'node:path';
import type * as TS from 'typescript';
import { problem, utf8 } from './problems.ts';
import type { PackProblem } from './types.ts';

export interface ImportPolicy {
  /** Builtins pack code may import, without the node: prefix. */
  builtins: readonly string[];
  /** Packages pack code may import (resolved from the Hub, never from the pack). */
  packages: readonly string[];
}

/**
 * The sandbox's policy (hub/rules/sandbox/policy.ts: PURE_BUILTINS, DECLARED_DEPENDENCIES), copied because rules exports it
 * only to its own modules; imports.test.ts compares this copy with what the sandbox really admits through callPackFunction.
 */
export const SANDBOX_IMPORT_POLICY: ImportPolicy = Object.freeze({
  builtins: Object.freeze([
    'assert',
    'assert/strict',
    'buffer',
    'crypto',
    'events',
    'path',
    'path/posix',
    'path/win32',
    'querystring',
    'stream',
    'stream/consumers',
    'stream/promises',
    'stream/web',
    'string_decoder',
    'timers',
    'timers/promises',
    'url',
    'util',
    'util/types',
    'zlib',
  ]),
  packages: Object.freeze(['saxes', 'parse5', 'fflate', 'zod']),
});

/** A declared pack function: the module and export, and where the declaration stands (for the problem). */
export interface FunctionEntry {
  module: string;
  export: string;
  /** Declaration file and JSON Pointer of the reference, for example workflow.json and /projection. */
  file: string;
  field: string;
}

const CODE = ['.ts', '.mts', '.js', '.mjs'];
const TYPESCRIPT = ['.ts', '.mts'];
/** Extensions whose module format Node detects from the syntax (no package.json in a pack says otherwise). */
const DETECTED = ['.ts', '.js'];
/**
 * The variables of the CommonJS wrapper: a top-level lexical declaration of one makes the CommonJS parse fail, and Node
 * then loads the file as an ES module.
 */
const COMMONJS_WRAPPER = new Set(['require', 'module', 'exports', '__filename', '__dirname']);

let loaded: Promise<typeof TS> | undefined;
/** TypeScript (a declared dependency) is loaded only when a pack is scanned. */
function typescript(): Promise<typeof TS> {
  // A CommonJS module: its exports are the default export of the ES module namespace.
  if (loaded === undefined) loaded = import('typescript').then((m) => m.default as unknown as typeof TS);
  return loaded;
}

// Integrator-reviewed static-only exception (2026-10-24). Runtime policy remains unchanged.
const REVIEWED_DYNAMIC_IMPORTS:Readonly<Record<string,{sha256:string;specifiers:readonly string[]}>>=Object.freeze({
  'functions/adoc/vendor/core.mjs':{sha256:'5a8785bf8dc39a216170b836bb274957f079f77e5f40b33453c988f85de9203d',specifiers:['node:fs','node:fs/promises','node:async_hooks']},
});

interface ImportUse {
  dynamic?: boolean;
  specifier: string;
  line: number;
  json: boolean;
  /** process.getBuiltinModule('name'): only builtins count. */
  builtinOnly: boolean;
}

interface ModuleFacts {
  imports: ImportUse[];
  /** Dynamic imports whose specifier is not a string literal, and builtins taken by getBuiltinModule in a way not checkable. */
  computed: { line: number; what: 'import' | 'builtin' | 'createRequire' }[];
  unsupported: { what: string; line: number }[];
  syntax: { message: string; line: number }[];
  exports: Set<string>;
  /** Specifiers of `export * from`. */
  star: string[];
  /**
   * ES module syntax that survives type stripping, as Node's module detection sees it: an import or export declaration, an
   * exported value declaration, import.meta, top-level await, or a top-level lexical declaration of a CommonJS wrapper name.
   */
  esm: boolean;
}

function hasModifier(ts: typeof TS, node: TS.Node, kind: TS.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
}

function bindingNames(ts: typeof TS, name: TS.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) out.add(name.text);
  else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bindingNames(ts, element.name, out);
}

function literalText(ts: typeof TS, node: TS.Node | undefined): string | undefined {
  if (node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text;
  return undefined;
}

function jsonAttribute(ts: typeof TS, attributes: TS.ImportAttributes | undefined): boolean {
  return (attributes?.elements ?? []).some((e) => e.name.text === 'type' && literalText(ts, e.value) === 'json');
}

/** A property of an object literal by its name (identifier or string literal), when it is a plain `name: value`. */
function property(ts: typeof TS, object: TS.Expression | undefined, name: string): TS.Expression | undefined {
  if (object === undefined || !ts.isObjectLiteralExpression(object)) return undefined;
  for (const p of object.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : undefined;
    if (key === name) return p.initializer;
  }
  return undefined;
}

/** `import(specifier, { with: { type: 'json' } })`: the options argument written as literals. */
function dynamicJsonAttribute(ts: typeof TS, options: TS.Expression | undefined): boolean {
  return literalText(ts, property(ts, property(ts, options, 'with'), 'type')) === 'json';
}

/** `x.getBuiltinModule` or `x['getBuiltinModule']`. */
function isGetBuiltinModule(ts: typeof TS, node: TS.Node): boolean {
  if (ts.isPropertyAccessExpression(node)) return node.name.text === 'getBuiltinModule';
  return ts.isElementAccessExpression(node) && literalText(ts, node.argumentExpression) === 'getBuiltinModule';
}

const FUNCTION_KINDS = (ts: typeof TS): ReadonlySet<TS.SyntaxKind> =>
  new Set([
    ts.SyntaxKind.FunctionDeclaration,
    ts.SyntaxKind.FunctionExpression,
    ts.SyntaxKind.ArrowFunction,
    ts.SyntaxKind.MethodDeclaration,
    ts.SyntaxKind.Constructor,
    ts.SyntaxKind.GetAccessor,
    ts.SyntaxKind.SetAccessor,
    ts.SyntaxKind.ClassStaticBlockDeclaration,
  ]);

/** Declarations type stripping erases entirely: they carry no value, so an export modifier on them is no module syntax. */
function erased(ts: typeof TS, node: TS.Node): boolean {
  return ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || (ts.isModuleDeclaration(node) && !namespaceHasValues(ts, node));
}

/** A namespace with only types is erased; one with values needs a transform Node does not do. */
function namespaceHasValues(ts: typeof TS, node: TS.ModuleDeclaration): boolean {
  const body = node.body;
  if (body === undefined) return false;
  if (ts.isModuleDeclaration(body)) return namespaceHasValues(ts, body);
  if (!ts.isModuleBlock(body)) return false;
  return body.statements.some((s) => !ts.isInterfaceDeclaration(s) && !ts.isTypeAliasDeclaration(s) && !(ts.isModuleDeclaration(s) && !namespaceHasValues(ts, s)));
}

const CREATE_REQUIRE_FIX = "删掉 createRequire，也不要 getBuiltinModule('module' 或 'node:module')；本地工具只用 import 导入包内文件或 Node 内置模块";

/** A tools file that can reach createRequire: the module loader, by name, default, namespace or dynamic import. */
function exposesCreateRequire(ts: typeof TS, node: TS.ImportDeclaration): boolean {
  const spec = literalText(ts, node.moduleSpecifier);
  if (spec !== 'module' && spec !== 'node:module') return false;
  const clause = node.importClause;
  if (clause === undefined || clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return false;
  if (clause.name !== undefined) return true;
  const named = clause.namedBindings;
  if (named === undefined) return false;
  if (ts.isNamespaceImport(named)) return true;
  return named.elements.some((element) => !element.isTypeOnly && (element.propertyName ?? element.name).text === 'createRequire');
}

function analyze(ts: typeof TS, path: string, text: string, tools = false): ModuleFacts {
  const facts: ModuleFacts = { imports: [], computed: [], unsupported: [], syntax: [], exports: new Set(), star: [], esm: false };
  const kind = TYPESCRIPT.includes(posix.extname(path)) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const lineOf = (node: TS.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  // parseDiagnostics is not in the public typings but has long been on every SourceFile; read defensively.
  const diagnostics = (source as unknown as { parseDiagnostics?: readonly TS.Diagnostic[] }).parseDiagnostics;
  for (const d of Array.isArray(diagnostics) ? diagnostics.slice(0, 5) : []) {
    const line = d.start === undefined ? 1 : source.getLineAndCharacterOfPosition(d.start).line + 1;
    facts.syntax.push({ message: ts.flattenDiagnosticMessageText(d.messageText, ' '), line });
  }
  const ambient = (node: TS.Node): boolean => hasModifier(ts, node, ts.SyntaxKind.DeclareKeyword);
  const functionKinds = FUNCTION_KINDS(ts);
  // Functions entered on the way down: an await outside every function is top-level await.
  let functions = 0;
  const visit = (node: TS.Node): void => {
    if (tools && ((ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') || (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && (node.expression.text === 'exports' || node.expression.text === 'module' && node.name.text === 'exports')) || (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && (node.expression.text === 'exports' || node.expression.text === 'module' && literalText(ts, node.argumentExpression) === 'exports')))) facts.unsupported.push({ what: 'CommonJS', line: lineOf(node) });
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (clause?.phaseModifier === ts.SyntaxKind.DeferKeyword) facts.unsupported.push({ what: 'import defer', line: lineOf(node) });
      const typeOnly = clause !== undefined && clause.phaseModifier === ts.SyntaxKind.TypeKeyword;
      if (!typeOnly) facts.esm = true;
      const specifier = literalText(ts, node.moduleSpecifier);
      if (!typeOnly && specifier !== undefined) facts.imports.push({ specifier, line: lineOf(node), json: jsonAttribute(ts, node.attributes), builtinOnly: false });
      if (tools && exposesCreateRequire(ts, node)) facts.computed.push({ line: lineOf(node), what: 'createRequire' });
      return;
    }
    if (ts.isExportDeclaration(node)) {
      if (node.isTypeOnly) return;
      facts.esm = true;
      const specifier = literalText(ts, node.moduleSpecifier);
      if (specifier !== undefined) facts.imports.push({ specifier, line: lineOf(node), json: jsonAttribute(ts, node.attributes), builtinOnly: false });
      const clause = node.exportClause;
      if (clause === undefined) {
        if (specifier !== undefined) facts.star.push(specifier);
      } else if (ts.isNamespaceExport(clause)) {
        facts.exports.add(clause.name.text);
      } else {
        for (const element of clause.elements) if (!element.isTypeOnly) facts.exports.add(element.name.text);
      }
      return;
    }
    if (ts.isExportAssignment(node)) {
      if (node.isExportEquals) facts.unsupported.push({ what: 'export =', line: lineOf(node) });
      else {
        facts.exports.add('default');
        facts.esm = true;
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (!node.isTypeOnly) facts.unsupported.push({ what: 'import = require', line: lineOf(node) });
      return;
    } else if (ts.isEnumDeclaration(node) && !ambient(node)) {
      facts.unsupported.push({ what: 'enum', line: lineOf(node) });
    } else if (ts.isModuleDeclaration(node) && !ambient(node) && namespaceHasValues(ts, node)) {
      facts.unsupported.push({ what: 'namespace', line: lineOf(node) });
    } else if (ts.isParameter(node) && ts.isConstructorDeclaration(node.parent) && ts.canHaveModifiers(node)) {
      const property = (ts.getModifiers(node) ?? []).some((m) =>
        [ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword, ts.SyntaxKind.ReadonlyKeyword, ts.SyntaxKind.OverrideKeyword].includes(m.kind),
      );
      if (property) facts.unsupported.push({ what: 'constructor parameter property', line: lineOf(node) });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = literalText(ts, node.arguments[0]);
      if (tools && (specifier === 'module' || specifier === 'node:module')) facts.computed.push({ line: lineOf(node), what: 'createRequire' });
      else if (specifier === undefined) facts.computed.push({ line: lineOf(node), what: 'import' });
      else facts.imports.push({ specifier, line: lineOf(node), json: dynamicJsonAttribute(ts, node.arguments[1]), builtinOnly: false, dynamic:true });
    } else if (isGetBuiltinModule(ts, node)) {
      // Only a direct call with a literal name can be checked; any other use of it (a computed name, a reference kept for
      // later) is reported like a computed import. The module builtin exposes createRequire, which loads any package.
      const call = node.parent;
      const specifier = ts.isCallExpression(call) && call.expression === node ? literalText(ts, call.arguments[0]) : undefined;
      if (tools && (specifier === 'module' || specifier === 'node:module')) facts.computed.push({ line: lineOf(node), what: 'createRequire' });
      else if (specifier !== undefined) facts.imports.push({ specifier, line: lineOf(node), json: false, builtinOnly: true });
      else facts.computed.push({ line: lineOf(node), what: 'builtin' });
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      // `const { getBuiltinModule } = process`: the property taken out of an object.
      const key = node.propertyName ?? node.name;
      if ((ts.isIdentifier(key) || ts.isStringLiteral(key)) && key.text === 'getBuiltinModule') facts.computed.push({ line: lineOf(node), what: 'builtin' });
    } else if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      facts.esm = true;
    } else if (functions === 0 && (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier !== undefined))) {
      facts.esm = true;
    }
    if (node.parent === source && hasModifier(ts, node, ts.SyntaxKind.ExportKeyword) && !ambient(node)) {
      if (!erased(ts, node)) facts.esm = true;
      if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
        if (hasModifier(ts, node, ts.SyntaxKind.DefaultKeyword)) facts.exports.add('default');
        else if (node.name !== undefined) facts.exports.add(node.name.text);
      } else if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) bindingNames(ts, declaration.name, facts.exports);
      } else if (ts.isEnumDeclaration(node)) {
        facts.exports.add(node.name.text);
      }
    }
    if (node.parent === source && !ambient(node)) {
      // `const require = ...` at the top: the CommonJS parse fails and Node loads the file as an ES module.
      const names = new Set<string>();
      if (ts.isVariableStatement(node) && (node.declarationList.flags & ts.NodeFlags.BlockScoped) !== 0) {
        for (const declaration of node.declarationList.declarations) bindingNames(ts, declaration.name, names);
      } else if (ts.isClassDeclaration(node) && node.name !== undefined) names.add(node.name.text);
      if ([...names].some((name) => COMMONJS_WRAPPER.has(name))) facts.esm = true;
    }
    const inner = functionKinds.has(node.kind);
    if (inner) functions += 1;
    ts.forEachChild(node, visit);
    if (inner) functions -= 1;
  };
  visit(source);
  return facts;
}

/** The pack path a relative specifier names, or null when it leaves the pack. */
function resolveRelative(from: string, specifier: string): string | null {
  const target = posix.normalize(posix.join(posix.dirname(from), specifier));
  if (target === '.' || target === '..' || target.startsWith('../') || posix.isAbsolute(target)) return null;
  return target;
}

const isRelative = (s: string): boolean => s === '.' || s === '..' || s.startsWith('./') || s.startsWith('../');

/** Package name of a bare specifier: `name` or `@scope/name`. */
function packageOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * Scans the modules the entries reach (relative imports followed inside the pack) and checks each import against the policy
 * and each entry's export. Returns one problem per offending import, unsupported syntax or missing export.
 */
async function scanModules(files: ReadonlyMap<string, Uint8Array>, entries: readonly FunctionEntry[], policy: ImportPolicy, tools = false): Promise<PackProblem[]> {
  const problems: PackProblem[] = [];
  const facts = new Map<string, ModuleFacts | null>();
  const queue: string[] = [];
  for (const entry of entries) {
    if (!files.has(entry.module)) {
      problems.push(
        problem('functions.missing_module', entry.file, `${entry.file} 的 ${entry.field} 指向 ${entry.module}，包里没有这个文件`, `把模块放到 ${entry.module}，或者改正引用的路径`, {
          field: `${entry.field}/module`,
        }),
      );
      continue;
    }
    if (!facts.has(entry.module)) {
      facts.set(entry.module, null);
      queue.push(entry.module);
    }
  }
  if (queue.length === 0) return problems;
  const ts = await typescript();

  while (queue.length > 0) {
    const path = queue.shift() as string;
    const text = utf8(files.get(path) as Uint8Array);
    if (text === null) {
      problems.push(problem('functions.not_utf8', path, `${path} 不是 UTF-8 文本`, `把 ${path} 存成 UTF-8 编码`));
      continue;
    }
    let module: ModuleFacts;
    try {
      module = analyze(ts, path, text, tools);
    } catch (error) {
      // The parser recurses per nesting level: code nested deep enough overflows the stack. Unchecked is not admitted.
      const why = error instanceof RangeError ? '嵌套太深，检查器的栈不够' : '检查器无法解析它';
      problems.push(problem('functions.syntax', path, `${path} 发布时无法检查：${why}`, '把深层嵌套的表达式或语句拆成几步'));
      continue;
    }
    facts.set(path, module);
    for (const s of module.syntax) problems.push(problem('functions.syntax', path, `${path} 第 ${s.line} 行有语法错误：${s.message}`, '改正语法错误', { line: s.line }));
    for (const u of module.unsupported) {
      problems.push(problem('functions.unsupported_syntax', path, `${path} 第 ${u.line} 行用了 ${u.what}；Node 只去掉类型、不做转换，运行时会报错`, '只用可擦除的 TypeScript 语法（不用 enum、带值的 namespace、构造参数属性和 import = require）', { line: u.line }));
    }
    for (const { line, what } of module.computed) {
      problems.push(
        what === 'import'
          ? problem('functions.import_computed', path, `${path} 第 ${line} 行的动态 import 的模块名不是字符串字面量，发布时无法核对`, '用字符串字面量写模块名', { line })
          : what === 'createRequire'
            ? problem('functions.import_computed', path, `${path} 第 ${line} 行通过 createRequire 或 module 的加载器导入，发布时无法核对，而且能加载任意包`, CREATE_REQUIRE_FIX, { line })
            : problem('functions.import_computed', path, `${path} 第 ${line} 行取 getBuiltinModule 的方式发布时无法核对（只认直接以字符串字面量调用）`, "写成 process.getBuiltinModule('node:<模块名>')；包内函数只能用纯计算的内置模块", { line }),
      );
    }
    if (DETECTED.includes(posix.extname(path)) && !module.esm && module.syntax.length === 0) {
      problems.push(
        problem('functions.module_format', path, `${path} 去掉类型后没有 ES 模块语法（import、export、import.meta 或顶层 await），Node 会把它当作 CommonJS 加载，沙箱只运行 ES 模块`, `在 ${path} 里加一行 export {};`),
      );
    }
    const reviewed=REVIEWED_DYNAMIC_IMPORTS[path];
    const reviewedBytes=reviewed!==undefined&&createHash('sha256').update(files.get(path)!).digest('hex')===reviewed.sha256;
    for (const use of module.imports) {
      const at = { line: use.line };
      const spec = use.specifier;
      if (spec.startsWith('node:') || isBuiltin(spec)) {
        const name = spec.startsWith('node:') ? spec.slice(5) : spec;
        if (!isBuiltin(spec)) problems.push(problem('functions.import_builtin', path, `${path} 第 ${use.line} 行导入的 ${spec} 不是 Node 的内置模块`, '删掉这个导入', at));
        else if (!tools && !policy.builtins.includes(name) && !(reviewedBytes&&use.dynamic===true&&reviewed.specifiers.includes(spec))) {
          problems.push(problem('functions.import_builtin', path, `${path} 第 ${use.line} 行导入了内置模块 ${spec}；沙箱里的包内函数只能用纯计算的内置模块（${policy.builtins.join('、')}）`, '包内函数不读写文件、不联网、不起进程：删掉这个导入，所需的数据作为函数输入传进来', at));
        }
        continue;
      }
      if (use.builtinOnly) {
        problems.push(problem('functions.import_builtin', path, `${path} 第 ${use.line} 行用 getBuiltinModule 取 ${spec}，它不是内置模块`, '删掉这一处', at));
        continue;
      }
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(spec)) {
        problems.push(problem('functions.import_url', path, `${path} 第 ${use.line} 行按 URL 导入 ${spec}；包内函数只能导入包里的文件、纯计算的内置模块和声明的依赖`, '改成包内文件的相对路径', at));
        continue;
      }
      if (spec.startsWith('/') || spec.startsWith('#') || spec.includes('\\')) {
        problems.push(problem('functions.import_outside', path, `${path} 第 ${use.line} 行导入 ${spec}，这不是包内的相对路径`, '改成包内文件的相对路径（./ 或 ../ 开头）', at));
        continue;
      }
      if (isRelative(spec)) {
        if (/[?#%]/.test(spec)) {
          problems.push(problem('functions.import_outside', path, `${path} 第 ${use.line} 行的模块名 ${spec} 带 ?、# 或 %`, '直接写包内文件的相对路径', at));
          continue;
        }
        const target = resolveRelative(path, spec);
        if (target === null) {
          problems.push(problem('functions.import_outside', path, `${path} 第 ${use.line} 行导入 ${spec}，它指向包外；运行时沙箱只许读包内的文件`, '把需要的代码复制进包里，或者改成 import type（只用类型时）', at));
          continue;
        }
        if (!files.has(target)) {
          const hint = files.has(`${target}.ts`) ? `（写全扩展名：${spec}.ts）` : target.endsWith('.js') && files.has(`${target.slice(0, -3)}.ts`) ? '（Node 不把 .js 换成 .ts：写 .ts）' : '';
          problems.push(problem('functions.import_missing', path, `${path} 第 ${use.line} 行导入的 ${target} 不在包里${hint}`, '把文件放进包并写进 pack.json，或者改正路径', at));
          continue;
        }
        const extension = posix.extname(target);
        if (extension === '.json') {
          if (!use.json) problems.push(problem('functions.import_json', path, `${path} 第 ${use.line} 行导入 JSON 文件 ${target} 却没有写 with { type: 'json' }`, `写成 import data from '${spec}' with { type: 'json' }`, at));
        } else if (!CODE.includes(extension)) {
          problems.push(problem('functions.import_format', path, `${path} 第 ${use.line} 行导入 ${target}；包内函数只能导入 .ts、.mts、.js、.mjs 模块和 .json 数据`, '改成上面几种文件', at));
        } else if (!facts.has(target)) {
          facts.set(target, null);
          queue.push(target);
        }
        continue;
      }
      const name = packageOf(spec);
      if (!policy.packages.includes(name)) {
        problems.push(problem('functions.import_package', path, `${path} 第 ${use.line} 行导入了包 ${name}；沙箱里的包内函数只能用声明的依赖（${policy.packages.join('、')}）`, '改用声明的依赖，或者把需要的代码写进包里', at));
      }
    }
  }

  // Exports: names a module defines plus what `export *` brings from modules inside the pack (never `default`).
  const exportsOf = (path: string, seen: Set<string>): { names: Set<string>; open: boolean } => {
    const module = facts.get(path);
    if (module === undefined || module === null || seen.has(path)) return { names: new Set(), open: module === null };
    seen.add(path);
    const names = new Set(module.exports);
    let open = false;
    for (const spec of module.star) {
      const target = isRelative(spec) ? resolveRelative(path, spec) : null;
      if (target === null) {
        open = true;
        continue;
      }
      const inner = exportsOf(target, seen);
      open ||= inner.open;
      for (const name of inner.names) if (name !== 'default') names.add(name);
    }
    return { names, open };
  };
  for (const entry of tools ? [] : entries) {
    const module = facts.get(entry.module);
    if (module === undefined || module === null) continue;
    const { names, open } = exportsOf(entry.module, new Set());
    if (!open && !names.has(entry.export)) {
      const what = entry.export === 'default' ? '默认导出（export default）' : `导出 ${entry.export}`;
      problems.push(problem('functions.missing_export', entry.file, `${entry.file} 的 ${entry.field} 要调用 ${entry.module} 的${what}，这个模块没有`, `在 ${entry.module} 里导出它，或者改正引用的 export`, { field: entry.field }));
    }
  }
  return problems;
}

/** Sandboxed functions retain their runtime policy and named-export checks. */
export function scanFunctions(files: ReadonlyMap<string, Uint8Array>, entries: readonly FunctionEntry[], policy: ImportPolicy = SANDBOX_IMPORT_POLICY): Promise<PackProblem[]> {
  return scanModules(files, entries, policy);
}
/** Client-side tools have no Hub dependencies: all builtins, no third-party packages, no required export. */
const COMMONJS_EXT = new Set(['.cjs', '.cts']);

export async function scanTools(files: ReadonlyMap<string, Uint8Array>): Promise<PackProblem[]> {
  const direct: PackProblem[] = [];
  for (const path of files.keys()) {
    if (!path.startsWith('tools/') || !COMMONJS_EXT.has(posix.extname(path))) continue;
    direct.push(problem('tools.module_format', path, `${path} 是 CommonJS 模块（${posix.extname(path)}）；本地工具只运行 ES 模块，不能用 require 加载包`, '改成 .mjs、.js、.mts 或 .ts，用 import 和 export，不要用 require', { line: 1 }));
  }
  const entries = [...files.keys()].filter((path) => path.startsWith('tools/') && CODE.includes(posix.extname(path))).map((module) => ({ module, export: '', file: module, field: '' }));
  const found = await scanModules(files, entries, { builtins: [], packages: [] }, true);
  return [
    ...direct,
    ...found.map((p) => ({
      ...p, line: p.line ?? 1, rule: p.rule.replace(/^functions\./, 'tools.'),
      message: p.rule === 'functions.import_package' ? `${p.file} 第 ${p.line ?? 1} 行导入了第三方包；本地工具只能用 Node 内置模块和包内文件` : p.message.replaceAll('包内函数', '本地工具').replaceAll('沙箱只运行', '本地工具只运行'),
      fix: p.rule === 'functions.import_package' ? '本地工具只能导入 Node 内置模块和清单里的包内文件；移除第三方依赖' : p.rule === 'functions.unsupported_syntax' ? '改用 ES 模块 import/export 和可擦除的 TypeScript 语法；不使用 CommonJS' : p.rule === 'functions.import_computed' && p.fix !== CREATE_REQUIRE_FIX ? '把模块名写成字符串字面量；本地工具只导入包内文件或 Node 内置模块' : p.fix,
    })),
  ];
}
