// The producer of the Lumen API product (product@1 producers, ProducerInput -> ProducerOutput): the endpoint reference of a
// build (slot spec, markdown@1) -> one definition entry per endpoint at /endpoints/<METHOD>/<path segments>. An endpoint is
// a section titled `<METHOD> <path>`; its parameter table (name, type, values) gives the typed positional parameters of the
// catalog entry (catalog-entry@1 data: words, signatures, summary): an endpoint is cited as `<METHOD> <path> <values...>`.
// Types: 整数 int (range a-b), 字符串 string (length a-b), 枚举 enum (values a、b), 端口 port; 可选 marks an optional one.
import type { ProducedEntry, ProducerOutput } from '../../../../contracts/src/product.ts';
import type { CatalogParamType } from '../../../../contracts/src/tables.ts';
import { asArray, asString, isRecord, tableRows } from './common.ts';

const PARSER = 'markdown@1';
const TITLE = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/[A-Za-z0-9_{}./-]*)$/;
const NAME = /^[a-z][a-z0-9_]{0,40}$/;
const MAX_ENDPOINTS = 2000;

type Param = { name: string; type: Extract<CatalogParamType, 'int' | 'string' | 'enum' | 'port'>; optional?: boolean; minimum?: number; maximum?: number; minLength?: number; maxLength?: number; values?: string[] };

/** One parameter row (name, type, values), or why it is not one. */
export function paramOf(row: readonly string[]): Param | string {
  const [name, type, values = ''] = row;
  if (name === undefined || !NAME.test(name)) return `参数名 ${String(name).slice(0, 40)} 不合法`;
  const optional = /可选/.test(values);
  const range = /([0-9]{1,9})\s*[-~]\s*([0-9]{1,9})/.exec(values);
  const base: Param = { name, type: 'string', ...(optional ? { optional: true } : {}) };
  switch (type) {
    case '整数':
      return { ...base, type: 'int', ...(range ? { minimum: Number(range[1]), maximum: Number(range[2]) } : {}) };
    case '端口':
      return { ...base, type: 'port' };
    case '字符串':
      return { ...base, type: 'string', ...(range ? { minLength: Number(range[1]), maxLength: Number(range[2]) } : {}) };
    case '枚举': {
      const list = values.replace(/[，,]?\s*可选\s*$/, '').split(/[、/]/).map((v) => v.trim()).filter((v) => /^[A-Za-z0-9_.-]{1,40}$/.test(v));
      return list.length > 0 ? { ...base, type: 'enum', values: list } : `参数 ${name} 是枚举却没有取值`;
    }
    default:
      return `参数 ${name} 的类型 ${String(type).slice(0, 20)} 不认识`;
  }
}

/** The tree path of an endpoint: /endpoints/<METHOD>/<segments> (braces kept, empty segments dropped). */
export function endpointPath(method: string, path: string): string {
  const segments = path.split('/').filter((s) => s !== '');
  return `/endpoints/${[method, ...segments].join('/')}`;
}

export function produceEndpoints(input: unknown): ProducerOutput {
  const slots = isRecord(input) && isRecord(input.slots) ? input.slots : {};
  const spec = isRecord(slots.spec) ? slots.spec : null;
  if (spec === null) return { entries: [], warnings: ['没有接口参考'] };
  if (spec.parser !== PARSER || !isRecord(spec.model)) return { entries: [], warnings: [`接口参考不是 Markdown（解析器 ${String(spec.parser)}）`] };
  const build = isRecord(input) && isRecord(input.build) && typeof input.build.name === 'string' ? input.build.name : null;
  const sections = asArray(spec.model.sections);
  const blocks = asArray(spec.model.blocks);
  const entries: ProducedEntry[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const section of sections) {
    if (entries.length >= MAX_ENDPOINTS) {
      warnings.push(`接口超过 ${MAX_ENDPOINTS} 个，后面的没有读`);
      break;
    }
    if (!isRecord(section) || typeof section.selector !== 'string') continue;
    const m = TITLE.exec((asString(section.title) ?? '').trim());
    if (m === null) continue;
    const [, method, path] = m;
    const key = `${method} ${path}`;
    if (seen.has(key)) {
      warnings.push(`接口 ${key} 写了两次，只取第一次`);
      continue;
    }
    seen.add(key);
    const own = asArray(section.blocks).map((k) => (typeof k === 'number' ? blocks[k] : undefined)).filter(isRecord);
    const summary = own.find((b) => b.kind === 'paragraph' && typeof b.text === 'string')?.text as string | undefined;
    const table = own.find((b) => b.kind === 'table' && typeof b.text === 'string');
    const params: Param[] = [];
    if (table !== undefined) {
      for (const row of tableRows(table.text as string)) {
        const param = paramOf(row);
        if (typeof param === 'string') warnings.push(`${key}：${param}`);
        else params.push(param);
      }
    }
    const fragments = [{ parser: PARSER, selector: section.selector }, ...(table !== undefined && typeof table.selector === 'string' ? [{ parser: PARSER, selector: table.selector }] : [])];
    const signature = params.length === 0 ? '无参数' : params.map((p) => `${p.name}${p.optional ? '?' : ''}:${p.type}`).join(' ');
    entries.push({
      kind: 'definition',
      path: endpointPath(method, path),
      statement: `接口 ${key}：${signature}${summary ? `。${summary.slice(0, 200)}` : ''}`,
      data: { words: [method, path], signatures: [{ id: '1', params }], ...(summary ? { summary: summary.slice(0, 200) } : {}), form: 'endpoint' },
      fragments,
      applicability: build === null ? null : { builds: [build] },
    });
  }
  if (entries.length === 0) warnings.push('接口参考里没有 “<方法> <路径>” 形式的章节');
  return { entries, warnings };
}

export default function (input: unknown): unknown {
  try {
    return produceEndpoints(input);
  } catch {
    return { entries: [], warnings: ['接口参考的生产函数内部出错（任务包的缺陷）'] };
  }
}
