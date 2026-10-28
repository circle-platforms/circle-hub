// Bind explicit text values to the original Python signature without expanding defaults or evaluating expressions.
import type { RuntimeEntry } from './runtime-contract.ts';
import type { PlanStep, KeywordValue } from './slots.ts';
export interface BoundValue { name: string; value: KeywordValue; pointer: string }
export interface BindProblem { code: string; pointer: string; message: string }
export function bindArguments(method: RuntimeEntry, step: PlanStep, at: string, executorProvided: ReadonlySet<string> = new Set()): { values: BoundValue[]; problems: BindProblem[] } {
  const values: BoundValue[] = []; const problems: BindProblem[] = [];
  const issue = (code: string, pointer: string, message: string) => problems.push({ code, pointer, message });
  const supplied = step.args.length + Object.keys(step.keywords).length;
  if (supplied === 0) issue('param_arity', at, '运行器把空 G 当作一个位置参数 None，至少写一个显式值；无参数调用在该格式下不能表达');
  const positional = method.parameters.filter((p) => p.kind === 'positional_only' || p.kind === 'positional_or_keyword');
  const variadic = method.parameters.find((p) => p.kind === 'var_positional');
  for (const [i, value] of step.args.entries()) {
    const param = positional[i] ?? variadic;
    if (!param) issue('param_arity', `${at}/args/${i}`, '多余的位置参数');
    else values.push({ name: param.name, value, pointer: `${at}/args/${i}` });
  }
  for (const [name, value] of Object.entries(step.keywords)) {
    const pointer = `${at}/keywords/${name.replaceAll('~', '~0').replaceAll('/', '~1')}`;
    const param = method.parameters.find((p) => p.name === name);
    if (!param || param.kind === 'var_positional' || param.kind === 'var_keyword') issue('param_arity', pointer, '关键字不是签名里可直接传入的参数');
    else if (param.kind === 'positional_only') issue('param_keyword', pointer, '仅位置参数不能用关键字传入');
    else if (values.some((v) => v.name === name)) issue('param_arity', pointer, '同一参数重复传入');
    else values.push({ name, value, pointer });
  }
  for (const param of method.parameters) {
    // A required parameter the executor supplies (the previous step's return) is not the plan's to provide.
    if (supplied > 0 && param.required && !executorProvided.has(param.name) && !values.some((v) => v.name === param.name) && !Object.hasOwn(step.keywords, param.name)) issue('param_arity', at, `缺必填参数 ${param.name}`);
    if (param.redacted) for (const value of values.filter((v) => v.name === param.name)) issue('param_sensitive', value.pointer, '脱敏凭据参数不许出现在计划里');
  }
  for (const v of values) {
    if (typeof v.value === 'number') { if (!Number.isSafeInteger(v.value) || v.value < 0) issue('param_value', v.pointer, '整数关键字必须是安全非负整数'); }
    else if (!(step.restore_for!==undefined&&step.input_register!==undefined&&v.pointer===at+'/args/0'&&v.value==='{}')&&!hasSingleLineValue(v.value)) issue('param_value', v.pointer, '参数值必须是有效单行原文，首尾无空白、不以 = 开头、没有 {} 或 {0}');
  }
  return { values, problems };
}

/** POSIX-subset command syntax only; the caller must establish a command role before using this lexer. */
export function hasBalancedCommandText(text: string): boolean {
  if (text.endsWith('\\')) return false;
  let quote: string | null = null; let escaped = false;
  for (const char of text) {
    if (escaped) { escaped = false; continue; }
    if (char === '\\' && quote!=="'") { escaped = true; continue; }
    if (quote !== null) { if (char === quote) quote = null; }
    else if (char === '"' || char === "'") quote = char;
  }
  return quote === null;
}

/** Shared cell-format policy; literal assertions do not use the ordinary command quote lexer. */
export function hasSingleLineValue(value: unknown): value is string {
  return typeof value === 'string' && value.isWellFormed() && value.trim() === value && !/[\r\n\v\f\u0085\u2028\u2029\u0000-\u0008\u000e-\u001f\uFFFE\uFFFF]/.test(value) && !/\{(?:0)?\}/.test(value) && !value.startsWith('=') && !/_x[0-9a-fA-F]{4}_/.test(value);
}

/** POSIX expansions are active outside single quotes; glob and control syntax only outside quotes. */
export function hasShellDynamicSyntax(text:string):boolean {
  let quote:string|null=null;
  for(let i=0;i<text.length;i++){
    const char=text[i];
    if(quote==="'"){if(char==="'")quote=null;continue;}
    if(char==='\\'){
      const next=text[i+1];if(next===undefined)return true;
      if(quote==='"'&&!['$','`','"','\\','\n'].includes(next))continue;
      i++;continue;
    }
    if(char==='"'){quote=quote==='"'?null:'"';continue;}
    if(char==="'"&&quote===null){quote="'";continue;}
    if(char==='$'||char==='`')return true;
    if(quote===null&&'*?[]{}~;|&<>'.includes(char))return true;
  }
  return false;
}
