import { commandTokens } from '../../contracts/src/command-grammar.ts';
import { at, type ExecutorDefinition } from './definition.ts';

export type ReadSpec = NonNullable<NonNullable<ExecutorDefinition['probes']>['read']>;

export type ReadLineCheck = { ok: true; line: string; words: number } | { ok: false; fact: string; next_action: string };

const refuse = (fact: string, next_action: string): ReadLineCheck => ({ ok: false, fact, next_action });

export function checkReadLine(line: unknown, commandPattern: string): ReadLineCheck {
  if (typeof line !== 'string' || line.trim() === '') return refuse('没有要读的那一行', 'line 写一条只读命令');
  if (/\p{Cc}/u.test(line)) return refuse('这一行里有控制字符（换行、制表、转义等），不发给设备', '去掉控制字符，写成一行普通文字后再读');
  const tokens = commandTokens(line);
  if (tokens === null || tokens.length === 0) return refuse('这一行不是一串完整的词（引号没有闭合、闭合引号后紧跟字符，或超过 2000 个字符或 320 个词）', '改成引号配对、不超长的一行后再读');
  const sent = tokens.map((token) => token.raw).join(' ');
  const match = new RegExp(commandPattern).exec(sent);
  if (match === null || match.index !== 0 || match[0].length !== sent.length) {
    return refuse(`这一行不符合执行器声明的只读命令形状 ${commandPattern}：${JSON.stringify(sent)}`, '改成符合这个形状的一条只读命令后再读；形状本身不对时请管理员核对执行器的命令形状声明');
  }
  return { ok: true, line: sent, words: tokens.length };
}

export type OutputReading = { ok: true; text: string | null } | { ok: false; why: string };

export function readOutput(value: unknown, pointer: string): OutputReading {
  const raw = at(value, pointer);
  if (raw !== undefined && raw !== null && typeof raw !== 'string') return { ok: false, why: '目标给出的输出不是文字' };
  return { ok: true, text: typeof raw === 'string' && raw.trim() !== '' ? raw : null };
}
