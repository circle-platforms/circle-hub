// Static admission check for digest-pinned client skills. Never imports or executes their code.
import ts from 'typescript';
import { builtinModules } from 'node:module';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface CallReview {
  file: string;
  operation: string;
  call: string;
  snippetSha256: string;
  reviewer: string;
  date: string;
  reason: string;
}
export interface ScriptIssue { file: string; line: number; operation: string; reason: string }
export interface ScriptAudit { files: number; issues: ScriptIssue[]; reviewed: CallReview[] }

/** Only this source fragment was reviewed; no filesystem operation is exempt as a whole. */
export const REVIEWED_SKILL_CALLS: readonly CallReview[] = [{
  file: 'packs/workflow/knowledge-contribution/tools/jev/lib/local.ts',
  operation: 'rename', call: 'rename(temp,file)',
  snippetSha256: 'dc941d04ec92bda8153e6a625b5e427ee2ca266a07e3cca8fb069d3025bda418',
  reviewer: '集成者', date: '2026-10-24',
  reason: '临时文件由此方法刚用 wx 新建为普通文件，rename 只作文件原子替换；不能创建软链接，目标是目录时替换失败。',
}];
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const dynamicEntrypoints = new Set(['eval', 'Function', 'globalThis.eval', 'global.eval', 'globalThis.Function', 'global.Function', 'node:process.binding', 'node:process._linkedBinding', 'node:process.dlopen', 'node:process.execve', 'node:module.register', 'node:module.registerHooks']);
const filesystemMutations = new Set(['symlink', 'symlinkSync', 'link', 'linkSync', 'rename', 'renameSync', 'cp', 'cpSync']);
const moduleName = (value: string) => value.startsWith('node:') ? value : builtinModules.includes(value) ? 'node:' + value : value;
const unwrap = (node: ts.Expression): ts.Expression => ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isAwaitExpression(node) ? unwrap(node.expression) : node;

/** The digest covers the whole enclosing function/method, including the source of temporary-file arguments. */
export function callSnippet(source: ts.SourceFile, call: ts.CallExpression | ts.NewExpression): string {
  for (let owner: ts.Node | undefined = call.parent; owner; owner = owner.parent) if (ts.isFunctionLike(owner)) return owner.getText(source);
  return call.parent.getText(source);
}

export function scanSkillScripts(files: ReadonlyMap<string, string>, reviews: readonly CallReview[] = REVIEWED_SKILL_CALLS): ScriptAudit {
  const virtual = '/skill-static-check';
  const sources = new Map([...files].map(([file, text]) => [resolve(virtual, file), ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS)]));
  const program = ts.createProgram([...sources.keys()], { noLib: true, noResolve: true, allowJs: true, checkJs: true, target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext }, {
    getSourceFile: file => sources.get(file), getDefaultLibFileName: () => '', writeFile: () => {}, getCurrentDirectory: () => virtual,
    getDirectories: () => [], fileExists: file => sources.has(file), readFile: file => sources.get(file)?.text,
    getCanonicalFileName: file => file, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
  });
  const checker = program.getTypeChecker(); const issues: ScriptIssue[] = [], approved: CallReview[] = [];
  const reviewUses = new Map<CallReview, number>();
  const add = (file: string, source: ts.SourceFile, node: ts.Node, operation: string, reason: string) => issues.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, operation, reason });
  for (const [file] of files) {
    const source = sources.get(resolve(virtual, file))!;
    const literal = (node: ts.Expression | undefined, seen = new Set<ts.Node>()): string | null => {
      if (!node || seen.has(node)) return null; seen.add(node); node = unwrap(node);
      if (ts.isStringLiteralLike(node)) return node.text;
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) { const a = literal(node.left, seen), b = literal(node.right, seen); return a === null || b === null ? null : a + b; }
      if (ts.isIdentifier(node)) { const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration; if (declaration && ts.isVariableDeclaration(declaration)) return literal(declaration.initializer, seen); }
      return null;
    };
    const origin = (value: ts.Expression, seen = new Set<ts.Node>()): string => {
      const node = unwrap(value); if (seen.has(node)) return ''; seen.add(node);
      if (ts.isIdentifier(node)) {
        const declarations = checker.getSymbolAtLocation(node)?.declarations ?? [];
        for (const declaration of declarations) {
          if (ts.isImportSpecifier(declaration)) {
            const imported = declaration.parent.parent.parent;
            if (ts.isImportDeclaration(imported) && ts.isStringLiteral(imported.moduleSpecifier)) return moduleName(imported.moduleSpecifier.text) + '.' + (declaration.propertyName ?? declaration.name).text;
          }
          if (ts.isNamespaceImport(declaration) || ts.isImportClause(declaration)) {
            const imported = ts.isNamespaceImport(declaration) ? declaration.parent.parent : declaration.parent;
            if (ts.isImportDeclaration(imported) && ts.isStringLiteral(imported.moduleSpecifier)) return moduleName(imported.moduleSpecifier.text);
          }
          if (ts.isVariableDeclaration(declaration) && declaration.initializer) return origin(declaration.initializer, seen);
          if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
            const variable = declaration.parent.parent;
            if (ts.isVariableDeclaration(variable) && variable.initializer) return origin(variable.initializer, seen) + '.' + (declaration.propertyName ?? declaration.name).getText(source).replace(/^['"]|['"]$/g, '');
          }
        }
        return node.text === 'require' ? '@require' : node.text === 'process' ? 'node:process' : node.text;
      }
      if (ts.isPropertyAccessExpression(node)) return origin(node.expression, seen) + '.' + node.name.text;
      if (ts.isElementAccessExpression(node)) return origin(node.expression, seen) + '.' + (literal(node.argumentExpression) ?? '<dynamic>');
      if (ts.isCallExpression(node)) {
        const callee = origin(node.expression, seen);
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword || callee === '@require' || callee === 'node:process.getBuiltinModule') return moduleName(literal(node.arguments[0]) ?? '<dynamic-module>');
        if (callee === 'node:module.createRequire') return '@require';
        if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'bind') return origin(node.expression.expression, seen);
      }
      return '';
    };
    const mutation = (name: string): string | null => {
      const parts = name.split('.');
      if (name.startsWith('node:fs')) return parts.find(part => filesystemMutations.has(part)) ?? null;
      const last = parts.at(-1)!; return filesystemMutations.has(last) ? last : null;
    };
    const copyDereferences = (call: ts.CallExpression | ts.NewExpression): boolean => {
      const options = call.arguments?.[2]; if (!options || !ts.isObjectLiteralExpression(options)) return false;
      let dereferences = false;
      for (const property of options.properties) {
        if (!ts.isPropertyAssignment(property)) return false;
        const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;
        if (name === null) return false;
        if (name === 'dereference') { if (property.initializer.kind !== ts.SyntaxKind.TrueKeyword) return false; dereferences = true; }
        if (name === 'verbatimSymlinks' && property.initializer.kind !== ts.SyntaxKind.FalseKeyword) return false;
      }
      return dereferences;
    };
    const dependency = (node: ts.Node, name: string | null) => {
      if (name !== null && moduleName(name).startsWith('node:')) return;
      if (name !== null && name.startsWith('.') && (name.endsWith('.json') || sources.has(resolve(virtual, file, '..', name)))) return;
      add(file, source, node, 'import', '代码依赖不在已核对的清单内或模块名是动态值；请使用清单内自包含脚本并重新检查');
    };
    for (const diagnostic of program.getSyntacticDiagnostics(source)) issues.push({ file, line: source.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1, operation: 'parse', reason: '源码未能完整静态解析；请修正发布源码后重新检查' });
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
        const bindings = node.importClause?.namedBindings;
        if (!(bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every(value => value.isTypeOnly))) dependency(node, ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null);
      }
      if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier) {
        const name = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null; dependency(node, name);
        if (name !== null && moduleName(name).startsWith('node:fs')) add(file, source, node, 'export', '不能把文件系统接口转交给未核对的调用点；请在清单内使用明确的直接调用');
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const name = origin(node.expression), operation = mutation(name);
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || name === '@require' || name === 'node:process.getBuiltinModule')) dependency(node, literal(node.arguments[0]));
        if (operation && !((operation === 'cp' || operation === 'cpSync') && copyDereferences(node))) {
          const call = node.getText(source), snippetSha256 = digest(callSnippet(source, node));
          const review = reviews.find(row => row.file === file && row.operation === operation && row.call === call && row.snippetSha256 === snippetSha256 && row.reviewer && /^\d{4}-\d{2}-\d{2}$/.test(row.date) && row.reason);
          if (review) { reviewUses.set(review, (reviewUses.get(review) ?? 0) + 1); approved.push(review); }
          else add(file, source, node, operation, '此调用能创建链接或改名目录；请集成者逐调用点复核源码片段后决定，不按函数名整体放行');
        } else if (name.startsWith('node:child_process.') || name.startsWith('node:vm.') || name.startsWith('node:wasi.') || name.startsWith('node:worker_threads.') || name.startsWith('node:cluster.') || name.split('.').includes('constructor') || dynamicEntrypoints.has(name)) {
          add(file, source, node, name, '动态代码、原生入口或子进程未被本检查覆盖；请改为清单内可静态核对的实现，或交集成者补核对');
        } else if (name.startsWith('node:fs') && name.includes('<dynamic>')) add(file, source, node, name, '不能静态核对动态文件系统调用；请使用明确的接口后重跑检查');
      }
      if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const name = origin(node); const operation = name.startsWith('node:fs') ? mutation(name) : null;
        let expression: ts.Node = node;
        while (expression.parent && (ts.isPropertyAccessExpression(expression.parent) || ts.isElementAccessExpression(expression.parent) || ts.isParenthesizedExpression(expression.parent) || ts.isAsExpression(expression.parent) || ts.isNonNullExpression(expression.parent))) expression = expression.parent;
        const parent = expression.parent;
        const callee = parent && (ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === expression;
        const declaration = node.parent && (ts.isImportSpecifier(node.parent) || ts.isImportClause(node.parent) || ts.isNamespaceImport(node.parent) || ts.isBindingElement(node.parent) && node.parent.name === node || ts.isVariableDeclaration(node.parent) && node.parent.name === node);
        if ((operation || name.startsWith('node:fs') && name.includes('<dynamic>') || dynamicEntrypoints.has(name) || name.startsWith('node:child_process.') || name.startsWith('node:vm.') || name.startsWith('node:wasi.') || name.startsWith('node:worker_threads.') || name.startsWith('node:cluster.') || name.split('.').includes('constructor')) && !callee && !declaration) add(file, source, node, operation ?? name, '链接或改名接口被传递为值，调用点无法封闭核对；请改成明确的直接调用后交集成者复核');
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  for (const review of reviews) if (files.has(review.file) && reviewUses.get(review) !== 1) issues.push({ file: review.file, line: 1, operation: review.operation, reason: '已复核调用点不存在、片段变动或不唯一；请集成者重新核对并更新登记' });
  return { files: files.size, issues, reviewed: approved };
}

/** Static relative modules a client script names. Dynamic specifiers stay in the scan of the file that names them. */
function relativeModules(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const names: string[] = [];
  const specifier = (node: ts.Expression | undefined) => { if (node && ts.isStringLiteralLike(node) && node.text.startsWith('.')) names.push(node.text); };
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) specifier(node.moduleSpecifier);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) specifier(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/**
 * Client entry points are the tools tree and inline hooks. Hub sandbox modules under functions/ ship in the same
 * manifest but run only inside the Hub, so they are scanned when a client script actually imports them.
 */
export function clientSkillSources(files: ReadonlyMap<string, string>): Map<string, string> {
  const virtual = '/skill-static-check';
  const byResolved = new Map([...files].map(([file]) => [resolve(virtual, file), file]));
  const included = new Set<string>();
  const visit = (file: string): void => {
    if (included.has(file) || !files.has(file)) return;
    included.add(file);
    for (const name of relativeModules(file, files.get(file)!)) {
      const target = byResolved.get(resolve(virtual, file, '..', name));
      if (target) visit(target);
    }
  };
  for (const file of files.keys()) if (file.includes('/tools/') || file.includes('#')) visit(file);
  return new Map([...files].filter(([file]) => included.has(file)));
}

/** Reads the exact published bytes, including helpers and inline skill hooks; never follows a source link. */
export function scanSkillPack(directory: string, reviews: readonly CallReview[] = REVIEWED_SKILL_CALLS): ScriptAudit {
  const root = realpathSync(directory), manifest = JSON.parse(readFileSync(join(root, 'pack.json'), 'utf8')) as { id?: unknown; kind?: unknown; files?: Array<{ path: string; size: number; sha256: string }> };
  if (typeof manifest.id !== 'string' || typeof manifest.kind !== 'string' || !Array.isArray(manifest.files)) throw new Error('缺少可核对的包清单；请提供已发布目录和 pack.json 后重跑');
  const files = new Map<string, string>(), paths = new Set<string>();
  for (const entry of manifest.files) {
    if (typeof entry.path !== 'string' || isAbsolute(entry.path) || entry.path.includes('\\') || entry.path.split('/').some(part => !part || part === '.' || part === '..') || paths.has(entry.path)) throw new Error('包清单含重复或越界路径；请重新取得已发布包后重跑');
    paths.add(entry.path); const target = resolve(root, entry.path);
    let parent = root;
    for (const part of relative(root, target).split(sep)) { parent = join(parent, part); if (lstatSync(parent).isSymbolicLink()) throw new Error('包清单文件经过软链接；请使用按摘要核对的真实发布目录'); }
    const bytes = readFileSync(target); if (bytes.length !== entry.size || digest(bytes) !== entry.sha256) throw new Error('包文件与清单摘要或长度不符；请重新取得原件后重跑，不扫描改过的副本');
    const file = `packs/${manifest.kind}/${manifest.id}/${entry.path}`;
    if (/\.[cm]?[jt]sx?$/.test(entry.path)) files.set(file, new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (entry.path.endsWith('hooks.json')) {
      const hooks = JSON.parse(bytes.toString()).hooks;
      for (const [event, entries] of Object.entries(hooks ?? {})) {
        if (!Array.isArray(entries)) throw new Error('技能钩子声明不可读；请集成者核对发布清单');
        for (const [index, hook] of entries.entries()) {
          const match = typeof hook.command === 'string' ? /^node --input-type=module -e '([^']*)'$/.exec(hook.command) : null;
          if (!match) throw new Error('技能钩子命令尚不能静态核对；请改为可核对的内联 Node 源码或补充检查后重跑');
          files.set(`${file}#${event}/${index}`, match[1]);
        }
      }
    }
  }
  return scanSkillScripts(clientSkillSources(files), reviews);
}

if (import.meta.main) {
  try {
    const directories = process.argv.slice(2);
    if (!directories.length) throw new Error('缺少发布目录');
    let failed = false;
    for (const directory of directories) {
      const audit = scanSkillPack(directory);
      process.stdout.write(`静态检查：脚本 ${audit.files}；逐调用点复核 ${audit.reviewed.length}；未通过 ${audit.issues.length}\n`);
      for (const issue of audit.issues) process.stdout.write(`${issue.file}:${issue.line} ${issue.operation}：${issue.reason}\n`);
      failed ||= audit.issues.length > 0;
    }
    if (failed) process.exitCode = 1;
  } catch {
    process.stderr.write('技能脚本静态检查未完成；请提供与 pack.json 字节一致的完整发布目录，核对路径、清单和钩子格式后重跑\n');
    process.exitCode = 1;
  }
}
