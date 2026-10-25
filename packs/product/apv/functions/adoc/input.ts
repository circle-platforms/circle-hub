import { createHash } from 'node:crypto';
import type { AdocInput, Limits, MappedLine, Report, SourceFile } from './types.ts';

export const ENGINE = { version: '4.1.1', sha256: '5a8785bf8dc39a216170b836bb274957f079f77e5f40b33453c988f85de9203d' } as const;
export const POLICY = 'restricted-whole-file-includes-source-lines-and-inline-structure@2';
export const LIMITS: Limits = { files: 128, inputBytes: 16 * 1024 * 1024, expandedBytes: 8 * 1024 * 1024, includeDepth: 16, includes: 512, lines: 250000, conditions: 1024, blocks: 250000 };
export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
export const canonical = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : v);
export const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export class AdocFailure extends Error {
  code: string; file?: string; line?: number;
  constructor(code: string, message: string, file?: string, line?: number) { super(message); this.code = code; this.file = file; this.line = line; }
}
export function fail(code: string, message: string, file?: string, line?: number): never { throw new AdocFailure(code, message, file, line); }
function bookDirectory(path: string): boolean {
  return path.length > 0 && path.length <= 2000 && !/[\\\p{Cc}\p{Cf}?#;]/u.test(path) && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && part.length <= 255);
}
export function localPath(file: string): boolean {
  return file !== '' && !/[:\\?#\p{Cc}\p{Cf}]/u.test(file) && !file.startsWith('/') && file.split('/').every((p) => p !== '' && p !== '.' && p !== '..') && file.endsWith('.adoc');
}
export function rejectClock(text: string, file?: string, line?: number): void {
  if (/\{(?:doc|local)(?:date|time|datetime|year)\}|^:!?(?:doc|local)(?:date|time|datetime|year)!?:|^(?:ifdef|ifndef)::[^\[]*\b(?:doc|local)(?:date|time|datetime|year)\b/i.test(text)) fail('clock_attribute', '使用了时间类属性', file, line);
}
export function validate(input: unknown, limits: Limits): AdocInput {
  if (!isRecord(input) || typeof input.main !== 'string' || !localPath(input.main) || typeof input.revision !== 'string' || !/^[1-9][0-9]*$/.test(input.revision) || !isRecord(input.files)) fail('invalid_input', '需要主文件、同一 SVN 修订号和完整文件表');
  const files: Record<string, SourceFile> = Object.create(null);
  const entries = Object.entries(input.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (entries.length === 0 || entries.length > limits.files) fail('file_budget', '文件数量超过限制或为空');
  let bytes = 0;
  for (const [name, value] of entries) {
    if (!localPath(name) || !isRecord(value) || typeof value.text !== 'string' || !value.text.isWellFormed() || typeof value.sha256 !== 'string') fail('invalid_file', '文件表需要相对 adoc 路径、UTF-8 原文和摘要', name);
    if (value.revision !== input.revision) fail('revision_mismatch', '一组文件没有在同一个 SVN 修订号上读取', name);
    if (!/^[0-9a-f]{64}$/.test(value.sha256) || sha256(value.text) !== value.sha256) fail('source_digest', '文件字节与声明的 SHA-256 不符', name);
    let lineCount = value.text === '' ? 0 : 1;
    for (const _match of value.text.matchAll(/\r\n|\r|\n/g)) if (++lineCount > limits.lines + 1) fail('line_budget', '原文件行数超过限制', name);
    bytes += Buffer.byteLength(value.text);
    if (bytes > limits.inputBytes) fail('input_budget', '文件表总字节超过限制', name);
    files[name] = { text: value.text, revision: value.revision as string, sha256: value.sha256 };
  }
  if (!Object.hasOwn(files, input.main)) fail('missing_main', '主文件不在文件表里', input.main);
  if (input.directory !== undefined && (typeof input.directory !== 'string' || !bookDirectory(input.directory))) fail('invalid_input', '书目录需要是相对 SVN 路径');
  const attributes: Record<string, string | boolean> = Object.create(null);
  if (input.attributes !== undefined && !isRecord(input.attributes)) fail('invalid_attributes', '声明属性集必须是对象');
  for (const [key, value] of Object.entries(input.attributes ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (!/^[a-z][a-z0-9_-]*$/i.test(key) || ['constructor', 'prototype', 'docfile', 'docdir', 'backend', 'doctype', 'reproducible', 'include-depth', 'safe-mode', 'allow-uri-read'].includes(key.toLowerCase()) || (typeof value !== 'string' && typeof value !== 'boolean')) fail('invalid_attributes', '属性名或值不受支持，不能覆盖适配器执行策略');
    if (/^(?:doc|local)(?:date|time|datetime|year)$/i.test(key)) fail('clock_attribute', '声明属性集含时间类属性');
    rejectClock(String(value));
    if (/[\r\n]/.test(String(value)) || /(?:include|ifdef|ifndef|ifeval|endif)::/.test(String(value))) fail('invalid_attributes', '声明属性只能是单行值，不能注入预处理指令');
    if (Object.hasOwn(attributes, key.toLowerCase())) fail('invalid_attributes', '声明属性名大小写折叠后重复');
    if(key.toLowerCase()==='webfonts'&&value!==false)fail('invalid_attributes','生成策略固定使用 webfonts!，不能启用 webfonts');
    attributes[key.toLowerCase()] = value as string | boolean;
  }
  return { main: input.main, revision: input.revision, ...(typeof input.directory === 'string' ? { directory: input.directory } : {}), files, attributes };
}
export function sourceLines(file: string, text: string): MappedLine[] {
  if (text === '') return [];
  const lines = text.replace(/^\ufeff/, '').split(/\r\n|\n|\r/);
  if (/\r\n$|[\r\n]$/.test(text)) lines.pop();
  return lines.map((line, index) => ({ file, line: index + 1, text: line.replaceAll('\0', '') }));
}
export function initialReport(input: AdocInput): Report {
  const files = Object.entries(input.files).map(([file, value]) => {
    let nul_bytes = 0, crlf = 0, lf = 0, cr = 0;
    for (let i = 0; i < value.text.length; i++) {
      const char = value.text[i];
      if (char === '\0') nul_bytes++;
      else if (char === '\r' && value.text[i + 1] === '\n') { crlf++; i++; }
      else if (char === '\r') cr++;
      else if (char === '\n') lf++;
    }
    return { file, nul_bytes, crlf, lf, cr, ...(value.text.startsWith('\ufeff') ? { utf8_bom_bytes: 3 } : {}) };
  });
  return { files, unused_files: [], conditions: [], unverified_count: 0, unverified_examples_truncated: false, unverified: [], disambiguated_count: 0, disambiguated_examples_truncated: false, disambiguated: [], remapped: [], engine_messages: [], invalid_headings: [] };
}
