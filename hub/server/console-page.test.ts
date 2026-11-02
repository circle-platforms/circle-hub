// The real-system probe is exercised only against a synthetic loopback HTTP server.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { probeConsole, summarizePage } from '../../scripts/real/console-page.ts';

const body = '<html><form action="/console/logout"><input name="csrf" value="synthetic-csrf"></form><p>合成私密名称</p><table><thead><tr><th>名称</th></tr></thead><tbody><tr><td>合成内容</td></tr><tr><td>合成内容</td></tr></tbody></table></html>';
/** The probe signs in as a console account does, with its username and password; the trailing space is part of the password. */
const USERNAME = '合成探测管理员';
const PASSWORD = 'synthetic-probe-password ';
async function fixture(action: (url: string, calls: string[]) => Promise<void>, target = body, status = 200) {
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    calls.push(`${req.method} ${req.url}`);
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    if (req.url === '/console/login' && req.method === 'GET') {
      res.setHeader('set-cookie', 'circle_hub_login=synthetic-nonce; Path=/console/login');
      res.end('<input name="csrf" value="synthetic-nonce">');
    } else if (req.url === '/console/login') {
      assert.match(req.headers.cookie ?? '', /circle_hub_login=synthetic-nonce/);
      assert.equal(req.headers.origin, `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`);
      assert.equal(form.get('csrf'), 'synthetic-nonce'); assert.equal(form.get('username'), USERNAME); assert.equal(form.get('password'), PASSWORD);
      assert.equal(form.has('token'), false, 'a token never signs in');
      res.writeHead(303, { location: '/console/runs', 'set-cookie': 'circle_hub_session=synthetic-session; Path=/console' }); res.end();
    } else if (req.url === '/console/logout') {
      assert.equal(form.get('csrf'), 'synthetic-csrf'); assert.match(req.headers.cookie ?? '', /circle_hub_session=synthetic-session/);
      res.writeHead(303, { location: '/console/login' }); res.end();
    } else {
      assert.match(req.headers.cookie ?? '', /circle_hub_session=synthetic-session/);
      res.writeHead(req.url === '/console/runs' ? 200 : status, { 'content-security-policy': "default-src 'none'" });
      res.end(req.url === '/console/runs' ? body : target);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await action(`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`, calls); }
  finally { await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); }
}

test('the CLI prints only metrics and signs out without exposing synthetic page content, the username or the password', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'console-probe-'));
  try {
    const passwordFile = join(dir, 'password'); await writeFile(passwordFile, `${PASSWORD}\n`, { mode: 0o600 });
    const run = (args: string[]) => new Promise<{ code: number | null; text: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['scripts/real/console-page.ts', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      let text = ''; child.stdout.on('data', (c) => { text += String(c); }); child.stderr.on('data', (c) => { text += String(c); });
      child.on('error', reject); child.on('close', (code) => resolve({ code, text }));
    });
    await fixture(async (url, calls) => {
      // The password never travels on argv: there is no flag for it, and nothing is sent.
      const onArgv = await run(['--username', USERNAME, '--password', PASSWORD.trim(), '--url', url, '--path', '/console/results']);
      assert.equal(onArgv.code, 1); assert.doesNotMatch(onArgv.text, /合成|synthetic|password/); assert.deepEqual(calls, []);
      const output = await run(['--username', USERNAME, '--password-file', passwordFile, '--url', url, '--path', '/console/results?build=synthetic-10.7']);
      assert.equal(output.code, 0, output.text); assert.doesNotMatch(output.text, /合成|synthetic|password|token|127\.0\.0\.1/);
      assert.match(output.text, /状态码 200/); assert.match(output.text, /CSP 有/); assert.match(output.text, /脚本标签 0/); assert.match(output.text, /外部地址 0/); assert.match(output.text, /表 1：2 行/); assert.match(output.text, /SHA-256 [0-9a-f]{12}/);
      assert.equal(calls.at(-1), 'POST /console/logout');
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an inline script counts unless the page CSP allows exactly its hash (the console live module)', () => {
  const script = "const x = 1;";
  const hash = createHash('sha256').update(script, 'utf8').digest('base64');
  const body = `<script type="module">${script}</script>`;
  assert.equal(summarizePage(body, `default-src 'none'; script-src 'sha256-${hash}'`).scripts, 0);
  assert.equal(summarizePage(body, "default-src 'none'").scripts, 1);
  assert.equal(summarizePage(body, `default-src 'none'; style-src 'sha256-${hash}'`).scripts, 1, 'only the script-src directive counts');
  assert.equal(summarizePage(`<script src="/x.js">${script}</script>`, `script-src 'sha256-${hash}'`).scripts, 1, 'an external script never counts as the allowed one');
  assert.equal(summarizePage(`${body}<script>alert(1)</script>`, `script-src 'sha256-${hash}'`).scripts, 1);
});

test('metrics detect unsafe markup, external addresses and each table independently', () => {
  const stats = summarizePage('<script src="https://192.0.2.1/a"></script><img src="//192.0.2.2/a"><table><tr><th>标题</th></tr><tr><td>值</td></tr></table><table><tbody></tbody></table>');
  assert.equal(stats.scripts, 1); assert.equal(stats.externalAddresses, 2); assert.deepEqual(stats.tableRows, [1, 0]); assert.match(stats.sha256, /^[0-9a-f]{12}$/);
});

test('an unavailable page still signs out using a freshly read console form', async () => {
  await fixture(async (url, calls) => {
    const stats = await probeConsole({ url, username: USERNAME, password: PASSWORD, path: '/console/results/absent' });
    assert.equal(stats.status, 404); assert.equal(stats.logoutStatus, 303); assert.equal(calls.at(-1), 'POST /console/logout'); assert.ok(calls.includes('GET /console/runs'));
  }, '对你不可用', 404);
});

test('probe rejects foreign URLs and non-console paths before any login', async () => {
  for (const [url, path] of [['http://192.0.2.1', '/console/results'], ['http://127.0.0.1', '//192.0.2.1/console'], ['http://127.0.0.1', '/mcp'], ['http://127.0.0.1', '/console/../mcp']]) {
    await assert.rejects(probeConsole({ url, path, username: USERNAME, password: PASSWORD }));
  }
});

test('probe rejects a username or password no console account can have before any login', async () => {
  await fixture(async (url, calls) => {
    for (const [username, password] of [['', PASSWORD], [' \t', PASSWORD], ['合'.repeat(101), PASSWORD], ['合成\n管理员', PASSWORD], [USERNAME, ''], [USERNAME, 'short-pass'], [USERNAME, `${PASSWORD}\n`], [USERNAME, 'p'.repeat(257)]]) {
      await assert.rejects(probeConsole({ url, path: '/console/results', username, password }), /invalid (?:username|password)/);
    }
    assert.deepEqual(calls, [], 'nothing was sent');
  });
});
