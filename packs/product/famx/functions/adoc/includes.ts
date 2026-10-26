import { posix } from 'node:path';
import { attributesAfter } from './engine.ts';
import { fail, localPath, rejectClock, sourceLines } from './input.ts';
import type { AdocInput, Limits, MappedLine } from './types.ts';

export interface Branch { id: number; directive: string; start: number; end: number; parent: number | null; target: string; inline: boolean; retained?: boolean }
export interface Expanded { lines: MappedLine[]; used: Set<string>; branches: Branch[] }
export async function expandIncludes(input: AdocInput, limits: Limits): Promise<Expanded> {
  const lines: MappedLine[] = [], used = new Set<string>(), stack: string[] = [];
  let bytes = 0, includes = 0;
  const walk = async (file: string): Promise<void> => {
    if (stack.includes(file)) fail('include_cycle', 'include 循环', file);
    if (stack.length >= limits.includeDepth) fail('include_depth', 'include 深度超过限制', file);
    if (!Object.hasOwn(input.files, file)) fail('include_missing', 'include 文件不在输入文件表里', file);
    stack.push(file); used.add(file);
    const conditions: string[] = [];
    for (const row of sourceLines(file, input.files[file].text)) {
      rejectClock(row.text, file, row.line);
      if (/^:!?(?:constructor|prototype|__proto__)!?:/i.test(row.text)) fail('invalid_attributes', '不支持的属性名', file, row.line);
      if (/^ifeval::|^else::/.test(row.text)) fail('conditional_syntax', '只支持 ifdef 和 ifndef 条件', file, row.line);
      const conditional = /^(ifdef|ifndef)::([^\s\[]+)\[(.*)\]$/.exec(row.text);
      if (conditional && conditional[3] === '') conditions.push(conditional[2]);
      if (/^endif::/.test(row.text)) {
        const end = /^endif::([^\[]*)\[\]$/.exec(row.text);
        if (!end || conditions.length === 0 || (end[1] !== '' && end[1].toLowerCase() !== conditions.at(-1)!.toLowerCase())) fail('conditional_syntax', '条件结束指令不匹配', file, row.line);
        conditions.pop();
      }
      if (/^include::/.test(row.text)) {
        if (conditions.length) fail('include_conditional', 'include 不能写在条件里（包括未选中的分支）', file, row.line);
        const include = /^include::([^\[]+)\[\]$/.exec(row.text);
        if (!include) fail('include_options', '只支持没有选项的整文件 include', file, row.line);
        if (++includes > limits.includes) fail('include_budget', 'include 次数超过限制', file, row.line);
        let target = include[1];
        if (target.includes('{')) {
          const attrs = await attributesAfter(lines.map((line) => line.text).join('\n'), input.main, input.attributes ?? {});
          target = target.replace(/\{([^{}]+)\}/g, (_whole, key: string) => typeof attrs[key] === 'string' ? attrs[key] as string : fail('include_attribute', 'include 路径中的属性没有可用的文本值', file, row.line));
        }
        if (!localPath(target) || /[{}]/.test(target)) fail('include_path', 'include 只许文件表里的本地相对路径，不接受 URI、绝对路径和上级路径', file, row.line);
        await walk(posix.join(posix.dirname(file), target));
      } else {
        if (row.text.includes('include::') && !row.text.startsWith('\\include::') && !row.text.startsWith('//')) fail('include_syntax', 'include 只能独占一行，不能藏在条件或其他块的行内', file, row.line);
        if (/^(?:ifdef|ifndef)::/.test(row.text) && !conditional) fail('conditional_syntax', '无法解释的条件指令', file, row.line);
        bytes += Buffer.byteLength(row.text) + 1;
        if (bytes > limits.expandedBytes || lines.length >= limits.lines) fail('expanded_budget', '展开后的字节或行数超过限制', file, row.line);
        lines.push(row);
      }
    }
    if (conditions.length) fail('conditional_syntax', '文件末尾有未结束的条件分支', file);
    stack.pop();
  };
  await walk(input.main);
  const branches: Branch[] = [], open: Branch[] = [];
  for (const [index, line] of lines.entries()) {
    const match = /^(ifdef|ifndef)::([^\[]+)\[(.*)\]$/.exec(line.text);
    if (match) {
      if (branches.length >= limits.conditions) fail('conditional_budget', '条件分支数量超过限制', line.file, line.line);
      const branch = { id: branches.length + 1, directive: line.text, start: index, end: index, parent: open.at(-1)?.id ?? null, target: match[2], inline: match[3] !== '' };
      branches.push(branch); if (!branch.inline) open.push(branch);
    } else if (/^endif::/.test(line.text)) { const branch = open.pop(); if (branch) branch.end = index; }
  }
  return { lines, used, branches };
}
