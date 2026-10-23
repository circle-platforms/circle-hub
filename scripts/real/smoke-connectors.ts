// Owner-run connector smoke. Prints counts only; response text and request keys never leave the check.
import { PROTOCOL_CODES, type ProtocolCode } from '../../contracts/generated/protocol.ts';
import { isConnectorErrorCode, type ConnectorErrorCode } from '../../hub/connectors/api.ts';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export type SmokeCommand = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
const defaultCommand: SmokeCommand = (args) => new Promise((done) => {
  execFile(process.execPath, ['bin/circle-hub', ...args], { cwd: resolve(import.meta.dirname, '../..'), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000 }, (error, stdout, stderr) => {
    done({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout, stderr });
  });
});

/** Every JSON string value, or text fragments split by markup and newlines. No key names or response bodies are printed. */
export function responseStrings(body: string, key: string): string[] {
  const strings: string[] = [];
  let value: unknown;
  let json = true;
  try { value = JSON.parse(body); } catch { json = false; }
  if (json) {
    const pending: unknown[] = [value];
    while (pending.length > 0) {
      const item = pending.pop();
      if (typeof item === 'string') strings.push(item);
      else if (item && typeof item === 'object') for (const child of Object.values(item)) pending.push(child);
    }
    strings.reverse();
  } else {
    strings.push(...body.split(/<[^>]*>|\r?\n/).map(part => part.trim()));
    for (const match of body.matchAll(/(?:^|[\s<])[^\s"'<>/=`]+\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) strings.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return [...new Set(strings)].filter((value) => value.length >= 8 && !/^[0-9a-f]{64}$/i.test(value) && !key.includes(value));
}

export class SmokeInputError extends Error {}
class SmokeCheckError extends Error {}

interface LogSnapshot { path: string; size: number; ino: number; dev: number }
async function snapshot(path: string): Promise<LogSnapshot> {
  let info;
  try { info = await stat(path); } catch { throw new SmokeCheckError('日志缺失或无法读取；下一步提供两份服务日志'); }
  if (!info.isFile()) throw new SmokeCheckError('日志不是普通文件；下一步提供两份普通服务日志');
  return { path, size: info.size, ino: info.ino, dev: info.dev };
}
async function appended(before: LogSnapshot): Promise<string> {
  let file;
  try { file = await open(before.path, 'r'); } catch { throw new SmokeCheckError('日志缺失或无法读取；下一步恢复对应服务日志'); }
  try {
    const info = await file.stat();
    if (info.ino !== before.ino || info.dev !== before.dev || info.size < before.size) throw new SmokeCheckError('日志被轮转或截短；下一步在日志稳定的时段重新核对');
    if (info.size - before.size > 64 * 1024 * 1024) throw new SmokeCheckError('日志增量超过 64 MiB；下一步选择较短的核对窗口');
    const buffer = Buffer.alloc(info.size - before.size); let offset = 0;
    while (offset < buffer.length) {
      const result = await file.read(buffer, offset, buffer.length - offset, before.size + offset);
      if (!result.bytesRead) throw new SmokeCheckError('日志读取不完整；下一步在日志稳定后重新核对');
      offset += result.bytesRead;
    }
    return buffer.toString('utf8');
  } finally { await file.close(); }
}
const lineCount = (text: string): number => text.split(/\r?\n/).filter((line) => line.length > 0).length;
const hitsIn = (text: string, candidates: readonly string[]): number => {
  let count = 0;
  for (const candidate of new Set(candidates.flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]))) {
    let at = 0;
    while ((at = text.indexOf(candidate, at)) >= 0) { count++; at += candidate.length; }
  }
  return count;
};
export interface SmokeResult {
  system: string;
  read: string;
  completed: boolean;
  code: ConnectorErrorCode | ProtocolCode | null;
  cliExit: number | null;
  artifacts: number;
  candidates: number;
  reason: string;
  bytes: number;
  commandLines: number;
  serviceLines: number;
  hits: { command: number; service: number };
  ok: boolean;
}

/** Sequential reads: one failed login is never retried. Missing exports or rotated/unreadable logs fail the check. */
export async function runSmoke(options: { logs: string; reads: readonly string[]; run?: SmokeCommand; print?: (line: string) => void }): Promise<SmokeResult[]> {
  const run = options.run ?? defaultCommand; const print = options.print ?? ((line) => process.stdout.write(`${line}\n`));
  if (!Array.isArray(options.reads) || !options.reads.length) throw new SmokeInputError('--read 需要至少一个 <资源>:<读取名>:<键>；下一步补充读取参数');
  const requests = options.reads.map(input => {
    const match = typeof input === 'string' ? /^([a-z0-9][a-z0-9._-]*):([a-z0-9][a-z0-9._-]*):(.+)$/.exec(input) : null;
    if (!match) throw new SmokeInputError('--read 格式应为 <资源>:<读取名>:<键>；下一步核对参数格式，不在输出中回显键');
    return { resource: match[1]!, read: match[2]!, key: match[3]! };
  });
  if (typeof options.logs !== 'string' || !options.logs) throw new SmokeInputError('--logs 需要服务日志目录；下一步提供包含两份服务日志的目录');
  const logPaths = ['hub.out.log', 'hub.err.log'].map(name => join(options.logs, name));
  try { await Promise.all(logPaths.map(snapshot)); }
  catch { throw new SmokeInputError('--logs 需要现有的普通 hub.out.log 和 hub.err.log 文件；下一步提供正确的服务日志目录'); }
  const results: SmokeResult[] = [];
  for (const request of requests) {
    let asciiOnly = false;
    const result: SmokeResult = { system: '系统包未取得', read: request.read, completed: false, code: null, cliExit: null, artifacts: 0, candidates: 0, reason: '', bytes: 0, commandLines: 0, serviceLines: 0, hits: { command: 0, service: 0 }, ok: false };
    const reasons = new Set<string>(); const fail = (reason: string) => reasons.add(reason);
    let scratch: string | undefined;
    try {
      const before = await Promise.all(logPaths.map(snapshot));
      let reply: Awaited<ReturnType<SmokeCommand>>;
      try { reply = await run(['resource', 'read', request.resource, request.read, request.key, '--events']); }
      catch { throw new SmokeCheckError('CLI 子进程未能执行；下一步检查 CLI 与管理员令牌'); }
      result.cliExit = reply.code; let commandText = `${reply.stdout}\n${reply.stderr}`;
      const header = /^([a-z0-9][a-z0-9._-]*@[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-z0-9.-]+)*)\/([a-z0-9][a-z0-9._-]*)：(读取完成|失败（([A-Z_]+)）)$/m.exec(reply.stdout);
      if (!header || header[2] !== request.read) fail(`CLI 没有输出匹配的读取行（退出码 ${reply.code}）；下一步检查管理员令牌、资源和读取名`);
      else {
        result.system = header[1]!; result.completed = header[3] === '读取完成';
        if (header[4]) {
          if (isConnectorErrorCode(header[4]) || Object.hasOwn(PROTOCOL_CODES, header[4])) result.code = header[4] as ConnectorErrorCode | ProtocolCode;
          else fail('CLI 输出的读取码未登记；下一步核对 CLI 输出与错误码注册');
        }
        if (!result.completed) fail(`CLI 读取失败（退出码 ${reply.code}）；下一步核对管理员读取记录和凭据配置`);
      }
      if (reply.code !== 0) fail(`CLI 退出非零（退出码 ${reply.code}）；下一步核对管理员读取记录`);
      const artifacts = [...reply.stdout.matchAll(/^产物 ([a-z0-9][a-z0-9._-]*) ([0-9a-f]{64}) ([0-9]+) 字节$/gm)].map(match => ({ name: match[1]!, sha256: match[2]!, size: Number(match[3]) }));
      result.artifacts = artifacts.length; result.bytes = artifacts.reduce((sum, artifact) => sum + artifact.size, 0);
      let exported = artifacts.length > 0;
      if (!exported) fail('CLI 没有输出可核对的产物；下一步选择包含原件的读取或核对 CLI 输出契约');
      if (!/^读清单 [0-9a-f]{64}$/m.test(reply.stdout)) { exported = false; fail('缺少读清单摘要；下一步核对 CLI 输出契约'); }
      const candidates: string[] = [];
      scratch = await mkdtemp(join(tmpdir(), 'circle-hub-smoke-')); await chmod(scratch, 0o700);
      for (const [i, artifact] of artifacts.entries()) {
        const target = join(scratch, `${i}.original`); let exportedReply: Awaited<ReturnType<SmokeCommand>>;
        try { exportedReply = await run(['original', 'export', artifact.sha256, '--out', target]); }
        catch { exported = false; fail('导出失败；下一步检查原件权限与 original export'); continue; }
        commandText += `\n${exportedReply.stdout}\n${exportedReply.stderr}`;
        if (exportedReply.code !== 0) { exported = false; fail('导出失败；下一步检查原件权限与 original export'); continue; }
        let bytes: Buffer;
        try { bytes = await readFile(target); } catch { exported = false; fail('导出文件缺失；下一步核对 original export 的输出契约'); continue; }
        if (bytes.length !== artifact.size || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) { exported = false; fail('原件摘要或大小不符；下一步重新核对导出的原件身份'); continue; }
        let text: string; let strictUtf8=true;
        if (bytes.includes(0)) { exported = false; fail('原件含 NUL，不能按支持的文本编码核对；下一步选择不含 NUL 的 UTF-8 文本读取'); continue; }
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch {
          // Latin-1 is a one-byte view used only to find ASCII canaries, never a charset guess.
          strictUtf8=false; asciiOnly=true; text=bytes.toString('latin1').replace(/[\u0080-\u00ff]/g,'�');
        }
        const eligible=responseStrings(text,request.key).filter(value=>strictUtf8 || /^[\x00-\x7f]+$/.test(value));
        if(!strictUtf8 && !eligible.length){exported=false;fail('原件不是 UTF-8，没有与编码无关的文字可核对；下一步选择 UTF-8 文本读取');continue;}
        candidates.push(...eligible);
      }
      const serviceText = (await Promise.all(before.map(appended))).join('\n');
      result.commandLines = lineCount(commandText); result.serviceLines = lineCount(serviceText);
      const unique = [...new Set(candidates)]; result.candidates = unique.length;
      if (exported && !unique.length) fail('应答里没有可核对的文字；下一步选择应答包含至少八个字符文字的读取');
      result.hits = { command: hitsIn(commandText, unique), service: hitsIn(serviceText, unique) };
      if (result.hits.command || result.hits.service) fail('命令输出或服务日志含应答候选文字；下一步由管理员核对对应读取记录与日志');
      result.ok = result.completed && reply.code === 0 && exported && result.candidates > 0 && reasons.size === 0;
    } catch (error) { fail(error instanceof SmokeCheckError ? error.message : '本地核对未完成；下一步核对输入与脚本实现'); }
    finally {
      if (scratch) { try { await rm(scratch, { recursive: true, force: true }); } catch { result.ok = false; fail('临时原件目录清理失败；下一步清理本次临时文件'); } }
    }
    result.reason = [...reasons].join('；');
    const state = result.completed ? '读取完成' : result.code ? `失败（${result.code}）` : '未取得可核对读取结果';
    print(`${result.system}/${result.read}：${state}，CLI 退出 ${result.cliExit ?? '未执行'}，产物 ${result.artifacts} 个共 ${result.bytes} 字节，命令输出 ${result.commandLines} 行、服务日志 ${result.serviceLines} 行，候选文字 ${result.candidates} 条，命中 ${result.hits.command + result.hits.service}（命令输出 ${result.hits.command}、服务日志 ${result.hits.service}）：${result.ok ? '通过' : '不通过'}${asciiOnly ? '；非 UTF-8 原件仅核对 ASCII 候选文字，其他文字未核对' : ''}${result.reason ? `；原因：${result.reason}` : ''}`);
    results.push(result);
  }
  return results;
}

async function main(): Promise<void> {
  try {
    const args = process.argv.slice(2); let logs: string | undefined; const reads: string[] = [];
    for (let i = 0; i < args.length; i += 2) {
      if (!args[i + 1]) throw new SmokeInputError('参数需要 --logs <目录> 和 --read <资源>:<读取名>:<键>；下一步补齐参数');
      if (args[i] === '--logs' && logs === undefined) logs = args[i + 1];
      else if (args[i] === '--read') reads.push(args[i + 1]);
      else throw new SmokeInputError('只接受 --logs <目录> 和可重复的 --read <资源>:<读取名>:<键>；下一步核对参数格式');
    }
    if (!logs) throw new SmokeInputError('--logs 缺失；下一步提供两份服务日志所在目录');
    const results = await runSmoke({ logs, reads }); process.exitCode = results.every((result) => result.ok) ? 0 : 1;
  } catch (error) { process.stderr.write(error instanceof SmokeInputError ? `${error.message}\n` : '本地冒烟检查未完成；下一步核对输入与脚本实现\n'); process.exitCode = 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
