// Bind explicit text values to the original Python signature without expanding defaults or evaluating expressions.
import type { RuntimeEntry } from './runtime-contract.ts';
import type { PlanStep } from './slots.ts';
export interface BoundValue { name: string; value: string; pointer: string }
export interface BindProblem { code: string; pointer: string; message: string }
export function bindArguments(method: RuntimeEntry, step: PlanStep, at: string): { values: BoundValue[]; problems: BindProblem[] } {
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
    if (supplied > 0 && param.required && !values.some((v) => v.name === param.name) && !Object.hasOwn(step.keywords, param.name)) issue('param_arity', at, `缺必填参数 ${param.name}`);
    if (param.redacted) for (const value of values.filter((v) => v.name === param.name)) issue('param_sensitive', value.pointer, '脱敏凭据参数不许出现在计划里');
  }
  for (const v of values) if (typeof v.value !== 'string' || v.value.trim() !== v.value || /[\r\n\v\f\u0085\u2028\u2029]/.test(v.value) || /\{(?:0)?\}/.test(v.value) || v.value.startsWith('=')) issue('param_value', v.pointer, '参数值必须是单行原文，首尾无空白、不以 = 开头、没有 {} 或 {0}');
  for (const v of values) if (typeof v.value === 'string' && !hasBalancedCommandText(v.value)) issue('param_value', v.pointer, '引号必须成对，值不能以反斜杠结尾；修正该值后重新提交');
  return { values, problems };
}

/** The catalog tokenizer cannot consume unmatched quoting or a final escape. Reject before its unknown path. */
export function hasBalancedCommandText(text: string): boolean {
  if (text.endsWith('\\')) return false;
  let quote: string | null = null; let escaped = false;
  for (const char of text) {
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (quote !== null) { if (char === quote) quote = null; }
    else if (char === '"' || char === "'") quote = char;
  }
  return quote === null;
}
