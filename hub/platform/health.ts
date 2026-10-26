// Health of the running Hub: GET /healthz on loopback. A body naming another release than the one expected is not
// healthy yet, so an old process still holding the port cannot pass a deploy.
import { connect } from 'node:net';
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
  /** When set, a body whose `release` names another release is not healthy. */
  release?: string;
}

export async function checkHealth(port: number, options: HealthOptions = {}): Promise<HealthResult> {
  try {
    const response = await fetch(`http://${LOOPBACK}:${port}${HEALTH_PATH}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? 2000),
      headers: { accept: 'application/json' },
    });
    const text = await response.text();
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
  throw new PlatformError(`健康检查超时（http://${LOOPBACK}:${port}${HEALTH_PATH}，最后一次：${seen}${last.error && last.status !== undefined ? `，${last.error}` : ''}）`);
}

/** True when something accepts TCP connections on the loopback port. */
export function portAnswers(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: LOOPBACK, port });
    const done = (answer: boolean) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}
