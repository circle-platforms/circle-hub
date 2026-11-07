// The module hub-client of run-tools: what a client-side tool of any workflow does around a Hub run. It reads files, takes the
// token from standard input, fetches a run's export and sends one submission. It decides nothing and reads no environment
// variable: every check stays in the Hub. Node built-ins only, as local tools require.
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_BYTES = 16 * 1024 * 1024;
const TIMEOUT_MS = 120_000;
const SUBMIT_TIMEOUT_MS = 300_000;
const isRecord = (value: unknown): value is { [key: string]: unknown } => typeof value === 'object' && value !== null && !Array.isArray(value);

export const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
export class InputFileError extends Error {readonly argument:string;readonly reason:'read'|'json'|'size';constructor(argument:string,reason:'read'|'json'|'size'){super(`${reason==='read'?'无法读取':reason==='json'?'不是完整的 UTF-8 JSON':'超过 16 MiB 上限'}：--${argument} 指定的输入；重新导出该运行对应输入的原始字节`);this.name='InputFileError';this.argument=argument;this.reason=reason;}}
export async function readBytes(path: string, argument='input'): Promise<Uint8Array> {
  let bytes: Buffer; try { bytes = await readFile(path); } catch { throw new InputFileError(argument,'read'); }
  if (bytes.length > 16 * 1024 * 1024) throw new InputFileError(argument,'size');
  return bytes;
}
export function jsonBytes(bytes: Uint8Array, argument='input'): unknown { try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); } catch { throw new InputFileError(argument,'json'); } }
export async function writeNew(path: string, bytes: Uint8Array): Promise<void> { try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); } catch { throw new Error('输出文件无法新建；不覆盖已有文件，请另选中性文件名'); } }
export function argumentsOf(argv: string[], required: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) { const key = argv[i]; if (!key?.startsWith('--') || !argv[i + 1] || Object.hasOwn(values, key.slice(2))) throw new Error('参数必须是唯一的 --名字 文件'); values[key.slice(2)] = argv[i + 1]; }
  if (required.some((name) => !values[name]) || Object.keys(values).some((key) => !required.includes(key))) throw new Error(`需要参数：${required.map((key) => '--' + key).join('、')}`);
  return values;
}

export async function tokenFromStdin(): Promise<string> {
  const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').trim();
}

/** The Hub answered with an HTTP error status; the message is the one every caller already shows. */
export class HubReplyError extends Error { readonly status: number; constructor(status: number, message: string) { super(message); this.name = 'HubReplyError'; this.status = status; } }

// A failure to reach the Hub is reported as what it is, never as a malformed answer (a submission that never arrived is told apart
// from one whose results could not be read).
export async function get(url: string, bearer: string): Promise<Uint8Array> {
  let reply: Response; let bytes: Uint8Array;
  try {
    reply = await fetch(url, { headers: { authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    bytes = new Uint8Array(await reply.arrayBuffer());
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') throw new Error(`Hub ${TIMEOUT_MS / 1000} 秒内没有答复；稍后用同一命令重取`);
    const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code ?? error.message : '未知原因';
    throw new Error(`Hub 不可达（${String(cause).slice(0, 120)}）；核对 --hub 是 MCP 条目的地址、网络可达后重取`);
  }
  if (!reply.ok) throw new HubReplyError(reply.status, `Hub 答复 ${reply.status}：${new TextDecoder().decode(bytes).trim().slice(0, 300)}`);
  if (bytes.length > MAX_BYTES) throw new Error('Hub 答复超过 16 MiB 上限');
  return bytes;
}

const SOURCE_REFERENCE = /^src:([0-9a-f]{64})(?:\/|$)/;
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');

/**
 * A run on local disk, so a model reads it with its own file tools instead of one Hub call per item: `run.json` (the run record,
 * indented so a file reader goes line by line), `items/<index>.json` (one frozen item each, the index of `#/items/<index>`),
 * `sources/<sha256>` (the original bytes of every source the run binds, each checked against its digest) and `sources.json`
 * (each binding: slot, role, reference, label, media type, file). A source the reader's tier gives no bytes for is listed as
 * withheld, never guessed. Everything is fetched and checked before anything is written; the directory must be new or empty.
 * It reads the run alone, so it works before anything is submitted; it decides nothing about the content.
 */
export async function downloadRun(origin: string, bearer: string, run: string, out: string): Promise<{ run: string; out: string; items: number; sources: number; withheld: string[]; files: Record<string, string> }> {
  let exported: unknown;
  try { exported = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await get(`${origin}/run-export/${run}/run`, bearer))); }
  catch (error) { if (error instanceof Error && error.message.startsWith('Hub ')) throw error; throw new Error('Hub 的运行导出不是完整的 UTF-8 JSON'); }
  if (!isRecord(exported) || exported.schema !== 'run-export@1' || !isRecord(exported.run)) throw new Error('Hub 的运行导出不合式');
  const record = exported.run;
  if (record.run !== run) throw new Error(`Hub 导出的运行不是 --run 指定的 ${run}，什么都没有写入；核对运行号后重取`);
  const items = Array.isArray(record.items) ? record.items : [];
  const bindings = Array.isArray(record.sources) ? record.sources.filter(isRecord) : [];
  const outputs: Array<{ name: string; bytes: Uint8Array }> = [{ name: 'run.json', bytes: json(record) }];
  const width = String(Math.max(items.length - 1, 0)).length;
  items.forEach((item, index) => outputs.push({ name: join('items', `${String(index).padStart(width, '0')}.json`), bytes: json(item) }));
  const fetched = new Map<string, 'file' | 'withheld'>(), withheld: string[] = [];
  for (const binding of bindings) {
    const sha = SOURCE_REFERENCE.exec(String(binding.reference))?.[1];
    if (sha === undefined || fetched.has(sha)) continue;
    let bytes: Uint8Array;
    try { bytes = await get(`${origin}/run-export/${run}/sources/${sha}`, bearer); }
    catch (error) { if (error instanceof HubReplyError && error.status === 403) { fetched.set(sha, 'withheld'); withheld.push(sha); continue; } throw error; }
    if (sha256(bytes) !== sha) throw new Error(`原件 ${sha.slice(0, 12)} 的字节与运行绑定的摘要不符，什么都没有写入`);
    fetched.set(sha, 'file');
    outputs.push({ name: join('sources', sha), bytes });
  }
  outputs.push({ name: 'sources.json', bytes: json(bindings.map((binding) => {
    const sha = SOURCE_REFERENCE.exec(String(binding.reference))?.[1];
    const state = sha === undefined ? undefined : fetched.get(sha);
    return { slot: binding.slot ?? null, role: binding.role ?? null, reference: binding.reference, label: binding.label ?? null, media_type: binding.media_type ?? null, file: state === 'file' ? `sources/${sha}` : null, ...(state === 'withheld' ? { withheld: '你的读取层级不给这份原件的字节' } : {}) };
  })) });
  const present = await readdir(out).catch(() => []);
  if (present.length) throw new Error(`--out 目录 ${out} 里已有文件（${present.slice(0, 3).join('、')}），不覆盖；另选一个新目录重取`);
  await mkdir(join(out, 'items'), { recursive: true, mode: 0o700 }); await mkdir(join(out, 'sources'), { recursive: true, mode: 0o700 });
  const files: Record<string, string> = {}, written: string[] = [];
  try { for (const { name, bytes } of outputs) { const path = join(out, name); await writeNew(path, bytes); written.push(path); files[name] = sha256(bytes); } }
  catch (error) { await Promise.all(written.map((path) => rm(path, { force: true }))); throw error; }
  return { run, out, items: items.length, sources: [...fetched.values()].filter((state) => state === 'file').length, withheld, files };
}

/** The token from standard input, refused when it is Circle's placeholder or plainly no token. */
export async function bearerFrom(readToken: () => Promise<string>): Promise<string> {
  const bearer = await readToken();
  // Circle hands a secret it does not store over as its literal placeholder: that is no token, and it is never sent.
  const placeholder = /^%([A-Z][A-Z0-9_]*)%$/.exec(bearer);
  if (placeholder) throw new Error(`Circle 里没有存密钥 ${placeholder[1]}（标准输入收到的是原样的占位符），什么都没有发出；所有者用 /secrets ${placeholder[1]} 存入 Hub 令牌后重跑`);
  if (!/^[\x21-\x7e]{8,4096}$/.test(bearer)) throw new Error("标准输入里没有令牌；在命令末尾写 <<'EOF'，下一行写 %HUB_TOKEN%，再一行写 EOF，令牌不写进参数");
  return bearer;
}

/** The origin of --hub; only http and https are accepted. */
export function hubOrigin(value: string): string {
  try { const url = new URL(value); if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(); return url.origin; }
  catch { throw new Error('--hub 必须是 Hub 的 http 或 https 地址（与 MCP 条目同一台）'); }
}

export const RUN_ID = /^run_[a-z0-9]+$/;

/** The case files of a directory in name order; one file is one item of the submission, exactly as written. */
export async function itemFiles(directory: string, shape: (value: { [key: string]: unknown }) => { [key: string]: unknown } = (value) => value): Promise<Array<{ [key: string]: unknown }>> {
  let names: string[];
  try { names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort(); } catch { throw new Error(`读不到 --plans 目录 ${directory}`); }
  if (!names.length) throw new Error(`--plans 目录 ${directory} 里没有 .json 文件`);
  const items: Array<{ [key: string]: unknown }> = [], seen = new Map<string, string>();
  for (const name of names) {
    const read = jsonBytes(await readBytes(join(directory, name), 'plans'), 'plans');
    const value = isRecord(read) ? shape(read) : read;
    if (!isRecord(value) || typeof value.item !== 'string' || !value.item || typeof value.handling !== 'string') throw new Error(`${name} 不是一个条目；写 {"item":"<编号>","handling":"handled","slots":{"plan":[…]}}`);
    const earlier = seen.get(value.item);
    if (earlier !== undefined) throw new Error(`${earlier} 和 ${name} 是同一个条目 ${value.item}；每个条目只留一个文件`);
    seen.set(value.item, name);
    items.push(value);
  }
  return items;
}

/** One submit_result call. The answer comes back as text, with whether the tool reported a failure. */
export async function submitResult(origin: string, bearer: string, submission: unknown): Promise<{ text: string; failed: boolean }> {
  let reply: Response; let body: string;
  try {
    reply = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'submit_result', arguments: submission } }),
      signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    });
    body = await reply.text();
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') throw new Error(`Hub ${SUBMIT_TIMEOUT_MS / 1000} 秒内没有答复；核验可能还在进行，读运行记录确认后再决定是否重交`);
    const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code ?? error.message : '未知原因';
    throw new Error(`Hub 不可达（${String(cause).slice(0, 120)}）；提交没有发出，核对 --hub 和网络后重交`);
  }
  if (!reply.ok) throw new Error(`Hub 答复 ${reply.status}：${body.trim().slice(0, 300)}`);
  let answer: unknown; try { answer = JSON.parse(body); } catch { throw new Error('Hub 的答复不是 JSON'); }
  if (isRecord(answer) && isRecord(answer.error)) throw new Error(`Hub 拒绝了这次调用：${String(answer.error.message).slice(0, 500)}`);
  const result = isRecord(answer) && isRecord(answer.result) ? answer.result : null, content = Array.isArray(result?.content) ? result.content : [];
  const text = content.flatMap((part) => (isRecord(part) && typeof part.text === 'string' ? [part.text] : [])).join('\n');
  if (result === null || !text) throw new Error('Hub 的答复没有文字内容');
  return { text, failed: result.isError === true };
}
