// Owner-run read-only console probe. Never print tokens, paths, names, response bodies or exception messages.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export interface PageMetrics {
  scripts: number;
  externalAddresses: number;
  tableRows: number[];
  sha256: string;
}

/** Counts markup only, without interpreting stored case names as executable HTML. */
export function summarizePage(body: string): PageMetrics {
  // Session nonces are not page content; leave every other byte in the evidence digest unchanged.
  const stableBody=body.replace(/<input\b[^>]*>/gi,tag=>/(?:\s)name\s*=\s*["']csrf["']/i.test(tag)
    ? tag.replace(/(\bvalue\s*=\s*)(["'])(.*?)\2/i,(_all,prefix:string,quote:string)=>`${prefix}${quote}[csrf]${quote}`) : tag);
  return {
    scripts: (body.match(/<script\b/gi) ?? []).length,
    externalAddresses: (body.match(/https?:\/\/[^\s"'<>]+|(?:href|src|action)\s*=\s*["']\/\/[^"']+/gi) ?? []).length,
    tableRows: [...body.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map((match) => {
      const content = match[1].replace(/<thead\b[^>]*>[\s\S]*?<\/thead>/gi, '');
      return [...content.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].filter((row) => /<td\b/i.test(row[1])).length;
    }),
    sha256: createHash('sha256').update(stableBody, 'utf8').digest('hex').slice(0, 12),
  };
}

const csrfOf = (body: string): string | undefined => /<input\b[^>]*name="csrf"[^>]*value="([A-Za-z0-9_-]+)"/i.exec(body)?.[1];

export interface ProbeResult extends PageMetrics {
  status: number;
  csp: boolean;
  loginStatus: number;
  logoutStatus: number;
}

/** Sign in, fetch exactly one requested page, and sign out even if the requested page fails. No redirect is followed. */
export async function probeConsole(options: { url: string; path: string; token: string }): Promise<ProbeResult> {
  const base = new URL(options.url);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('invalid origin');
  const target = new URL(options.path, base);
  if (!options.path.startsWith('/console/') || target.origin !== base.origin || !target.pathname.startsWith('/console/') || target.hash || target.pathname === '/console/login' || target.pathname === '/console/logout') throw new Error('invalid path');
  const token = options.token.trim().replace(/^Bearer[ \t]+/i, '');
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('invalid token');
  const jar = new Map<string, string>();
  const fetchPage = async (path: string, fields?: Record<string, string>): Promise<Response> => {
    const reply = await fetch(new URL(path, base), {
      method: fields === undefined ? 'GET' : 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000),
      headers: { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '), ...(fields === undefined ? {} : { origin: base.origin, 'content-type': 'application/x-www-form-urlencoded' }) },
      ...(fields === undefined ? {} : { body: new URLSearchParams(fields).toString() }),
    });
    for (const cookie of reply.headers.getSetCookie()) {
      const pair = cookie.split(';')[0]; const equals = pair.indexOf('=');
      const name = pair.slice(0, equals);
      if (equals > 0 && ['circle_hub_login', 'circle_hub_session'].includes(name)) jar.set(name, pair.slice(equals + 1));
    }
    return reply;
  };
  const form = await fetchPage('/console/login');
  const nonce = csrfOf(await form.text());
  if (form.status !== 200 || nonce === undefined) throw new Error('login form unavailable');
  const logged = await fetchPage('/console/login', { csrf: nonce, token });
  await logged.text();
  if (logged.status !== 303 || !jar.get('circle_hub_session')) throw new Error('login refused');
  let csrf: string | undefined;
  let metrics: Omit<ProbeResult, 'logoutStatus'>;
  let logoutStatus = 0;
  try {
    const reply = await fetchPage(`${target.pathname}${target.search}`);
    const body = await reply.text();
    csrf = csrfOf(body);
    metrics = { status: reply.status, csp: reply.headers.has('content-security-policy'), loginStatus: logged.status, ...summarizePage(body) };
  } finally {
    if (csrf === undefined) {
      const home = await fetchPage('/console/runs');
      csrf = csrfOf(await home.text());
    }
    if (csrf === undefined) throw new Error('logout form unavailable');
    const reply = await fetchPage('/console/logout', { csrf });
    logoutStatus = reply.status;
    await reply.text();
    if (logoutStatus !== 303) throw new Error('logout refused');
  }
  return { ...metrics, logoutStatus };
}

async function main(): Promise<void> {
  try {
    const args = process.argv.slice(2); const values = new Map<string, string>();
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i]; const value = args[i + 1];
      if (!['--token-file', '--path', '--url'].includes(key) || values.has(key) || value === undefined || value.startsWith('--')) throw new Error('invalid arguments');
      values.set(key, value);
    }
    if (!values.has('--token-file') || !values.has('--path')) throw new Error('missing arguments');
    const result = await probeConsole({ url: values.get('--url') ?? 'http://127.0.0.1:7420', path: values.get('--path')!, token: await readFile(values.get('--token-file')!, 'utf8') });
    process.stdout.write(`登录状态码 ${result.loginStatus}；状态码 ${result.status}；退出状态码 ${result.logoutStatus}\nCSP ${result.csp ? '有' : '无'}；脚本标签 ${result.scripts}；外部地址 ${result.externalAddresses}\n`);
    result.tableRows.forEach((rows, i) => process.stdout.write(`表 ${i + 1}：${rows} 行\n`));
    process.stdout.write(`正文 SHA-256 ${result.sha256}\n`);
    if (result.status !== 200 || !result.csp || result.scripts !== 0 || result.externalAddresses !== 0) process.exitCode = 1;
  } catch {
    process.stderr.write('控制台检查未完成\n');
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
