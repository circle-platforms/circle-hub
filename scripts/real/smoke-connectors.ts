// Owner-run connector smoke. Prints counts only; response text and request keys never leave the check.
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
  } else strings.push(...body.split(/<[^>]*>|\r?\n/).map((part) => part.trim()));
  return [...new Set(strings)].filter((value) => value.length >= 8 && !/^[0-9a-f]{64}$/i.test(value) && !key.includes(value));
}

interface LogSnapshot { path: string; size: number; ino: number; dev: number }
async function snapshot(path: string): Promise<LogSnapshot> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error('not a log');
  return { path, size: info.size, ino: info.ino, dev: info.dev };
}
async function appended(before: LogSnapshot): Promise<string> {
  const file = await open(before.path, 'r');
  try {
    const info = await file.stat();
    if (info.ino !== before.ino || info.dev !== before.dev || info.size < before.size || info.size - before.size > 64 * 1024 * 1024) throw new Error('log changed');
    const buffer = Buffer.alloc(info.size - before.size); let offset = 0;
    while (offset < buffer.length) {
      const result = await file.read(buffer, offset, buffer.length - offset, before.size + offset);
      if (!result.bytesRead) throw new Error('log incomplete');
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
  code: string;
  artifacts: number;
  bytes: number;
  commandLines: number;
  serviceLines: number;
  hits: { command: number; service: number };
  ok: boolean;
}

/** Sequential reads: one failed login is never retried. Missing exports or rotated/unreadable logs fail the check. */
export async function runSmoke(options: { logs: string; reads: readonly string[]; run?: SmokeCommand; print?: (line: string) => void }): Promise<SmokeResult[]> {
  const run = options.run ?? defaultCommand; const print = options.print ?? ((line) => process.stdout.write(`${line}\n`));
  const requests = options.reads.map((input) => {
    const match = /^([^:]+):([a-z0-9][a-z0-9._-]*):(.+)$/.exec(input);
    if (!match || !/^[a-z0-9][a-z0-9._-]*$/.test(match[1])) throw new Error('invalid read');
    return { resource: match[1], read: match[2], key: match[3] };
  });
  if (!requests.length) throw new Error('no reads');
  const results: SmokeResult[] = [];
  for (const request of requests) {
    const result: SmokeResult = { system: '系统包未取得', read: request.read, completed: false, code: '检查未完成', artifacts: 0, bytes: 0, commandLines: 0, serviceLines: 0, hits: { command: 0, service: 0 }, ok: false };
    let scratch: string | undefined;
    try {
      const before = await Promise.all(['hub.out.log', 'hub.err.log'].map((name) => snapshot(join(options.logs, name))));
      const reply = await run(['resource', 'read', request.resource, request.read, request.key]);
      let commandText = `${reply.stdout}\n${reply.stderr}`;
      const header = /^([a-z0-9][a-z0-9._-]*@[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?)\/([a-z0-9][a-z0-9._-]*)：(读取完成|失败（([A-Z_]+)）)$/m.exec(reply.stdout);
      if (header && header[2] === request.read) { result.system = header[1]; result.code = header[4] ?? ''; result.completed = reply.code === 0 && header[3] === '读取完成'; }
      const artifacts = [...reply.stdout.matchAll(/^产物 ([a-z0-9][a-z0-9._-]*) ([0-9a-f]{64}) ([0-9]+) 字节$/gm)].map((match) => ({ name: match[1], sha256: match[2], size: Number(match[3]) }));
      result.artifacts = artifacts.length; result.bytes = artifacts.reduce((sum, artifact) => sum + artifact.size, 0);
      let exported = artifacts.length > 0 && /^读清单 [0-9a-f]{64}$/m.test(reply.stdout);
      const candidates: string[] = [];
      scratch = await mkdtemp(join(tmpdir(), 'circle-hub-smoke-')); await chmod(scratch, 0o700);
      for (const [i, artifact] of artifacts.entries()) {
        const target = join(scratch, `${i}.original`);
        const exportedReply = await run(['original', 'export', artifact.sha256, '--out', target]);
        commandText += `\n${exportedReply.stdout}\n${exportedReply.stderr}`;
        if (exportedReply.code !== 0) { exported = false; continue; }
        const bytes = await readFile(target);
        if (bytes.length !== artifact.size || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) exported = false;
        candidates.push(...responseStrings(new TextDecoder('utf-8', { fatal: true }).decode(bytes), request.key));
      }
      const serviceText = (await Promise.all(before.map(appended))).join('\n');
      result.commandLines = lineCount(commandText); result.serviceLines = lineCount(serviceText);
      result.hits = { command: hitsIn(commandText, candidates), service: hitsIn(serviceText, candidates) };
      result.ok = result.completed && exported && result.hits.command === 0 && result.hits.service === 0;
    } catch { result.ok = false; }
    finally { if (scratch) await rm(scratch, { recursive: true, force: true }); }
    print(`${result.system}/${result.read}：${result.completed ? '读取完成' : `失败（${result.code}）`}，产物 ${result.artifacts} 个共 ${result.bytes} 字节，命令输出 ${result.commandLines} 行、服务日志 ${result.serviceLines} 行，命中 ${result.hits.command + result.hits.service}（命令输出 ${result.hits.command}、服务日志 ${result.hits.service}）：${result.ok ? '通过' : '不通过'}`);
    results.push(result);
  }
  return results;
}

async function main(): Promise<void> {
  try {
    const args = process.argv.slice(2); let logs: string | undefined; const reads: string[] = [];
    for (let i = 0; i < args.length; i += 2) {
      if (!args[i + 1]) throw new Error('missing argument');
      if (args[i] === '--logs' && logs === undefined) logs = args[i + 1];
      else if (args[i] === '--read') reads.push(args[i + 1]);
      else throw new Error('invalid argument');
    }
    if (!logs) throw new Error('missing logs');
    const results = await runSmoke({ logs, reads }); process.exitCode = results.every((result) => result.ok) ? 0 : 1;
  } catch { process.stderr.write('连接器冒烟检查未完成\n'); process.exitCode = 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
