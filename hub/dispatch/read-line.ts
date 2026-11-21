// A read of a booked device on request (decision 181): what is checked before the one line is sent, and how the answer
// is read. Structure alone decides: no word of the line is compared with any list, and no word of the answer is read.
import { commandTokens } from '../../contracts/src/command-grammar.ts';
import { at, type ExecutorDefinition } from './definition.ts';

export type ReadSpec = NonNullable<NonNullable<ExecutorDefinition['probes']>['read']>;

export type ReadLineCheck = { ok: true; line: string; words: number } | { ok: false; fact: string; next_action: string };

const refuse = (fact: string, next_action: string): ReadLineCheck => ({ ok: false, fact, next_action });

/**
 * The line of a requested read before it is sent: one complete line of words (the shared command lexer: quotes paired, at
 * most 2000 characters and 320 words), no control character at all, and the whole line of the shape the executor declares
 * for the commands its per-seat read sends (`commandPattern`, probes.command_pattern). The match must span the line from its
 * first character to its last, so a declared shape whose alternatives are not grouped (^a|b$) lets no half line through.
 * What is sent is the words joined by single spaces, and that text is what is held to the shape.
 */
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

/** The device text at the declared place of the answer, as received: nothing, null or only blanks there is no output; anything that is not text is not shown. */
export function readOutput(value: unknown, pointer: string): OutputReading {
  const raw = at(value, pointer);
  if (raw !== undefined && raw !== null && typeof raw !== 'string') return { ok: false, why: '目标给出的输出不是文字' };
  return { ok: true, text: typeof raw === 'string' && raw.trim() !== '' ? raw : null };
}
