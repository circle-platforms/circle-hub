import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * The local test site implementing SMP-V03-01: deterministic login,
 * failure counting with a 5-strike / 15-minute lockout, MFA with a
 * 60-second window and a site-side simulator, and a session lifecycle
 * whose invalidation is observable. Accounts and passwords are
 * fictional test fixtures for this local site only.
 */
export interface TestAccount {
  id: string;
  password: string;
  mfa: boolean;
}

export const TEST_ACCOUNTS: Record<string, TestAccount> = {
  acct_ok: { id: "acct_ok", password: "test-pwd-correct", mfa: true },
  acct_nomfa: { id: "acct_nomfa", password: "test-pwd-nomfa", mfa: false },
};
export const WRONG_PASSWORD = "test-pwd-wrong";

export const MAX_FAILURES = 5;
export const LOCKOUT_MS = 15 * 60_000;
export const MFA_WINDOW_MS = 60_000;
export const MFA_MAX_ATTEMPTS = 3;
export const SESSION_TTL_MS = 30 * 60_000;

interface Session {
  id: string;
  accountId: string;
  createdAt: number;
  authenticatedAt?: number;
  mfa?: { code: string; expiresAt: number; attempts: number };
}

interface ClockLike {
  now(): number;
}

function page(state: string, body: string): string {
  return `<!doctype html><html><body><main data-state="${state}">${body}</main></body></html>`;
}

export class TestSite {
  #clock: ClockLike;
  #failCounts = new Map<string, number>();
  #lockedUntil = new Map<string, number>();
  #sessions = new Map<string, Session>();
  #sessionSeq = 0;
  #codeSeq = 0;
  #server: Server | undefined;
  baseUrl = "";

  constructor(clock: ClockLike) {
    this.#clock = clock;
  }

  async start(): Promise<string> {
    this.#server = createServer((req, res) => {
      void this.#handle(req, res);
    });
    await new Promise<void>((resolve) => {
      this.#server?.listen(0, "127.0.0.1", resolve);
    });
    const address = this.#server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    this.baseUrl = `http://127.0.0.1:${port}`;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#server?.close(() => resolve());
    });
  }

  /** Out-of-band simulator access: the current MFA code for a session. */
  simulatorMfaCode(sessionId: string): string | undefined {
    return this.#sessions.get(sessionId)?.mfa?.code;
  }

  sessionIdForCookie(cookieHeader: string | undefined): string | undefined {
    const match = /(?:^|;\s*)ts_session=([^;]+)/.exec(cookieHeader ?? "");
    return match?.[1];
  }

  activeSessionCount(): number {
    return this.#sessions.size;
  }

  failCount(accountId: string): number {
    return this.#failCounts.get(accountId) ?? 0;
  }

  isLocked(accountId: string): boolean {
    return (this.#lockedUntil.get(accountId) ?? 0) > this.#clock.now();
  }

  #nextCode(): string {
    this.#codeSeq += 1;
    return String(100_000 + ((this.#codeSeq * 79_191) % 900_000));
  }

  #sessionOf(req: IncomingMessage): Session | undefined {
    const id = this.sessionIdForCookie(req.headers.cookie);
    return id ? this.#sessions.get(id) : undefined;
  }

  #sendHtml(res: ServerResponse, status: number, html: string, headers: Record<string, string> = {}): void {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
    res.end(html);
  }

  #redirect(res: ServerResponse, location: string, headers: Record<string, string> = {}): void {
    res.writeHead(302, { location, ...headers });
    res.end();
  }

  async #readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (chunks.length === 0) return {};
    const text = Buffer.concat(chunks).toString("utf8");
    const contentType = req.headers["content-type"] ?? "";
    if (contentType.includes("application/x-www-form-urlencoded")) {
      // Real browser forms (P3-3 browser-level work): form posts are
      // accepted alongside the JSON posts the flow-level client uses.
      return Object.fromEntries(new URLSearchParams(text));
    }
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  #loginPage(res: ServerResponse, opts: { error?: string; failCount?: number; state?: string } = {}): void {
    const state = opts.state ?? (opts.error ? "login-error" : "login");
    const errorHtml = opts.error
      ? `<p class="error">${opts.error}</p><p data-fail-count="${opts.failCount ?? 0}">连续失败 ${opts.failCount ?? 0} 次</p>`
      : "";
    this.#sendHtml(res, 200, page(state, `<h1>登录</h1>${errorHtml}<form method="post" action="/login"><label>用户名 <input name="username" autocomplete="username"></label><label>口令 <input name="password" type="password" autocomplete="current-password"></label><button type="submit">提交</button></form>`));
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://local");
    const path = url.pathname;
    const now = this.#clock.now();

    if (req.method === "GET" && path === "/login") {
      const flash = url.searchParams.get("flash");
      if (flash === "mfa-timeout") {
        this.#loginPage(res, { state: "login-mfa-timeout", error: "MFA 验证已超时，请重新登录" });
        return;
      }
      if (flash === "mfa-failed") {
        this.#loginPage(res, { error: "MFA 验证失败次数过多，会话已作废" });
        return;
      }
      this.#loginPage(res);
      return;
    }

    if (req.method === "POST" && path === "/login") {
      const body = await this.#readBody(req);
      const username = String(body.username ?? "");
      const password = String(body.password ?? "");
      const account = TEST_ACCOUNTS[username];
      if (account && this.isLocked(username)) {
        this.#redirect(res, "/locked");
        return;
      }
      if (!account || account.password !== password) {
        const count = this.failCount(username) + 1;
        this.#failCounts.set(username, count);
        if (account && count >= MAX_FAILURES) {
          this.#lockedUntil.set(username, now + LOCKOUT_MS);
          this.#redirect(res, "/locked");
          return;
        }
        this.#loginPage(res, { error: "凭据不正确", failCount: count });
        return;
      }
      this.#failCounts.set(username, 0);
      this.#sessionSeq += 1;
      const session: Session = {
        id: `sess_${String(this.#sessionSeq).padStart(4, "0")}`,
        accountId: username,
        createdAt: now,
      };
      const cookie = { "set-cookie": `ts_session=${session.id}; Path=/; HttpOnly` };
      if (account.mfa) {
        session.mfa = { code: this.#nextCode(), expiresAt: now + MFA_WINDOW_MS, attempts: 0 };
        this.#sessions.set(session.id, session);
        this.#redirect(res, "/mfa", cookie);
        return;
      }
      session.authenticatedAt = now;
      this.#sessions.set(session.id, session);
      this.#redirect(res, "/home", cookie);
      return;
    }

    if (path === "/mfa") {
      const session = this.#sessionOf(req);
      if (!session?.mfa) {
        this.#redirect(res, "/login");
        return;
      }
      if (now > session.mfa.expiresAt) {
        this.#sessions.delete(session.id);
        this.#redirect(res, "/login?flash=mfa-timeout");
        return;
      }
      if (req.method === "GET") {
        this.#sendHtml(res, 200, page("mfa-waiting", `<h1>双因素验证</h1><p>请输入 6 位验证码</p><form method="post" action="/mfa"><label>验证码 <input name="code" inputmode="numeric" autocomplete="one-time-code"></label><button type="submit">提交</button></form>`));
        return;
      }
      if (req.method === "POST") {
        const body = await this.#readBody(req);
        const code = String(body.code ?? "");
        if (code !== session.mfa.code) {
          session.mfa.attempts += 1;
          if (session.mfa.attempts >= MFA_MAX_ATTEMPTS) {
            this.#sessions.delete(session.id);
            this.#redirect(res, "/login?flash=mfa-failed");
            return;
          }
          this.#sendHtml(
            res,
            200,
            page("mfa-error", `<p class="error">验证码不正确</p><p data-mfa-attempts="${session.mfa.attempts}"></p><form method="post" action="/mfa"><label>验证码 <input name="code" inputmode="numeric" autocomplete="one-time-code"></label><button type="submit">提交</button></form>`),
          );
          return;
        }
        session.mfa = undefined;
        session.authenticatedAt = now;
        this.#redirect(res, "/home");
        return;
      }
    }

    if (req.method === "GET" && path === "/home") {
      const session = this.#sessionOf(req);
      if (
        session?.authenticatedAt !== undefined &&
        now - session.authenticatedAt <= SESSION_TTL_MS
      ) {
        const remaining = Math.max(0, SESSION_TTL_MS - (now - session.authenticatedAt));
        this.#sendHtml(
          res,
          200,
          page("home", `<h1>控制台首页</h1><p data-session-remaining-ms="${remaining}">会话剩余 ${Math.round(remaining / 1000)} 秒</p><p><a href="/download" download>下载会话报告</a></p><form method="post" action="/logout"><button type="submit">退出登录</button></form>`),
        );
        return;
      }
      this.#redirect(res, "/login");
      return;
    }

    if (req.method === "GET" && path === "/download") {
      // Fixture download for browser-level checks (D-T04): the bytes
      // are deterministic so a browser download can be verified.
      const session = this.#sessionOf(req);
      if (session?.authenticatedAt === undefined) {
        this.#redirect(res, "/login");
        return;
      }
      const body = `session-report\naccount=${session.accountId}\nsession=${session.id}\n`;
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": 'attachment; filename="session-report.txt"',
      });
      res.end(body);
      return;
    }

    if (req.method === "GET" && path === "/locked") {
      this.#sendHtml(res, 200, page("locked", "<h1>账号已锁定</h1><p>连续失败次数过多，账号锁定 15 分钟</p>"));
      return;
    }

    if (req.method === "POST" && path === "/logout") {
      const session = this.#sessionOf(req);
      if (session) this.#sessions.delete(session.id);
      this.#redirect(res, "/login", { "set-cookie": "ts_session=; Path=/; Max-Age=0" });
      return;
    }

    this.#sendHtml(res, 404, page("not-found", "not found"));
  }
}
