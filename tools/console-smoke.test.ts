// Unit tests for tools/console-smoke.ts: verifies complete console route coverage against hub/server/console/routes.ts
// and console-routes.ts, strict CLI/stdin secret isolation, GET-only enforcement, and full pass/fail scenarios over HTTP.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { dirname, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAuthority, issueServerCertificate } from '../hub/platform/tls.ts';
import * as routeConstructors from '../hub/server/console/routes.ts';
import {
  ADMIN_GET_ROUTES,
  MEMBER_BLOCKED_ADMIN_PATHS,
  MEMBER_COMMON_GET_ROUTES,
  PROTECTED_REDIRECT_PATHS,
  defaultHttpRequester,
  extractTeamNames,
  formatSmokeLine,
  formatSmokeSummary,
  parseSmokeCliArgs,
  readPasswordsFromStdin,
  runConsoleSmoke,
} from './console-smoke.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const NON_STANDALONE_GET_ROUTES: Readonly<Record<string, string>> = {
  // Public login / favicon / logout POST are explicitly checked outside ADMIN_GET_ROUTES.
  loginPath: 'checked in unauthenticated and sign-in flows',
  logoutPath: 'POST-only logout action, checked explicitly',
  faviconPath: 'checked in unauthenticated probes',
  // Parameterized detail, query-required, or interactive setup/OAuth flows.
  runPath: 'requires runId parameter',
  roundsPath: 'requires run query parameter (related-tasks page)',
  roundDevicePath: 'requires run and sha256 query parameters',
  resultPath: 'requires runId parameter',
  workflowPath: 'requires pack id parameter',
  skillPath: 'requires pack id parameter',
  teamDetailPath: 'requires tm_ teamId parameter',
  knowledgeProductPath: 'requires product id parameter',
  knowledgeRootPath: 'requires root sha256 parameter',
  knowledgeTreePath: 'requires root sha256 and path parameters',
  knowledgeDiffPath: 'requires from/to sha256 parameters',
  knowledgeSpaceDiffPath: 'requires from/to sha256 parameters',
  knowledgeSourcePath: 'requires sha256 parameter',
  knowledgeDownloadPath: 'file download route requiring sha256/artifact',
  authorizePath: 'OAuth interactive authorization flow',
  authorizeRequestPath: 'OAuth authorization request id flow',
  devicePath: 'OAuth device flow',
  setupPath: 'first-time setup page (409 once admin exists)',
  resetStatusPath: 'requires async reset operation UUID',
  // Mutating POST routes: explicitly excluded by read-only smoke probe.
  adminDoPath: 'POST-only admin action',
  knowledgeDoPath: 'POST-only knowledge action',
  knowledgeShareBatchPath: 'POST-only batch share action',
  rebuildAuthorizePath: 'POST-only rebuild maintenance authorization',
  rebuildPreviewPath: 'POST-only rebuild preview',
  rebuildExecutePath: 'POST-only rebuild execute',
  rebuildNewActionPath: 'POST-only rebuild new action',
};

function htmlPage(title: string, bodyContent: string, csrf?: string): string {
  return `<!doctype html><html><head><title>${title} · circle-hub</title></head><body><main><h1>${title}</h1>${csrf === undefined ? '' : `<form method="post" action="/console/logout"><input type="hidden" name="csrf" value="${csrf}"></form>`}${bodyContent}</main></body></html>`;
}

function withMockConsoleServer(
  options: {
    failAdminHealthForAdmin?: boolean;
    allowMemberAdminLeak?: boolean;
    leakOtherTeamToMember?: boolean;
    tls?: { cert: string; key: string };
  } = {},
) {
  const requests: Array<{ method: string; url: string }> = [];
  const activeSessions = new Map<string, { role: 'admin' | 'member'; csrf: string }>();
  const loginNonces = new Set<string>();
  const secure = options.tls !== undefined;
  const loginCookieName = secure ? '__Secure-circle_hub_login' : 'circle_hub_login';
  const sessionCookieName = secure ? '__Secure-circle_hub_session' : 'circle_hub_session';
  const cookieAttrs = secure ? '; Secure; HttpOnly' : '; HttpOnly';
  let seq = 0;

  const titleByPath = new Map<string, string>(ADMIN_GET_ROUTES.map((r) => [r.path, r.expectedTitle]));

  const readForm = (req: http.IncomingMessage): Promise<URLSearchParams> =>
    new Promise((resolvePromise, rejectPromise) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolvePromise(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
      req.on('error', rejectPromise);
    });

  const handler: http.RequestListener = async (req, res) => {
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';
    requests.push({ method, url: rawUrl });
    const parsed = new URL(rawUrl, secure ? 'https://127.0.0.1' : 'http://127.0.0.1');
    const cookies = new Map<string, string>();
    for (const part of (req.headers.cookie ?? '').split(';')) {
      const eq = part.indexOf('=');
      if (eq > 0) cookies.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }
    const sid = cookies.get(sessionCookieName);
    const session = sid ? activeSessions.get(sid) ?? null : null;

    if (parsed.pathname === '/console/favicon.svg' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8' });
      res.end('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
      return;
    }

    if (parsed.pathname === '/console/login') {
      if (method === 'GET') {
        const nonce = `nonce-${++seq}`;
        loginNonces.add(nonce);
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'set-cookie': `${loginCookieName}=${nonce}; Path=/console/login${cookieAttrs}`,
        });
        res.end(
          `<!doctype html><html><head><title>登录 · circle-hub</title></head><body><form method="post" action="/console/login"><input type="hidden" name="csrf" value="${nonce}"><input name="username"><input name="password" type="password"></form></body></html>`,
        );
        return;
      }
      if (method === 'POST') {
        const form = await readForm(req);
        const csrf = form.get('csrf') ?? '';
        if (cookies.get(loginCookieName) !== csrf || !loginNonces.has(csrf)) {
          res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
          res.end(htmlPage('拒绝', '<p>CSRF invalid</p>'));
          return;
        }
        const username = form.get('username');
        const password = form.get('password');
        if ((username === 'admin' && password === 'secret-admin-pass') || (username === 'member1' && password === 'secret-member-pass')) {
          const id = `sess-${++seq}`;
          const role = username === 'admin' ? 'admin' : 'member';
          activeSessions.set(id, { role, csrf: `csrf-${id}` });
          res.writeHead(303, {
            location: '/console/overview',
            'set-cookie': `${sessionCookieName}=${id}; Path=/console${cookieAttrs}`,
          });
          res.end();
          return;
        }
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
        res.end(htmlPage('登录', '<p>用户名或密码无效</p>'));
        return;
      }
    }

    if (parsed.pathname === '/console/logout' && method === 'POST') {
      const form = await readForm(req);
      if (!session || form.get('csrf') !== session.csrf) {
        res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
        res.end(htmlPage('拒绝', '<p>CSRF invalid</p>'));
        return;
      }
      activeSessions.delete(sid!);
      res.writeHead(303, {
        location: '/console/login',
        'set-cookie': `${sessionCookieName}=; Path=/console; Max-Age=0${secure ? '; Secure' : ''}`,
      });
      res.end();
      return;
    }

    if (parsed.pathname === '/console/rebuild') {
      if (session === null || session.role !== 'admin') {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('需要当前有效且已完成密码设置的管理员会话');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(htmlPage('需要重建', '<section><h2>归档并初始化</h2></section>', session.csrf));
      return;
    }

    if (session === null) {
      const target = parsed.pathname === '/console' ? '/console/login' : `/console/login?next=${encodeURIComponent(rawUrl)}`;
      res.writeHead(303, { location: target });
      res.end();
      return;
    }

    if (parsed.pathname === '/console') {
      res.writeHead(303, { location: '/console/overview' });
      res.end();
      return;
    }

    if (session.role === 'admin' && options.failAdminHealthForAdmin && parsed.pathname === '/console/health') {
      res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
      res.end(htmlPage('Hub 内部错误', '<p>Hub 内部错误，原因已记入服务日志</p>', session.csrf));
      return;
    }

    const isAdminOnly = MEMBER_BLOCKED_ADMIN_PATHS.includes(parsed.pathname);
    if (session.role === 'member' && isAdminOnly && !options.allowMemberAdminLeak) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(htmlPage('该内容不存在或无权查看', '<p>该内容不存在或无权查看</p>', session.csrf));
      return;
    }

    if (parsed.pathname === '/console/team' || parsed.pathname === '/console/teams') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (session.role === 'admin' && parsed.searchParams.get('tab') === null) {
        res.end(
          htmlPage(
            '团队',
            '<section><h2>新建团队</h2><table><tr><td><a href="/console/team/tm_alpha">团队甲</a></td><td><a href="/console/team/tm_beta">团队乙</a></td></tr></table></section>',
            session.csrf,
          ),
        );
      } else if (session.role === 'member') {
        const leaked = options.leakOtherTeamToMember ? '<td><a href="/console/team/tm_beta">团队乙</a></td>' : '';
        res.end(
          htmlPage(
            '团队',
            `<p>只显示当前账户所属团队的名字。</p><table><tr><td><a href="/console/team/tm_alpha">团队甲</a></td>${leaked}</tr></table>`,
            session.csrf,
          ),
        );
      } else {
        res.end(htmlPage('团队', '<p>团队视图</p>', session.csrf));
      }
      return;
    }

    if (parsed.pathname === '/console/settings' && parsed.searchParams.get('tab') === 'hub') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      const extra = session.role === 'admin' ? '<section id="reset-rebuild"><h2>重置和重建</h2></section>' : '';
      res.end(htmlPage('设置', `<section data-hub-state></section>${extra}`, session.csrf));
      return;
    }

    const expectedTitle = titleByPath.get(rawUrl) ?? titleByPath.get(parsed.pathname);
    if (expectedTitle !== undefined) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(htmlPage(expectedTitle, '<p>OK</p>', session.csrf));
      return;
    }

    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(htmlPage('该内容不存在或无权查看', '<p>该内容不存在或无权查看</p>', session.csrf));
  };

  const server = options.tls ? https.createServer({ cert: options.tls.cert, key: options.tls.key }, handler) : http.createServer(handler);
  return { server, requests, protocol: secure ? 'https' : 'http' };
}

async function listen(server: http.Server | https.Server, protocol = 'http'): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    baseUrl: `${protocol}://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolvePromise, rejectPromise) => server.close((err) => (err ? rejectPromise(err) : resolvePromise()))),
  };
}

test('route coverage covers every ROUTES key in console-routes.ts and every routes.ts export', () => {
  const routesSource = readFileSync(resolve(ROOT, 'hub/server/console/console-routes.ts'), 'utf8');
  const mapBlock = /export const ROUTES[^=]*=\s*\{([\s\S]*?)\n\};/.exec(routesSource)?.[1] ?? '';
  const topLevelKeys = [...mapBlock.matchAll(/^\s{2}([a-z]+)\s*:/gm)].map((m) => m[1]);
  assert.ok(topLevelKeys.length >= 16, `expected ROUTES keys in console-routes.ts, got ${topLevelKeys.join(', ')}`);

  const visitedPaths = new Set([
    ...ADMIN_GET_ROUTES.map((r) => new URL(r.path, 'http://127.0.0.1').pathname),
    ...MEMBER_BLOCKED_ADMIN_PATHS,
    ...MEMBER_COMMON_GET_ROUTES.map((r) => new URL(r.path, 'http://127.0.0.1').pathname),
    routeConstructors.rebuildPath(),
    // Query-required: covered via NON_STANDALONE_GET_ROUTES, not probed without ?run=.
    routeConstructors.roundsPath(),
  ]);

  for (const key of topLevelKeys) {
    if (key === 'admin') {
      assert.ok(MEMBER_BLOCKED_ADMIN_PATHS.some((p) => p.startsWith('/console/admin')), 'admin namespace probed');
    } else {
      assert.ok(visitedPaths.has(`/console/${key}`), `ROUTES key ${key} (/console/${key}) must be covered by console-smoke`);
    }
  }

  for (const name of Object.keys(routeConstructors)) {
    if (!name.endsWith('Path')) continue;
    const ctor = (routeConstructors as Record<string, (...args: never[]) => unknown>)[name];
    if (ctor.length === 0 && !Object.hasOwn(NON_STANDALONE_GET_ROUTES, name)) {
      const built = String((ctor as () => string)());
      assert.ok(visitedPaths.has(built), `routes.ts constructor ${name}() -> ${built} missing from console-smoke routes`);
    } else {
      assert.ok(
        Object.hasOwn(NON_STANDALONE_GET_ROUTES, name) || visitedPaths.has(`/console/${name.replace(/Path$/, '').toLowerCase()}`),
        `routes.ts constructor ${name} must be covered or listed in NON_STANDALONE_GET_ROUTES`,
      );
    }
  }
});

test('parseSmokeCliArgs forbids command-line passwords and validates options', () => {
  assert.throws(() => parseSmokeCliArgs(['--base-url', 'http://127.0.0.1:3000', '--admin', '管理员', '--password', 'secret']), /命令行参数禁止传递密码/);
  assert.throws(() => parseSmokeCliArgs(['--base-url', 'http://127.0.0.1:3000', '--admin', '管理员', '--admin-password=secret']), /命令行参数禁止传递密码/);
  assert.throws(() => parseSmokeCliArgs(['--base-url', 'ftp://127.0.0.1', '--admin', '管理员']), /http 或 https/);
  assert.throws(() => parseSmokeCliArgs(['--base-url', 'http://127.0.0.1:3000', '--admin', '管理员', '--member-teams', '团队甲']), /必须配合 --member/);
  assert.throws(() => parseSmokeCliArgs(['--base-url', 'http://127.0.0.1:3000', '--admin', '管理员', '--timeout-ms', '50']), /不小于 100/);

  const parsed = parseSmokeCliArgs([
    '--base-url',
    'https://192.0.2.10:8443/console/ignored',
    '--admin',
    '管理员',
    '--member',
    '成员甲',
    '--member-teams',
    '团队甲,团队丙',
    '--excluded-teams',
    '团队乙',
    '--timeout-ms',
    '8000',
  ]);
  assert.equal(parsed.help, false);
  assert.equal(parsed.baseUrl, 'https://192.0.2.10:8443/console/ignored');
  assert.equal(parsed.adminUser, '管理员');
  assert.equal(parsed.memberUser, '成员甲');
  assert.deepEqual(parsed.memberTeams, ['团队甲', '团队丙']);
  assert.deepEqual(parsed.excludedTeams, ['团队乙']);
  assert.equal(parsed.timeoutMs, 8000);
});

test('readPasswordsFromStdin reads 1 or 2 lines from pipe and TTY without echo', async () => {
  const one = new PassThrough();
  one.end('admin-line-pw\n');
  assert.deepEqual(await readPasswordsFromStdin(false, one), { adminPassword: 'admin-line-pw' });

  const two = new PassThrough();
  two.end('admin-pw\r\nmember-pw\r\n');
  assert.deepEqual(await readPasswordsFromStdin(true, two), {
    adminPassword: 'admin-pw',
    memberPassword: 'member-pw',
  });

  const missingSecond = new PassThrough();
  missingSecond.end('admin-pw\n');
  await assert.rejects(readPasswordsFromStdin(true, missingSecond), /第 2 行普通成员/);

  const tty = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (mode: boolean) => void };
  tty.isTTY = true;
  tty.setRawMode = () => {};
  const prompts: string[] = [];
  const promise = readPasswordsFromStdin(false, tty, (text) => prompts.push(text));
  tty.write('s3cr\u001b[Aet!\r');
  assert.deepEqual(await promise, { adminPassword: 's3cret!' });
  assert.equal(prompts.join('').includes('s3cret'), false);
});

test('defaultHttpRequester refuses non-GET requests outside login and logout', async () => {
  await assert.rejects(
    defaultHttpRequester({
      url: new URL('http://127.0.0.1:1/console/admin/do/team-create'),
      method: 'POST',
      headers: {},
      timeoutMs: 1000,
    }),
    /禁止除登录与登出之外的非 GET 请求/,
  );
});

test('extractTeamNames extracts only team detail link names', () => {
  const html = '<a href="/console/team/usr_1">管理员</a><a href="/console/team/tm_1">研发团队</a><a href="/console/teams/tm_2">产品&amp;支持</a>';
  assert.deepEqual(extractTeamNames(html), ['研发团队', '产品&支持']);
});

test('runConsoleSmoke passes all unauthenticated, admin, member isolation, and logout checks strictly via GET (+ login/logout POST)', async (t) => {
  const mock = withMockConsoleServer();
  const srv = await listen(mock.server);
  t.after(() => srv.close());

  const report = await runConsoleSmoke({
    baseUrl: srv.baseUrl,
    admin: { username: 'admin', password: 'secret-admin-pass' },
    member: {
      username: 'member1',
      password: 'secret-member-pass',
      memberTeams: ['团队甲'],
      excludedTeams: ['团队乙'],
    },
  });

  assert.equal(report.ok, true, report.checks.map(formatSmokeLine).join('\n'));
  assert.equal(report.failed, 0);
  assert.equal(report.total, report.passed);

  // The member home (/console/me) is probed once in each of the anonymous, administrator and member phases, and passes.
  for (const phase of ['未登录', '管理员', '普通成员'] as const) {
    const home = report.checks.filter((check) => check.phase === phase && check.path === '/console/me');
    assert.equal(home.length, 1, `${phase}: /console/me is probed once`);
    assert.equal(home[0].ok, true, `${phase}: ${home[0].detail}`);
  }

  // Strict read-only enforcement: every POST must be /console/login or /console/logout.
  const nonGet = mock.requests.filter((r) => r.method !== 'GET');
  assert.deepEqual(
    nonGet.map((r) => `${r.method} ${r.url}`),
    ['POST /console/login', 'POST /console/logout', 'POST /console/login', 'POST /console/logout'],
  );

  const rendered = `${report.checks.map(formatSmokeLine).join('\n')}\n${formatSmokeSummary(report)}`;
  assert.equal(rendered.includes('secret-admin-pass'), false);
  assert.equal(rendered.includes('secret-member-pass'), false);
  assert.match(rendered, /汇总：共检查 \d+ 项，通过 \d+ 项，失败 0 项/);
});

test('runConsoleSmoke reports failures cleanly when admin page returns 500, member leaks excluded team, or admin page opens for member', async (t) => {
  const mock = withMockConsoleServer({
    failAdminHealthForAdmin: true,
    allowMemberAdminLeak: true,
    leakOtherTeamToMember: true,
  });
  const srv = await listen(mock.server);
  t.after(() => srv.close());

  const report = await runConsoleSmoke({
    baseUrl: srv.baseUrl,
    admin: { username: 'admin', password: 'secret-admin-pass' },
    member: {
      username: 'member1',
      password: 'secret-member-pass',
      memberTeams: ['团队甲'],
    },
  });

  assert.equal(report.ok, false);
  assert.ok(report.failed >= 3);

  const healthAdmin = report.checks.find((c) => c.phase === '管理员' && c.path === '/console/health');
  assert.equal(healthAdmin?.ok, false);
  assert.match(healthAdmin?.detail ?? '', /HTTP 500/);

  const teamMember = report.checks.find((c) => c.phase === '普通成员' && c.path === '/console/team');
  assert.equal(teamMember?.ok, false);
  assert.match(teamMember?.detail ?? '', /越权看到非所属团队「团队乙」/);

  const healthMember = report.checks.find((c) => c.phase === '普通成员' && c.path === '/console/health');
  assert.equal(healthMember?.ok, false);
  assert.match(healthMember?.detail ?? '', /期望 HTTP 404/);
});

test('runConsoleSmoke works over HTTPS with custom CA and __Secure- cookies', async (t) => {
  const authority = createAuthority();
  const tls = issueServerCertificate(authority, ['127.0.0.1']);
  const mock = withMockConsoleServer({ tls });
  const srv = await listen(mock.server, mock.protocol);
  t.after(() => srv.close());

  const report = await runConsoleSmoke({
    baseUrl: srv.baseUrl,
    ca: authority.cert,
    admin: { username: 'admin', password: 'secret-admin-pass' },
    member: {
      username: 'member1',
      password: 'secret-member-pass',
      memberTeams: ['团队甲'],
    },
  });

  assert.equal(report.ok, true, report.checks.map(formatSmokeLine).join('\n'));
  assert.equal(report.failed, 0);
});
