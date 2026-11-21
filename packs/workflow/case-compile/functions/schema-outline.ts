import { isRecord } from './text.ts';
import { TARGET, labelOf } from './generated/vocabulary.ts';

const scalar = (schema: Record<string, unknown>): string => {
  if ('const' in schema) return `固定为 ${JSON.stringify(schema.const)}`;
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => JSON.stringify(value)).join(' | ');
  const type = Array.isArray(schema.type) ? schema.type.join(' | ') : typeof schema.type === 'string' ? schema.type : '';
  const limits: string[] = [];
  if (typeof schema.minLength === 'number' && schema.minLength > 0) limits.push(schema.minLength === 1 ? '非空' : `至少 ${schema.minLength} 字符`);
  if (typeof schema.maxLength === 'number') limits.push(`至多 ${schema.maxLength} 字符`);
  if (typeof schema.pattern === 'string') limits.push(`形如 /${schema.pattern}/`);
  if (typeof schema.minimum === 'number' || typeof schema.maximum === 'number') limits.push(`${typeof schema.minimum === 'number' ? schema.minimum : ''}..${typeof schema.maximum === 'number' && schema.maximum < Number.MAX_SAFE_INTEGER ? schema.maximum : ''}`);
  if (typeof schema.minItems === 'number' && schema.minItems > 0) limits.push(`至少 ${schema.minItems} 项`);
  if (typeof schema.maxItems === 'number') limits.push(`至多 ${schema.maxItems} 项`);
  return (type || '任意') + (limits.length ? `（${limits.join('，')}）` : '');
};
const alternatives = (schema: Record<string, unknown>): Record<string, unknown>[] | null => {
  const list = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : null;
  return list && list.every(isRecord) ? (list as Record<string, unknown>[]) : null;
};
const isObject = (schema: Record<string, unknown>): boolean => schema.type === 'object' || isRecord(schema.properties);
const discriminator = (schema: Record<string, unknown>): string | null => {
  const props = isRecord(schema.properties) ? schema.properties : {};
  for (const [key, value] of Object.entries(props)) if (isRecord(value) && 'const' in value) return `${key}=${JSON.stringify(value.const)}`;
  return null;
};

export function schemaOutline(schema: unknown, path = 'data'): string[] {
  const seen = new Map<string, string>();
  const lines: string[] = [];
  const describe = (node: Record<string, unknown>): string => (typeof node.description === 'string' && node.description.trim() ? ` — ${node.description.trim().replace(/\s+/g, ' ')}` : '');
  const walk = (node: unknown, at: string, indent: string, head: string): void => {
    if (!isRecord(node)) { lines.push(`${indent}${head}任意`); return; }
    if (head && !head.startsWith('·')) {
      const whole = head + JSON.stringify(node);
      const first = whole.length > 150 ? seen.get(whole) : undefined;
      if (first) { lines.push(`${indent}${head}同 ${first}`); return; }
      if (whole.length > 150) seen.set(whole, at);
    }
    const options = alternatives(node);
    if (options) {
      if (options.every((option) => !isObject(option) && option.type !== 'array')) { lines.push(`${indent}${head}${options.map(scalar).join(' | ')}${describe(node)}`); return; }
      lines.push(`${indent}${head}下列之一${describe(node)}`);
      options.forEach((option, index) => walk(option, `${at}（${discriminator(option) ?? `形状 ${index + 1}`}）`, indent + '  ', `· ${discriminator(option) ?? `形状 ${index + 1}`}：`));
      return;
    }
    if (node.type === 'array') {
      const items = node.items;
      const bounds = scalar({ minItems: node.minItems, maxItems: node.maxItems }).replace(/^任意/, '');
      if (isRecord(items) && (isObject(items) || alternatives(items) || items.type === 'array')) { lines.push(`${indent}${head}列表${bounds}${describe(node)}，每项：`); walk(items, `${at}[]`, indent + '  ', ''); }
      else lines.push(`${indent}${head}列表${bounds}，每项 ${isRecord(items) ? scalar(items) : '任意'}${describe(node)}`);
      return;
    }
    if (isObject(node)) {
      const props = isRecord(node.properties) ? node.properties : {};
      const required = new Set(Array.isArray(node.required) ? node.required.filter((key): key is string => typeof key === 'string') : []);
      const extra = node.additionalProperties;
      const key = JSON.stringify({ properties: props, required: [...required].sort(), extra });
      const before = key.length > 400 ? seen.get(key) : undefined;
      if (before) { lines.push(`${indent}${head}对象，结构同 ${before}${describe(node)}`); return; }
      if (key.length > 400) seen.set(key, at);
      const open = extra === false ? '' : isRecord(extra) ? `；其余键的值：${isObject(extra) || alternatives(extra)?.some(isObject) ? '对象' : (alternatives(extra) ?? [extra]).map(scalar).join(' | ')}` : '；可带其它键';
      if (head || describe(node) || open) lines.push(`${indent}${head}对象${open}${describe(node)}${Object.keys(props).length ? '：' : ''}`);
      for (const [name, value] of Object.entries(props)) walk(value, `${at}.${name}`, indent + (head || describe(node) || open ? '  ' : ''), `${name}${required.has(name) ? '*' : ''}: `);
      return;
    }
    lines.push(`${indent}${head}${scalar(node)}${describe(node)}`);
  };
  walk(schema, path, '', '');
  return lines;
}

export function slotsOutline(slots: unknown): string {
  const out: string[] = ['# 计划字段一览（由 slots.schema.json 生成；带 * 的是必填；“—”后面是 schema 对这个字段的说明）', ''];
  if (!isRecord(slots)) return out.join('\n') + '\n';
  for (const scope of TARGET) {
    const group = slots[scope];
    if (!isRecord(group)) continue;
    for (const [name, slot] of Object.entries(group)) {
      if (!isRecord(slot)) continue;
      out.push(`## ${labelOf('target', scope)}的 ${name} 槽：${slot.min ?? 0} 到 ${slot.max ?? '任意多'} 条陈述；陈述的 data：`);
      out.push(...schemaOutline(slot.data, `${name}.data`), '');
    }
  }
  return out.join('\n').replace(/\n+$/, '') + '\n';
}
