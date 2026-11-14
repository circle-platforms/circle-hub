// Presentation slots are data origins, not a dictionary of phrases or an exception list.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export interface SourceModule { file: string; source: string }
export interface ProseRoutingHit { file: string; line: number; column: number; operation: string; detail: string }
const TEXT = 1, ITEMS = 2, STACK = 4, MARKUP = 8;
// Existing error, note and diagnostic presentation fields. Structured code/reason/role are not prose origins.
const proseFields = new Set(['message', 'fix', 'text', 'missing_fact', 'next_action', 'missing', 'diagnostics', 'notices']);
const collectionFields = new Set(['missing', 'diagnostics', 'notices']);
const stringMethods = new Set(['includes', 'startsWith', 'endsWith', 'indexOf', 'lastIndexOf', 'match', 'matchAll', 'search', 'replace', 'replaceAll', 'split']);
type Fn = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;
const isFn = (n: ts.Node): n is Fn => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);
const unwrap = (n: ts.Expression): ts.Expression => ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isTypeAssertionExpression(n) || ts.isNonNullExpression(n) || ts.isSatisfiesExpression(n) ? unwrap(n.expression) : n;
const nameOf = (n: ts.Node | undefined): string | undefined => n && (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n)) ? n.text : undefined;

export function isProseRoutingFile(file: string): boolean {
  const path = file.replaceAll('\\', '/');
  return path.startsWith('hub/server/') && path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('.d.ts');
}

function punctuation(text: string): boolean { return [...text].every(char => /[\p{P}\p{S}\s\p{Cc}]/u.test(char)); }
function encodingText(text: string): boolean {
  return punctuation(text) || /^&(?:#[0-9]+|#x[0-9a-f]+|[a-z]+);$/i.test(text) || /^\\[xu][0-9a-f]*$/i.test(text);
}
/** A conservative regex grammar for punctuation/control formatting, not natural-language recognition. */
function punctuationPattern(pattern: string): boolean {
  let inClass = false, previous = -1;
  for (let i = 0; i < pattern.length; i++) {
    let char = pattern[i], code = char.codePointAt(0)!;
    if (char === '\\') {
      const rest = pattern.slice(i + 1), hex = /^(?:u([0-9a-f]{4})|x([0-9a-f]{2}))/i.exec(rest);
      if (hex) { code = parseInt(hex[1] ?? hex[2], 16); char = String.fromCodePoint(code); i += hex[0].length; }
      else {
        const escaped = pattern[++i];
        if (escaped === undefined) return false;
        if ('srntfv'.includes(escaped)) { previous = -1; continue; }
        if (/[A-Za-z0-9]/.test(escaped)) return false;
        char = escaped; code = char.codePointAt(0)!;
      }
    } else {
      if (char === '[') { inClass = true; previous = -1; continue; }
      if (char === ']') { inClass = false; previous = -1; continue; }
      if (char === '^' && inClass) return false;
      if (char === '.' && !inClass) return false;
      if (!inClass && '^$?*+()|'.includes(char)) continue;
      if (char === '-' && inClass) {
        const tail = /^\\(?:u([0-9a-f]{4})|x([0-9a-f]{2}))/i.exec(pattern.slice(i + 1));
        if (!tail) return false;
        const end = parseInt(tail[1] ?? tail[2], 16);
        if (!(previous >= 0 && previous <= end && (end <= 31 || previous >= 127 && end <= 159))) return false;
        i += tail[0].length; previous = end; continue;
      }
    }
    if (!punctuation(char)) return false;
    previous = code;
  }
  return !inClass;
}

/** Source-only fixed-point analysis: never imports or executes a renderer, service or fixture. */
export function proseRoutingHits(modules: readonly SourceModule[]): ProseRoutingHit[] {
  const input = modules.filter(module => isProseRoutingFile(module.file));
  const texts = new Map(input.map(module => [resolve('/prose-routing', module.file), module.source]));
  const host = ts.createCompilerHost({ noLib: true, noResolve: true });
  host.fileExists = path => texts.has(resolve(path));
  host.directoryExists = path => [...texts.keys()].some(file => file.startsWith(resolve(path) + '/'));
  host.getCurrentDirectory = () => '/prose-routing';
  host.readFile = path => texts.get(resolve(path));
  host.getSourceFile = (path, languageVersion) => {
    const source = texts.get(resolve(path));
    return source === undefined ? undefined : ts.createSourceFile(path, source, languageVersion, true, ts.ScriptKind.TS);
  };
  const program = ts.createProgram([...texts.keys()], { noLib: true, noResolve: true, target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext }, host);
  if (program.getSyntacticDiagnostics().length) throw new Error('成句检查的输入存在语法错误，不能跳过检查');
  const checker = program.getTypeChecker();
  const files = program.getSourceFiles(), nodes: ts.Node[] = [];
  const symbols = new Map<ts.Symbol, number>(), returns = new Map<Fn, number>(), returnedExpressions = new Map<Fn, ts.Expression[]>();
  const parameterInputs = new Map<ts.Symbol, Set<ts.Expression>>();
  function symbol(node: ts.Node): ts.Symbol | undefined {
    const found = checker.getSymbolAtLocation(node);
    if (found && found.flags & ts.SymbolFlags.Alias) {
      const target = checker.getAliasedSymbol(found);
      if (target.declarations?.length) return target;
    }
    return found;
  }
  function functionOf(expression: ts.Expression): Fn | undefined {
    const value = unwrap(expression);
    if (isFn(value)) return value;
    const found = symbol(ts.isPropertyAccessExpression(value) ? value.name : value);
    for (const declaration of found?.declarations ?? []) {
      if (isFn(declaration)) return declaration;
      if (ts.isVariableDeclaration(declaration) && declaration.initializer && isFn(unwrap(declaration.initializer))) return unwrap(declaration.initializer) as Fn;
    }
    return undefined;
  }
  function initializer(expression: ts.Expression): ts.Expression | undefined {
    const value = unwrap(expression);
    if (!ts.isIdentifier(value)) return undefined;
    const declaration = symbol(value)?.valueDeclaration;
    return declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
  }
  function literal(expression: ts.Expression | undefined, seen = new Set<ts.Node>()): string | undefined {
    if (!expression || seen.has(expression)) return undefined;
    seen.add(expression); const value = unwrap(expression);
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
    if (ts.isRegularExpressionLiteral(value)) return value.text.slice(1, value.text.lastIndexOf('/'));
    if (ts.isTemplateExpression(value)) {
      let result = value.head.text;
      for (const span of value.templateSpans) { const part = literal(span.expression, new Set(seen)); if (part === undefined) return undefined; result += part + span.literal.text; }
      return result;
    }
    if (ts.isNewExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === 'RegExp') return literal(value.arguments?.[0], seen);
    if (ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression) && value.expression.expression.getText() === 'String' && value.expression.name.text === 'fromCharCode' && value.arguments.every(arg => ts.isNumericLiteral(arg))) return String.fromCharCode(...value.arguments.map(arg => Number((arg as ts.NumericLiteral).text)));

    const init = initializer(value); return init ? literal(init, seen) : undefined;
  }
  function htmlText(base: ts.Expression): boolean {
    // Html.text is serialized markup, not a new natural-language origin. Its tainted interpolation still propagates.
    function contains(type: ts.Type): boolean {
      return type.isUnionOrIntersection() ? type.types.some(contains) : (type.aliasSymbol ?? type.getSymbol())?.declarations?.some(node => ts.isClassDeclaration(node) && node.name?.text === 'Html') === true;
    }
    return contains(checker.getTypeAtLocation(base));
  }
  function formalInput(base: ts.Expression): boolean {
    const value=unwrap(base);if(!ts.isIdentifier(value))return false;
    const declaration=symbol(value)?.valueDeclaration;
    if(!declaration||!ts.isParameter(declaration)||!declaration.type)return false;
    // z.infer<typeof AnInputSchema> is an authored parameter grammar, not a message/fix text slot.
    const type=declaration.type;
    return ts.isTypeReferenceNode(type)&&type.typeArguments?.some(arg=>ts.isTypeQueryNode(arg))===true;
  }
  function property(base: ts.Expression, key: string, seen: Set<ts.Node>): number {
    const value = unwrap(base);
    if (seen.has(value)) return 0;
    const next = new Set(seen); next.add(value);
    if (ts.isObjectLiteralExpression(value)) {
      const entry = value.properties.find(entry => 'name' in entry && nameOf(entry.name) === key);
      if (entry && ts.isPropertyAssignment(entry)) return flow(entry.initializer, next);
      if (entry && ts.isShorthandPropertyAssignment(entry)) return flow(entry.name, next);
    }
    const init = initializer(value);
    if (init) return property(init, key, next);
    if (ts.isCallExpression(value)) {
      const fn = functionOf(value.expression);
      if (fn) return (returnedExpressions.get(fn) ?? []).reduce((all, expr) => all | property(expr, key, next), 0);
    }
    if (ts.isIdentifier(value)) {
      const inputs = parameterInputs.get(symbol(value)!);
      if (inputs) return [...inputs].reduce((all, expr) => all | property(expr, key, next), 0);
    }
    return 0;
  }
  function flow(expression: ts.Expression | undefined, seen = new Set<ts.Node>()): number {
    if (!expression || seen.has(expression)) return 0;
    const value = unwrap(expression), next = new Set(seen); next.add(expression);
    if (ts.isIdentifier(value)) return (symbols.get(symbol(value)!) ?? 0) | (htmlText(value) ? MARKUP : 0);
    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
      const key = ts.isPropertyAccessExpression(value) ? value.name.text : nameOf(value.argumentExpression);
      if (key) {
        const local = property(value.expression, key, next) | (symbols.get(symbol(ts.isPropertyAccessExpression(value) ? value.name : value)!) ?? 0);
        if (local) return local;
        if (key === 'stack') return TEXT | STACK;
        if (proseFields.has(key) && !(key === 'text' && (htmlText(value.expression) || flow(value.expression, next) & MARKUP))) return collectionFields.has(key) ? ITEMS : TEXT;
        if (key === 'text' && (htmlText(value.expression) || flow(value.expression, next) & MARKUP)) return flow(value.expression, next) | MARKUP;
      }
      return ts.isElementAccessExpression(value) && flow(value.expression, next) & ITEMS ? TEXT | (flow(value.expression, next) & (STACK | MARKUP)) : 0;
    }
    if (ts.isArrayLiteralExpression(value)) { const flags=value.elements.reduce((all,element)=>all|flow(element as ts.Expression,next),0); return (flags & (TEXT | ITEMS) ? ITEMS : 0) | (flags & (STACK | MARKUP)); }
    if (ts.isTemplateExpression(value)) return value.templateSpans.some(span => flow(span.expression, next) & (TEXT | ITEMS)) ? TEXT : 0;
    if (ts.isTaggedTemplateExpression(value)) return (ts.isTemplateExpression(value.template) && value.template.templateSpans.some(span => flow(span.expression, next) & (TEXT | ITEMS)) ? TEXT : 0) | (htmlText(value) ? MARKUP : 0);
    if (ts.isConditionalExpression(value)) return flow(value.whenTrue, next) | flow(value.whenFalse, next);
    if (ts.isBinaryExpression(value)) return [ts.SyntaxKind.PlusToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(value.operatorToken.kind) ? flow(value.left, next) | flow(value.right, next) : 0;
    if (ts.isAwaitExpression(value)) return flow(value.expression, next);
    if (ts.isNewExpression(value)) return (value.arguments?.some(arg => flow(arg, next) & (TEXT | ITEMS)) ? TEXT : 0) | (htmlText(value) ? MARKUP : 0);
    if (ts.isCallExpression(value)) {
      const call = operation(value);
      if (call) {
        const source = flow(call.receiver, next);
        if (['test', 'includes', 'startsWith', 'endsWith', 'indexOf', 'lastIndexOf', 'some', 'every', 'findIndex'].includes(call.method)) return 0;
        if (['match', 'matchAll', 'exec', 'split'].includes(call.method)) return (source & (TEXT | ITEMS) || value.arguments.some(arg => flow(arg, next) & (TEXT | ITEMS)) ? ITEMS : 0) | (source & (STACK | MARKUP));
        if (call.method === 'join') return (source & ITEMS ? TEXT : 0) | (source & (STACK | MARKUP));
        if (['map', 'flatMap', 'filter', 'find'].includes(call.method)) {
          const fn = value.arguments[0] && functionOf(value.arguments[0]);
          const result = fn ? returns.get(fn) ?? 0 : 0;
          return call.method === 'filter' ? source : call.method === 'find' ? (source & ITEMS ? TEXT : 0) | (source & (STACK | MARKUP)) : fn ? (result & (TEXT | ITEMS) ? ITEMS : 0) | (result & (STACK | MARKUP)) : source;
        }
        if (['trim', 'trimStart', 'trimEnd', 'replace', 'replaceAll', 'slice', 'substring', 'substr', 'concat', 'toString', 'toLowerCase', 'toUpperCase', 'normalize'].includes(call.method)) return source;
      }
      const fn = functionOf(value.expression);
      if (fn) return returns.get(fn) ?? 0;
      return value.arguments.some(arg => flow(arg, next) & (TEXT | ITEMS)) ? TEXT : 0;
    }
    return 0;
  }
  function operation(call: ts.CallExpression): { method: string; receiver: ts.Expression } | undefined {
    let expression=unwrap(call.expression);
    const seen=new Set<ts.Node>();
    while(ts.isIdentifier(expression)&&!seen.has(expression)) { seen.add(expression);const init=initializer(expression);if(!init)break;expression=unwrap(init); }
    if(ts.isCallExpression(expression)&&ts.isPropertyAccessExpression(expression.expression)&&expression.expression.name.text==='bind') {
      const member=unwrap(expression.expression.expression);
      if(ts.isPropertyAccessExpression(member))return {method:member.name.text,receiver:expression.arguments[0]??member.expression};
    }
    if (ts.isPropertyAccessExpression(expression)) return { method: expression.name.text, receiver: expression.expression };
    if (ts.isElementAccessExpression(expression)) {
      const method = literal(expression.argumentExpression); if (method) return { method, receiver: expression.expression };
    }
    return undefined;
  }
  let changed = false;
  function add(name: ts.Node, value: number): void {
    const key = symbol(name); if (!key || !value) return;
    const old = symbols.get(key) ?? 0;
    if ((old | value) !== old) { symbols.set(key, old | value); changed = true; }
  }
  function bind(name: ts.BindingName, value: ts.Expression, supplied = flow(value)): void {
    if (ts.isIdentifier(name)) { add(name, supplied); return; }
    for (const entry of name.elements) {
      if (ts.isOmittedExpression(entry)) continue;
      const key = nameOf(entry.propertyName ?? (ts.isIdentifier(entry.name) ? entry.name : undefined));
      const part = ts.isObjectBindingPattern(name) && key ? property(value, key, new Set()) || (proseFields.has(key) ? collectionFields.has(key) ? ITEMS : TEXT : 0) : supplied & ITEMS ? TEXT : 0;
      bind(entry.name, value, part);
    }
  }
  function visit(node: ts.Node, fn?: Fn): void {
    nodes.push(node);
    const current = isFn(node) ? node : fn;
    if (isFn(node) && !ts.isBlock(node.body ?? node) && node.body) returnedExpressions.set(node, [node.body as ts.Expression]);
    if (ts.isReturnStatement(node) && node.expression && current) {
      const values = returnedExpressions.get(current) ?? []; values.push(node.expression); returnedExpressions.set(current, values);
    }
    ts.forEachChild(node, child => visit(child, current));
  }
  files.forEach(file => visit(file));
  do {
    changed = false;
    for (const node of nodes) {
      if (ts.isVariableDeclaration(node) && node.initializer) bind(node.name, node.initializer);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) add(ts.isPropertyAccessExpression(node.left) ? node.left.name : node.left, flow(node.right));
      if (ts.isCallExpression(node)) {
        const fn = functionOf(node.expression);
        if (fn) fn.parameters.forEach((param, index) => {
          const arg = node.arguments[index]; if (!arg) return;
          bind(param.name, arg);
          if (ts.isIdentifier(param.name)) {
            const key = symbol(param.name); if (!key) return;
            const inputs = parameterInputs.get(key) ?? new Set<ts.Expression>();
            if (!inputs.has(arg)) { inputs.add(arg); parameterInputs.set(key, inputs); changed = true; }
          }
        });
        const call = operation(node), callback = node.arguments[0] && functionOf(node.arguments[0]);
        if (call && callback && ['map', 'flatMap', 'filter', 'some', 'every', 'find', 'findIndex'].includes(call.method) && flow(call.receiver) & (ITEMS | MARKUP) && callback.parameters[0]) add(callback.parameters[0].name, (flow(call.receiver) & ITEMS ? TEXT : 0) | (flow(call.receiver) & (STACK | MARKUP)));
        if (call && ['replace', 'replaceAll'].includes(call.method) && flow(call.receiver) && node.arguments[1]) {
          const replacement = functionOf(node.arguments[1]); if (replacement?.parameters[0]) add(replacement.parameters[0].name, TEXT);
        }
      }
    }
    for (const [fn, expressions] of returnedExpressions) {
      const old = returns.get(fn) ?? 0, value = expressions.reduce((all, expression) => all | flow(expression), old);
      if (old !== value) { returns.set(fn, value); changed = true; }
    }
  } while (changed);

  function encodingLookup(node: ts.ElementAccessExpression): boolean {
    let base = unwrap(node.expression); const init = initializer(base); if (init) base = unwrap(init);
    return ts.isObjectLiteralExpression(base) && base.properties.length > 0 && base.properties.every(entry => ts.isPropertyAssignment(entry) &&
      nameOf(entry.name)?.length === 1 && punctuation(nameOf(entry.name)!) && typeof literal(entry.initializer) === 'string' && encodingText(literal(entry.initializer)!));
  }
  function safeReplacement(expression: ts.Expression | undefined): boolean {
    if (!expression) return false;
    const text = literal(expression); if (text !== undefined) return encodingText(text);
    const fn = functionOf(expression); if (!fn) return false;
    let safe = true;
    function walk(node: ts.Node): void {
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && !encodingText(node.text)) {
        const parent=node.parent;
        if (!(node.text === '0' && ts.isCallExpression(parent) && operation(parent)?.method === 'padStart')) safe = false;
      }
      ts.forEachChild(node, walk);
    }
    walk(fn); return safe;
  }
  function decoration(expression: ts.Expression, subject: ts.Expression): { valid: boolean; contains: boolean } {
    const trimmed = (node: ts.Expression): ts.Expression => {
      const value = unwrap(node);
      return ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression) && ['trim','trimStart','trimEnd'].includes(value.expression.name.text) && value.arguments.length === 0 ? trimmed(value.expression.expression) : value;
    };
    const value = trimmed(expression), source = trimmed(subject);
    if (ts.isIdentifier(value) && ts.isIdentifier(source) && symbol(value) === symbol(source)) return { valid: true, contains: true };
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return { valid: punctuation(value.text), contains: false };
    if (ts.isTemplateExpression(value)) {
      const parts = value.templateSpans.map(span => decoration(span.expression, subject));
      return { valid: punctuation(value.head.text) && value.templateSpans.every(span => punctuation(span.literal.text)) && parts.every(part => part.valid), contains: parts.some(part => part.contains) };
    }
    if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const a = decoration(value.left, subject), b = decoration(value.right, subject);
      return { valid: a.valid && b.valid, contains: a.contains || b.contains };
    }
    return { valid: false, contains: false };
  }
  function punctuationUse(node: ts.CallExpression, subject: ts.Expression): boolean {
    const parent = node.parent;
    if (!ts.isConditionalExpression(parent) || parent.condition !== node) return false;
    const a = decoration(parent.whenTrue, subject), b = decoration(parent.whenFalse, subject);
    return a.valid && a.contains && b.valid && b.contains;
  }
  function regexExpression(expression: ts.Expression | undefined): boolean {
    if (!expression) return false;
    const value = unwrap(expression), init = initializer(value);
    return ts.isRegularExpressionLiteral(value) || ts.isNewExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === 'RegExp' || !!init && regexExpression(init);
  }
  function markupText(expression: ts.Expression): boolean {
    const value = unwrap(expression);
    if (flow(value) & MARKUP) return true;
    if (ts.isPropertyAccessExpression(value) && value.name.text === 'text' && htmlText(value.expression)) return true;
    const init = initializer(value); if (init) return markupText(init);
    if (ts.isCallExpression(value)) { const op = operation(value); return !!op && ['replace','replaceAll','trim','slice'].includes(op.method) && markupText(op.receiver); }
    return false;
  }
  function markupPattern(expression: ts.Expression, seen=new Set<ts.Node>()): boolean {
    if(seen.has(expression))return false;seen.add(expression);const value=unwrap(expression),init=initializer(value);
    if(init)return markupPattern(init,seen);const text=literal(value);
    return text!==undefined?markupNeedle(text):ts.isTemplateExpression(value)&&markupNeedle(value.head.text);
  }
  function parameterText(expression: ts.Expression): boolean {
    const value=unwrap(expression);
    if(ts.isCallExpression(value)){const op=operation(value);return !!op&&['trim','trimStart','trimEnd'].includes(op.method)&&parameterText(op.receiver);}
    return ts.isPropertyAccessExpression(value)&&value.name.text==='text'&&formalInput(value.expression);
  }
  function markupNeedle(text: string): boolean { return /<\/?[A-Za-z][^>]*|(?:^|[\s>])[a-z][a-z0-9-]*=["']/i.test(text); }
  function cwdValue(expression: ts.Expression, seen = new Set<ts.Node>()): boolean {
    if (seen.has(expression)) return false; seen.add(expression);
    const value = unwrap(expression), init = initializer(value);
    if (init && cwdValue(init, seen)) return true;
    if (ts.isCallExpression(value) && value.expression.getText() === 'process.cwd' && value.arguments.length === 0) return true;
    if (ts.isConditionalExpression(value)) return cwdValue(value.whenTrue, seen) || cwdValue(value.whenFalse, seen);
    return false;
  }
  function stackGrammar(call: ts.CallExpression, op: {method: string; receiver: ts.Expression}): boolean {
    if (!(flow(op.receiver) & STACK)) return false;
    const arg = call.arguments[0], text = literal(arg);
    if (op.method === 'startsWith' && text === 'at ') {
      let control: ts.Node = call;
      if (ts.isPrefixUnaryExpression(control.parent) && control.parent.operator === ts.SyntaxKind.ExclamationToken) control = control.parent;
      if (ts.isIfStatement(control.parent) && control.parent.expression === control) {
        const statement = control.parent.thenStatement;
        if (ts.isContinueStatement(statement)) return true;
        if (ts.isReturnStatement(statement) && statement.expression) { const part=decoration(statement.expression,op.receiver); return part.valid && part.contains; }
      }
    }
    if (op.method === 'includes' && text !== undefined && text.startsWith('/') && text.endsWith('/')) return true;
    if (!['replace','replaceAll'].includes(op.method)) return false;
    const replacement = literal(call.arguments[1]);
    if (replacement === undefined || !/^(?:\$[1-9][0-9]*|[\/.: -])*$/.test(replacement)) return false;
    if (text !== undefined && regexExpression(arg)) return text.startsWith('(?:file:') || text.startsWith('\\/');
    if (text !== undefined && (text.startsWith('file://') || text.startsWith('/'))) return true;
    const pattern = arg && unwrap(arg);
    return !!pattern && ts.isTemplateExpression(pattern) && (pattern.head.text === '' || pattern.head.text === 'file://') && pattern.templateSpans.every(span => cwdValue(span.expression) && span.literal.text === '/');
  }
  function enclosingFunction(node: ts.Node): Fn | undefined {
    for (let parent=node.parent;parent;parent=parent.parent) if(isFn(parent)) return parent;
    return undefined;
  }
  function registryValidator(fn: Fn): boolean {
    if (!fn.body || !ts.isBlock(fn.body) || fn.parameters.length !== 1 || !ts.isIdentifier(fn.parameters[0].name)) return false;
    const body=fn.body.statements;
    if(body.length!==2 || !ts.isIfStatement(body[0]) || !ts.isReturnStatement(body[1]) || !body[1].expression || !ts.isIdentifier(body[1].expression) || symbol(body[1].expression)!==symbol(fn.parameters[0].name)) return false;
    const refusal=ts.isBlock(body[0].thenStatement)?body[0].thenStatement.statements:[body[0].thenStatement];
    if(refusal.length!==1 || !ts.isThrowStatement(refusal[0]))return false;
    const condition=body[0].expression;
    return ts.isPrefixUnaryExpression(condition) && condition.operator===ts.SyntaxKind.ExclamationToken && ts.isCallExpression(condition.operand) && ['some','includes','has'].includes(operation(condition.operand)?.method??'');
  }
  function validationOnlyExtraction(call: ts.CallExpression): boolean {
    // A parser may extract command tokens solely for a closed-registry assertion, not for rendered choices.
    const fn=enclosingFunction(call); if(!fn)return false;
    const uses=nodes.filter((node):node is ts.CallExpression=>ts.isCallExpression(node)&&functionOf(node.expression)===fn);
    return uses.length>0 && uses.every(use=>{
      if(!ts.isForOfStatement(use.parent)||use.parent.expression!==use)return false;
      const owner=enclosingFunction(use.parent);if(!owner||returnedExpressions.get(owner)?.length)return false;
      const body=ts.isBlock(use.parent.statement)?use.parent.statement.statements:[use.parent.statement];
      return body.length===1 && ts.isExpressionStatement(body[0]) && ts.isCallExpression(body[0].expression) && !!functionOf(body[0].expression.expression) && registryValidator(functionOf(body[0].expression.expression)!);
    });
  }
  function groupingLookup(call: ts.CallExpression): boolean {
    const op=operation(call), key=call.arguments[0];
    if(op?.method!=='get'||!key||!ts.isIdentifier(op.receiver))return false;
    const map=initializer(op.receiver), tuple=initializer(key);
    if(!map||!ts.isNewExpression(map)||!ts.isIdentifier(map.expression)||map.expression.text!=='Map'||map.arguments?.length)return false;
    if(!tuple||!ts.isCallExpression(tuple)||tuple.expression.getText()!=='JSON.stringify'||!tuple.arguments[0]||!ts.isArrayLiteralExpression(tuple.arguments[0]))return false;
    const pair=call.parent;
    if(!ts.isBinaryExpression(pair)||pair.left!==call||pair.operatorToken.kind!==ts.SyntaxKind.QuestionQuestionToken||!ts.isObjectLiteralExpression(pair.right))return false;
    const entries=tuple.arguments[0].elements, fallback=pair.right;
    if(!entries.length||!entries.every(entry=>ts.isPropertyAccessExpression(entry)&&fallback.properties.some(value=>ts.isPropertyAssignment(value)&&nameOf(value.name)===entry.name.text&&value.initializer.getText()===entry.getText())))return false;
    const writes=nodes.filter((node):node is ts.CallExpression=>ts.isCallExpression(node)&&operation(node)?.method==='set'&&ts.isPropertyAccessExpression(node.expression)&&symbol(node.expression.expression)===symbol(op.receiver));
    return writes.length>0&&writes.every(write=>write.arguments[0]&&symbol(write.arguments[0])===symbol(key)&&write.arguments[1]&&ts.isIdentifier(write.arguments[1])&&initializer(write.arguments[1])===pair);
  }
  const hits: ProseRoutingHit[] = [];
  function hit(node: ts.Node, method: string): void {
    const sf = node.getSourceFile(), site=ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)?node.expression.name:node, position = sf.getLineAndCharacterOfPosition(site.getStart(sf));
    const file = sf.fileName.slice(resolve('/prose-routing').length + 1).replaceAll('\\', '/');
    hits.push({ file, line: position.line + 1, column: position.character + 1, operation: method,
      detail: '成句文字经别名或调用流入内容匹配、语义替换或索引；请改用结构化事实，不设文句例外' });
  }
  for (const node of nodes) {
    if (ts.isElementAccessExpression(node) && node.argumentExpression && flow(node.argumentExpression) & (TEXT | ITEMS) && !encodingLookup(node) && !literal(node.argumentExpression)) hit(node, 'computed-index');
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsEqualsToken,ts.SyntaxKind.ExclamationEqualsEqualsToken,ts.SyntaxKind.EqualsEqualsToken,ts.SyntaxKind.ExclamationEqualsToken].includes(node.operatorToken.kind)) {
      const pairs=[[node.left,node.right],[node.right,node.left]] as const;
      if(pairs.some(([value,expected])=>{const text=literal(expected);return !!(flow(value)&(TEXT|ITEMS))&&text!==undefined&&text.length>0&&!punctuation(text)&&!(parameterText(value)&&/^[a-z][a-z0-9+.-]*:$/.test(text));})) hit(node,'text-equality');
    }
    if(ts.isSwitchStatement(node)&&flow(node.expression)&(TEXT|ITEMS)&&node.caseBlock.clauses.some(clause=>ts.isCaseClause(clause)&&literal(clause.expression)!==undefined)) hit(node,'text-switch');
    if (!ts.isCallExpression(node)) continue;
    const call = operation(node); if (!call) continue;
    if (['get','has','hasOwnProperty'].includes(call.method) && node.arguments[0] && flow(node.arguments[0]) & (TEXT|ITEMS) && !groupingLookup(node)) hit(node,'text-key');
    if (call.method==='hasOwn' && node.arguments[1] && flow(node.arguments[1]) & (TEXT|ITEMS)) hit(node,'text-key');
    if (call.method === 'test' || call.method === 'exec') {
      const subject = node.arguments[0]; if (!subject || !(flow(subject) & (TEXT | ITEMS))) continue;
      if (stackGrammar(node, call)) continue;
      const pattern = literal(call.receiver);
      if (pattern !== undefined && punctuationPattern(pattern) && punctuationUse(node, subject)) continue;
      hit(node, call.method); continue;
    }
    if (!stringMethods.has(call.method) || !(flow(call.receiver) & (TEXT | ITEMS))) continue;
    const argument = node.arguments[0], text = literal(argument);
    const regex = regexExpression(argument);
    const formatting = text !== undefined && (regex ? punctuationPattern(text) : punctuation(text));
    if (stackGrammar(node, call)) continue;
    if (argument && markupText(call.receiver) && markupPattern(argument)) continue;
    if (call.method === 'startsWith' && parameterText(call.receiver) && text !== undefined && /^[a-z][a-z0-9+.-]*:$/.test(text)) continue;
    if (['replace','replaceAll'].includes(call.method) && text !== undefined && /^<[^<>\r\n]+>$/.test(text)) continue;
    if (call.method === 'matchAll' && validationOnlyExtraction(node)) continue;
    if (call.method === 'split' && formatting) continue;
    if (['replace', 'replaceAll'].includes(call.method) && formatting && safeReplacement(node.arguments[1])) continue;
    if (formatting && punctuationUse(node, call.receiver)) continue;
    hit(node, call.method);
  }
  return hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
}

export function loadProseRoutingModules(root: string): SourceModule[] {
  const paths = execFileSync('git', ['ls-files', '-z', '--', 'hub/server'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(isProseRoutingFile);
  return paths.map(file => ({ file, source: readFileSync(join(root, file), 'utf8') }));
}
export function proseRoutingProblems(root: string): string[] {
  return proseRoutingHits(loadProseRoutingModules(root)).map(hit => `${hit.file}:${hit.line}:${hit.column} ${hit.operation}: ${hit.detail}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = proseRoutingProblems(process.cwd());
  for (const problem of problems) process.stderr.write(problem + '\n');
  if (problems.length) process.exitCode = 1;
}
