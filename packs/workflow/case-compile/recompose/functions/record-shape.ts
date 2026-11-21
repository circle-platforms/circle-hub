import { schema as packSchema } from './schema.ts';
import { isRecord } from './text.ts';

export interface ShapeIssue {
  pointer: string;
  found: string;
  expected: string;
}

const MAX_ISSUES = 20;
const TYPE_LABEL: Readonly<Record<string, string>> = { object: '对象', array: '数组', string: '字符串', integer: '整数', number: '数字', boolean: '布尔值', null: 'null' };

const kindOf = (value: unknown): string =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'object' ? 'object' : typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'number') : typeof value;
const show = (value: unknown): string => {
  const text = JSON.stringify(value);
  if (text === undefined) return '缺失';
  return [...text].length > 60 ? `${[...text].slice(0, 57).join('')}…` : text;
};
const fits = (type: unknown, value: unknown): boolean => type === 'number' ? typeof value === 'number' && Number.isFinite(value) : type === 'integer' ? Number.isInteger(value) : kindOf(value) === type;

export function allowed(node: unknown): string {
  if (!isRecord(node)) return '符合声明的值';
  if (Array.isArray(node.enum)) return node.enum.map((value) => JSON.stringify(value)).join(' | ');
  if (Object.hasOwn(node, 'const')) return JSON.stringify(node.const);
  if (Array.isArray(node.anyOf)) return node.anyOf.map(allowed).join(' | ');
  const type = typeof node.type === 'string' ? (TYPE_LABEL[node.type] ?? node.type) : '符合声明的值';
  if (node.type === 'string' && typeof node.minLength === 'number') return `${type}（至少 ${node.minLength} 个字符）`;
  if (node.type === 'array' && typeof node.minItems === 'number') return `${type}（至少 ${node.minItems} 项）`;
  return type;
}

function walk(node: unknown, value: unknown, pointer: string, out: ShapeIssue[]): void {
  if (!isRecord(node) || out.length >= MAX_ISSUES) return;
  const at = (found: string, expected: string, where = pointer): void => { out.push({ pointer: where, found, expected }); };
  if (Array.isArray(node.anyOf)) {
    if (!node.anyOf.some((arm) => { const probe: ShapeIssue[] = []; walk(arm, value, pointer, probe); return probe.length === 0; })) at(`写的是 ${show(value)}`, allowed(node));
    return;
  }
  if (Object.hasOwn(node, 'const') && value !== node.const) return at(`写的是 ${show(value)}`, allowed(node));
  if (Array.isArray(node.enum) && !node.enum.includes(value)) return at(`写的是 ${show(value)}`, allowed(node));
  if (node.type === undefined) return;
  if (!fits(node.type, value)) return at(`写的是 ${show(value)}（${TYPE_LABEL[kindOf(value)] ?? kindOf(value)}）`, allowed(node));
  if (node.type === 'object' && isRecord(value)) {
    const properties = isRecord(node.properties) ? node.properties : {};
    for (const key of Array.isArray(node.required) ? node.required : []) if (typeof key === 'string' && !Object.hasOwn(value, key)) at('缺这一项', allowed(properties[key]), `${pointer}/${key}`);
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) walk(properties[key], child, `${pointer}/${key}`, out);
      else if (node.additionalProperties === false) at('多了这个字段', `只能写 ${Object.keys(properties).join('、')}`, `${pointer}/${key}`);
      else if (isRecord(node.additionalProperties)) walk(node.additionalProperties, child, `${pointer}/${key}`, out);
    }
  } else if (node.type === 'array' && Array.isArray(value)) {
    if (typeof node.minItems === 'number' && value.length < node.minItems) at(`只有 ${value.length} 项`, `至少 ${node.minItems} 项`);
    if (typeof node.maxItems === 'number' && value.length > node.maxItems) at(`有 ${value.length} 项`, `至多 ${node.maxItems} 项`);
    if (node.items !== undefined) value.forEach((child, index) => walk(node.items, child, `${pointer}/${index}`, out));
  } else if (node.type === 'string' && typeof value === 'string') {
    const length = [...value].length;
    if (typeof node.minLength === 'number' && length < node.minLength) at(`写的是 ${show(value)}`, `至少 ${node.minLength} 个字符`);
    if (typeof node.maxLength === 'number' && length > node.maxLength) at(`写了 ${length} 个字符`, `至多 ${node.maxLength} 个字符`);
    if (typeof node.pattern === 'string' && !new RegExp(node.pattern, 'u').test(value)) at(`写的是 ${show(value)}`, `符合 ${node.pattern}`);
  } else if ((node.type === 'integer' || node.type === 'number') && typeof value === 'number') {
    if (typeof node.minimum === 'number' && value < node.minimum) at(`写的是 ${value}`, `不小于 ${node.minimum}`);
    if (typeof node.maximum === 'number' && value > node.maximum) at(`写的是 ${value}`, `不大于 ${node.maximum}`);
  }
}

export function shapeIssues(shape: unknown, value: unknown): ShapeIssue[] {
  if (packSchema(shape).safeParse(value).success) return [];
  const out: ShapeIssue[] = [];
  walk(shape, value, '', out);
  if (out.length === 0) out.push({ pointer: '', found: '整条记录的形状不对', expected: '符合声明的完整形状' });
  return out;
}
