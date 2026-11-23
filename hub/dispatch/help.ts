import { commandTokens } from '../../contracts/src/command-grammar.ts';
import { at, type ExecutorDefinition } from './definition.ts';

export type HelpSpec = NonNullable<NonNullable<ExecutorDefinition['probes']>['help']>;

export const HELP_TEXT_CHARS = 16000;

export interface AskedPrefix {
  text: string;
  words: number;
  next_word: string | null;
}

export interface AskedLine {
  line: string;
  words: number;
  prefixes: AskedPrefix[];
}

export type LineCheck = { ok: true; asked: AskedLine } | { ok: false; fact: string; next_action: string };

const refuse = (fact: string, next_action: string): LineCheck => ({ ok: false, fact, next_action });

export function checkLine(line: unknown, mode: string | undefined, spec: HelpSpec): LineCheck {
  if (typeof line !== 'string' || line.trim() === '') return refuse('没有要问的那一行', 'line 写要问的命令行，不带问号');
  if (/\p{Cc}/u.test(line)) return refuse('这一行里有控制字符（换行、制表、转义等），不发给设备', '去掉控制字符，写成一行普通文字后再问');
  const tokens = commandTokens(line);
  if (tokens === null || tokens.length === 0) return refuse('这一行不是一串完整的词（引号没有闭合、闭合引号后紧跟字符，或超过 2000 个字符或 320 个词）', '改成引号配对、不超长的一行后再问');
  if (spec.modes !== undefined) {
    if (mode === undefined) return refuse(`这台执行器要先说在哪一级问（mode），可选：${spec.modes.join('、')}`, `mode 写 ${spec.modes.join('、')} 之一`);
    if (!spec.modes.includes(mode)) return refuse(`级别 ${JSON.stringify(mode)} 不在执行器声明的 ${spec.modes.join('、')} 里`, `mode 写 ${spec.modes.join('、')} 之一`);
  } else if (mode !== undefined) {
    return refuse('这台执行器没有声明级别，不能带 mode', '去掉 mode 再问');
  }
  const words = tokens.map((token) => token.raw);
  const shape = new RegExp(spec.line_pattern);
  const prefixes: AskedPrefix[] = [];
  for (let k = words.length; k >= 1 && prefixes.length < spec.max_positions; k--) {
    prefixes.push({ text: words.slice(0, k).join(' '), words: k, next_word: k < words.length ? words[k]! : null });
  }
  const refused = prefixes.find((prefix) => !shape.test(prefix.text));
  if (refused !== undefined) return refuse(`要问的文字不符合执行器声明的问法形状 ${spec.line_pattern}：${JSON.stringify(refused.text)}`, '改写这一行；形状不对时请管理员核对执行器的问法声明');
  return { ok: true, asked: { line: words.join(' '), words: words.length, prefixes } };
}

export type Reading = { ok: true; text: string | null; caret_only: boolean | null } | { ok: false; why: string };

export function readAnswer(spec: HelpSpec, value: unknown): Reading {
  if (at(value, spec.entered) !== false || at(value, spec.cleared) !== true) return { ok: false, why: '目标没有确认“没有按回车、输入行已清掉”' };
  const raw = at(value, spec.text);
  if (raw !== undefined && raw !== null && typeof raw !== 'string') return { ok: false, why: '目标给出的说明不是文字' };
  const caret = spec.caret_only === undefined ? undefined : at(value, spec.caret_only);
  if (caret !== undefined && caret !== null && typeof caret !== 'boolean') return { ok: false, why: '目标给出的“只回了插入符”不是真假值' };
  return { ok: true, text: typeof raw === 'string' && raw.trim() !== '' ? raw : null, caret_only: caret ?? null };
}

export function capText(text: string, max = HELP_TEXT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return { text: text.slice(0, end), truncated: true };
}
