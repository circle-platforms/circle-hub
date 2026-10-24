// Reading a secret value for `secret set`: from standard input only, never from the command line or the environment. On a
// terminal the value is typed without echo (raw mode): the bytes are decoded as one UTF-8 stream (a character split across
// reads stays whole, invalid bytes refuse the value), escape sequences of special keys (arrows, function keys, bracketed
// paste markers) are dropped rather than kept as text, backspace deletes and Ctrl-U clears, Enter ends, Ctrl-C (or Ctrl-D on
// an empty line) cancels, and a terminal that closes first refuses. From a pipe or a file the whole input is read and one
// trailing line break removed. The value is returned to the caller and never written anywhere by this module.
import type { Readable } from 'node:stream';

/** Largest secret accepted (the vault holds at most 64 KiB per entry). */
export const MAX_SECRET_BYTES = 64 * 1024;

export class SecretInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretInputError';
  }
}

export interface SecretInput {
  /** Default process.stdin. */
  input?: Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
  /** Where the prompt goes on a terminal; default stderr (stdout may be captured). */
  prompt?: (text: string) => void;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** Removes one trailing LF or CRLF (what `echo`, a here-string or a file ends with). */
function withoutLineBreak(text: string): string {
  if (text.endsWith('\r\n')) return text.slice(0, -2);
  if (text.endsWith('\n')) return text.slice(0, -1);
  return text;
}

async function readPiped(input: Readable, maximum = MAX_SECRET_BYTES): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > maximum) throw new SecretInputError(`标准输入超过 ${maximum} 字节，不是一个凭据`);
    chunks.push(buffer);
  }
  const bytes = Buffer.concat(chunks);
  try {
    return withoutLineBreak(UTF8.decode(bytes));
  } catch {
    throw new SecretInputError('标准输入不是 UTF-8 文本');
  } finally {
    bytes.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

/** Where the terminal reader is inside an escape sequence: after ESC, inside `ESC [` (CSI) or after `ESC O` (SS3). */
type EscapeState = 'none' | 'escape' | 'csi' | 'ss3';

function readTerminal(input: NonNullable<SecretInput['input']>, prompt: (text: string) => void, label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = '';
    let escape: EscapeState = 'none';
    let done = false;
    // One decoder for the whole input: a character whose bytes arrive in two reads is decoded once, whole.
    const decoder = new TextDecoder('utf-8', { fatal: true });
    prompt(`输入 ${label} 的值（不回显），回车结束：`);
    const finish = (error: Error | null) => {
      if (done) return;
      done = true;
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('close', onEnd);
      input.off('error', onError);
      input.setRawMode?.(false);
      input.pause();
      if (error !== null) {
        value = '';
        reject(error);
      } else resolve(value);
    };
    const onEnd = () => finish(new SecretInputError('标准输入在回车之前关闭了，没有设置'));
    const onError = () => finish(new SecretInputError('读标准输入失败，没有设置'));
    const onData = (chunk: Buffer | string) => {
      let text: string;
      try {
        text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      } catch {
        return finish(new SecretInputError('输入不是 UTF-8 文本，没有设置'));
      }
      for (const char of text) {
        if (escape === 'escape') {
          // ESC [ and ESC O start the sequences special keys send; after a lone ESC the character counts as typed.
          escape = char === '[' ? 'csi' : char === 'O' ? 'ss3' : 'none';
          if (escape !== 'none') continue;
        } else if (escape === 'csi') {
          // Parameter and intermediate bytes (0x20-0x3F) continue it, a final byte (0x40-0x7E) ends it.
          if (char >= ' ' && char <= '?') continue;
          escape = 'none';
          if (char >= '@' && char <= '~') continue;
        } else if (escape === 'ss3') {
          escape = 'none';
          continue;
        }
        if (char === '\u001b') {
          escape = 'escape';
          continue;
        }
        if (char === '\r' || char === '\n') return finish(null);
        if (char === '\u0003' || (char === '\u0004' && value.length === 0)) return finish(new SecretInputError('已取消，没有设置'));
        if (char === '\u007f' || char === '\b') value = [...value].slice(0, -1).join('');
        else if (char === '\u0015') value = '';
        else if (char >= ' ' && !(char >= '\u0080' && char <= '\u009f')) value += char;
        if (Buffer.byteLength(value) > MAX_SECRET_BYTES) return finish(new SecretInputError('输入太长，不是一个凭据'));
      }
    };
    input.setRawMode?.(true);
    input.resume();
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('close', onEnd);
    input.on('error', onError);
  });
}

/** Reads one secret value from standard input (`label` names it in the terminal prompt). */
export async function readSecret(label: string, options: SecretInput = {}): Promise<string> {
  const input = options.input ?? (process.stdin as NonNullable<SecretInput['input']>);
  if (input.isTTY === true && typeof input.setRawMode === 'function') {
    return readTerminal(input, options.prompt ?? ((text) => process.stderr.write(`${text}\n`)), label);
  }
  return readPiped(input);
}

/** One prompt per terminal value; a pipe is consumed once and must contain exactly one line per name. */
export async function readSecrets(labels: readonly string[], options: SecretInput = {}): Promise<string[]> {
  const input = options.input ?? (process.stdin as NonNullable<SecretInput['input']>);
  if (input.isTTY === true && typeof input.setRawMode === 'function') {
    const values: string[] = []; for (const label of labels) values.push(await readTerminal(input, options.prompt ?? (text => process.stderr.write(text + '\n')), label)); return values;
  }
  const values = (await readPiped(input, Math.max(MAX_SECRET_BYTES, labels.length * (4096 * 4 + 2)))).split(/\r?\n/);
  if (values.length !== labels.length) throw new SecretInputError('标准输入的行数须与密钥名字数相同；一行一个，未写入任何密钥');
  return values;
}
