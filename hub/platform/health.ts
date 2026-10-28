// Health of the running Hub: GET /healthz on loopback. A body naming another release than the one expected is not
// healthy yet, so an old process still holding the port cannot pass a deploy.
import { connect } from 'node:net';
import { request } from 'node:http';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { PlatformError } from './errors.ts';

export const HEALTH_PATH = '/healthz';
const LOOPBACK = '127.0.0.1';

export interface HealthResult {
  ok: boolean;
  status?: number;
  release?: string;
  error?: string;
}

export interface HealthOptions {
  timeoutMs?: number;
  /** Explicit listener and one declared authority; the TCP destination never comes from the authority. */
  host?: string;
  authority?: string;
  /** When set, a body whose `release` names another release is not healthy. */
  release?: string;
}

export async function checkHealth(port: number, options: HealthOptions = {}): Promise<HealthResult> {
  try {
    const host = options.host ?? LOOPBACK;
    const response = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request({ host, port, path: HEALTH_PATH, method: 'GET', signal: AbortSignal.timeout(options.timeoutMs ?? 2000), headers: { accept: 'application/json', ...(options.authority ? { host: `${options.authority}:${port}` } : {}) } }, res => {
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 64 * 1024) req.destroy(new Error('健康检查应答过大')); else chunks.push(chunk); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      });
      req.on('error', reject); req.end();
    });
    const text = response.text;
    let release: string | undefined;
    try {
      const body = JSON.parse(text) as { release?: unknown };
      if (typeof body.release === 'string') release = body.release;
    } catch {
      // A plain-text body is fine.
    }
    const named = release === undefined ? {} : { release };
    if (response.status !== 200) return { ok: false, status: response.status, ...named };
    if (options.release !== undefined && release !== undefined && release !== options.release) {
      return { ok: false, status: response.status, ...named, error: `应答来自发布 ${release}，不是 ${options.release}` };
    }
    return { ok: true, status: response.status, ...named };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export interface WaitOptions extends HealthOptions {
  totalMs?: number;
  intervalMs?: number;
}

/** Polls until healthy; throws with the last observation when the time is up. */
export async function waitForHealth(port: number, options: WaitOptions = {}): Promise<HealthResult> {
  const deadline = Date.now() + (options.totalMs ?? 60_000);
  let last: HealthResult = { ok: false, error: '没有检查' };
  do {
    last = await checkHealth(port, options);
    if (last.ok) return last;
    await delay(options.intervalMs ?? 500);
  } while (Date.now() < deadline);
  const seen = last.status !== undefined ? `HTTP ${last.status}` : (last.error ?? '没有应答');
  throw new PlatformError(`健康检查超时（${options.host ?? LOOPBACK}:${port}${HEALTH_PATH}，最后一次：${seen}${last.error && last.status !== undefined ? `，${last.error}` : ''}）`);
}

/** True when something accepts TCP connections on the loopback port. */
export function portAnswers(port: number, timeoutMs = 1000, host = LOOPBACK): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (answer: boolean) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** A malformed or unreadable kernel inventory is unknown, never proof of an idle port. */
export async function linuxPortOccupied(port: number, read: (path: string) => Promise<string> = path => readFile(path, 'utf8')): Promise<boolean> {
  try {
    const tables = await Promise.all([read('/proc/net/tcp'), read('/proc/net/tcp6')]);
    const target = port.toString(16).toUpperCase().padStart(4, '0');
    for (let table = 0; table < tables.length; table++) {
      const lines = tables[table]!.split('\n');
      const header = (lines.shift() ?? '').trim().split(/\s+/);
      if (header[0] !== 'sl' || header[1] !== 'local_address' || header[2] !== (table === 0 ? 'rem_address' : 'remote_address') || header[3] !== 'st') return true;
      for (const line of lines) {
        if (!line.trim()) continue;
        const fields = line.trim().split(/\s+/);
        if (fields.length < 4) return true;
        const pattern = table === 0 ? /^[0-9A-F]{8}:([0-9A-F]{4})$/ : /^[0-9A-F]{32}:([0-9A-F]{4})$/;
        const local = pattern.exec(fields[1] ?? '');
        if (!local || !/^[0-9A-F]{2}$/.test(fields[3] ?? '')) return true;
        if (local[1] === target && fields[3] === '0A') return true;
      }
    }
    return false;
  } catch { return true; }
}

/** Fail closed on an unavailable inventory. Checking only the newly configured IP can miss an old running service. */
export async function portOccupied(port: number): Promise<boolean> {
  if (process.platform === 'darwin') return new Promise(resolve => {
    execFile('/usr/sbin/lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { timeout: 3000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (stdout.trim() || stderr.trim()) return resolve(true);
      resolve(error === null ? false : (error as { code?: string | number }).code !== 1);
    });
  });
  if (process.platform === 'linux') return linuxPortOccupied(port);
  return true;
}
