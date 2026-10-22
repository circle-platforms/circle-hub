// Console client support for acceptance tests: HTML inspection, cookie/session management, and HTTP requests.
import { request as httpRequest } from 'node:http';
import type { TestHub } from '../../../hub/server/testing-real.ts';

export interface ConsoleReply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface ConsoleClient {
  port: number;
  sessionCookie?: string;
  get(path: string): Promise<ConsoleReply>;
  post(path: string, fields: Record<string, string>): Promise<ConsoleReply>;
  send(path: string, options?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<ConsoleReply>;
}

export function requestHttp(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<ConsoleReply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${port}`, ...(options.headers ?? {}) };
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers, setHost: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const cookieHeader = (reply: ConsoleReply, name: string): string | undefined =>
  ([] as string[]).concat(reply.headers['set-cookie'] ?? []).find((value) => value.startsWith(`${name}=`));
const cookieValue = (header: string | undefined): string => (header ?? '').split(';')[0].split('=').slice(1).join('=');
const csrfOf = (body: string): string => /name="csrf" value="([^"]+)"/.exec(body)?.[1] ?? '';

export async function openConsole(hub: TestHub, token?: string): Promise<ConsoleClient> {
  const port = hub.port;
  let sessionCookie: string | undefined;

  const client: ConsoleClient = {
    port,
    get sessionCookie() {
      return sessionCookie;
    },
    async send(path, options = {}) {
      const headers = { ...(options.headers ?? {}) };
      if (sessionCookie && !headers.cookie) headers.cookie = `circle_hub_session=${sessionCookie}`;
      return requestHttp(port, path, { ...options, headers });
    },
    async get(path) {
      return client.send(path, { method: 'GET' });
    },
    async post(path, fields) {
      const form = new URLSearchParams(fields).toString();
      const origin = `http://127.0.0.1:${port}`;
      return client.send(path, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin,
          referer: `${origin}${path}`,
        },
        body: form,
      });
    },
  };

  if (token) {
    const loginPage = await requestHttp(port, '/console/login');
    const nonce = csrfOf(loginPage.body);
    const loginCookie = cookieValue(cookieHeader(loginPage, 'circle_hub_login'));
    const origin = `http://127.0.0.1:${port}`;
    const loginRes = await requestHttp(port, '/console/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `circle_hub_login=${loginCookie}`,
        origin,
        referer: `${origin}/console/login`,
      },
      body: new URLSearchParams({ token, csrf: nonce }).toString(),
    });
    sessionCookie = cookieValue(cookieHeader(loginRes, 'circle_hub_session'));
  }

  return client;
}
